//  Observed status (hub plan H6; publishing spec §3.3): what the hub sees of
//  each BBS's tunnel, published from the hub's own AT account, so anyone
//  can tell a BBS is down even when the BBS can't say so itself.
//
//  One record per BBS, in the hub's repo, its key the BBS's DID:
//    { subject: <BBS DID>, connected: <bool>, since: <when it last changed> }
//
//  Two parts:
//  - checkTunnels: asks the tunnel server which proxies are really up, and
//    forgets the ones it no longer has. Its hooks report agents coming and
//    going at once (spike, 2026-11-17: a killed agent's close arrived in
//    1 ms), but not the tunnel server itself restarting or crashing.
//  - ObservedStatus.publish: writes a BBS's record when its state has
//    changed and held for settleSeconds, so a tunnel that drops and comes
//    straight back writes nothing.

import { FrpsAdminPasswordEnv } from './config.ts';
import type { Registry, Bbs } from './registry.ts';
import { observedStatusType, XrpcError, type RecordWriter } from './hub_account.ts';

type Log = (line: string) => void;

//  ---- the tunnel server's own view ----

//  Proxies approved within this long of asking may not be listed yet
export const ListingGraceMs = 10 * 1000;

export type TunnelCheck = 'ok' | 'down' | 'error';

export interface TunnelCheckOptions {
    port: number;
    password: string;
    fetch?: typeof fetch;
    now?: () => Date;
    timeoutMs?: number;
    //  given the tunnel server's proxies, with their traffic (usage trends)
    onProxies?: (proxies: readonly Record<string, unknown>[]) => void;
}

export async function checkTunnels(
    registry: Registry,
    options: TunnelCheckOptions,
    log: Log
): Promise<TunnelCheck> {
    const doFetch = options.fetch ?? fetch;
    const asked = (options.now ?? (() => new Date()))();
    const openedBefore = new Date(asked.getTime() - ListingGraceMs).toISOString();
    let resp: Response;
    try {
        resp = await doFetch(`http://127.0.0.1:${options.port}/api/proxy/http`, {
            headers: { Authorization: `Basic ${Buffer.from(`hub:${options.password}`).toString('base64')}` },
            signal: AbortSignal.timeout(options.timeoutMs ?? 5000),
        });
    } catch (e) {
        //  nothing listening: the tunnel server is down, so no BBS is
        //  connected. A timeout says less, so it changes nothing.
        const cause = (e as { cause?: { code?: string } }).cause;
        if ('ECONNREFUSED' === cause?.code) {
            const closed = registry.closeAllProxies();
            if (closed.length) {
                log(`tunnels: the tunnel server isn't running; closed ${closed.join(', ')}`);
            }
            return 'down';
        }
        log(`tunnels: couldn't ask the tunnel server: ${(e as Error).message}`);
        return 'error';
    }
    if (!resp.ok) {
        log(
            `tunnels: the tunnel server's admin API said ${resp.status}; is ${FrpsAdminPasswordEnv} the same for both?`
        );
        return 'error';
    }
    let body: unknown;
    try {
        body = await resp.json();
    } catch {
        log("tunnels: the tunnel server's admin API sent something that isn't JSON");
        return 'error';
    }
    const proxies = (body as { proxies?: unknown }).proxies;
    if (!Array.isArray(proxies)) {
        log("tunnels: the tunnel server's admin API sent no proxy list");
        return 'error';
    }
    options.onProxies?.(proxies.filter(p => p && 'object' === typeof p));
    const online = new Set<string>();
    for (const p of proxies) {
        const { name, status } = (p ?? {}) as { name?: unknown; status?: unknown };
        if ('string' === typeof name && 'online' === status) {
            online.add(name);
        }
    }
    const closed = registry.reconcileProxies(online, openedBefore);
    if (closed.length) {
        log(`tunnels: the tunnel server no longer has ${closed.join(', ')}; closed`);
    }
    return 'ok';
}

//  ---- publishing ----

//  Record keys may hold these characters only (AT record key syntax)
const RkeyRe = /^[A-Za-z0-9._:~-]{1,512}$/;

export interface Observation {
    name: string;
    subject: string;
    connected: boolean;
    since: string;
}

interface Published {
    subject: string;
    account: string;
    connected: number;
    since: string;
    published_at: string;
}

export interface PublishResult {
    written: string[];
    removed: string[];
    //  changed, but not yet held for settleSeconds
    settling: string[];
    failed: string[];
}

export interface ObservedStatusOptions {
    nsidPrefix: string;
    settleMs: number;
    //  writes per run at most; the rest follow on the next runs
    maxWrites?: number;
    now?: () => Date;
}

//  What the hub sees of a BBS now, and since when
export function observe(bbs: Bbs): Observation | null {
    if (!bbs.bbsDid || !RkeyRe.test(bbs.bbsDid)) {
        return null;
    }
    const since = bbs.connected
        ? (bbs.lastConnectedAt ?? bbs.createdAt)
        : (bbs.lastDisconnectedAt ?? bbs.createdAt);
    return { name: bbs.name, subject: bbs.bbsDid, connected: bbs.connected, since };
}

export class ObservedStatus {
    registry: Registry;
    writer: RecordWriter;
    options: Required<ObservedStatusOptions>;
    log: Log;
    noAccountLogged = false;

    constructor(registry: Registry, writer: RecordWriter, options: ObservedStatusOptions, log: Log) {
        this.registry = registry;
        this.writer = writer;
        this.options = { maxWrites: 10, now: () => new Date(), ...options };
        this.log = log;
    }

    get collection(): string {
        return observedStatusType(this.options.nsidPrefix);
    }

    published(): Map<string, Published> {
        const rows = this.registry.db
            .prepare('SELECT * FROM observed_published')
            .all() as unknown as Published[];
        return new Map(rows.map(r => [r.subject, r]));
    }

    //  Each BBS with a DID: what the hub sees, and what it last published
    report(): { observation: Observation; published: Published | null }[] {
        const published = this.published();
        return this.registry
            .list()
            .map(observe)
            .filter((o): o is Observation => null !== o)
            .map(observation => ({ observation, published: published.get(observation.subject) ?? null }));
    }

    async publish(): Promise<PublishResult> {
        const result: PublishResult = { written: [], removed: [], settling: [], failed: [] };
        const account = this.writer.did();
        if (!account) {
            if (!this.noAccountLogged) {
                this.log(
                    'observed status: no hub account connected ("hub-account connect"); nothing published'
                );
                this.noAccountLogged = true;
            }
            return result;
        }
        this.noAccountLogged = false;
        const db = this.registry.db;
        //  records published from another account can't be changed from
        //  this one: start afresh
        db.prepare('DELETE FROM observed_published WHERE account <> ?').run(account);

        const now = this.options.now();
        const published = this.published();
        const observations = this.registry
            .list()
            .map(observe)
            .filter((o): o is Observation => null !== o);
        const seen = new Set(observations.map(o => o.subject));
        let writes = 0;
        const stamp = () => this.options.now().toISOString();

        for (const o of observations) {
            const before = published.get(o.subject);
            if (before && Boolean(before.connected) === o.connected) {
                continue;
            }
            if (now.getTime() - Date.parse(o.since) < this.options.settleMs) {
                result.settling.push(o.name);
                continue;
            }
            if (writes >= this.options.maxWrites) {
                continue;
            }
            writes++;
            try {
                await this.writer.putRecord(this.collection, o.subject, {
                    $type: this.collection,
                    subject: o.subject,
                    connected: o.connected,
                    since: o.since,
                });
                db.prepare(
                    'INSERT OR REPLACE INTO observed_published (subject, account, connected, since, published_at) VALUES (?, ?, ?, ?, ?)'
                ).run(o.subject, account, Number(o.connected), o.since, stamp());
                result.written.push(o.name);
                this.log(
                    `observed status: ${o.name} ${o.connected ? 'connected' : 'disconnected'} since ${o.since}`
                );
            } catch (e) {
                result.failed.push(o.name);
                this.log(`observed status: publishing ${o.name} failed: ${(e as Error).message}`);
                if (e instanceof XrpcError && 429 === e.status) {
                    return result;
                }
            }
        }

        //  BBSes removed from the hub, or whose DID changed: take their
        //  records down
        for (const subject of published.keys()) {
            if (seen.has(subject) || writes >= this.options.maxWrites) {
                continue;
            }
            writes++;
            try {
                await this.writer.deleteRecord(this.collection, subject);
                db.prepare('DELETE FROM observed_published WHERE subject = ?').run(subject);
                result.removed.push(subject);
                this.log(`observed status: removed the record for ${subject}`);
            } catch (e) {
                result.failed.push(subject);
                this.log(
                    `observed status: removing the record for ${subject} failed: ${(e as Error).message}`
                );
            }
        }
        return result;
    }
}
