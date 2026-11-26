//  Abuse reports about BBSes, or the hub itself (hub plan H8): anyone may
//  file one on the hub's site, signed in or not. The admin reads them with
//  "hubctl abuse ...". Closing one lets go of what it said and how to reply,
//  keeping only what it was about, its kind, and the outcome.

import type { DatabaseSync } from 'node:sqlite';
import { HubError } from './errors.ts';
import { Moderation } from './moderation.ts';

export const AbuseKinds = {
    illegal: 'Illegal content',
    harassment: 'Harassment or threats',
    spam: 'Spam, scams or malware',
    copyright: 'Copyright',
    art: 'Art on the hub (what it shows)',
    copied: 'Art copied without permission',
    privacy: "Someone's private information",
    security: 'A security problem',
    other: 'Something else',
} as const;

export type AbuseKind = keyof typeof AbuseKinds;

export const MaxDetails = 4000;
export const MaxContact = 200;
export const MaxOutcome = 300;

export interface AbuseReport {
    id: number;
    //  the BBS's name, or null for the hub itself
    bbs: string | null;
    kind: AbuseKind;
    //  the art it is about, by its hash (assets spec §9), if any
    asset: string | null;
    //  null once closed
    details: string | null;
    contact: string | null;
    //  the reporter's DID, if they were signed in; null once closed
    reporter: string | null;
    createdAt: string;
    closedAt: string | null;
    outcome: string | null;
}

interface Row {
    id: number;
    bbs: string | null;
    kind: AbuseKind;
    asset: string | null;
    details: string | null;
    contact: string | null;
    reporter: string | null;
    created_at: string;
    closed_at: string | null;
    outcome: string | null;
}

const toReport = (r: Row): AbuseReport => ({
    id: r.id,
    bbs: r.bbs,
    kind: r.kind,
    asset: r.asset ?? null,
    details: r.details,
    contact: r.contact,
    reporter: r.reporter,
    createdAt: r.created_at,
    closedAt: r.closed_at,
    outcome: r.outcome,
});

export function isAbuseKind(value: unknown): value is AbuseKind {
    return 'string' === typeof value && Object.hasOwn(AbuseKinds, value);
}

//  Control characters out, except newlines in the details
function clean(text: string, newlines: boolean): string {
    const kept = text.replace(
        newlines ? /[\u0000-\u0009\u000b-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g,
        ' '
    );
    return kept.trim();
}

export class AbuseReports {
    db: DatabaseSync;
    now: () => number;
    moderation: Moderation;

    constructor(db: DatabaseSync, now: () => number = Date.now) {
        this.db = db;
        this.now = now;
        this.moderation = new Moderation(db, now);
    }

    file(r: {
        bbs: string | null;
        kind: unknown;
        details: string;
        contact: string;
        reporter: string | null;
        asset?: string | null;
    }): AbuseReport {
        if (!isAbuseKind(r.kind)) {
            throw new HubError('bad-report', 'Choose what kind of problem it is.');
        }
        const details = clean(r.details, true);
        if (!details || details.length > MaxDetails) {
            throw new HubError('bad-report', `Say what's wrong, in up to ${MaxDetails} characters.`);
        }
        const contact = clean(r.contact, false);
        if (contact.length > MaxContact) {
            throw new HubError('bad-report', `A way to reach you can be up to ${MaxContact} characters.`);
        }
        //  a hash only, from the gallery's report link
        const asset = r.asset && /^[0-9a-f]{64}$/.test(r.asset) ? r.asset : null;
        const { lastInsertRowid } = this.db
            .prepare(
                'INSERT INTO abuse_report (bbs, kind, details, contact, reporter, created_at, asset) VALUES (?, ?, ?, ?, ?, ?, ?)'
            )
            .run(r.bbs, r.kind, details, contact || null, r.reporter, new Date(this.now()).toISOString(), asset);
        const report = this.mustGet(Number(lastInsertRowid));
        this.moderation.log(
            'abuse-report',
            r.bbs ?? asset ?? '(the hub)',
            `abuse report ${report.id}: ${r.kind}`
        );
        return report;
    }

    get(id: number): AbuseReport | null {
        const row = this.db.prepare('SELECT * FROM abuse_report WHERE id = ?').get(id) as Row | undefined;
        return row ? toReport(row) : null;
    }

    mustGet(id: number): AbuseReport {
        const report = this.get(id);
        if (!report) {
            throw new HubError('not-found', `No abuse report ${id}`);
        }
        return report;
    }

    list(all = false): AbuseReport[] {
        return (
            this.db
                .prepare(`SELECT * FROM abuse_report${all ? '' : ' WHERE closed_at IS NULL'} ORDER BY id`)
                .all() as unknown as Row[]
        ).map(toReport);
    }

    //  Done with it: what it said, how to reply and who sent it are let go
    close(id: number, outcome = ''): AbuseReport {
        const report = this.mustGet(id);
        if (report.closedAt) {
            throw new HubError('closed', `Abuse report ${id} is already closed`);
        }
        const text = clean(outcome, false).slice(0, MaxOutcome);
        this.db
            .prepare(
                'UPDATE abuse_report SET details = NULL, contact = NULL, reporter = NULL, closed_at = ?, outcome = ? WHERE id = ?'
            )
            .run(new Date(this.now()).toISOString(), text, id);
        this.moderation.log(
            'close-abuse',
            report.bbs ?? '(the hub)',
            `abuse report ${id}${text ? `: ${text}` : ''}`
        );
        return this.mustGet(id);
    }
}
