import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Registry } from '../src/registry.ts';
import { hashToken } from '../src/tokens.ts';
import { BbsDid, OtherSysopDid, SysopDid, testRegistry } from './helpers.ts';

describe('the registry', () => {
    it('registers a BBS and stores only a hash of its token', () => {
        const registry = testRegistry();
        const { bbs, token } = registry.add('coolbbs', SysopDid);
        assert.equal(bbs.name, 'coolbbs');
        assert.equal(bbs.state, 'active');
        assert.equal(bbs.connected, false);
        assert.match(token, /^hub_[A-Za-z0-9_-]{43}$/);

        const raw = registry.db.prepare('SELECT * FROM bbs').get() as Record<string, unknown>;
        assert.equal(raw.token_hash, hashToken(token));
        assert.ok(!JSON.stringify(raw).includes(token));
    });

    it('authenticates the right token only', () => {
        const registry = testRegistry();
        const { token } = registry.add('coolbbs', SysopDid);
        assert.equal(registry.authenticate('coolbbs', token)?.name, 'coolbbs');
        assert.equal(registry.authenticate('coolbbs', `${token}x`), null);
        assert.equal(registry.authenticate('coolbbs', ''), null);
        assert.equal(registry.authenticate('coolbbs', undefined), null);
        assert.equal(registry.authenticate('other', token), null);
        assert.equal(registry.authenticate(['coolbbs'], token), null);
    });

    it('refuses bad names, bad DIDs, duplicates and too many per sysop', () => {
        const registry = testRegistry();
        assert.throws(() => registry.add('Bad Name', SysopDid), { code: 'bad-name' });
        assert.throws(() => registry.add('admin', SysopDid), { code: 'bad-name' });
        assert.throws(() => registry.add('coolbbs', 'alice.bsky.social'), { code: 'bad-did' });

        registry.add('coolbbs', SysopDid, BbsDid);
        assert.throws(() => registry.add('coolbbs', OtherSysopDid), { code: 'taken' });
        assert.throws(() => registry.add('another', OtherSysopDid, BbsDid), { code: 'taken' });

        registry.add('second', SysopDid);
        registry.add('third', SysopDid);
        assert.throws(() => registry.add('fourth', SysopDid), { code: 'limit' });
    });

    it('rotating the token stops the old one', () => {
        const registry = testRegistry();
        const { token } = registry.add('coolbbs', SysopDid);
        const fresh = registry.rotateToken('coolbbs');
        assert.notEqual(fresh, token);
        assert.equal(registry.authenticate('coolbbs', token), null);
        assert.equal(registry.authenticate('coolbbs', fresh)?.name, 'coolbbs');
    });

    it('a suspended BBS is refused until resumed', () => {
        const registry = testRegistry();
        const { token } = registry.add('coolbbs', SysopDid);
        registry.setState('coolbbs', 'suspended');
        assert.equal(registry.authenticate('coolbbs', token), null);
        registry.setState('coolbbs', 'active');
        assert.equal(registry.authenticate('coolbbs', token)?.name, 'coolbbs');
    });

    it('a suspension says why, for its sysop, until resumed', () => {
        const registry = testRegistry();
        registry.add('coolbbs', SysopDid);
        const on = registry.setState('coolbbs', 'suspended', 'Spam in the\nfile areas');
        assert.equal(on.stateReason, 'Spam in the file areas');
        assert.equal(registry.setState('coolbbs', 'active', 'ignored').stateReason, null);
        assert.equal(registry.setState('coolbbs', 'suspended').stateReason, null);
    });

    it('a ban removes every BBS a DID runs or is, for good, and refuses it another', () => {
        const registry = testRegistry();
        const { token } = registry.add('coolbbs', SysopDid);
        registry.add('second', SysopDid);
        registry.add('theirs', OtherSysopDid, BbsDid);
        registry.add('other', OtherSysopDid);
        registry.setState('second', 'suspended', 'on probation');

        const { ban, removed } = registry.banDid(SysopDid, 'spam');
        assert.deepEqual(removed, ['coolbbs', 'second'], 'suspended ones too');
        assert.equal(ban.reason, 'spam');
        assert.equal(registry.get('coolbbs'), null);
        assert.equal(registry.authenticate('coolbbs', token), null);
        assert.ok(registry.heldUntil('coolbbs'), 'its name is held as for any removed BBS');
        assert.throws(() => registry.add('again', SysopDid), { code: 'banned' });
        assert.throws(
            () => registry.add('again', OtherSysopDid, SysopDid),
            { code: 'banned' },
            'nor as a BBS DID'
        );
        assert.throws(() => registry.setBbsDid('other', SysopDid), { code: 'banned' });

        //  a banned BBS account takes its BBS with it, not its sysop's others
        assert.deepEqual(registry.banDid(BbsDid).removed, ['theirs']);
        assert.equal(registry.get('other')?.state, 'active');
        assert.deepEqual(
            registry.bans().map(b => b.did),
            [SysopDid, BbsDid]
        );

        //  lifted: may register again, under a new name
        registry.unbanDid(SysopDid);
        assert.equal(registry.add('again', SysopDid).bbs.name, 'again');
        assert.throws(() => registry.unbanDid(SysopDid), { code: 'not-found' });
        assert.throws(() => registry.banDid('nope'), { code: 'bad-did' });
    });

    it("holds a removed BBS's name for 90 days, unless the admin frees it", () => {
        let clock = new Date('2026-11-25T12:00:00Z');
        const registry = testRegistry(() => clock);
        registry.add('coolbbs', SysopDid);
        registry.remove('coolbbs');
        assert.equal(registry.heldUntil('coolbbs'), '2027-02-23T12:00:00.000Z');
        assert.throws(() => registry.add('coolbbs', OtherSysopDid), { code: 'taken' });
        clock = new Date('2027-02-23T12:00:01Z');
        assert.equal(registry.add('coolbbs', OtherSysopDid).bbs.sysopDid, OtherSysopDid);

        registry.remove('coolbbs');
        assert.equal(registry.release('coolbbs'), true);
        assert.equal(registry.release('coolbbs'), false);
        assert.equal(registry.add('coolbbs', SysopDid).bbs.name, 'coolbbs');
    });

    it('takes applications, and registers one when approved', () => {
        let clock = new Date('2026-11-25T12:00:00Z');
        const registry = testRegistry(() => clock);
        const app = registry.apply(
            'coolbbs',
            SysopDid,
            BbsDid,
            { web: 9080 },
            '  A board for\nretro games  '
        );
        assert.equal(app.status, 'pending');
        assert.equal(app.note, 'A board for\nretro games');
        assert.equal(registry.get('coolbbs'), null, 'not registered yet');
        assert.throws(
            () => registry.apply('coolbbs', OtherSysopDid),
            { code: 'taken' },
            'the name is spoken for'
        );
        assert.throws(() => registry.add('coolbbs', OtherSysopDid), { code: 'taken' });
        assert.deepEqual(
            registry.applications().map(a => a.name),
            ['coolbbs']
        );

        const bbs = registry.approve('coolbbs');
        assert.deepEqual(
            [bbs.sysopDid, bbs.bbsDid, bbs.webPort, bbs.state],
            [SysopDid, BbsDid, 9080, 'active']
        );
        assert.equal(registry.application('coolbbs'), null);
        assert.throws(() => registry.approve('coolbbs'), { code: 'not-found' });

        //  rejected: the sysop sees why for 30 days, and may apply again
        registry.apply('second', SysopDid);
        const no = registry.reject('second', 'Tell us more\nabout it');
        assert.deepEqual([no.status, no.reason], ['rejected', 'Tell us more about it']);
        assert.equal(registry.applications().length, 0);
        assert.equal(registry.applications(true).length, 1);
        assert.throws(() => registry.apply('second', OtherSysopDid), { code: 'taken' });
        assert.equal(registry.apply('second', SysopDid).status, 'pending');
        registry.reject('second');
        clock = new Date('2026-12-26T12:00:00Z');
        assert.equal(registry.applicationsFor(SysopDid).length, 0, 'forgotten after 30 days');

        //  a sysop may withdraw only their own
        registry.apply('third', SysopDid);
        assert.equal(registry.withdraw('third', OtherSysopDid), false);
        assert.equal(registry.withdraw('third', SysopDid), true);
    });

    it('counts applications toward the per-sysop limit, and refuses banned DIDs', () => {
        const registry = testRegistry();
        registry.add('one', SysopDid);
        registry.apply('two', SysopDid);
        registry.apply('three', SysopDid);
        assert.throws(() => registry.apply('four', SysopDid), { code: 'limit' });
        assert.equal(registry.approve('two').name, 'two', 'approving one counts it once');
        registry.banDid(OtherSysopDid);
        assert.throws(() => registry.apply('mine', OtherSysopDid), { code: 'banned' });
        assert.throws(() => registry.apply('x', OtherSysopDid), { code: 'bad-name' });
    });

    it('a BBS DID belongs to one BBS', () => {
        const registry = testRegistry();
        registry.add('coolbbs', SysopDid);
        registry.add('other', OtherSysopDid);
        registry.setBbsDid('coolbbs', BbsDid);
        assert.equal(registry.getByDid(BbsDid)?.name, 'coolbbs');
        assert.throws(() => registry.setBbsDid('other', BbsDid), { code: 'taken' });
        registry.setBbsDid('coolbbs', null);
        assert.equal(registry.setBbsDid('other', BbsDid).bbsDid, BbsDid);
    });

    it('tracks the tunnel: connected while any proxy is open', () => {
        let clock = Date.UTC(2026, 10, 9, 12, 0, 0);
        const registry = testRegistry(() => new Date(clock));
        registry.add('coolbbs', SysopDid);

        registry.proxyOpened('coolbbs', 'coolbbs.ws', 'run1');
        registry.proxyOpened('coolbbs', 'coolbbs.web', 'run1');
        let bbs = registry.mustGet('coolbbs');
        assert.equal(bbs.connected, true);
        assert.equal(bbs.lastConnectedAt, '2026-11-09T12:00:00.000Z');

        clock += 60_000;
        registry.proxyClosed('coolbbs', 'coolbbs.ws');
        assert.equal(registry.mustGet('coolbbs').connected, true);
        registry.proxyClosed('coolbbs', 'coolbbs.web');
        bbs = registry.mustGet('coolbbs');
        assert.equal(bbs.connected, false);
        assert.equal(bbs.lastDisconnectedAt, '2026-11-09T12:01:00.000Z');

        //  a close for a proxy never opened changes nothing
        clock += 60_000;
        registry.proxyClosed('coolbbs', 'coolbbs.ws');
        assert.equal(registry.mustGet('coolbbs').lastDisconnectedAt, '2026-11-09T12:01:00.000Z');
    });

    it('removing a BBS removes its tunnel records', () => {
        const registry = testRegistry();
        registry.add('coolbbs', SysopDid);
        registry.proxyOpened('coolbbs', 'coolbbs.ws', null);
        registry.remove('coolbbs');
        assert.equal(registry.get('coolbbs'), null);
        assert.equal(registry.openProxies('coolbbs'), 0);
        assert.throws(() => registry.remove('coolbbs'), { code: 'not-found' });
    });
});

describe('registry upgrades', () => {
    it('adds the port columns to a schema 1 registry, keeping its BBSes', async () => {
        const { mkdtempSync, rmSync } = await import('node:fs');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const { DatabaseSync } = await import('node:sqlite');
        const dir = mkdtempSync(join(tmpdir(), 'hub-reg-'));
        const file = join(dir, 'hub.sqlite');
        const old = new DatabaseSync(file);
        old.exec(`CREATE TABLE bbs (name TEXT PRIMARY KEY, sysop_did TEXT NOT NULL, bbs_did TEXT,
            state TEXT NOT NULL DEFAULT 'active', token_hash TEXT NOT NULL, created_at TEXT NOT NULL,
            last_connected_at TEXT, last_disconnected_at TEXT);
            INSERT INTO bbs (name, sysop_did, token_hash, created_at) VALUES ('oldbbs', '${SysopDid}', 'x', 'then');
            PRAGMA user_version = 1;`);
        old.close();
        const registry = new Registry(file, { reservedNames: [], maxBbsPerSysop: 3 });
        const bbs = registry.mustGet('oldbbs');
        assert.equal(bbs.webPort, 8080);
        assert.equal(bbs.wsPort, 8810);
        registry.close();
        rmSync(dir, { recursive: true, force: true });
    });
});
