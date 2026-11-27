//  Live objects BBSes publish from their own accounts (build spec of the
//  live object slice, §3, stage 3). An object is a record of its own
//  (<nsidPrefix>.object): a title, the program it runs (by the hash of the
//  program's module, and the record that publishes it), that program's
//  input, and how often it updates. A program is an asset.item record of
//  form "program", its module and its source as two versions, and its
//  manifest beside them.
//
//  The hub reads objects from the BBSes compute.owners names, linked to
//  their accounts here; fetches each program they name from its own
//  account, wherever that is, checking it by hash; and keeps the module
//  and its source on disk. Only programs on the admin's vetted list
//  (compute.programs) are run, so a program found elsewhere is only ever
//  one the admin chose. A blocked program (by its hash, as any asset is
//  blocked) or a refused account takes its objects with it. Records that
//  are gone are withdrawn. Each BBS has a count of objects
//  (compute.perOwner.objects), and the hub a count in all (maxObjects).
//
//  Running them is the scheduler's (stage 4); this only says what there is.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AtClient } from './atproto.ts';
import type { HubConfig } from './config.ts';
import type { Bbs } from './registry.ts';
import { checkProgram, type CheckedProgram } from './wasm_meter.ts';

export const MaxModuleBytes = 1024 * 1024;
export const MaxSourceBytes = 256 * 1024;
export const MaxInputBytes = 1024;
//  the shared value types the hub knows (compute spec §1.1); the slice has one
export const ValueTypes = ['weather'];
//  a file that failed is not fetched again for this long
const RetryMs = 60 * 60 * 1000;
//  a BBS's records are read no more often than this
const MinReadGapMs = 60 * 1000;
const FetchWindowMs = 60 * 60 * 1000;
const HostRe = /^(?=.{1,200}$)([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9]$/;

export interface BoardObjectsDeps {
    config: HubConfig;
    list: () => Bbs[];
    at: AtClient | null;
    //  whether a BBS's account is linked to it here (its listing names it)
    linked: (bbs: Bbs) => boolean;
    blocked?: (sha256: string) => boolean;
    refused?: (did: string) => boolean;
    log?: (line: string) => void;
    now?: () => number;
}

interface Named {
    sha256: string;
    size: number;
    cid: string;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && 'object' === typeof v && !Array.isArray(v) ? (v as Json) : {});
//  text from outside: trimmed, cut short, and without control or direction
//  characters
const str = (v: unknown, max: number): string | undefined => {
    if ('string' !== typeof v) {
        return undefined;
    }
    const plain = v.replace(/(?!‍)[\p{Cc}\p{Cf}]/gu, ' ').trim();
    const clean = Array.from(plain).slice(0, max).join('').trim();
    return clean || undefined;
};

function namedFile(version: Json, maxBytes: number, mediaType: string): Named | null {
    const file = obj(version.file);
    const ref = obj(obj(version.blob).ref);
    const size = file.size;
    if (
        'string' !== typeof file.sha256 ||
        !/^[0-9a-f]{64}$/.test(file.sha256) ||
        mediaType !== file.mediaType ||
        !Number.isInteger(size) ||
        (size as number) < 1 ||
        (size as number) > maxBytes ||
        'string' !== typeof ref.$link ||
        ref.$link.length > 200
    ) {
        return null;
    }
    return { sha256: file.sha256, size: size as number, cid: ref.$link };
}

//  An object's record, as the hub reads it
export interface ObjectRecord {
    title: string;
    program: { sha256: string; did: string; rkey: string };
    input: unknown;
    interval: number; //  seconds, within the hub's limits
    look: 'badge';
}

//  A record, if it is an object the hub can take: a program named by its
//  hash and by an asset.item record keyed by that hash, an input of at
//  most MaxInputBytes as JSON, and an interval no shorter than
//  |minInterval| (a shorter one is raised to it) and no longer than a day
export function objectRecordOf(value: unknown, nsidPrefix: string, minInterval: number): ObjectRecord | null {
    const v = obj(value);
    const program = obj(v.program);
    const sha256 = program.sha256;
    const uri = 'string' === typeof program.uri ? program.uri : '';
    const m = /^at:\/\/(did:[a-z]+:[a-zA-Z0-9._:%-]{1,200})\/([a-zA-Z0-9.-]{1,200})\/([0-9a-f]{64})$/.exec(
        uri
    );
    if (
        'string' !== typeof sha256 ||
        !/^[0-9a-f]{64}$/.test(sha256) ||
        !m ||
        m[2] !== `${nsidPrefix}.asset.item` ||
        m[3] !== sha256
    ) {
        return null;
    }
    const input = v.input ?? {};
    if ('object' !== typeof input || null === input || Array.isArray(input)) {
        return null;
    }
    if (Buffer.byteLength(JSON.stringify(input)) > MaxInputBytes) {
        return null;
    }
    const asked = Number.isInteger(v.interval) ? (v.interval as number) : minInterval;
    return {
        title: str(v.title, 60) ?? 'A live object',
        program: { sha256, did: m[1]!, rkey: m[3]! },
        input,
        interval: Math.min(86400, Math.max(minInterval, asked)),
        look: 'badge',
    };
}

//  A program's record, as the hub reads it
export interface ProgramRecord {
    module: Named;
    source: Named;
    name: string;
    licence: { id: string; url?: string };
    credit: { author?: string };
    description: { short: string };
    //  from its manifest: the sites it reads, the values it sets, and the
    //  credit its data needs wherever it shows (each a text and a link)
    fetch: string[];
    values: string;
    dataCredit: { text: string; url: string }[];
}

//  A record, if it is a program the hub can take: keyed by its module's
//  hash, with its source, and a manifest naming the sites it reads (host
//  names, at most 8) and a value type the hub knows
export function programRecordOf(rkey: string, value: unknown): ProgramRecord | null {
    const v = obj(value);
    const versions = Array.isArray(v.versions) ? v.versions.slice(0, 8).map(obj) : [];
    const first = versions[0] ?? {};
    if ('program' !== first.form) {
        return null;
    }
    const module = namedFile(first, MaxModuleBytes, 'application/wasm');
    const sourceVersion = versions.slice(1).find(version => 'source' === version.form);
    const source = sourceVersion ? namedFile(sourceVersion, MaxSourceBytes, 'text/plain') : null;
    if (!module || module.sha256 !== rkey || !source) {
        return null;
    }
    const manifest = obj(v.manifest);
    const fetch = Array.isArray(manifest.fetch) ? manifest.fetch : [];
    if (fetch.length > 8 || fetch.some(h => 'string' !== typeof h || !HostRe.test(h))) {
        return null;
    }
    if (!ValueTypes.includes(manifest.values as string)) {
        return null;
    }
    const credits = Array.isArray(manifest.credit) ? manifest.credit.slice(0, 3).map(obj) : [];
    const dataCredit: { text: string; url: string }[] = [];
    for (const c of credits) {
        const text = str(c.text, 80);
        const link = str(c.url, 512);
        if (!text || !link || !/^https:\/\/[^\s"'<>]+$/.test(link)) {
            return null;
        }
        dataCredit.push({ text, url: link });
    }
    const licence = obj(v.licence);
    const url = str(licence.url, 512);
    const author = str(obj(v.credit).author, 80);
    const name = str(v.name, 80) ?? 'A program';
    return {
        module,
        source,
        name,
        licence: {
            id: str(licence.id, 64) ?? 'custom',
            ...(url && /^https:\/\/[^\s"'<>]+$/.test(url) ? { url } : {}),
        },
        credit: author ? { author } : {},
        description: { short: str(obj(v.description).short, 300) ?? name },
        fetch: [...new Set((fetch as string[]).map(h => h.toLowerCase()))],
        values: manifest.values as string,
        dataCredit,
    };
}

//  A program the hub keeps: its module and source are files on disk, named
//  by their hashes
export interface KeptProgram {
    sha256: string; //  its module's, as published (the hub meters a copy)
    did: string; //     the account that publishes it
    cid: string; //     its record's version
    name: string;
    licence: ProgramRecord['licence'];
    credit: ProgramRecord['credit'];
    description: ProgramRecord['description'];
    fetch: string[];
    values: string;
    dataCredit: ProgramRecord['dataCredit'];
    source: string; //  its source's hash
    bytes: number; //   of both files
}

//  An object the hub keeps
export interface KeptObject {
    bbs: string;
    did: string;
    rkey: string;
    cid: string;
    title: string;
    program: string; //  its program's module hash
    input: unknown;
    interval: number;
    look: 'badge';
}

export class BoardObjects {
    deps: BoardObjectsDeps;
    dir: string;
    log: (line: string) => void;
    now: () => number;
    //  by keyOf(bbs, rkey)
    kept = new Map<string, KeptObject>();
    //  by module hash
    programs = new Map<string, KeptProgram>();
    failed = new Map<string, number>();
    settleMs = 5_000;
    private checked = new Map<string, CheckedProgram>();
    private queue: Promise<void> = Promise.resolve();
    private soon = new Map<string, ReturnType<typeof setTimeout>>();
    private lastRead = new Map<string, number>();
    private fetchedIn = new Map<string, { since: number; bytes: number }>();

    constructor(deps: BoardObjectsDeps, dir: string) {
        this.deps = deps;
        this.dir = dir;
        this.log = deps.log ?? (() => {});
        this.now = deps.now ?? Date.now;
        mkdirSync(join(dir, 'files'), { recursive: true });
        const read = <T>(name: string): T[] => {
            const path = join(dir, name);
            return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as T[]) : [];
        };
        for (const p of read<KeptProgram>('programs.json')) {
            this.programs.set(p.sha256, p);
        }
        for (const o of read<KeptObject>('objects.json')) {
            this.kept.set(keyOf(o.bbs, o.rkey), o);
        }
    }

    get settings() {
        return this.deps.config.compute;
    }

    //  whether the hub takes objects from this BBS at all
    allowed(bbs: Bbs): boolean {
        const owners = this.settings.owners;
        return (
            this.settings.enabled &&
            'active' === bbs.state &&
            ('registered' === owners || owners.includes(bbs.name)) &&
            !(bbs.bbsDid && (this.deps.refused?.(bbs.bbsDid) ?? false))
        );
    }

    isBlocked(sha256: string): boolean {
        return this.deps.blocked?.(sha256) ?? false;
    }

    //  whether a program kept may run: vetted by the admin, neither it nor
    //  its source blocked, and its publisher not refused
    runnable(sha256: string): boolean {
        const p = this.programs.get(sha256);
        return (
            !!p &&
            this.settings.programs.includes(sha256) &&
            !this.isBlocked(sha256) &&
            !this.isBlocked(p.source) &&
            !(this.deps.refused?.(p.did) ?? false)
        );
    }

    //  The objects to run and show now: their BBS still taken from and
    //  linked here, their program runnable; at most maxObjects, in the
    //  order taken
    objects(): KeptObject[] {
        const bbses = new Map(this.deps.list().map(bbs => [bbs.name, bbs]));
        return [...this.kept.values()]
            .filter(o => {
                const bbs = bbses.get(o.bbs);
                return !!bbs && this.allowed(bbs) && this.deps.linked(bbs) && this.runnable(o.program);
            })
            .slice(0, this.settings.maxObjects);
    }

    //  A program's module, checked and metered for running (kept checked
    //  in memory once done)
    checkedProgram(sha256: string): CheckedProgram | null {
        if (!this.runnable(sha256)) {
            return null;
        }
        let checked = this.checked.get(sha256);
        if (!checked) {
            checked = checkProgram(readFileSync(join(this.dir, 'files', sha256)), {
                moduleBytes: MaxModuleBytes,
                memoryPages: this.settings.perStep.memoryPages,
            });
            this.checked.set(sha256, checked);
        }
        return checked;
    }

    //  A program's source, as text, for its page
    sourceOf(sha256: string): string | null {
        const p = this.programs.get(sha256);
        if (!p || !this.runnable(sha256)) {
            return null;
        }
        return readFileSync(join(this.dir, 'files', p.source), 'utf8');
    }

    refresh(only?: string[]): Promise<void> {
        const run = this.queue.then(() => this.read(only));
        this.queue = run.catch(() => {});
        return run;
    }

    //  One account's records changed: read that BBS's again, soon
    changed(did: string): void {
        const bbs = this.deps.list().find(b => b.bbsDid === did);
        if (!bbs || this.soon.has(bbs.name) || !this.settings.enabled) {
            return;
        }
        const wait = Math.max(
            this.settleMs,
            (this.lastRead.get(bbs.name) ?? -Infinity) + MinReadGapMs - this.now()
        );
        const timer = setTimeout(() => {
            this.soon.delete(bbs.name);
            void this.refresh([bbs.name]).catch(e => this.log(`board objects: ${(e as Error).message}`));
        }, wait);
        timer.unref?.();
        this.soon.set(bbs.name, timer);
    }

    private async read(only?: string[]): Promise<void> {
        const bbses = this.deps.list();
        const registered = new Set(bbses.map(b => b.name));
        this.drop(o => !registered.has(o.bbs));
        for (const [key, at] of this.failed) {
            if (this.now() - at >= RetryMs) {
                this.failed.delete(key);
            }
        }
        for (const bbs of bbses.filter(b => !only || only.includes(b.name))) {
            await this.readOne(bbs);
        }
        this.prune();
    }

    private async readOne(bbs: Bbs): Promise<void> {
        if (!this.allowed(bbs)) {
            this.drop(o => o.bbs === bbs.name);
            return;
        }
        const at = this.deps.at;
        if (!at || !bbs.bbsDid || !this.deps.linked(bbs)) {
            return;
        }
        this.lastRead.set(bbs.name, this.now());
        const perOwner = this.settings.perOwner.objects;
        const listMax = perOwner + 100;
        let records: { rkey: string; cid: string; value: unknown }[];
        try {
            records = await at.listRecords(
                bbs.bbsDid,
                `${this.deps.config.directory.nsidPrefix}.object`,
                listMax
            );
        } catch (e) {
            this.log(`board objects: can't read ${bbs.name}'s records: ${(e as Error).message}`);
            return;
        }
        const published = new Map<string, { record: ObjectRecord; rkey: string; cid: string }>();
        let over = false;
        for (const entry of records) {
            if (!/^[A-Za-z0-9._:~-]{1,512}$/.test(entry.rkey)) {
                continue;
            }
            const record = objectRecordOf(
                entry.value,
                this.deps.config.directory.nsidPrefix,
                this.settings.minInterval
            );
            if (!record || this.isBlocked(record.program.sha256)) {
                continue;
            }
            if (published.size >= perOwner) {
                over = true;
                break;
            }
            published.set(keyOf(bbs.name, entry.rkey), { record, rkey: entry.rkey, cid: entry.cid });
        }
        if (over) {
            this.log(
                `board objects: ${bbs.name} publishes more than ${perOwner} objects; the rest are left out`
            );
        }
        //  an object whose record is gone is withdrawn; not when the listing
        //  was cut short, where it may only be further on
        if (records.length < listMax) {
            this.drop(o => o.bbs === bbs.name && !published.has(keyOf(o.bbs, o.rkey)));
        }
        for (const [key, { record, rkey, cid }] of published) {
            const sha = record.program.sha256;
            try {
                if (!this.programs.has(sha)) {
                    if (this.now() - (this.failed.get(sha) ?? -Infinity) < RetryMs) {
                        continue;
                    }
                    if (!this.settings.programs.includes(sha)) {
                        //  not vetted: not fetched, and said once an hour
                        this.failed.set(sha, this.now());
                        this.log(
                            `board objects: ${bbs.name}'s ${record.title} runs a program the hub hasn't vetted (${sha})`
                        );
                        continue;
                    }
                    await this.takeProgram(bbs, record.program.did, sha);
                }
                const kept = this.kept.get(key);
                if (kept?.cid !== cid) {
                    this.kept.set(key, {
                        bbs: bbs.name,
                        did: bbs.bbsDid,
                        rkey,
                        cid,
                        title: record.title,
                        program: sha,
                        input: record.input,
                        interval: record.interval,
                        look: record.look,
                    });
                    this.save();
                    this.log(`board objects: ${kept ? 'read again' : 'took'} ${bbs.name}'s ${record.title}`);
                }
            } catch (e) {
                this.failed.set(sha, this.now());
                this.log(`board objects: ${bbs.name}'s ${record.title} not taken: ${(e as Error).message}`);
            }
        }
    }

    //  Count |bytes| against what the BBS may have fetched this hour
    private spend(bbs: Bbs, bytes: number): void {
        const allowance = 2 * Math.max(1, this.settings.perOwner.objects) * (MaxModuleBytes + MaxSourceBytes);
        const now = this.now();
        let spent = this.fetchedIn.get(bbs.name);
        if (!spent || now - spent.since >= FetchWindowMs) {
            spent = { since: now, bytes: 0 };
            this.fetchedIn.set(bbs.name, spent);
        }
        if (spent.bytes + bytes > allowance) {
            throw new Error(`${bbs.name} has had the hub fetch ${spent.bytes} bytes this hour, its limit`);
        }
        spent.bytes += bytes;
    }

    //  A program, from the account that publishes it: its record, then its
    //  module and source, each checked against the hash the record names
    private async takeProgram(bbs: Bbs, did: string, sha256: string): Promise<void> {
        const at = this.deps.at!;
        if (this.deps.refused?.(did)) {
            throw new Error('the account publishing its program is refused on this hub');
        }
        const entry = await at.getRecord(did, `${this.deps.config.directory.nsidPrefix}.asset.item`, sha256);
        const record = entry ? programRecordOf(sha256, entry.value) : null;
        if (!entry || !record) {
            throw new Error('its program has no record the hub can read');
        }
        if (this.isBlocked(record.source.sha256)) {
            throw new Error("its program's source is blocked on this hub");
        }
        this.spend(bbs, record.module.size + record.source.size);
        const module = await at.getBlob(did, record.module.cid, MaxModuleBytes);
        if (module.length !== record.module.size || sha256Of(module) !== sha256) {
            throw new Error("the program isn't the module its record names");
        }
        const checked = checkProgram(module, {
            moduleBytes: MaxModuleBytes,
            memoryPages: this.settings.perStep.memoryPages,
        });
        const source = await at.getBlob(did, record.source.cid, MaxSourceBytes);
        if (source.length !== record.source.size || sha256Of(source) !== record.source.sha256) {
            throw new Error("the program's source isn't the file its record names");
        }
        try {
            new TextDecoder('utf-8', { fatal: true }).decode(source);
        } catch {
            throw new Error("the program's source is not UTF-8 text");
        }
        this.write(sha256, module);
        this.write(record.source.sha256, source);
        this.checked.set(sha256, checked);
        this.programs.set(sha256, {
            sha256,
            did,
            cid: entry.cid,
            name: record.name,
            licence: record.licence,
            credit: record.credit,
            description: record.description,
            fetch: record.fetch,
            values: record.values,
            dataCredit: record.dataCredit,
            source: record.source.sha256,
            bytes: module.length + source.length,
        });
        this.save();
        this.log(
            `board objects: took the program ${record.name} (${sha256.slice(0, 12)}, ${module.length} bytes)`
        );
    }

    //  Forget the objects |which| picks; prune() then lets go of programs
    //  no object uses, and their files
    drop(which: (o: KeptObject) => boolean): void {
        const gone = [...this.kept.entries()].filter(([, o]) => which(o));
        if (!gone.length) {
            return;
        }
        for (const [key] of gone) {
            this.kept.delete(key);
        }
        this.save();
        this.log(`board objects: let go of ${gone.map(([, o]) => `${o.bbs}'s ${o.title}`).join(', ')}`);
    }

    prune(): void {
        const used = new Set([...this.kept.values()].map(o => o.program));
        let changed = false;
        for (const sha of [...this.programs.keys()]) {
            if (!used.has(sha)) {
                this.programs.delete(sha);
                this.checked.delete(sha);
                changed = true;
            }
        }
        if (changed) {
            this.save();
        }
        const files = new Set([...this.programs.values()].flatMap(p => [p.sha256, p.source]));
        for (const name of readdirSync(join(this.dir, 'files'))) {
            if (!files.has(name)) {
                rmSync(join(this.dir, 'files', name), { force: true });
            }
        }
    }

    private write(sha256: string, body: Buffer): void {
        const path = join(this.dir, 'files', sha256);
        writeFileSync(`${path}.new`, body);
        renameSync(`${path}.new`, path);
    }

    private save(): void {
        const write = (name: string, value: unknown) => {
            const path = join(this.dir, name);
            writeFileSync(`${path}.new`, JSON.stringify(value, null, 2) + '\n');
            renameSync(`${path}.new`, path);
        };
        write('programs.json', [...this.programs.values()]);
        write('objects.json', [...this.kept.values()]);
    }
}

const keyOf = (bbs: string, rkey: string) => `${bbs}:${rkey}`;
const sha256Of = (body: Buffer) => createHash('sha256').update(body).digest('hex');
