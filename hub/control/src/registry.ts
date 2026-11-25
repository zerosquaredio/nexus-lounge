//  The BBS registry (hub plan H3, the admin CLI part): who may run a tunnel
//  for which name. SQLite, shared by the server and the admin CLI, so
//  changes take effect at once without a restart.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { HubError } from './errors.ts';
import { hashToken, newToken, tokenMatches } from './tokens.ts';
import { isDid, nameProblem } from './rules.ts';

export type BbsState = 'active' | 'suspended';

export interface Bbs {
    name: string;
    sysopDid: string;
    bbsDid: string | null;
    state: BbsState;
    createdAt: string;
    webPort: number;
    wsPort: number;
    //  observed through the tunnel's hooks (H6 refines this)
    connected: boolean;
    lastConnectedAt: string | null;
    lastDisconnectedAt: string | null;
}

interface BbsRow {
    name: string;
    sysop_did: string;
    bbs_did: string | null;
    state: BbsState;
    token_hash: string;
    created_at: string;
    web_port: number;
    ws_port: number;
    last_connected_at: string | null;
    last_disconnected_at: string | null;
    open_proxies: number;
}

const SchemaVersion = 7;

const Schema = `
CREATE TABLE IF NOT EXISTS bbs (
    name                 TEXT PRIMARY KEY,
    sysop_did            TEXT NOT NULL,
    bbs_did              TEXT,
    state                TEXT NOT NULL DEFAULT 'active'
                              CHECK (state IN ('active', 'suspended')),
    token_hash           TEXT NOT NULL,
    created_at           TEXT NOT NULL,
    --  where the BBS's web and WebSocket servers listen on its own machine,
    --  for its agent config (schema 2)
    web_port             INTEGER NOT NULL DEFAULT 8080,
    ws_port              INTEGER NOT NULL DEFAULT 8810,
    last_connected_at    TEXT,
    last_disconnected_at TEXT
);
CREATE INDEX IF NOT EXISTS bbs_by_sysop ON bbs (sysop_did);
CREATE UNIQUE INDEX IF NOT EXISTS bbs_by_did ON bbs (bbs_did) WHERE bbs_did IS NOT NULL;

--  proxies the tunnel server has opened for a BBS, from its hooks
CREATE TABLE IF NOT EXISTS tunnel_proxy (
    name       TEXT NOT NULL REFERENCES bbs (name) ON DELETE CASCADE,
    proxy      TEXT NOT NULL,
    run_id     TEXT,
    opened_at  TEXT NOT NULL,
    PRIMARY KEY (name, proxy)
);

--  the hub's own web sign-in (schema 2): AT OAuth flows in progress, AT
--  sessions (kept only while signing in), and browser sessions
CREATE TABLE IF NOT EXISTS oauth_state (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_session (
    did        TEXT PRIMARY KEY,
    value      TEXT NOT NULL
);
--  the directory (schema 3): listings and status from the AT network,
--  sanitized; accounts the hub admin hid; the stream's place
CREATE TABLE IF NOT EXISTS directory_entry (
    did         TEXT PRIMARY KEY,
    listing     TEXT NOT NULL,
    listing_cid TEXT NOT NULL,
    status      TEXT,
    status_cid  TEXT,
    updated_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS directory_hidden (
    did       TEXT PRIMARY KEY,
    reason    TEXT NOT NULL DEFAULT '',
    hidden_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS directory_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
--  the hub's own AT account (schema 4): which account it is, and its AT
--  session, kept apart from the sessions of people signing in
CREATE TABLE IF NOT EXISTS hub_account (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    did          TEXT NOT NULL,
    handle       TEXT,
    connected_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS hub_oauth_session (
    did        TEXT PRIMARY KEY,
    value      TEXT NOT NULL
);
--  observed status records the hub has published, one per BBS DID, from
--  the account named (schema 4)
CREATE TABLE IF NOT EXISTS observed_published (
    subject      TEXT PRIMARY KEY,
    account      TEXT NOT NULL,
    connected    INTEGER NOT NULL,
    since        TEXT NOT NULL,
    published_at TEXT NOT NULL
);
--  people signed in to the hub (schema 5): a small profile, created at
--  sign-in while the common space is on (profiles.ts)
CREATE TABLE IF NOT EXISTS profile (
    did          TEXT PRIMARY KEY,
    handle       TEXT,
    created_at   TEXT NOT NULL,
    signed_in_at TEXT NOT NULL,
    presence     INTEGER NOT NULL DEFAULT 0
);
--  what BBSes report about their members (schema 5, presence.ts): each
--  BBS's latest report replaces its rows. member is "did:<did>" or
--  "user:<local name, lower-case>"
CREATE TABLE IF NOT EXISTS bbs_member (
    bbs          TEXT NOT NULL REFERENCES bbs (name) ON DELETE CASCADE,
    member       TEXT NOT NULL,
    did          TEXT,
    name         TEXT NOT NULL,
    member_since TEXT NOT NULL,
    online       INTEGER NOT NULL,
    online_since TEXT,
    PRIMARY KEY (bbs, member)
);
CREATE INDEX IF NOT EXISTS bbs_member_did ON bbs_member (did);
CREATE TABLE IF NOT EXISTS bbs_report (
    bbs         TEXT PRIMARY KEY REFERENCES bbs (name) ON DELETE CASCADE,
    reported_at INTEGER NOT NULL
);
--  a person's answer, signed in at the hub, to a BBS saying they are a
--  member there: "confirmed" or "denied"
CREATE TABLE IF NOT EXISTS profile_bbs (
    did        TEXT NOT NULL,
    bbs        TEXT NOT NULL REFERENCES bbs (name) ON DELETE CASCADE,
    answer     TEXT NOT NULL,
    answered_at TEXT NOT NULL,
    PRIMARY KEY (did, bbs)
);
--  moderation of the common space (schema 6, moderation.ts): the hub
--  admin's blocks, each person's own mutes, reports with what was just said
--  in the room, and a record of what was done
CREATE TABLE IF NOT EXISTS space_block (
    id         INTEGER PRIMARY KEY,
    subject    TEXT NOT NULL,
    scope      TEXT NOT NULL CHECK (scope IN ('space', 'room')),
    reason     TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    until      INTEGER,
    lifted_at  TEXT
);
CREATE INDEX IF NOT EXISTS space_block_subject ON space_block (subject);
CREATE TABLE IF NOT EXISTS space_mute (
    did        TEXT NOT NULL,
    person     TEXT NOT NULL,
    label      TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (did, person)
);
CREATE TABLE IF NOT EXISTS space_report (
    id         INTEGER PRIMARY KEY,
    reporter   TEXT NOT NULL,
    person     TEXT NOT NULL,
    subject    TEXT,
    label      TEXT NOT NULL,
    note       TEXT NOT NULL,
    messages   TEXT NOT NULL,
    created_at TEXT NOT NULL,
    closed_at  TEXT,
    outcome    TEXT
);
CREATE TABLE IF NOT EXISTS moderation_log (
    id      INTEGER PRIMARY KEY,
    at      TEXT NOT NULL,
    action  TEXT NOT NULL,
    subject TEXT NOT NULL,
    detail  TEXT NOT NULL DEFAULT ''
);
--  DIDs banned from the hub (schema 7, hub plan H8): their BBSes are
--  suspended, and they can't register one, as sysop or as its own account
CREATE TABLE IF NOT EXISTS hub_ban (
    did       TEXT PRIMARY KEY,
    reason    TEXT NOT NULL DEFAULT '',
    banned_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS web_session (
    token_hash TEXT PRIMARY KEY,
    did        TEXT NOT NULL,
    handle     TEXT,
    created_at TEXT NOT NULL,
    expires_at INTEGER NOT NULL
);
`;

const SelectBbs = `
SELECT b.*, (SELECT COUNT(*) FROM tunnel_proxy p WHERE p.name = b.name) AS open_proxies
FROM bbs b`;

function toBbs(row: BbsRow): Bbs {
    return {
        name: row.name,
        sysopDid: row.sysop_did,
        bbsDid: row.bbs_did,
        state: row.state,
        createdAt: row.created_at,
        webPort: row.web_port,
        wsPort: row.ws_port,
        connected: row.open_proxies > 0,
        lastConnectedAt: row.last_connected_at,
        lastDisconnectedAt: row.last_disconnected_at,
    };
}

export interface Ban {
    did: string;
    reason: string;
    bannedAt: string;
}

export interface RegistryOptions {
    reservedNames: readonly string[];
    maxBbsPerSysop: number;
    now?: () => Date;
}

export class Registry {
    db: DatabaseSync;
    options: RegistryOptions;
    now: () => Date;

    constructor(path: string, options: RegistryOptions) {
        if (':memory:' !== path) {
            mkdirSync(dirname(path), { recursive: true });
        }
        this.db = new DatabaseSync(path);
        this.options = options;
        this.now = options.now ?? (() => new Date());
        this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
        this.migrate();
    }

    migrate(): void {
        const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number };
        if (row.user_version > SchemaVersion) {
            throw new HubError(
                'schema',
                `The registry is from a newer hub (schema ${row.user_version}); this one knows ${SchemaVersion}`
            );
        }
        if (1 === row.user_version) {
            this.db.exec(
                'ALTER TABLE bbs ADD COLUMN web_port INTEGER NOT NULL DEFAULT 8080; ' +
                    'ALTER TABLE bbs ADD COLUMN ws_port INTEGER NOT NULL DEFAULT 8810;'
            );
        }
        this.db.exec(Schema);
        this.db.exec(`PRAGMA user_version = ${SchemaVersion}`);
    }

    close(): void {
        this.db.close();
    }

    stamp(): string {
        return this.now().toISOString();
    }

    get(name: string): Bbs | null {
        const row = this.db.prepare(`${SelectBbs} WHERE b.name = ?`).get(name) as BbsRow | undefined;
        return row ? toBbs(row) : null;
    }

    getByDid(did: string): Bbs | null {
        const row = this.db.prepare(`${SelectBbs} WHERE b.bbs_did = ?`).get(did) as BbsRow | undefined;
        return row ? toBbs(row) : null;
    }

    listForSysop(did: string): Bbs[] {
        return (
            this.db
                .prepare(`${SelectBbs} WHERE b.sysop_did = ? ORDER BY b.name`)
                .all(did) as unknown as BbsRow[]
        ).map(toBbs);
    }

    list(): Bbs[] {
        return (this.db.prepare(`${SelectBbs} ORDER BY b.name`).all() as unknown as BbsRow[]).map(toBbs);
    }

    mustGet(name: string): Bbs {
        const bbs = this.get(name);
        if (!bbs) {
            throw new HubError('not-found', `No BBS is registered as "${name}"`);
        }
        return bbs;
    }

    //  Register a BBS. Returns its token, which is not stored and can't be
    //  shown again (rotate it to get a new one).
    add(
        name: string,
        sysopDid: string,
        bbsDid: string | null = null,
        ports: { web?: number; ws?: number } = {}
    ): { bbs: Bbs; token: string } {
        for (const p of [ports.web, ports.ws]) {
            if (undefined !== p && (!Number.isInteger(p) || p < 1 || p > 65535)) {
                throw new HubError('bad-port', 'Ports are whole numbers from 1 to 65535');
            }
        }
        const problem = nameProblem(name, this.options.reservedNames);
        if (problem) {
            throw new HubError('bad-name', problem);
        }
        if (!isDid(sysopDid)) {
            throw new HubError('bad-did', `"${sysopDid}" is not a did:plc or did:web`);
        }
        if (null !== bbsDid && !isDid(bbsDid)) {
            throw new HubError('bad-did', `"${bbsDid}" is not a did:plc or did:web`);
        }
        for (const did of [sysopDid, bbsDid]) {
            if (did && this.ban(did)) {
                throw new HubError('banned', `${did} is banned from this hub`);
            }
        }
        if (this.get(name)) {
            throw new HubError('taken', `"${name}" is already registered`);
        }
        if (bbsDid && this.getByDid(bbsDid)) {
            throw new HubError('taken', `${bbsDid} is already registered for another BBS`);
        }
        const { count } = this.db
            .prepare('SELECT COUNT(*) AS count FROM bbs WHERE sysop_did = ?')
            .get(sysopDid) as { count: number };
        if (count >= this.options.maxBbsPerSysop) {
            throw new HubError(
                'limit',
                `${sysopDid} already has ${count} BBS(es); this hub allows ${this.options.maxBbsPerSysop}`
            );
        }
        const token = newToken();
        this.db
            .prepare(
                'INSERT INTO bbs (name, sysop_did, bbs_did, token_hash, created_at, web_port, ws_port) VALUES (?, ?, ?, ?, ?, ?, ?)'
            )
            .run(name, sysopDid, bbsDid, hashToken(token), this.stamp(), ports.web ?? 8080, ports.ws ?? 8810);
        return { bbs: this.mustGet(name), token };
    }

    //  The BBS a token belongs to, if it is registered and active
    authenticate(name: unknown, token: unknown): Bbs | null {
        if ('string' !== typeof name) {
            return null;
        }
        const row = this.db.prepare('SELECT token_hash, state FROM bbs WHERE name = ?').get(name) as
            { token_hash: string; state: BbsState } | undefined;
        if (!row || 'active' !== row.state || !tokenMatches(token, row.token_hash)) {
            return null;
        }
        return this.get(name);
    }

    rotateToken(name: string): string {
        this.mustGet(name);
        const token = newToken();
        this.db.prepare('UPDATE bbs SET token_hash = ? WHERE name = ?').run(hashToken(token), name);
        return token;
    }

    setState(name: string, state: BbsState): Bbs {
        const bbs = this.mustGet(name);
        const banned = 'active' === state ? this.banOf(bbs) : null;
        if (banned) {
            throw new HubError('banned', `${banned.did} is banned from this hub; unban it first`);
        }
        this.db.prepare('UPDATE bbs SET state = ? WHERE name = ?').run(state, name);
        return this.mustGet(name);
    }

    setBbsDid(name: string, did: string | null): Bbs {
        this.mustGet(name);
        if (null !== did) {
            if (!isDid(did)) {
                throw new HubError('bad-did', `"${did}" is not a did:plc or did:web`);
            }
            if (this.ban(did)) {
                throw new HubError('banned', `${did} is banned from this hub`);
            }
            const other = this.getByDid(did);
            if (other && other.name !== name) {
                throw new HubError('taken', `${did} is already registered for "${other.name}"`);
            }
        }
        this.db.prepare('UPDATE bbs SET bbs_did = ? WHERE name = ?').run(did, name);
        return this.mustGet(name);
    }

    //  Ban a DID from the hub: every BBS it runs, or that is its own
    //  account, is suspended (so their tunnels are cut), and it can't
    //  register another. Returns the BBSes suspended now.
    banDid(did: string, reason = ''): { ban: Ban; suspended: string[] } {
        if (!isDid(did)) {
            throw new HubError('bad-did', `"${did}" is not a did:plc or did:web`);
        }
        const suspended = this.bbsesOf(did)
            .filter(b => 'active' === b.state)
            .map(b => b.name);
        this.db
            .prepare(
                'INSERT INTO hub_ban (did, reason, banned_at) VALUES (?, ?, ?) ' +
                    'ON CONFLICT (did) DO UPDATE SET reason = excluded.reason'
            )
            .run(did, reason.slice(0, 300), this.stamp());
        for (const name of suspended) {
            this.db.prepare("UPDATE bbs SET state = 'suspended' WHERE name = ?").run(name);
        }
        return { ban: this.ban(did) as Ban, suspended };
    }

    //  Lift a ban. Its BBSes stay suspended until each is resumed.
    unbanDid(did: string): Ban {
        const ban = this.ban(did);
        if (!ban) {
            throw new HubError('not-found', `${did} is not banned`);
        }
        this.db.prepare('DELETE FROM hub_ban WHERE did = ?').run(did);
        return ban;
    }

    ban(did: string): Ban | null {
        const row = this.db.prepare('SELECT * FROM hub_ban WHERE did = ?').get(did) as
            { did: string; reason: string; banned_at: string } | undefined;
        return row ? { did: row.did, reason: row.reason, bannedAt: row.banned_at } : null;
    }

    bans(): Ban[] {
        return (
            this.db.prepare('SELECT * FROM hub_ban ORDER BY banned_at, rowid').all() as unknown as {
                did: string;
                reason: string;
                banned_at: string;
            }[]
        ).map(r => ({ did: r.did, reason: r.reason, bannedAt: r.banned_at }));
    }

    //  The ban, if any, on a BBS's sysop or its own account
    banOf(bbs: Bbs): Ban | null {
        return this.ban(bbs.sysopDid) ?? (bbs.bbsDid ? this.ban(bbs.bbsDid) : null);
    }

    //  BBSes a DID runs, or that are its own account
    bbsesOf(did: string): Bbs[] {
        return (
            this.db
                .prepare(`${SelectBbs} WHERE b.sysop_did = ? OR b.bbs_did = ? ORDER BY b.name`)
                .all(did, did) as unknown as BbsRow[]
        ).map(toBbs);
    }

    remove(name: string): void {
        this.mustGet(name);
        this.db.prepare('DELETE FROM bbs WHERE name = ?').run(name);
    }

    //  Tunnel bookkeeping, from the tunnel server's hooks. A BBS is
    //  connected while it has any proxy open.
    proxyOpened(name: string, proxy: string, runId: string | null): void {
        const before = this.openProxies(name);
        this.db
            .prepare(
                'INSERT OR REPLACE INTO tunnel_proxy (name, proxy, run_id, opened_at) VALUES (?, ?, ?, ?)'
            )
            .run(name, proxy, runId, this.stamp());
        if (0 === before) {
            this.db.prepare('UPDATE bbs SET last_connected_at = ? WHERE name = ?').run(this.stamp(), name);
        }
    }

    proxyClosed(name: string, proxy: string): void {
        const { changes } = this.db
            .prepare('DELETE FROM tunnel_proxy WHERE name = ? AND proxy = ?')
            .run(name, proxy);
        if (changes > 0 && 0 === this.openProxies(name)) {
            this.db.prepare('UPDATE bbs SET last_disconnected_at = ? WHERE name = ?').run(this.stamp(), name);
        }
    }

    //  The tunnel server's own view, from its admin API: forget proxies it
    //  no longer has (its hooks can't report a close when it restarts or
    //  crashes). Only proxies opened before |openedBefore| are forgotten:
    //  a proxy is approved before the tunnel server lists it, so one opened
    //  as the list was being read may not be in it yet.
    reconcileProxies(online: ReadonlySet<string>, openedBefore: string): string[] {
        const rows = this.db
            .prepare('SELECT name, proxy FROM tunnel_proxy WHERE opened_at < ?')
            .all(openedBefore) as { name: string; proxy: string }[];
        const closed: string[] = [];
        for (const row of rows) {
            if (!online.has(row.proxy)) {
                this.proxyClosed(row.name, row.proxy);
                closed.push(`${row.name}/${row.proxy}`);
            }
        }
        return closed;
    }

    //  The tunnel server isn't running: no BBS is connected
    closeAllProxies(): string[] {
        const rows = this.db.prepare('SELECT name, proxy FROM tunnel_proxy').all() as {
            name: string;
            proxy: string;
        }[];
        for (const row of rows) {
            this.proxyClosed(row.name, row.proxy);
        }
        return rows.map(row => `${row.name}/${row.proxy}`);
    }

    openProxies(name: string): number {
        const { count } = this.db
            .prepare('SELECT COUNT(*) AS count FROM tunnel_proxy WHERE name = ?')
            .get(name) as { count: number };
        return count;
    }
}
