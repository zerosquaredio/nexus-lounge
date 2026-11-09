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
    last_connected_at: string | null;
    last_disconnected_at: string | null;
    open_proxies: number;
}

const SchemaVersion = 1;

const Schema = `
CREATE TABLE IF NOT EXISTS bbs (
    name                 TEXT PRIMARY KEY,
    sysop_did            TEXT NOT NULL,
    bbs_did              TEXT,
    state                TEXT NOT NULL DEFAULT 'active'
                              CHECK (state IN ('active', 'suspended')),
    token_hash           TEXT NOT NULL,
    created_at           TEXT NOT NULL,
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
        connected: row.open_proxies > 0,
        lastConnectedAt: row.last_connected_at,
        lastDisconnectedAt: row.last_disconnected_at,
    };
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
    add(name: string, sysopDid: string, bbsDid: string | null = null): { bbs: Bbs; token: string } {
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
                'INSERT INTO bbs (name, sysop_did, bbs_did, token_hash, created_at) VALUES (?, ?, ?, ?, ?)'
            )
            .run(name, sysopDid, bbsDid, hashToken(token), this.stamp());
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
        this.mustGet(name);
        this.db.prepare('UPDATE bbs SET state = ? WHERE name = ?').run(state, name);
        return this.mustGet(name);
    }

    setBbsDid(name: string, did: string | null): Bbs {
        this.mustGet(name);
        if (null !== did) {
            if (!isDid(did)) {
                throw new HubError('bad-did', `"${did}" is not a did:plc or did:web`);
            }
            const other = this.getByDid(did);
            if (other && other.name !== name) {
                throw new HubError('taken', `${did} is already registered for "${other.name}"`);
            }
        }
        this.db.prepare('UPDATE bbs SET bbs_did = ? WHERE name = ?').run(did, name);
        return this.mustGet(name);
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

    openProxies(name: string): number {
        const { count } = this.db
            .prepare('SELECT COUNT(*) AS count FROM tunnel_proxy WHERE name = ?')
            .get(name) as { count: number };
        return count;
    }
}
