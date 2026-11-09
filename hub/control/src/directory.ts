//  The directory (hub plan H7): listings and status published by BBSes,
//  gathered from the AT network. A first sweep asks a relay which accounts
//  hold listings and fetches them, slowly, in the background; after that
//  the live stream (jetstream.ts) brings only changes. Everything is kept
//  in the hub's database, so restarts fetch nothing again.

import type { AtClient } from './atproto.ts';
import type { HubConfig } from './config.ts';
import { sanitizeListing, sanitizeStatus, pointsAtHub, type Listing, type Status } from './listing.ts';
import type { Bbs, Registry } from './registry.ts';

export interface DirectoryEntry {
    did: string;
    listing: Listing;
    status: Status | null;
    updatedAt: string;
    //  the BBS registered on this hub, when both sides confirm it
    bbs: Bbs | null;
}

export function collections(config: HubConfig) {
    const prefix = config.directory.nsidPrefix;
    return { listing: `${prefix}.leaf.listing`, status: `${prefix}.leaf.status` };
}

export class Directory {
    registry: Registry;
    config: HubConfig;
    now: () => Date;

    constructor(registry: Registry, config: HubConfig, now: () => Date = () => new Date()) {
        this.registry = registry;
        this.config = config;
        this.now = now;
    }

    get db() {
        return this.registry.db;
    }

    isHidden(did: string): boolean {
        return !!this.db.prepare('SELECT 1 FROM directory_hidden WHERE did = ?').get(did);
    }

    //  only accounts that are this hub's own BBSes, in "hub" scope
    wanted(did: string): boolean {
        if (this.isHidden(did)) {
            return false;
        }
        return 'network' === this.config.directory.scope || null !== this.registry.getByDid(did);
    }

    putListing(did: string, cid: string, value: unknown): boolean {
        if (!this.wanted(did)) {
            return false;
        }
        const listing = sanitizeListing(value);
        if (!listing) {
            this.deleteListing(did);
            return false;
        }
        this.db
            .prepare(
                `INSERT INTO directory_entry (did, listing, listing_cid, updated_at) VALUES (?, ?, ?, ?)
                 ON CONFLICT (did) DO UPDATE SET listing = excluded.listing, listing_cid = excluded.listing_cid,
                 updated_at = excluded.updated_at WHERE directory_entry.listing_cid IS NOT excluded.listing_cid`
            )
            .run(did, JSON.stringify(listing), cid, this.now().toISOString());
        return true;
    }

    deleteListing(did: string): void {
        this.db.prepare('DELETE FROM directory_entry WHERE did = ?').run(did);
    }

    putStatus(did: string, cid: string, value: unknown): void {
        const status = sanitizeStatus(value);
        //  status only for BBSes the directory lists
        this.db
            .prepare('UPDATE directory_entry SET status = ?, status_cid = ?, updated_at = ? WHERE did = ?')
            .run(status ? JSON.stringify(status) : null, cid, this.now().toISOString(), did);
    }

    deleteStatus(did: string): void {
        this.db.prepare('UPDATE directory_entry SET status = NULL, status_cid = NULL WHERE did = ?').run(did);
    }

    //  The registered BBS an account's listing belongs to: the sysop named
    //  the account, and the account's listing names the BBS's hub address
    linkedBbs(did: string, listing: Listing): Bbs | null {
        const bbs = this.registry.getByDid(did);
        return bbs && 'active' === bbs.state && pointsAtHub(listing, bbs.name, this.config.domain)
            ? bbs
            : null;
    }

    entry(did: string): DirectoryEntry | null {
        const row = this.db.prepare('SELECT * FROM directory_entry WHERE did = ?').get(did) as
            Row | undefined;
        return row ? this.toEntry(row) : null;
    }

    //  The listing of a registered BBS, if the link is confirmed
    forBbs(bbs: Bbs): DirectoryEntry | null {
        if (!bbs.bbsDid) {
            return null;
        }
        const entry = this.entry(bbs.bbsDid);
        return entry?.bbs?.name === bbs.name ? entry : null;
    }

    entries(): DirectoryEntry[] {
        const rows = this.db
            .prepare(
                `SELECT e.* FROM directory_entry e
                 WHERE NOT EXISTS (SELECT 1 FROM directory_hidden h WHERE h.did = e.did)`
            )
            .all() as unknown as Row[];
        return rows
            .map(r => this.toEntry(r))
            .filter(e => this.config.directory.ratings.includes(e.listing.rating));
    }

    toEntry(row: Row): DirectoryEntry {
        const listing = JSON.parse(row.listing) as Listing;
        return {
            did: row.did,
            listing,
            status: row.status ? (JSON.parse(row.status) as Status) : null,
            updatedAt: row.updated_at,
            bbs: this.linkedBbs(row.did, listing),
        };
    }

    hide(did: string, reason: string): void {
        this.db
            .prepare('INSERT OR REPLACE INTO directory_hidden (did, reason, hidden_at) VALUES (?, ?, ?)')
            .run(did, reason, this.now().toISOString());
        this.deleteListing(did);
    }

    unhide(did: string): void {
        this.db.prepare('DELETE FROM directory_hidden WHERE did = ?').run(did);
    }

    hidden(): { did: string; reason: string; hiddenAt: string }[] {
        return (
            this.db.prepare('SELECT did, reason, hidden_at FROM directory_hidden ORDER BY did').all() as {
                did: string;
                reason: string;
                hidden_at: string;
            }[]
        ).map(r => ({ did: r.did, reason: r.reason, hiddenAt: r.hidden_at }));
    }

    getState(key: string): string | null {
        const row = this.db.prepare('SELECT value FROM directory_state WHERE key = ?').get(key) as
            { value: string } | undefined;
        return row ? row.value : null;
    }

    setState(key: string, value: string): void {
        this.db.prepare('INSERT OR REPLACE INTO directory_state (key, value) VALUES (?, ?)').run(key, value);
    }

    //  The accounts to sweep: every account with a listing (from a relay),
    //  or only this hub's own BBSes
    async *accounts(at: AtClient): AsyncGenerator<string> {
        if ('hub' === this.config.directory.scope) {
            for (const bbs of this.registry.list()) {
                if (bbs.bbsDid) {
                    yield bbs.bbsDid;
                }
            }
            return;
        }
        let cursor: string | undefined;
        for (let page = 0; page < 1000; page++) {
            const reply = await at.listRepos(collections(this.config).listing, cursor);
            yield* reply.dids;
            if (!reply.cursor || reply.cursor === cursor) {
                return;
            }
            cursor = reply.cursor;
        }
    }

    //  Fetch every listing (and status), a few at a time with pauses, so
    //  account servers aren't hammered. Listings that have gone are removed.
    async sweep(at: AtClient, log: (line: string) => void = () => {}, pauseMs = 250): Promise<SweepResult> {
        const { listing: listingNsid, status: statusNsid } = collections(this.config);
        const result: SweepResult = { accounts: 0, listed: 0, removed: 0, failed: 0 };
        const seen = new Set<string>();
        const queue = this.accounts(at);
        const worker = async () => {
            for (;;) {
                const next = await queue.next();
                if (next.done) {
                    return;
                }
                const did = next.value;
                if (seen.has(did) || !this.wanted(did)) {
                    continue;
                }
                seen.add(did);
                result.accounts++;
                try {
                    const listing = await at.getRecord(did, listingNsid, 'self');
                    if (listing && this.putListing(did, listing.cid, listing.value)) {
                        result.listed++;
                        const status = await at.getRecord(did, statusNsid, 'self');
                        if (status) {
                            this.putStatus(did, status.cid, status.value);
                        } else {
                            this.deleteStatus(did);
                        }
                    } else if (!listing && this.entry(did)) {
                        this.deleteListing(did);
                        result.removed++;
                    }
                } catch (e) {
                    result.failed++;
                    log(`directory: ${did}: ${(e as Error).message}`);
                }
                await new Promise(r => setTimeout(r, pauseMs));
            }
        };
        //  generators can't be read concurrently: serialise .next() calls
        const lock = { p: Promise.resolve() as Promise<unknown> };
        const original = queue.next.bind(queue);
        queue.next = () => {
            const p = lock.p.then(() => original());
            lock.p = p.catch(() => {});
            return p;
        };
        await Promise.all(Array.from({ length: this.config.directory.concurrency }, worker));
        this.setState('lastSweep', this.now().toISOString());
        log(
            `directory: sweep done: ${result.accounts} accounts, ${result.listed} listed, ${result.removed} removed, ${result.failed} failed`
        );
        return result;
    }
}

interface Row {
    did: string;
    listing: string;
    listing_cid: string;
    status: string | null;
    status_cid: string | null;
    updated_at: string;
}

export interface SweepResult {
    accounts: number;
    listed: number;
    removed: number;
    failed: number;
}
