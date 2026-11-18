import { beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeConfig, type HubConfig } from '../src/config.ts';
import type { Directory, DirectoryEntry } from '../src/directory.ts';
import { parseReport, Presence, type ReportedMember } from '../src/presence.ts';
import { Profiles } from '../src/profiles.ts';
import { Registry } from '../src/registry.ts';
import { BbsDid, OtherSysopDid, SysopDid } from './helpers.ts';

const Alice = 'did:plc:alicealicealicealicealic';
const Bob = 'did:plc:bobbobbobbobbobbobbobbob';
const Long = '2026-01-01T00:00:00.000Z';

let clock: number;
let config: HubConfig;
let registry: Registry;
let profiles: Profiles;
let listings: Map<string, Partial<DirectoryEntry['listing']>>;
let presence: Presence;

//  a directory that knows only the listings a test gives it
function fakeDirectory(): Directory {
    return {
        entry(did: string) {
            const listing = listings.get(did);
            const bbs = registry.getByDid(did);
            return listing
                ? ({
                      did,
                      listing: { rating: 'general', admission: { policy: [], howToJoin: '' }, ...listing },
                      status: null,
                      updatedAt: Long,
                      bbs,
                  } as DirectoryEntry)
                : null;
        },
    } as unknown as Directory;
}

function setUp(space: Partial<HubConfig['space']> = {}): void {
    clock = Date.UTC(2026, 10, 17, 12);
    config = makeConfig({ database: ':memory:', space: { enabled: true, ...space } });
    registry = new Registry(':memory:', { ...config.registration, now: () => new Date(clock) });
    profiles = new Profiles(registry.db, () => new Date(clock));
    listings = new Map();
    presence = new Presence(registry, config, profiles, fakeDirectory(), () => clock);
    registry.add('coolbbs', SysopDid, BbsDid, {});
    registry.add('otherbbs', OtherSysopDid, null, {});
    registry.proxyOpened('coolbbs', 'coolbbs.web', null);
    registry.proxyOpened('otherbbs', 'otherbbs.web', null);
}

function member(over: Partial<ReportedMember> = {}): ReportedMember {
    return { did: Alice, name: 'alice', memberSince: Long, online: true, ...over };
}

function report(bbs: string, members: ReportedMember[]): void {
    presence.report(registry.mustGet(bbs), members);
}

function labels(): string[] {
    return presence.around().map(p => p.label);
}

describe('presence reports', () => {
    it('are checked whole', () => {
        assert.deepEqual(parseReport({ members: [] }), []);
        const ok = parseReport({
            members: [
                { did: Alice, name: ' alice ', memberSince: '2026-01-01T00:00:00Z', online: true },
                { user: 'Bob', name: 'Bob', memberSince: Long, online: false },
            ],
        });
        assert.deepEqual(ok[0], { did: Alice, name: 'alice', memberSince: Long, online: true });
        assert.equal(ok[1]?.user, 'Bob');

        const bad: unknown[] = [
            null,
            [],
            { members: 'x' },
            { members: [{ name: 'a', memberSince: Long, online: true }] },
            { members: [{ did: Alice, user: 'a', name: 'a', memberSince: Long, online: true }] },
            { members: [{ did: 'did:example:x', name: 'a', memberSince: Long, online: true }] },
            { members: [{ did: Alice, name: '', memberSince: Long, online: true }] },
            { members: [{ did: Alice, name: 'a‮b', memberSince: Long, online: true }] },
            { members: [{ did: Alice, name: 'x'.repeat(65), memberSince: Long, online: true }] },
            { members: [{ did: Alice, name: 'a', memberSince: 'soon', online: true }] },
            { members: [{ did: Alice, name: 'a', memberSince: Long, online: 'yes' }] },
            {
                members: [
                    { user: 'Al', name: 'a', memberSince: Long, online: true },
                    { user: 'al', name: 'b', memberSince: Long, online: true },
                ],
            },
            {
                members: Array.from({ length: 2001 }, (_, i) => ({
                    user: `u${i}`,
                    name: 'u',
                    memberSince: Long,
                    online: false,
                })),
            },
        ];
        for (const body of bad) {
            assert.throws(() => parseReport(body), /./, JSON.stringify(body)?.slice(0, 80));
        }
    });
});

describe('who is around', () => {
    beforeEach(() => setUp());

    it('shows a reported member by the name their BBS gives, until they confirm it', () => {
        report('coolbbs', [member()]);
        assert.deepEqual(labels(), ['alice via coolbbs']);
        assert.equal(presence.around()[0]?.did, null);

        profiles.signedIn({ did: Alice, handle: 'alice.example' });
        profiles.setPresence(Alice, true);
        presence.answer(Alice, 'coolbbs', 'confirmed');
        assert.deepEqual(labels(), ['@alice.example']);
        assert.equal(presence.around()[0]?.did, Alice);
    });

    it('lets the stricter setting win: a profile with presence off hides them', () => {
        report('coolbbs', [member()]);
        profiles.signedIn({ did: Alice, handle: 'alice.example' });
        assert.deepEqual(labels(), []);
    });

    it('ignores a BBS the person has denied', () => {
        report('coolbbs', [member()]);
        presence.answer(Alice, 'coolbbs', 'denied');
        assert.deepEqual(labels(), []);
        assert.equal(presence.mayJoin(Alice), false);
    });

    it('replaces each report, and a BBS speaks only for itself', () => {
        report('coolbbs', [member(), member({ did: Bob, name: 'bob' })]);
        report('otherbbs', [member({ name: 'al' })]);
        assert.deepEqual(labels().sort(), ['al via otherbbs', 'alice via coolbbs', 'bob via coolbbs']);
        report('coolbbs', [member({ did: Bob, name: 'bob' })]);
        assert.deepEqual(labels().sort(), ['al via otherbbs', 'bob via coolbbs']);
        assert.deepEqual(
            presence.memberships(Alice).map(m => m.bbs),
            ['otherbbs']
        );
    });

    it('shows only who is on, while the tunnel is up and reports keep coming', () => {
        report('coolbbs', [member(), member({ did: Bob, name: 'bob', online: false })]);
        assert.deepEqual(labels(), ['alice via coolbbs']);

        registry.proxyClosed('coolbbs', 'coolbbs.web');
        assert.deepEqual(labels(), []);
        registry.proxyOpened('coolbbs', 'coolbbs.web', null);
        assert.deepEqual(labels(), ['alice via coolbbs']);

        clock += 181_000;
        assert.deepEqual(labels(), []);
        report('coolbbs', [member()]);
        assert.deepEqual(labels(), ['alice via coolbbs']);

        registry.setState('coolbbs', 'suspended');
        assert.deepEqual(labels(), []);
    });

    it('keeps when someone came on across reports', () => {
        report('coolbbs', [member()]);
        const since = presence.around()[0]?.onlineSince;
        clock += 60_000;
        report('coolbbs', [member()]);
        assert.equal(presence.around()[0]?.onlineSince, since);
        report('coolbbs', [member({ online: false })]);
        clock += 60_000;
        report('coolbbs', [member()]);
        assert.notEqual(presence.around()[0]?.onlineSince, since);
    });

    it('shows members without an AT account only from BBSes the hub accepts them from', () => {
        report('coolbbs', [member({ did: undefined, user: 'carol', name: 'carol' })]);
        assert.deepEqual(labels(), []);
        setUp({ vouchedFrom: ['coolbbs'] });
        report('coolbbs', [member({ did: undefined, user: 'carol', name: 'carol' })]);
        assert.deepEqual(labels(), ['carol@coolbbs']);
    });

    it('follows the rating rule', () => {
        listings.set(BbsDid, { rating: 'adult' });
        report('coolbbs', [member()]);
        assert.deepEqual(labels(), []);
        listings.set(BbsDid, { rating: 'general' });
        assert.deepEqual(labels(), ['alice via coolbbs']);
    });

    it('is gone with the BBS', () => {
        report('coolbbs', [member()]);
        presence.answer(Alice, 'coolbbs', 'confirmed');
        registry.remove('coolbbs');
        assert.deepEqual(labels(), []);
        assert.deepEqual(presence.memberships(Alice), []);
    });
});

describe('who may join the common space', () => {
    it('is, by default, members of a BBS on this hub', () => {
        setUp();
        assert.equal(presence.mayJoin(Alice), false);
        report('coolbbs', [member({ online: false })]);
        assert.equal(presence.mayJoin(Alice), true);
        report('coolbbs', []);
        assert.equal(presence.mayJoin(Alice), false);
    });

    it('can be anyone with an AT account', () => {
        setUp({ join: 'anyone' });
        assert.equal(presence.mayJoin(Alice), true);
    });

    it('can need a waiting period', () => {
        setUp({ memberDays: 7 });
        report('coolbbs', [member({ memberSince: new Date(clock - 3 * 86_400_000).toISOString() })]);
        assert.equal(presence.mayJoin(Alice), false);
        assert.deepEqual(labels(), []);
        clock += 5 * 86_400_000;
        report('coolbbs', [member({ memberSince: new Date(clock - 8 * 86_400_000).toISOString() })]);
        assert.equal(presence.mayJoin(Alice), true);
    });

    it("can leave out BBSes that admit anyone, or whose listing it can't see", () => {
        setUp({ excludeOpenBbses: true });
        report('coolbbs', [member()]);
        assert.equal(presence.mayJoin(Alice), false);
        listings.set(BbsDid, { admission: { policy: ['open'], howToJoin: '' } });
        assert.equal(presence.mayJoin(Alice), false);
        listings.set(BbsDid, { admission: { policy: ['invite'], howToJoin: '' } });
        assert.equal(presence.mayJoin(Alice), true);
    });

    it('refuses bad settings', () => {
        assert.throws(() => makeConfig({ space: { join: 'everyone' } }), /space\.join/);
        assert.throws(() => makeConfig({ space: { memberDays: -1 } }), /memberDays/);
        assert.throws(() => makeConfig({ space: { reportTimeoutSeconds: 5 } }), /reportTimeoutSeconds/);
        assert.throws(() => makeConfig({ space: { vouchedFrom: 'coolbbs' } }), /vouchedFrom/);
    });
});
