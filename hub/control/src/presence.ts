//  Who is around (hub plan H14), from what BBSes report (vision §8.6), and
//  who may join the common space (vision §8.7).
//
//  A BBS on this hub reports, over HTTPS with its tunnel token, every member
//  who has chosen to take part: whether they are on now, and since when they
//  have been a member. Each report replaces the last, so a member who turns
//  it off, or whom the sysop withholds, is simply left out of the next one.
//  A report only ever speaks for the BBS whose token sent it.
//
//  A BBS's word is only its word: a DID it reports is shown as the name the
//  BBS knows them by, "via" the BBS, until the person, signed in to the hub,
//  confirms that BBS. Then they are shown as their own account. They can
//  also deny it, and that BBS's claim about them is then ignored.
//
//  Who is shown is worked out when asked, never stored: someone is on only
//  while their BBS's tunnel is up and its reports keep coming.

import type { DatabaseSync } from 'node:sqlite';
import type { HubConfig } from './config.ts';
import type { Directory } from './directory.ts';
import { HubError } from './errors.ts';
import type { Profiles } from './profiles.ts';
import type { Bbs, Registry } from './registry.ts';
import { isDid } from './rules.ts';

//  the most members one report may carry
export const MaxReportMembers = 2000;
const MaxName = 64;
//  printable, no control or formatting characters
const NameRe = /^[^\p{C}]+$/u;

export interface ReportedMember {
    //  a member with a linked AT account
    did?: string;
    //  a member without one: their user name on the BBS
    user?: string;
    //  the name the BBS knows them by
    name: string;
    memberSince: string;
    online: boolean;
}

export interface Membership {
    bbs: string;
    name: string;
    memberSince: string;
    answer: 'confirmed' | 'denied' | null;
}

//  Someone shown in the common space
export interface PersonShown {
    //  how they appear: "@handle", "name via coolbbs", or "alice@coolbbs"
    label: string;
    //  their own AT account, when they have confirmed this BBS
    did: string | null;
    kind: 'account' | 'via' | 'vouched';
    bbs: string;
    onlineSince: string | null;
}

interface MemberRow {
    bbs: string;
    member: string;
    did: string | null;
    name: string;
    member_since: string;
    online: number;
    online_since: string | null;
}

//  A BBS's report, checked: anything off and the whole report is refused,
//  so a mistake never half-applies
export function parseReport(body: unknown): ReportedMember[] {
    const fail = (why: string): never => {
        throw new HubError('bad-report', why);
    };
    if (!body || 'object' !== typeof body || Array.isArray(body)) {
        return fail('A report is a JSON object.');
    }
    const members = (body as { members?: unknown }).members;
    if (!Array.isArray(members)) {
        return fail('A report has a "members" list.');
    }
    if (members.length > MaxReportMembers) {
        return fail(`A report has at most ${MaxReportMembers} members.`);
    }
    const seen = new Set<string>();
    return members.map((m: unknown, i): ReportedMember => {
        if (!m || 'object' !== typeof m || Array.isArray(m)) {
            return fail(`members[${i}] is not an object.`);
        }
        const v = m as Record<string, unknown>;
        const did = v.did;
        const user = v.user;
        if ((undefined === did) === (undefined === user)) {
            return fail(`members[${i}] has either "did" or "user".`);
        }
        if (undefined !== did && ('string' !== typeof did || !isDid(did))) {
            return fail(`members[${i}].did is not a did:plc or did:web.`);
        }
        const name = v.name;
        for (const [what, value] of [
            ['name', name],
            ['user', user ?? 'x'],
        ] as const) {
            if ('string' !== typeof value || !value.trim() || value.length > MaxName || !NameRe.test(value)) {
                return fail(`members[${i}].${what} is 1 to ${MaxName} printable characters.`);
            }
        }
        const since = v.memberSince;
        if ('string' !== typeof since || Number.isNaN(Date.parse(since))) {
            return fail(`members[${i}].memberSince is a date and time.`);
        }
        if ('boolean' !== typeof v.online) {
            return fail(`members[${i}].online is true or false.`);
        }
        const key = memberKey(did as string | undefined, user as string | undefined);
        if (seen.has(key)) {
            return fail(`members[${i}] appears twice.`);
        }
        seen.add(key);
        return {
            ...(undefined !== did ? { did: did as string } : { user: (user as string).trim() }),
            name: (name as string).trim(),
            memberSince: new Date(since).toISOString(),
            online: v.online,
        };
    });
}

function memberKey(did: string | undefined, user: string | undefined): string {
    return did ? `did:${did}` : `user:${(user ?? '').trim().toLowerCase()}`;
}

//  A BBS's member looking at the space from inside the BBS (F19, the door)
export interface DoorAccess {
    bbs: string;
    //  set only where the hub knows this is them: they confirmed the BBS
    did: string | null;
    //  how the live model knows them, whether or not they are shown
    kind: 'account' | 'via' | 'vouched';
    label: string;
    //  only someone the hub knows as themselves may speak in the room
    chat: boolean;
}

export class Presence {
    db: DatabaseSync;
    registry: Registry;
    config: HubConfig;
    profiles: Profiles;
    directory: Directory | null;
    now: () => number;

    constructor(
        registry: Registry,
        config: HubConfig,
        profiles: Profiles,
        directory: Directory | null = null,
        now: () => number = Date.now
    ) {
        this.db = registry.db;
        this.registry = registry;
        this.config = config;
        this.profiles = profiles;
        this.directory = directory;
        this.now = now;
    }

    //  A BBS's report replaces everything it said before, at once
    report(bbs: Bbs, members: ReportedMember[]): void {
        const at = new Date(this.now()).toISOString();
        const before = new Map(
            (
                this.db
                    .prepare('SELECT member, online, online_since FROM bbs_member WHERE bbs = ?')
                    .all(bbs.name) as unknown as Pick<MemberRow, 'member' | 'online' | 'online_since'>[]
            ).map(r => [r.member, r])
        );
        const insert = this.db.prepare(
            `INSERT INTO bbs_member (bbs, member, did, name, member_since, online, online_since)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
        );
        this.db.exec('BEGIN');
        try {
            this.db.prepare('DELETE FROM bbs_member WHERE bbs = ?').run(bbs.name);
            for (const m of members) {
                const key = memberKey(m.did, m.user);
                const was = before.get(key);
                //  on since: kept from report to report while they stay on
                const since = m.online ? (was?.online && was.online_since ? was.online_since : at) : null;
                insert.run(bbs.name, key, m.did ?? null, m.name, m.memberSince, m.online ? 1 : 0, since);
            }
            this.db
                .prepare('INSERT OR REPLACE INTO bbs_report (bbs, reported_at) VALUES (?, ?)')
                .run(bbs.name, this.now());
            this.db.exec('COMMIT');
        } catch (e) {
            this.db.exec('ROLLBACK');
            throw e;
        }
    }

    //  Whether a BBS's word about who is on still holds: its tunnel is up
    //  and it reported recently
    live(bbs: Bbs): boolean {
        if ('active' !== bbs.state || !bbs.connected) {
            return false;
        }
        const row = this.db.prepare('SELECT reported_at FROM bbs_report WHERE bbs = ?').get(bbs.name) as
            { reported_at: number } | undefined;
        return !!row && row.reported_at >= this.now() - this.config.space.reportTimeoutSeconds * 1000;
    }

    //  The BBS's listing rating, for the rating rule: presence on a BBS is
    //  shown only where its rating is (hub spec §5.4)
    ratingAllowed(bbs: Bbs): boolean {
        const entry = bbs.bbsDid ? this.directory?.entry(bbs.bbsDid) : null;
        const rating = entry?.bbs?.name === bbs.name ? entry.listing.rating : 'general';
        return this.config.directory.ratings.includes(rating);
    }

    //  Whether a BBS's members count as members here
    counts(bbs: Bbs): boolean {
        if ('active' !== bbs.state) {
            return false;
        }
        if (this.config.space.excludeOpenBbses) {
            const entry = bbs.bbsDid ? this.directory?.entry(bbs.bbsDid) : null;
            //  without a listing, the hub can't tell, so it doesn't count it
            if (!entry || entry.bbs?.name !== bbs.name || entry.listing.admission.policy.includes('open')) {
                return false;
            }
        }
        return true;
    }

    //  Whether a BBS may show the space to one of its members, inside the
    //  BBS: a member it reported (by DID, or by user name), on a BBS that is
    //  live and shown here, who may join (by DID) or whose BBS this hub takes
    //  members without AT accounts from. Null if not
    doorAccess(bbs: Bbs, did: string | null, user: string | null): DoorAccess | null {
        if (!this.live(bbs) || !this.ratingAllowed(bbs)) {
            return null;
        }
        const row = this.db
            .prepare('SELECT * FROM bbs_member WHERE bbs = ? AND member = ?')
            .get(bbs.name, memberKey(did ?? undefined, user ?? undefined)) as unknown as MemberRow | undefined;
        if (!row) {
            return null;
        }
        if (!row.did) {
            if (!this.config.space.vouchedFrom.includes(bbs.name) || !this.counts(bbs)) {
                return null;
            }
            return { bbs: bbs.name, did: null, kind: 'vouched', label: `${row.name}@${bbs.name}`, chat: false };
        }
        const answer = (
            this.db.prepare('SELECT answer FROM profile_bbs WHERE did = ? AND bbs = ?').get(row.did, bbs.name) as
                | { answer: string }
                | undefined
        )?.answer;
        if ('denied' === answer || !this.mayJoin(row.did)) {
            return null;
        }
        const profile = this.profiles.get(row.did);
        if ('confirmed' === answer && profile) {
            return {
                bbs: bbs.name,
                did: row.did,
                kind: 'account',
                label: profile.handle ? `@${profile.handle}` : row.did,
                chat: true,
            };
        }
        return { bbs: bbs.name, did: null, kind: 'via', label: `${row.name} via ${bbs.name}`, chat: false };
    }

    //  What BBSes on this hub say about a DID, and the person's answers
    memberships(did: string): Membership[] {
        const rows = this.db
            .prepare(
                `SELECT m.bbs, m.name, m.member_since, p.answer FROM bbs_member m
                 LEFT JOIN profile_bbs p ON p.did = m.did AND p.bbs = m.bbs
                 WHERE m.did = ? ORDER BY m.bbs`
            )
            .all(did) as unknown as {
            bbs: string;
            name: string;
            member_since: string;
            answer: string | null;
        }[];
        return rows.map(r => ({
            bbs: r.bbs,
            name: r.name,
            memberSince: r.member_since,
            answer: r.answer as Membership['answer'],
        }));
    }

    answer(did: string, bbs: string, answer: 'confirmed' | 'denied'): void {
        this.registry.mustGet(bbs);
        this.db
            .prepare('INSERT OR REPLACE INTO profile_bbs (did, bbs, answer, answered_at) VALUES (?, ?, ?, ?)')
            .run(did, bbs, answer, new Date(this.now()).toISOString());
    }

    //  Whether someone with an AT account may join the common space. By
    //  default: a member of a BBS on this hub that counts, for long enough,
    //  that they haven't denied
    mayJoin(did: string): boolean {
        if ('anyone' === this.config.space.join) {
            return true;
        }
        const waited = this.now() - this.config.space.memberDays * 24 * 60 * 60 * 1000;
        return this.memberships(did).some(m => {
            const bbs = this.registry.get(m.bbs);
            return !!bbs && 'denied' !== m.answer && this.counts(bbs) && Date.parse(m.memberSince) <= waited;
        });
    }

    //  Who is shown in the common space now
    around(): PersonShown[] {
        const out: PersonShown[] = [];
        const vouched = new Set(this.config.space.vouchedFrom);
        for (const bbs of this.registry.list()) {
            if (!this.live(bbs) || !this.ratingAllowed(bbs)) {
                continue;
            }
            const rows = this.db
                .prepare('SELECT * FROM bbs_member WHERE bbs = ? AND online = 1 ORDER BY name')
                .all(bbs.name) as unknown as MemberRow[];
            for (const row of rows) {
                if (!row.did) {
                    if (vouched.has(bbs.name)) {
                        out.push({
                            label: `${row.name}@${bbs.name}`,
                            did: null,
                            kind: 'vouched',
                            bbs: bbs.name,
                            onlineSince: row.online_since,
                        });
                    }
                    continue;
                }
                const answer = (
                    this.db
                        .prepare('SELECT answer FROM profile_bbs WHERE did = ? AND bbs = ?')
                        .get(row.did, bbs.name) as { answer: string } | undefined
                )?.answer;
                if ('denied' === answer) {
                    continue;
                }
                //  the stricter setting wins: someone with a profile here
                //  has their own switch too
                const profile = this.profiles.get(row.did);
                if (profile && !profile.presence) {
                    continue;
                }
                if (!this.mayJoin(row.did)) {
                    continue;
                }
                const own = 'confirmed' === answer && profile;
                out.push({
                    label: own
                        ? profile.handle
                            ? `@${profile.handle}`
                            : row.did
                        : `${row.name} via ${bbs.name}`,
                    did: own ? row.did : null,
                    kind: own ? 'account' : 'via',
                    bbs: bbs.name,
                    onlineSince: row.online_since,
                });
            }
        }
        return out;
    }
}
