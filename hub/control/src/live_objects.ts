//  Running live objects (build spec of the live object slice, stage 4): each
//  object the hub takes (board_objects.ts) is updated at its interval, one
//  object at a time. An update is a few steps of its program: a step says
//  what it wants fetched, the hub fetches it through its guarded fetcher
//  (public https only, no redirects, within the per-step size), and runs
//  the next step with the replies, until a step asks for nothing more. The
//  values it sets are checked against its type (object_types.ts) before the
//  live model carries them. An object that misses three updates is stale.
//
//  What each object has (its values, its working state, when it next runs)
//  is kept beside the hub's database, so a restart neither loses the last
//  reading nor looks a place up again.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BoardObjects, KeptObject } from './board_objects.ts';
import type { HubConfig } from './config.ts';
import type { FetchReply } from './net.ts';
import { checkValues, type Values } from './object_types.ts';
import { allowedHosts, runStep, type Reply, type StepLimits, type StepResult } from './program.ts';

//  how often the scheduler looks for objects due
const TickMs = 15_000;
//  the most steps one update may take (ask, reply, ask again, reply)
const MaxSteps = 4;
//  missed updates before an object is stale
const StaleAfter = 3;
//  log lines kept for each object's owner
const LogLines = 20;

export interface ObjectEntity {
    id: string;
    type: 'object';
    //  the leaf whose object it is
    owner: string;
    title: string;
    //  its shared value type
    kind: string;
    //  its zone; the slice has only the common space
    zone: null;
    look: { badge: true; credit: { text: string; url: string }[] };
    values: Values;
    updatedAt: string | null;
    stale: boolean;
    //  its page on the hub, and its record
    page: string;
    record: string;
}

interface ObjectState {
    values: Values;
    updatedAt: number | null;
    keep: unknown;
    nextAt: number;
    //  the record's version the state is for
    cid: string;
    lastError: string | null;
    log: string[];
    fuel: number;
}

export interface LiveObjectsDeps {
    config: HubConfig;
    objects: BoardObjects;
    fetch: (url: string, maxBytes: number) => Promise<FetchReply>;
    //  something shown changed
    changed?: () => void;
    log?: (line: string) => void;
    now?: () => number;
}

export const keyOf = (o: { bbs: string; rkey: string }) => `${o.bbs}/${o.rkey}`;
export const pageOf = (o: { bbs: string; rkey: string }) => `/objects/${o.bbs}/${encodeURIComponent(o.rkey)}`;

export class LiveObjects {
    deps: LiveObjectsDeps;
    dir: string;
    log: (line: string) => void;
    now: () => number;
    states = new Map<string, ObjectState>();
    //  something shown changed (the site sets this to its live model's poke)
    onChange: (() => void) | null = null;
    private timer: NodeJS.Timeout | null = null;
    private running = false;

    constructor(deps: LiveObjectsDeps, dir: string) {
        this.deps = deps;
        this.dir = dir;
        this.log = deps.log ?? (() => {});
        this.now = deps.now ?? Date.now;
        mkdirSync(dir, { recursive: true });
        const path = join(dir, 'state.json');
        if (existsSync(path)) {
            for (const [key, s] of Object.entries(
                JSON.parse(readFileSync(path, 'utf8')) as Record<string, ObjectState>
            )) {
                this.states.set(key, { ...s, log: s.log ?? [] });
            }
        }
    }

    get settings() {
        return this.deps.config.compute;
    }

    get limits(): StepLimits {
        const s = this.settings.perStep;
        return {
            fuel: s.fuel,
            ms: s.ms,
            fetches: s.fetches,
            urlBytes: 2048,
            valuesBytes: 4096,
            keepBytes: 4096,
            logBytes: 200,
            logLines: LogLines,
        };
    }

    start(): void {
        this.timer = setInterval(() => void this.tick(), TickMs);
        this.timer.unref();
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
        }
    }

    //  Run every object that is due, one at a time; one run at a time
    async tick(): Promise<void> {
        if (this.running) {
            return;
        }
        this.running = true;
        try {
            const objects = this.deps.objects.objects();
            const present = new Set(objects.map(keyOf));
            for (const key of [...this.states.keys()]) {
                if (!present.has(key)) {
                    this.states.delete(key);
                }
            }
            const due = objects
                .map(o => ({ o, s: this.stateOf(o) }))
                .filter(({ s }) => s.nextAt <= this.now())
                .sort((a, b) => a.s.nextAt - b.s.nextAt);
            for (const { o } of due) {
                await this.update(o);
            }
        } finally {
            this.running = false;
        }
    }

    private stateOf(o: KeptObject): ObjectState {
        const key = keyOf(o);
        let s = this.states.get(key);
        if (!s) {
            s = {
                values: {},
                updatedAt: null,
                keep: null,
                nextAt: this.now(),
                cid: o.cid,
                lastError: null,
                log: [],
                fuel: 0,
            };
            this.states.set(key, s);
        } else if (s.cid !== o.cid) {
            //  its record changed (a new place, say): update it now
            s.cid = o.cid;
            s.nextAt = this.now();
        }
        return s;
    }

    //  One update of one object
    async update(o: KeptObject): Promise<void> {
        const s = this.stateOf(o);
        const program = this.deps.objects.checkedProgram(o.program);
        const kept = this.deps.objects.programs.get(o.program);
        s.nextAt = this.now() + o.interval * 1000;
        if (!program || !kept) {
            return;
        }
        const hosts = allowedHosts(kept.fetch, this.settings.fetch);
        let replies: Reply[] = [];
        let values: Record<string, unknown> | null = null;
        let failed: string | null = null;
        let fuel = 0;
        const lines: string[] = [];
        for (let step = 0; step < MaxSteps; step++) {
            const r: StepResult = await runStep(
                program,
                { input: o.input, state: s.keep, replies, time: new Date(this.now()).toISOString() },
                { allowedHosts: hosts, limits: this.limits }
            );
            fuel += r.fuelUsed;
            lines.push(...r.log);
            if (!r.ok) {
                failed = `${r.reason}: ${r.message}`;
                break;
            }
            if (undefined !== r.keep) {
                s.keep = r.keep;
            }
            if (r.values) {
                values = r.values;
            }
            if (!r.fetches.length) {
                break;
            }
            replies = await this.fetchAll(r.fetches, hosts);
        }
        s.fuel = fuel;
        //  what its program said in this update alone
        s.log = lines.slice(-LogLines);
        s.lastError = failed;
        if (failed) {
            this.log(`live objects: ${o.bbs}'s ${o.title}: ${failed}`);
        }
        if (values) {
            const checked = checkValues(kept.values, values, this.now());
            s.values = checked;
            s.updatedAt = this.now();
            this.deps.changed?.();
            this.onChange?.();
        }
        this.save();
    }

    //  What a step asked for, fetched in order: each on a site still allowed
    //  (checked again here, as well as in the step), within the size limit
    private async fetchAll(urls: string[], hosts: string[]): Promise<Reply[]> {
        const out: Reply[] = [];
        for (const url of urls.slice(0, this.settings.perStep.fetches)) {
            let host = '';
            try {
                host = new URL(url).hostname;
            } catch {
                //  refused below
            }
            if (!hosts.includes(host)) {
                out.push({ status: 0, body: '' });
                continue;
            }
            try {
                const reply = await this.deps.fetch(url, this.settings.perStep.fetchBytes);
                out.push({ status: reply.status, body: reply.body.toString('utf8') });
            } catch (e) {
                this.log(`live objects: fetching ${host}: ${(e as Error).message}`);
                out.push({ status: 0, body: '' });
            }
        }
        return out;
    }

    stale(o: KeptObject): boolean {
        const s = this.states.get(keyOf(o));
        return !s?.updatedAt || this.now() - s.updatedAt > StaleAfter * o.interval * 1000;
    }

    //  What an object's page shows of how it is running, for its owner and
    //  anyone looking: its last error and the lines its program logged
    status(o: KeptObject): { lastError: string | null; log: string[]; fuel: number } | null {
        const s = this.states.get(keyOf(o));
        return s ? { lastError: s.lastError, log: s.log, fuel: s.fuel } : null;
    }

    //  The objects, as the live model carries them
    entities(): ObjectEntity[] {
        const prefix = this.deps.config.directory.nsidPrefix;
        return this.deps.objects.objects().map(o => {
            const s = this.states.get(keyOf(o));
            const program = this.deps.objects.programs.get(o.program);
            return {
                id: `object:${o.did}/${o.rkey}`,
                type: 'object',
                owner: `leaf:${o.bbs}`,
                title: o.title,
                kind: program?.values ?? '',
                zone: null,
                look: { badge: true, credit: program?.dataCredit ?? [] },
                values: s?.values ?? {},
                updatedAt: s?.updatedAt ? new Date(s.updatedAt).toISOString() : null,
                stale: this.stale(o),
                page: pageOf(o),
                record: `at://${o.did}/${prefix}.object/${o.rkey}`,
            };
        });
    }

    private save(): void {
        const path = join(this.dir, 'state.json');
        writeFileSync(`${path}.new`, JSON.stringify(Object.fromEntries(this.states), null, 2) + '\n');
        renameSync(`${path}.new`, path);
    }
}
