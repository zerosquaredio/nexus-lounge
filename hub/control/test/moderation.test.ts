import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../src/cli.ts';
import { makeConfig } from '../src/config.ts';
import {
    blockText,
    describeSubject,
    isPersonId,
    MaxMutes,
    Moderation,
    parseDuration,
    parseSubject,
} from '../src/moderation.ts';
import { Registry } from '../src/registry.ts';
import { OtherSysopDid, SysopDid } from './helpers.ts';

const Alice = SysopDid;
const Bob = OtherSysopDid;

describe('moderation', () => {
    let registry: Registry;
    let clock: number;
    let moderation: Moderation;

    beforeEach(() => {
        registry = new Registry(':memory:', makeConfig().registration);
        clock = Date.parse('2026-11-19T12:00:00.000Z');
        moderation = new Moderation(registry.db, () => clock);
    });

    afterEach(() => registry.close());

    it('reads who the admin means', () => {
        assert.equal(parseSubject(Alice), Alice);
        assert.equal(parseSubject('Dave@CoolBBS'), 'user:coolbbs:dave');
        assert.equal(parseSubject('*@coolbbs'), 'vouched:coolbbs');
        assert.equal(describeSubject('user:coolbbs:dave'), 'dave@coolbbs');
        assert.equal(describeSubject('vouched:coolbbs'), '*@coolbbs');
        assert.equal(describeSubject(Alice), Alice);
        for (const bad of ['did:key:x', 'dave', '@coolbbs', 'dave@Not A Name', 'a:b@coolbbs']) {
            assert.throws(() => parseSubject(bad), /not a/, bad);
        }
        assert.equal(parseDuration('30m'), 30 * 60_000);
        assert.equal(parseDuration('7d'), 7 * 86_400_000);
        assert.equal(parseDuration('forever'), null);
        for (const bad of ['0h', '1w', '12', 'soon']) {
            assert.throws(() => parseDuration(bad), /not a time/, bad);
        }
        assert.ok(isPersonId(`person:${Alice}`));
        assert.ok(isPersonId('person:via:coolbbs:0123456789ab'));
        assert.ok(isPersonId('person:vouched:coolbbs:0123456789ab'));
        for (const bad of ['person:did:key:x', 'person:via:coolbbs:xyz', 'leaf:coolbbs', 42, null]) {
            assert.equal(isPersonId(bad), false, String(bad));
        }
    });

    it('blocks for the space or the room, for a time or for good, and lifts them', () => {
        const room = moderation.block(Alice, 'room', { forMs: 60 * 60_000, reason: 'flooding\nthe room' });
        assert.equal(room.reason, 'flooding the room');
        assert.equal(moderation.blockOf([Alice], 'space'), null, 'the room only');
        assert.equal(moderation.blockOf([Alice], 'room')?.id, room.id);
        const space = moderation.block(Alice, 'space');
        //  a block on the space covers the room, and the longest wins
        assert.equal(moderation.blockOf([Alice], 'room')?.id, space.id);
        assert.equal(moderation.blockOf([Bob, Alice], 'space')?.id, space.id);
        assert.equal(moderation.blockOf([Bob], 'space'), null);
        moderation.unblock(space.id);
        assert.throws(() => moderation.unblock(space.id), /already lifted/);
        assert.equal(moderation.blockOf([Alice], 'room')?.id, room.id);
        clock += 60 * 60_000;
        assert.equal(moderation.blockOf([Alice], 'room'), null, 'ran out');
        assert.equal(moderation.blocks().length, 0);
        assert.equal(moderation.blocks(true).length, 2);
        assert.deepEqual(
            moderation.history().map(e => e.action),
            ['block', 'block', 'unblock']
        );
    });

    it('tells the blocked person who blocked them', () => {
        const block = moderation.block(Alice, 'space', { forMs: 86_400_000, reason: 'spam' });
        assert.equal(blockText(block, 'hub.test'), 'The admin of hub.test has blocked you from its common space until 2026-11-20 12:00 UTC: spam.');
        assert.equal(
            blockText(moderation.block(Alice, 'room'), 'hub.test'),
            'The admin of hub.test has blocked you from its chat room.'
        );
    });

    it("keeps each person's mutes to themselves", () => {
        moderation.mute(Alice, `person:${Bob}`, '@bob.example');
        moderation.mute(Alice, `person:${Bob}`, '@bob.example');
        assert.deepEqual([...moderation.muted(Alice)], [`person:${Bob}`]);
        assert.deepEqual([...moderation.muted(Bob)], []);
        assert.equal(moderation.mutes(Alice)[0]?.label, '@bob.example');
        assert.equal(moderation.version(), 0, 'mutes are not moderation');
        moderation.unmute(Alice, `person:${Bob}`);
        assert.equal(moderation.muted(Alice).size, 0);
        for (let i = 0; i < MaxMutes; i++) {
            moderation.mute(Alice, `person:via:coolbbs:${i.toString(16).padStart(12, '0')}`, 'x');
        }
        assert.throws(() => moderation.mute(Alice, `person:${Bob}`, 'x'), /at most/);
        moderation.forget(Alice);
        assert.equal(moderation.muted(Alice).size, 0);
    });

    it('keeps reports until the admin is done, then lets what was said go', () => {
        const said = [{ did: Bob, nick: 'bob', text: 'something', time: '2026-11-19T11:59:00.000Z' }];
        const r = moderation.report({ reporter: Alice, person: `person:${Bob}`, subject: Bob, label: '@bob', note: 'Rude‮.', messages: said });
        assert.equal(r.note, 'Rude .');
        assert.deepEqual(moderation.reports().map(x => x.id), [r.id]);
        const closed = moderation.closeReport(r.id, 'blocked for a day');
        assert.deepEqual(closed.messages, []);
        assert.equal(closed.outcome, 'blocked for a day');
        assert.equal(moderation.reports().length, 0);
        assert.equal(moderation.reports(true).length, 1);
        assert.throws(() => moderation.closeReport(r.id, ''), /already closed/);
        assert.deepEqual(
            moderation.history().map(e => e.action),
            ['report', 'close-report']
        );
    });
});

describe('moderation from the command line', () => {
    let dir: string;
    let configFile: string;
    let out: string[];
    const log = console.log;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'hub-moderation-'));
        configFile = join(dir, 'hub.json');
        writeFileSync(configFile, JSON.stringify({ domain: 'hub.test', database: join(dir, 'hub.db') }));
        out = [];
        console.log = (...args: unknown[]) => void out.push(args.join(' '));
    });

    afterEach(() => {
        console.log = log;
        rmSync(dir, { recursive: true, force: true });
    });

    const cli = (...args: string[]) => run(['--config', configFile, ...args]);

    it('blocks, lists, lifts, and keeps a record', async () => {
        await cli('space', 'block', 'dave@coolbbs', '--room', '--for', '12h', '--reason', 'flooding');
        assert.match(out.at(-1) ?? '', /^#1 {2}dave@coolbbs {2}room, until .+ {2}"flooding"$/);
        await cli('space', 'block', '*@coolbbs');
        await cli('space', 'blocks');
        assert.equal(out.slice(-2).length, 2);
        assert.match(out.at(-1) ?? '', /^#2 {2}\*@coolbbs {2}space, for good$/);
        await cli('space', 'unblock', '2');
        await cli('space', 'log');
        assert.deepEqual(
            out.slice(-3).map(l => l.split(/\s+/)[1]),
            ['block', 'block', 'unblock']
        );
        await assert.rejects(cli('space', 'block', 'nobody'), /not a DID/);
        await assert.rejects(cli('space', 'block', Alice, '--for', 'soon'), /not a time/);
        await assert.rejects(cli('space', 'unblock', 'x'), /whole number/);
    });

    it('shows a report with what was said, safely, and closes it', async () => {
        const registry = new Registry(join(dir, 'hub.db'), makeConfig().registration);
        new Moderation(registry.db).report({
            reporter: Alice,
            person: `person:${Bob}`,
            subject: Bob,
            label: '@bob.example',
            note: 'Rude.',
            messages: [{ did: null, nick: 'evil\u001b[2J', text: 'hi\u0007 there', time: '2026-11-19T11:59:00.000Z' }],
        });
        registry.close();
        await cli('space', 'reports');
        assert.match(out.at(-1) ?? '', /^#1 .* about @bob\.example {2}from did:plc:a+$/);
        await cli('space', 'report', '1');
        const text = out.at(-1) ?? '';
        assert.match(text, /block {3}did:plc:b+/);
        assert.match(text, /11:59:00 {2}evil \[2J \(unverified\): hi  there/);
        assert.equal(/[\u0000-\u001f]/.test(text.replace(/\n/g, '')), false, 'no control codes reach the terminal');
        await cli('space', 'close', '1', '--outcome', 'warned');
        await cli('space', 'reports');
        assert.equal(out.at(-1), 'No reports.');
    });
});
