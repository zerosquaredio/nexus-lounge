//  Usage trends (hub plan H8): a summary kept for the long view, after the
//  logs are gone. One row a day for the hub, and one a day for each BBS, by
//  name. Counts and totals only: no DIDs, nothing anyone said, no addresses.
//
//  Fed from the tunnel check (every 15 seconds, by default): frps's own
//  traffic counters for each proxy, which reset when frps restarts and at
//  midnight, so what's added is how much each grew since the last look.

import type { Registry } from './registry.ts';

//  What frps's admin API says of a proxy (GET /api/proxy/http)
export interface ProxyStats {
    name?: unknown;
    user?: unknown;
    status?: unknown;
    todayTrafficIn?: unknown;
    todayTrafficOut?: unknown;
    curConns?: unknown;
}

export interface UsageDay {
    day: string;
    bbsRegistered: number;
    bbsActive: number;
    bbsConnectedPeak: number;
    people: number;
    presenceOn: number;
    signedIn: number;
    livePeak: number;
    chatPeak: number;
    reports: number;
    blocks: number;
}

export interface UsageBbsDay {
    day: string;
    bbs: string;
    connectedSeconds: number;
    bytesIn: number;
    bytesOut: number;
    connsPeak: number;
}

interface DayRow {
    day: string;
    bbs_registered: number;
    bbs_active: number;
    bbs_connected_peak: number;
    people: number;
    presence_on: number;
    signed_in: number;
    live_peak: number;
    chat_peak: number;
    reports: number;
    blocks: number;
}

interface BbsDayRow {
    day: string;
    bbs: string;
    connected_seconds: number;
    bytes_in: number;
    bytes_out: number;
    conns_peak: number;
}

//  A sample longer than this after the last (the control plane was stopped,
//  or the machine slept) counts only this much connected time
const MaxStepMs = 2 * 60 * 1000;

const num = (v: unknown): number => ('number' === typeof v && Number.isFinite(v) && v >= 0 ? v : 0);

export class Usage {
    registry: Registry;
    now: () => Date;
    //  each proxy's counters at the last look
    last = new Map<string, { in: number; out: number }>();
    lastSample: number | null = null;

    constructor(registry: Registry, now: () => Date = () => new Date()) {
        this.registry = registry;
        this.now = now;
    }

    day(at = this.now()): string {
        return at.toISOString().slice(0, 10);
    }

    //  frps's proxies: add each BBS's traffic since the last look, and note
    //  its most connections at once
    traffic(proxies: readonly ProxyStats[]): void {
        const day = this.day();
        const known = new Set(this.registry.list().map(b => b.name));
        const seen = new Set<string>();
        const add = this.registry.db.prepare(
            `INSERT INTO usage_bbs_day (day, bbs, bytes_in, bytes_out, conns_peak) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (day, bbs) DO UPDATE SET bytes_in = bytes_in + excluded.bytes_in,
                bytes_out = bytes_out + excluded.bytes_out,
                conns_peak = MAX(conns_peak, excluded.conns_peak)`
        );
        const conns = new Map<string, number>();
        const bytes = new Map<string, { in: number; out: number }>();
        for (const p of proxies) {
            if ('string' !== typeof p.name) {
                continue;
            }
            const bbs = 'string' === typeof p.user && p.user ? p.user : p.name.split('.')[0];
            if (!bbs || !known.has(bbs)) {
                continue;
            }
            seen.add(p.name);
            const now = { in: num(p.todayTrafficIn), out: num(p.todayTrafficOut) };
            const before = this.last.get(p.name);
            this.last.set(p.name, now);
            //  the first look only sets where counting starts
            const grew = before
                ? {
                      in: now.in >= before.in ? now.in - before.in : now.in,
                      out: now.out >= before.out ? now.out - before.out : now.out,
                  }
                : { in: 0, out: 0 };
            const sum = bytes.get(bbs) ?? { in: 0, out: 0 };
            bytes.set(bbs, { in: sum.in + grew.in, out: sum.out + grew.out });
            if ('online' === p.status) {
                conns.set(bbs, (conns.get(bbs) ?? 0) + num(p.curConns));
            }
        }
        for (const name of [...this.last.keys()]) {
            if (!seen.has(name)) {
                this.last.delete(name);
            }
        }
        for (const [bbs, b] of bytes) {
            add.run(day, bbs, b.in, b.out, conns.get(bbs) ?? 0);
        }
    }

    //  The hub's counts now, and each connected BBS's time since the last
    //  sample
    sample(counts: { live?: number; chat?: number } = {}): void {
        const at = this.now();
        const day = this.day(at);
        const db = this.registry.db;
        const step =
            null === this.lastSample ? 0 : Math.min(MaxStepMs, Math.max(0, at.getTime() - this.lastSample));
        this.lastSample = at.getTime();

        const bbses = this.registry.list();
        if (step > 0) {
            const add = db.prepare(
                `INSERT INTO usage_bbs_day (day, bbs, connected_seconds) VALUES (?, ?, ?)
                 ON CONFLICT (day, bbs) DO UPDATE SET connected_seconds = connected_seconds + excluded.connected_seconds`
            );
            for (const b of bbses.filter(b => b.connected)) {
                add.run(day, b.name, step / 1000);
            }
        }
        const count = (sql: string, ...args: string[]) => (db.prepare(sql).get(...args) as { n: number }).n;
        const row = {
            registered: bbses.length,
            active: bbses.filter(b => 'active' === b.state).length,
            connected: bbses.filter(b => b.connected).length,
            people: count('SELECT COUNT(*) AS n FROM profile'),
            presence: count('SELECT COUNT(*) AS n FROM profile WHERE presence = 1'),
            signedIn: count('SELECT COUNT(*) AS n FROM profile WHERE signed_in_at >= ?', day),
            live: num(counts.live),
            chat: num(counts.chat),
            reports: count(
                "SELECT COUNT(*) AS n FROM moderation_log WHERE action IN ('report', 'abuse-report') AND at >= ?",
                day
            ),
            blocks: count("SELECT COUNT(*) AS n FROM moderation_log WHERE action = 'block' AND at >= ?", day),
        };
        db.prepare(
            `INSERT INTO usage_day (day, bbs_registered, bbs_active, bbs_connected_peak, people, presence_on,
                signed_in, live_peak, chat_peak, reports, blocks) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (day) DO UPDATE SET bbs_registered = excluded.bbs_registered,
                bbs_active = excluded.bbs_active,
                bbs_connected_peak = MAX(bbs_connected_peak, excluded.bbs_connected_peak),
                people = excluded.people, presence_on = excluded.presence_on,
                signed_in = MAX(signed_in, excluded.signed_in),
                live_peak = MAX(live_peak, excluded.live_peak), chat_peak = MAX(chat_peak, excluded.chat_peak),
                reports = MAX(reports, excluded.reports), blocks = MAX(blocks, excluded.blocks)`
        ).run(
            day,
            row.registered,
            row.active,
            row.connected,
            row.people,
            row.presence,
            row.signedIn,
            row.live,
            row.chat,
            row.reports,
            row.blocks
        );
    }

    //  The last `days` days, oldest first
    days(days = 14): { hub: UsageDay[]; bbses: UsageBbsDay[] } {
        const from = this.day(new Date(this.now().getTime() - (days - 1) * 24 * 60 * 60 * 1000));
        const db = this.registry.db;
        const hub = (
            db.prepare('SELECT * FROM usage_day WHERE day >= ? ORDER BY day').all(from) as unknown as DayRow[]
        ).map(r => ({
            day: r.day,
            bbsRegistered: r.bbs_registered,
            bbsActive: r.bbs_active,
            bbsConnectedPeak: r.bbs_connected_peak,
            people: r.people,
            presenceOn: r.presence_on,
            signedIn: r.signed_in,
            livePeak: r.live_peak,
            chatPeak: r.chat_peak,
            reports: r.reports,
            blocks: r.blocks,
        }));
        const bbses = (
            db
                .prepare('SELECT * FROM usage_bbs_day WHERE day >= ? ORDER BY day, bbs')
                .all(from) as unknown as BbsDayRow[]
        ).map(r => ({
            day: r.day,
            bbs: r.bbs,
            connectedSeconds: r.connected_seconds,
            bytesIn: r.bytes_in,
            bytesOut: r.bytes_out,
            connsPeak: r.conns_peak,
        }));
        return { hub, bbses };
    }
}

//  "1.2 MB", for people
export function sizeText(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let n = bytes;
    let i = 0;
    while (n >= 1024 && i < units.length - 1) {
        n /= 1024;
        i++;
    }
    return `${i ? n.toFixed(1) : n} ${units[i]}`;
}
