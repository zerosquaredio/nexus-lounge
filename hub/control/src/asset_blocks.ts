//  Files blocked on the hub (assets spec §9): the admin blocks one by its
//  hash ("hubctl asset block"), and the hub neither shows, serves nor takes
//  it again, nor any copy with the same bytes, nor the piece it belongs to.
//  Blocks are written by the admin's command line and read by the running
//  hub, which looks again every half a minute (refresh()).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Library, LibraryItem } from './bake.ts';
import { HubError } from './errors.ts';
import { Moderation } from './moderation.ts';
import { isDid } from './rules.ts';

export const MaxBlockReason = 300;

export interface AssetBlock {
    sha256: string;
    reason: string;
    blockedAt: string;
}

export function isSha256(value: string): boolean {
    return /^[0-9a-f]{64}$/.test(value);
}

//  A piece of art on the hub, for the admin's list: whose it is, and its
//  files by hash (the first is its id, the cleaned ANSI)
export interface ArtOnHub {
    owner: string;
    name: string;
    id: string;
    files: string[];
}

//  The art in the hub's own library (assets.library) and what it took from
//  BBSes (board-art/), as their files on disk say. Either may be missing.
export function artOnHub(dirs: {
    library: string;
    boardArt: string;
    pictures?: string;
    boardModels?: string;
}): ArtOnHub[] {
    const read = (path: string): unknown => {
        try {
            return JSON.parse(readFileSync(path, 'utf8'));
        } catch {
            return null;
        }
    };
    const items = (dir: string) => {
        const library = dir ? (read(join(dir, 'library.json')) as Library | null) : null;
        return Array.isArray(library?.items) ? library.items : [];
    };
    const filesOf = (item: LibraryItem) => [
        item.id,
        ...item.record.versions.map(v => v.file.sha256).filter(hash => hash !== item.id),
    ];
    const out: ArtOnHub[] = items(dirs.library).map(item => ({
        owner: "the hub's library",
        name: String(item.record.name),
        id: item.id,
        files: filesOf(item),
    }));
    //  each BBS's: "splash:coolbbs", "emblem:coolbbs", "piece:coolbbs:<sha>"
    const kept = (read(join(dirs.boardArt, 'boards.json')) ?? {}) as Record<string, { id: string }>;
    for (const item of items(dirs.boardArt)) {
        const owners = Object.entries(kept)
            .filter(([, k]) => k.id === item.id)
            .map(([key]) => {
                const [kind, name] = key.includes(':') ? key.split(':') : ['splash', key];
                return `${name}'s ${'piece' === kind ? 'art' : kind}`;
            });
        out.push({
            owner: owners.join(', ') || '(nobody now)',
            name: String(item.record.name),
            id: item.id,
            files: filesOf(item),
        });
    }
    //  the 3D models BBSes publish (board_models.ts): the model as served,
    //  its preview, and the model as the BBS published it
    const models = (dirs.boardModels ? read(join(dirs.boardModels, 'models.json')) : null) as
        | { bbs: string; name: string; id: string; preview: string; raw: string }[]
        | null;
    for (const m of Array.isArray(models) ? models : []) {
        if (isSha256(String(m?.id))) {
            out.push({
                owner: `${m.bbs}'s model`,
                name: String(m.name),
                id: m.id,
                files: [m.id, m.preview, m.raw].filter((hash, i, all) => isSha256(String(hash)) && all.indexOf(hash) === i),
            });
        }
    }
    //  people's Bluesky pictures (pictures.ts): by DID
    const pictures = (dirs.pictures ? read(join(dirs.pictures, 'index.json')) : null) as Record<
        string,
        { sha256: string }
    > | null;
    for (const [did, k] of Object.entries(pictures ?? {})) {
        if (isSha256(String(k?.sha256))) {
            out.push({ owner: `${did}'s picture`, name: 'profile picture', id: k.sha256, files: [k.sha256] });
        }
    }
    return out;
}

//  A hash the admin typed: whole, or the start of one (12 characters at
//  least, as the gallery and the chat show) that names one file on the hub
export function resolveHash(typed: string, art: ArtOnHub[]): string {
    const wanted = typed.trim().toLowerCase();
    if (isSha256(wanted)) {
        return wanted;
    }
    if (!/^[0-9a-f]{12,63}$/.test(wanted)) {
        throw new HubError('usage', 'Name the file by its SHA-256 (64 hex digits), or the first 12 or more of them');
    }
    const matches = [...new Set(art.flatMap(a => a.files).filter(hash => hash.startsWith(wanted)))];
    if (1 !== matches.length) {
        throw new HubError(
            'usage',
            matches.length ? `${wanted} names more than one file; give more of it` : `No file on the hub starts with ${wanted}`
        );
    }
    return matches[0]!;
}

//  An account whose art the hub refuses, all of it (assets spec §9)
export interface RefusedPublisher {
    did: string;
    reason: string;
    refusedAt: string;
}

export class AssetBlocks {
    db: DatabaseSync;
    now: () => number;
    moderation: Moderation;
    private blocked = new Set<string>();
    private refused = new Set<string>();
    private seen = '';

    constructor(db: DatabaseSync, now: () => number = Date.now) {
        this.db = db;
        this.now = now;
        this.moderation = new Moderation(db, now);
        this.refresh();
    }

    //  Read the blocks again; true if they changed since last time
    refresh(): boolean {
        const rows = this.db.prepare('SELECT sha256 FROM asset_block ORDER BY sha256').all() as {
            sha256: string;
        }[];
        const dids = this.db.prepare('SELECT did FROM asset_publisher_block ORDER BY did').all() as {
            did: string;
        }[];
        const now = `${rows.map(r => r.sha256).join(',')};${dids.map(r => r.did).join(',')}`;
        if (now === this.seen) {
            return false;
        }
        this.seen = now;
        this.blocked = new Set(rows.map(r => r.sha256));
        this.refused = new Set(dids.map(r => r.did));
        return true;
    }

    //  As of the last refresh()
    has(sha256: string): boolean {
        return this.blocked.has(sha256);
    }

    //  Whether the hub refuses this account's art, as of the last refresh()
    refuses(did: string): boolean {
        return this.refused.has(did);
    }

    refuse(did: string, reason: string): RefusedPublisher {
        if (!isDid(did)) {
            throw new HubError('usage', `Not a DID: ${did}`);
        }
        const why = reason.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
        if (why.length > MaxBlockReason) {
            throw new HubError('usage', `A reason can be up to ${MaxBlockReason} characters`);
        }
        const at = new Date(this.now()).toISOString();
        this.db
            .prepare('INSERT OR REPLACE INTO asset_publisher_block (did, reason, refused_at) VALUES (?, ?, ?)')
            .run(did, why, at);
        this.moderation.log('asset-refuse', did, why);
        this.refresh();
        return { did, reason: why, refusedAt: at };
    }

    accept(did: string): boolean {
        const changed = this.db.prepare('DELETE FROM asset_publisher_block WHERE did = ?').run(did).changes > 0;
        if (changed) {
            this.moderation.log('asset-accept', did, '');
            this.refresh();
        }
        return changed;
    }

    refusedPublishers(): RefusedPublisher[] {
        return (
            this.db
                .prepare('SELECT did, reason, refused_at FROM asset_publisher_block ORDER BY refused_at')
                .all() as { did: string; reason: string; refused_at: string }[]
        ).map(r => ({ did: r.did, reason: r.reason, refusedAt: r.refused_at }));
    }

    block(sha256: string, reason: string): AssetBlock {
        const hash = sha256.trim().toLowerCase();
        if (!isSha256(hash)) {
            throw new HubError('usage', 'Name the file by its SHA-256: 64 hex digits');
        }
        const why = reason.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
        if (why.length > MaxBlockReason) {
            throw new HubError('usage', `A reason can be up to ${MaxBlockReason} characters`);
        }
        const at = new Date(this.now()).toISOString();
        this.db
            .prepare('INSERT OR REPLACE INTO asset_block (sha256, reason, blocked_at) VALUES (?, ?, ?)')
            .run(hash, why, at);
        this.moderation.log('asset-block', hash, why);
        this.refresh();
        return { sha256: hash, reason: why, blockedAt: at };
    }

    unblock(sha256: string): boolean {
        const hash = sha256.trim().toLowerCase();
        const changed = this.db.prepare('DELETE FROM asset_block WHERE sha256 = ?').run(hash).changes > 0;
        if (changed) {
            this.moderation.log('asset-unblock', hash, '');
            this.refresh();
        }
        return changed;
    }

    list(): AssetBlock[] {
        return (
            this.db.prepare('SELECT sha256, reason, blocked_at FROM asset_block ORDER BY blocked_at').all() as {
                sha256: string;
                reason: string;
                blocked_at: string;
            }[]
        ).map(r => ({ sha256: r.sha256, reason: r.reason, blockedAt: r.blocked_at }));
    }
}
