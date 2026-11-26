import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoardArt, fontPath } from '../src/board_art.ts';
import { makeConfig } from '../src/config.ts';
import { sanitizeListing } from '../src/listing.ts';
import { agentConfig } from '../src/generate.ts';
import type { Bbs } from '../src/registry.ts';
import { testFont } from './helpers.ts';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

//  a splash with one of ENiGMA½'s menu codes in it, and SAUCE naming its artist
function splash(text = 'WELCOME TO COOLBBS'): Buffer {
    const art = Buffer.from(`\x1b[1;36m${text}\x1b[0m %TL1 node %NN\r\n`, 'latin1');
    const sauce = Buffer.alloc(128, 0x20);
    sauce.write('SAUCE00', 0, 'latin1');
    sauce.write('Cool welcome', 7, 'latin1');
    sauce.write('Ana', 42, 'latin1');
    sauce.write('ACiD', 62, 'latin1');
    sauce.write('20261126', 82, 'latin1');
    sauce.writeUInt32LE(art.length, 90);
    sauce[94] = 1;
    sauce[95] = 1;
    sauce.writeUInt16LE(80, 96);
    sauce.writeUInt16LE(1, 98);
    sauce[104] = 0;
    return Buffer.concat([art, Buffer.from([0x1a]), sauce]);
}

const bbs = (name: string, extra: Partial<Bbs> = {}) =>
    ({ name, state: 'active', connected: true, ...extra }) as Bbs;

describe("BBSes' own splash screens", () => {
    let dir: string;
    let fetched: string[];
    let offers: Map<string, { sha256: string; size: number }>;
    let files: Map<string, Buffer>;

    const make = (boardSplashes = ['coolbbs'], list = [bbs('coolbbs'), bbs('other')]) =>
        new BoardArt(
            {
                config: makeConfig({ assets: { boardSplashes, font: testFont(dir) } }),
                list: () => list,
                splashOf: b => offers.get(b.name) ?? null,
                fetch: async (b, hash) => {
                    fetched.push(`${b.name}:${hash.slice(0, 8)}`);
                    const body = files.get(hash);
                    if (!body) {
                        throw new Error('the BBS answered 404');
                    }
                    return body;
                },
            },
            join(dir, 'board-art')
        );
    const offer = (name: string, body: Buffer) => {
        files.set(sha(body), body);
        offers.set(name, { sha256: sha(body), size: body.length });
    };

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'hub-board-art-'));
        fetched = [];
        offers = new Map();
        files = new Map();
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('takes what a BBS offers, baked, credited from SAUCE, its menu codes blanked', async () => {
        const art = make();
        offer('coolbbs', splash());
        await art.refresh();
        const item = art.splashFor(bbs('coolbbs'));
        assert.ok(item);
        assert.equal(item.name, 'Cool welcome');
        assert.deepEqual(item.credit, { author: 'Ana', group: 'ACiD', note: "coolbbs's splash screen" });
        assert.equal(item.licence.text, "Shown on this hub with the BBS's consent");
        const ansi = art.file(item.ansi.replace('/assets/', ''))!.body.toString('latin1');
        assert.match(ansi, /WELCOME TO COOLBBS/);
        assert.doesNotMatch(ansi, /%TL1|%NN/, "none of the board's live details");
        assert.ok(art.file(item.thumb.url.replace('/assets/', '')), 'and its pictures');
    });

    it('fetches each file once, and keeps it across a restart', async () => {
        offer('coolbbs', splash());
        await make().refresh();
        const again = make();
        await again.refresh();
        assert.deepEqual(fetched, [`coolbbs:${offers.get('coolbbs')!.sha256.slice(0, 8)}`]);
        assert.ok(again.splashFor(bbs('coolbbs')));
    });

    it('takes new art when the BBS offers it, and shows none once it stops', async () => {
        const art = make();
        offer('coolbbs', splash());
        await art.refresh();
        offer('coolbbs', splash('A NEW LOOK'));
        assert.equal(art.splashFor(bbs('coolbbs')), null, 'not the old one meanwhile');
        await art.refresh();
        assert.match(art.file(art.splashFor(bbs('coolbbs'))!.ansi.slice(8))!.body.toString('latin1'), /A NEW LOOK/);
        offers.delete('coolbbs');
        assert.equal(art.splashFor(bbs('coolbbs')), null);
    });

    it('takes nothing from BBSes it was not told to, offline, or suspended', async () => {
        offer('other', splash());
        offer('coolbbs', splash('X'));
        const art = make(['coolbbs'], [bbs('other'), bbs('coolbbs', { connected: false })]);
        await art.refresh();
        assert.deepEqual(fetched, []);
        assert.equal(art.splashFor(bbs('other')), null);
        const suspended = make(['coolbbs'], [bbs('coolbbs', { state: 'suspended' })]);
        await suspended.refresh();
        assert.deepEqual(fetched, []);
    });

    it("refuses a file that isn't the one named, or isn't ANSI art, and waits before trying again", async () => {
        const art = make();
        const real = splash();
        files.set(sha(real), Buffer.from('something else entirely'));
        offers.set('coolbbs', { sha256: sha(real), size: real.length });
        await art.refresh();
        await art.refresh();
        assert.equal(fetched.length, 1, 'tried once, not again at once');
        assert.equal(art.splashFor(bbs('coolbbs')), null);

        offers.set('coolbbs', { sha256: 'a'.repeat(64), size: 100 * 1024 });
        await art.refresh();
        assert.equal(fetched.length, 1, 'too large to fetch at all');
    });

    it('draws with the web terminal\'s own font unless told another', () => {
        assert.equal(
            fontPath(makeConfig({ webTerminal: { root: '/opt/enig-term' } })).replaceAll('\\', '/'),
            '/opt/enig-term/fonts/pc/cp437-8x16.psf'
        );
        assert.equal(fontPath(makeConfig({ assets: { font: '/x.psf' } })), '/x.psf');
        assert.throws(() => fontPath(makeConfig({})), /no font/);
    });
});

describe('a listing naming its splash, and the tunnel that serves it', () => {
    it('keeps a splash named by hash and size, and nothing else', () => {
        const listing = (splash: unknown) => sanitizeListing({ name: 'Cool', splash })?.splash;
        assert.deepEqual(listing({ sha256: 'ab'.repeat(32), size: 120, mediaType: 'text/x-ansi', x: 1 }), {
            sha256: 'ab'.repeat(32),
            size: 120,
        });
        for (const bad of [
            null,
            'ab'.repeat(32),
            { sha256: 'AB'.repeat(32), size: 1 },
            { sha256: 'ab'.repeat(31), size: 1 },
            { sha256: 'ab'.repeat(32), size: 0 },
            { sha256: 'ab'.repeat(32), size: 64 * 1024 + 1 },
            { sha256: 'ab'.repeat(32), size: '120' },
        ]) {
            assert.equal(listing(bad), null, JSON.stringify(bad));
        }
    });

    it("forwards /assets/ to a BBS's web server, where it offers the file", () => {
        const text = agentConfig(makeConfig({}), { name: 'coolbbs', token: 't' });
        assert.match(text, /locations = \[[^\]]*"\/assets\/"[^\]]*\]/);
    });
});
