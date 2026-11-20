//  Moderation of the common space (hub plan H18, vision §8.7). The first
//  model is hub-moderated: the hub's admin decides, from the command line.
//
//    - Blocks, by the hub's admin: an AT account (by DID, however it
//      connects: its own sign-in, a BBS's report, a door, the room), one
//      BBS member without an AT account (alice@coolbbs), or all of a BBS's
//      members without one (*@coolbbs). For the whole space or only its
//      chat room, for a time or for good. A blocked person is told who
//      blocked them, and why if the admin said.
//    - Mutes, by anyone in the space, for themselves only: the person they
//      mute is left out of what the hub sends them, and their chat hides
//      that person's messages. Nobody else is told.
//    - Reports, by anyone in the space, about someone in it, with what was
//      said in the room in the last few minutes (chat.ts keeps that, in
//      memory only), for the admin to read.
//    - A record of what the admin did, and of reports made.
//
//  A BBS keeps its own way to hold its members back (F18): it leaves them
//  out of its reports.

import type { DatabaseSync } from 'node:sqlite';
import { HubError } from './errors.ts';
import { isDid } from './rules.ts';

export type BlockScope = 'space' | 'room';

export interface Block {
    id: number;
    //  a DID, "user:<bbs>:<user>" or "vouched:<bbs>"
    subject: string;
    scope: BlockScope;
    reason: string;
    createdAt: string;
    //  null: for good
    until: string | null;
    liftedAt: string | null;
}

//  One line said in the room, as the hub's own connection heard it
export interface RecentMessage {
    did: string | null;
    nick: string;
    text: string;
    time: string;
}

export interface Report {
    id: number;
    //  the DID of whoever reported
    reporter: string;
    //  the reported person, as the live model knows them
    person: string;
    //  what the admin can block, where the hub could tell
    subject: string | null;
    label: string;
    note: string;
    messages: RecentMessage[];
    createdAt: string;
    closedAt: string | null;
    outcome: string | null;
}

export interface Mute {
    person: string;
    label: string;
    createdAt: string;
}

export interface LogEntry {
    id: number;
    at: string;
    action: string;
    subject: string;
    detail: string;
}

export const MaxReason = 300;
export const MaxNote = 1000;
export const MaxMutes = 1000;
const MaxLabel = 200;
const BbsRe = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const UserRe = /^[^\p{C}:@]{1,64}$/u;
//  how the live model names people (live.ts personId)
const PersonRe = /^person:(?:(did:.+)|(?:via|vouched):[a-z0-9-]{1,32}:[0-9a-f]{12})$/;

export function isPersonId(value: unknown): value is string {
    if ('string' !== typeof value || value.length > 300) {
        return false;
    }
    const m = PersonRe.exec(value);
    return !!m && (!m[1] || isDid(m[1]));
}

//  What the admin types: a DID, user@bbs, or *@bbs
export function parseSubject(text: string): string {
    const value = text.trim();
    if (value.startsWith('did:')) {
        if (!isDid(value)) {
            throw new HubError('bad-subject', `"${value}" is not a did:plc or did:web`);
        }
        return value;
    }
    const at = value.lastIndexOf('@');
    const user = value.slice(0, at);
    const bbs = value.slice(at + 1).toLowerCase();
    if (at < 1 || !BbsRe.test(bbs) || !('*' === user || UserRe.test(user))) {
        throw new HubError('bad-subject', `"${value}" is not a DID, user@bbs or *@bbs`);
    }
    return '*' === user ? `vouched:${bbs}` : `user:${bbs}:${user.trim().toLowerCase()}`;
}

//  ...and back, to show it
export function describeSubject(subject: string): string {
    if (subject.startsWith('vouched:')) {
        return `*@${subject.slice(8)}`;
    }
    if (subject.startsWith('user:')) {
        const [, bbs, ...user] = subject.split(':');
        return `${user.join(':')}@${bbs}`;
    }
    return subject;
}

//  What a block on a BBS member without an AT account may be on
export function vouchedSubjects(bbs: string, user: string): string[] {
    return [`user:${bbs}:${user.trim().toLowerCase()}`, `vouched:${bbs}`];
}

//  "7d", "12h", "30m": milliseconds; "forever": null
export function parseDuration(text: string): number | null {
    if ('forever' === text) {
        return null;
    }
    const m = /^(\d{1,4})([mhd])$/.exec(text);
    if (!m || 0 === Number(m[1])) {
        throw new HubError('bad-duration', `"${text}" is not a time such as 30m, 12h, 7d, or forever`);
    }
    return Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 'm' | 'h' | 'd'];
}

//  What the blocked person is told
export function blockText(block: Block, domain: string): string {
    const what = 'room' === block.scope ? 'its chat room' : 'its common space';
    const until = block.until ? ` until ${block.until.slice(0, 16).replace('T', ' ')} UTC` : '';
    const reason = block.reason ? `: ${block.reason}${/[.!?]$/.test(block.reason) ? '' : '.'}` : '.';
    return `The admin of ${domain} has blocked you from ${what}${until}${reason}`;
}

function oneLine(text: string, max: number): string {
    return text.replace(/[\p{C}]+/gu, ' ').trim().slice(0, max);
}

interface BlockRow {
    id: number;
    subject: string;
    scope: BlockScope;
    reason: string;
    created_at: string;
    until: number | null;
    lifted_at: string | null;
}

function toBlock(row: BlockRow): Block {
    return {
        id: row.id,
        subject: row.subject,
        scope: row.scope,
        reason: row.reason,
        createdAt: row.created_at,
        until: null === row.until ? null : new Date(row.until).toISOString(),
        liftedAt: row.lifted_at,
    };
}

interface ReportRow {
    id: number;
    reporter: string;
    person: string;
    subject: string | null;
    label: string;
    note: string;
    messages: string;
    created_at: string;
    closed_at: string | null;
    outcome: string | null;
}

function toReport(row: ReportRow): Report {
    return {
        id: row.id,
        reporter: row.reporter,
        person: row.person,
        subject: row.subject,
        label: row.label,
        note: row.note,
        messages: JSON.parse(row.messages) as RecentMessage[],
        createdAt: row.created_at,
        closedAt: row.closed_at,
        outcome: row.outcome,
    };
}

export class Moderation {
    db: DatabaseSync;
    now: () => number;

    constructor(db: DatabaseSync, now: () => number = Date.now) {
        this.db = db;
        this.now = now;
    }

    stamp(): string {
        return new Date(this.now()).toISOString();
    }

    log(action: string, subject: string, detail = ''): void {
        this.db
            .prepare('INSERT INTO moderation_log (at, action, subject, detail) VALUES (?, ?, ?, ?)')
            .run(this.stamp(), action, subject, detail);
    }

    history(limit = 50): LogEntry[] {
        return (
            this.db.prepare('SELECT * FROM moderation_log ORDER BY id DESC LIMIT ?').all(limit) as unknown as LogEntry[]
        ).reverse();
    }

    //  Changes with every action the admin takes, so a running hub notices
    //  one made from the command line
    version(): number {
        return (this.db.prepare('SELECT COALESCE(MAX(id), 0) AS v FROM moderation_log').get() as { v: number }).v;
    }

    // ── Blocks ──

    block(subject: string, scope: BlockScope, options: { forMs?: number | null; reason?: string } = {}): Block {
        if ('space' !== scope && 'room' !== scope) {
            throw new HubError('bad-scope', 'A block is on the space or the room');
        }
        const reason = oneLine(options.reason ?? '', MaxReason);
        const until = options.forMs ? this.now() + options.forMs : null;
        const { lastInsertRowid } = this.db
            .prepare('INSERT INTO space_block (subject, scope, reason, created_at, until) VALUES (?, ?, ?, ?, ?)')
            .run(subject, scope, reason, this.stamp(), until);
        const block = this.mustGetBlock(Number(lastInsertRowid));
        this.log('block', subject, `${scope}${block.until ? ` until ${block.until}` : ''}${reason ? `: ${reason}` : ''}`);
        return block;
    }

    unblock(id: number): Block {
        const block = this.mustGetBlock(id);
        if (block.liftedAt) {
            throw new HubError('not-found', `Block ${id} was already lifted`);
        }
        this.db.prepare('UPDATE space_block SET lifted_at = ? WHERE id = ?').run(this.stamp(), id);
        this.log('unblock', block.subject, `block ${id}`);
        return this.mustGetBlock(id);
    }

    mustGetBlock(id: number): Block {
        const row = this.db.prepare('SELECT * FROM space_block WHERE id = ?').get(id) as BlockRow | undefined;
        if (!row) {
            throw new HubError('not-found', `No block ${id}`);
        }
        return toBlock(row);
    }

    //  Blocks in force (or every block, lifted and ended too)
    blocks(all = false): Block[] {
        const rows = all
            ? this.db.prepare('SELECT * FROM space_block ORDER BY id').all()
            : this.db
                  .prepare('SELECT * FROM space_block WHERE lifted_at IS NULL AND (until IS NULL OR until > ?) ORDER BY id')
                  .all(this.now());
        return (rows as unknown as BlockRow[]).map(toBlock);
    }

    //  The block in force on any of |subjects| for |scope| (a block on the
    //  space covers its room too): the longest, if there are several
    blockOf(subjects: string[], scope: BlockScope): Block | null {
        if (!subjects.length) {
            return null;
        }
        const scopes = 'space' === scope ? ['space'] : ['space', 'room'];
        const row = this.db
            .prepare(
                `SELECT * FROM space_block
                 WHERE subject IN (${subjects.map(() => '?').join(', ')})
                   AND scope IN (${scopes.map(() => '?').join(', ')})
                   AND lifted_at IS NULL AND (until IS NULL OR until > ?)
                 ORDER BY until IS NOT NULL, until DESC, scope = 'room' LIMIT 1`
            )
            .get(...subjects, ...scopes, this.now()) as BlockRow | undefined;
        return row ? toBlock(row) : null;
    }

    // ── Mutes ──

    mute(did: string, person: string, label: string): void {
        const { count } = this.db.prepare('SELECT COUNT(*) AS count FROM space_mute WHERE did = ?').get(did) as {
            count: number;
        };
        if (count >= MaxMutes && !this.muted(did).has(person)) {
            throw new HubError('limit', `You can mute at most ${MaxMutes} people.`);
        }
        this.db
            .prepare('INSERT OR REPLACE INTO space_mute (did, person, label, created_at) VALUES (?, ?, ?, ?)')
            .run(did, person, oneLine(label, MaxLabel) || person, this.stamp());
    }

    unmute(did: string, person: string): void {
        this.db.prepare('DELETE FROM space_mute WHERE did = ? AND person = ?').run(did, person);
    }

    mutes(did: string): Mute[] {
        return (
            this.db
                .prepare('SELECT person, label, created_at FROM space_mute WHERE did = ? ORDER BY label')
                .all(did) as unknown as { person: string; label: string; created_at: string }[]
        ).map(r => ({ person: r.person, label: r.label, createdAt: r.created_at }));
    }

    muted(did: string): Set<string> {
        return new Set(
            (this.db.prepare('SELECT person FROM space_mute WHERE did = ?').all(did) as { person: string }[]).map(
                r => r.person
            )
        );
    }

    //  When someone removes their profile
    forget(did: string): void {
        this.db.prepare('DELETE FROM space_mute WHERE did = ?').run(did);
    }

    // ── Reports ──

    report(r: { reporter: string; person: string; subject: string | null; label: string; note: string; messages: RecentMessage[] }): Report {
        const { lastInsertRowid } = this.db
            .prepare(
                `INSERT INTO space_report (reporter, person, subject, label, note, messages, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
                r.reporter,
                r.person,
                r.subject,
                oneLine(r.label, MaxLabel) || r.person,
                r.note.replace(/[^\P{C}\n]+/gu, ' ').trim().slice(0, MaxNote),
                JSON.stringify(r.messages),
                this.stamp()
            );
        const id = Number(lastInsertRowid);
        this.log('report', r.subject ?? r.person, `report ${id} from ${r.reporter}`);
        return this.mustGetReport(id);
    }

    mustGetReport(id: number): Report {
        const row = this.db.prepare('SELECT * FROM space_report WHERE id = ?').get(id) as ReportRow | undefined;
        if (!row) {
            throw new HubError('not-found', `No report ${id}`);
        }
        return toReport(row);
    }

    reports(all = false): Report[] {
        const sql = `SELECT * FROM space_report ${all ? '' : 'WHERE closed_at IS NULL '}ORDER BY id`;
        return (this.db.prepare(sql).all() as unknown as ReportRow[]).map(toReport);
    }

    //  Done with: what was said is let go, the rest is kept
    closeReport(id: number, outcome: string): Report {
        const report = this.mustGetReport(id);
        if (report.closedAt) {
            throw new HubError('not-found', `Report ${id} is already closed`);
        }
        const text = oneLine(outcome, MaxReason);
        this.db
            .prepare("UPDATE space_report SET closed_at = ?, outcome = ?, messages = '[]' WHERE id = ?")
            .run(this.stamp(), text, id);
        this.log('close-report', report.subject ?? report.person, `report ${id}${text ? `: ${text}` : ''}`);
        return this.mustGetReport(id);
    }
}
