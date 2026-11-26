import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoardArt, fontPath, pieceOf } from '../src/board_art.ts';
import { artJson, artPageBody } from '../src/art_page.ts';
import type { PublicItem } from '../src/assets.ts';
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
    let emblems: Map<string, { sha256: string; size: number }>;
    let files: Map<string, Buffer>;

    const make = (boardArt = ['coolbbs'], list = [bbs('coolbbs'), bbs('other')]) =>
        new BoardArt(
            {
                config: makeConfig({ assets: { boardArt, font: testFont(dir) } }),
                list: () => list,
                artOf: (b, kind) => ('splash' === kind ? offers : emblems).get(b.name) ?? null,
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
        emblems = new Map();
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

    it("forgets a removed BBS's art, files and all, keeping what another BBS still uses", async () => {
        const list = [bbs('coolbbs'), bbs('other')];
        const art = make(['coolbbs', 'other'], list);
        offer('coolbbs', splash());
        offer('other', splash('OTHER BOARD'));
        emblems.set('coolbbs', offers.get('other')!);
        await art.refresh();
        const mine = art.splashFor(bbs('coolbbs'))!;
        const theirs = art.splashFor(bbs('other'))!;
        assert.ok(art.emblemFor(bbs('coolbbs')), "coolbbs's emblem is the other board's splash");
        const mineFiles = [mine.ansi, mine.thumb.url].map(u => u.replace('/assets/', ''));
        const theirFiles = [theirs.ansi, theirs.thumb.url].map(u => u.replace('/assets/', ''));

        list.splice(0, 1);
        await art.refresh();
        assert.equal(art.splashFor(bbs('coolbbs')), null);
        assert.equal(art.emblemFor(bbs('coolbbs')), null);
        for (const hash of mineFiles) {
            assert.equal(art.file(hash), null, 'its files are gone');
        }
        for (const hash of theirFiles) {
            assert.ok(art.file(hash), "the other board's are kept");
        }
        assert.ok(art.splashFor(bbs('other')));

        //  and stays gone after a restart
        const again = make(['coolbbs', 'other'], list);
        assert.equal(again.splashFor(bbs('coolbbs')), null);
        assert.ok(again.splashFor(bbs('other')));
        assert.doesNotMatch(readFileSync(join(dir, 'board-art', 'boards.json'), 'utf8'), /coolbbs/);
    });

    it('lets go of a splash replaced or no longer offered, files and all', async () => {
        const art = make();
        offer('coolbbs', splash());
        await art.refresh();
        const first = art.splashFor(bbs('coolbbs'))!;
        const firstFiles = [first.ansi, first.thumb.url].map(u => u.replace('/assets/', ''));
        offer('coolbbs', splash('A NEW LOOK'));
        await art.refresh();
        for (const hash of firstFiles) {
            assert.equal(existsSync(join(dir, 'board-art', 'files', hash)), false, 'the old one is gone');
        }
        const second = art.splashFor(bbs('coolbbs'))!;
        offers.delete('coolbbs');
        await art.refresh();
        assert.equal(art.file(second.ansi.replace('/assets/', '')), null);
        assert.deepEqual(JSON.parse(readFileSync(join(dir, 'board-art', 'library.json'), 'utf8')).items, []);
    });

    it('neither fetches a blocked splash nor shows one blocked after it was taken', async () => {
        const blocked = new Set<string>();
        const art = new BoardArt(
            {
                config: makeConfig({ assets: { boardArt: ['coolbbs'], font: testFont(dir) } }),
                list: () => [bbs('coolbbs')],
                artOf: (b, kind) => ('splash' === kind ? offers.get(b.name) ?? null : null),
                fetch: async (_b, hash) => {
                    fetched.push(hash);
                    return files.get(hash)!;
                },
                blocked: hash => blocked.has(hash),
            },
            join(dir, 'board-art')
        );
        offer('coolbbs', splash());
        blocked.add(offers.get('coolbbs')!.sha256);
        await art.refresh();
        assert.deepEqual(fetched, []);
        blocked.clear();
        await art.refresh();
        assert.ok(art.splashFor(bbs('coolbbs')));
        blocked.add(offers.get('coolbbs')!.sha256);
        assert.equal(art.splashFor(bbs('coolbbs')), null, 'blocked by the file it offered');
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

    it('takes an emblem too, kept apart from the splash, and the splash kept from before emblems', async () => {
        offer('coolbbs', splash());
        const mark = Buffer.from('\x1b[1;35m<>\x1b[0m\r\n', 'latin1');
        files.set(sha(mark), mark);
        emblems.set('coolbbs', { sha256: sha(mark), size: mark.length });
        const art = make();
        await art.refresh();
        assert.match(art.emblemFor(bbs('coolbbs'))!.credit.note!, /coolbbs's emblem/);
        assert.match(art.splashFor(bbs('coolbbs'))!.credit.note!, /coolbbs's splash screen/);
        assert.notEqual(art.emblemFor(bbs('coolbbs'))!.id, art.splashFor(bbs('coolbbs'))!.id);

        //  a hub from before emblems kept its splashes by the BBS's name alone
        const index = join(dir, 'board-art', 'boards.json');
        const kept = JSON.parse(readFileSync(index, 'utf8'));
        writeFileSync(index, JSON.stringify({ coolbbs: kept['splash:coolbbs'] }));
        const fetchedBefore = fetched.length;
        const again = make();
        assert.ok(again.splashFor(bbs('coolbbs')), 'still known');
        await again.refresh();
        assert.equal(fetched.length, fetchedBefore + 1, 'only the emblem is fetched again');
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
    it('keeps an emblem as it keeps a splash', () => {
        const emblem = { sha256: 'cd'.repeat(32), size: 40 };
        const kept = sanitizeListing({ name: 'Cool', emblem: { ...emblem, mediaType: 'text/x-ansi' } });
        assert.deepEqual(kept?.emblem, emblem);
        assert.equal(kept?.splash, null);
        assert.equal(sanitizeListing({ name: 'Cool', emblem: { sha256: 'x', size: 40 } })?.emblem, null);
    });

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

describe('the art BBSes publish from their accounts', () => {
    let dir: string;
    let records: { rkey: string; cid: string; value: unknown }[];
    let blobs: Map<string, Buffer>;
    let fetched: string[];

    const art = (text: string) => Buffer.from(`\x1b[1;33m${text}\x1b[0m\r\n`, 'latin1');
    const record = (body: Buffer, extra: Record<string, unknown> = {}) => {
        const hash = sha(body);
        blobs.set(`cid-${hash.slice(0, 10)}`, body);
        return {
            rkey: hash,
            cid: `rec-${hash.slice(0, 6)}`,
            value: {
                name: 'Skull',
                rating: 'general',
                licence: { id: 'CC-BY-4.0', url: 'https://creativecommons.org/licenses/by/4.0/' },
                credit: { author: 'Ana', group: 'ACiD' },
                versions: [
                    {
                        form: 'ansi',
                        file: { sha256: hash, size: body.length, mediaType: 'text/x-ansi' },
                        blob: { $type: 'blob', ref: { $link: `cid-${hash.slice(0, 10)}` }, mimeType: 'text/x-ansi', size: body.length },
                    },
                ],
                ...extra,
            },
        };
    };
    const at = {
        async listRecords() {
            return records;
        },
        async getBlob(_did: string, cid: string) {
            fetched.push(cid);
            const body = blobs.get(cid);
            if (!body) {
                throw new Error('HTTP 404');
            }
            return body;
        },
    };
    const board = (extra: Partial<Bbs> = {}) =>
        ({ name: 'coolbbs', state: 'active', connected: false, bbsDid: 'did:plc:cool', ...extra }) as Bbs;
    const make = (
        linked = true,
        ratings = ['general'],
        more: {
            blocked?: (sha256: string) => boolean;
            refused?: (did: string) => boolean;
            boardPieces?: number;
            boardArt?: string[];
        } = {}
    ) =>
        new BoardArt(
            {
                config: makeConfig({
                    assets: {
                        boardArt: more.boardArt ?? ['coolbbs'],
                        font: testFont(dir),
                        ...(undefined === more.boardPieces ? {} : { boardPieces: more.boardPieces }),
                    },
                    directory: { ratings },
                }),
                list: () => [board()],
                artOf: () => null,
                at: at as never,
                linked: () => linked,
                blocked: more.blocked,
                refused: more.refused,
            },
            join(dir, 'board-art')
        );
    const filesOf = (item: PublicItem) => [item.ansi, item.image.url, item.thumb.url].map(u => u.replace('/assets/', ''));

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'hub-pieces-'));
        records = [];
        blobs = new Map();
        fetched = [];
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('takes each piece, offline or not, named, credited and licensed as its record says', async () => {
        records = [record(art('SKULL'))];
        const hub = make();
        await hub.refreshPieces();
        const [piece] = hub.piecesFor(board());
        assert.ok(piece);
        assert.equal(piece.name, 'Skull', "the BBS's name for it");
        assert.deepEqual(piece.credit, { author: 'Ana', group: 'ACiD', note: 'from coolbbs' });
        assert.equal(piece.licence.id, 'CC-BY-4.0');
        assert.equal(piece.licence.url, 'https://creativecommons.org/licenses/by/4.0/');
        assert.ok(hub.file(piece.thumb.url.replace('/assets/', '')), 'drawn, and served');
    });

    it('fetches each file once, across restarts, and follows what the BBS publishes now', async () => {
        const skull = record(art('SKULL'));
        const logo = record(art('LOGO'), { name: 'Logo' });
        records = [skull, logo];
        await make().refreshPieces();
        assert.equal(fetched.length, 2);
        records = [logo];
        const again = make();
        assert.equal(again.piecesFor(board()).length, 2, 'as last read, until read again');
        await again.refreshPieces();
        assert.equal(fetched.length, 2, 'nothing fetched again');
        assert.deepEqual(again.piecesFor(board()).map(p => p.name), ['Logo']);
    });

    it('lets go of a piece, files and all, once its record is gone (withdrawn)', async () => {
        const skull = record(art('SKULL'));
        const logo = record(art('LOGO'), { name: 'Logo' });
        records = [skull, logo];
        const hub = make();
        await hub.refreshPieces();
        const gone = hub.piecesFor(board()).find(p => 'Skull' === p.name)!;
        records = [logo];
        await hub.refreshPieces();
        for (const hash of filesOf(gone)) {
            assert.equal(hub.file(hash), null, 'not served');
            assert.equal(existsSync(join(dir, 'board-art', 'files', hash)), false, 'not kept');
        }
        assert.deepEqual(hub.piecesFor(board()).map(p => p.name), ['Logo']);
        assert.equal(make().piecesFor(board()).length, 1, 'and after a restart');
    });

    it('lets go of all of a BBS once the hub no longer takes its art', async () => {
        records = [record(art('SKULL'))];
        await make().refreshPieces();
        const [piece] = make().piecesFor(board());
        const off = make(true, ['general'], { boardArt: [] });
        await off.refreshPieces();
        assert.equal(off.file(filesOf(piece!)[0]!), null);
        assert.deepEqual(JSON.parse(readFileSync(join(dir, 'board-art', 'library.json'), 'utf8')).items, []);
    });

    it('neither fetches nor shows a blocked piece, and shows it again once unblocked', async () => {
        const skull = record(art('SKULL'));
        const logo = record(art('LOGO'), { name: 'Logo' });
        const blocked = new Set([skull.rkey]);
        records = [skull, logo];
        const hub = make(true, ['general'], { blocked: hash => blocked.has(hash) });
        await hub.refreshPieces();
        assert.deepEqual(fetched, [`cid-${logo.rkey.slice(0, 10)}`], 'the blocked one not fetched');
        assert.deepEqual(hub.piecesFor(board()).map(p => p.name), ['Logo']);

        //  blocked after it was taken: hidden and not served, by any of its files
        blocked.clear();
        await hub.refreshPieces();
        const taken = hub.piecesFor(board()).find(p => 'Skull' === p.name)!;
        blocked.add(filesOf(taken)[1]!);
        assert.deepEqual(hub.piecesFor(board()).map(p => p.name), ['Logo']);
        for (const hash of filesOf(taken)) {
            assert.equal(hub.file(hash), null);
        }
        blocked.clear();
        assert.equal(hub.piecesFor(board()).length, 2, 'back once unblocked');
    });

    it('takes nothing from an account the hub refuses, and lets go of what it took', async () => {
        records = [record(art('SKULL'))];
        const refused = new Set<string>();
        const hub = make(true, ['general'], { refused: did => refused.has(did) });
        await hub.refreshPieces();
        const [piece] = hub.piecesFor(board());
        refused.add('did:plc:cool');
        await hub.refreshPieces();
        assert.deepEqual(hub.piecesFor(board()), []);
        assert.equal(hub.file(filesOf(piece!)[0]!), null, 'let go of');
        records = [record(art('NEW'))];
        await hub.refreshPieces();
        assert.equal(fetched.length, 1, 'nothing new fetched');
    });

    it('reads one account again soon after the stream says its art changed, once for many changes', async () => {
        const hub = make();
        hub.settleMs = 10;
        records = [record(art('SKULL'))];
        hub.piecesChanged('did:plc:cool');
        hub.piecesChanged('did:plc:cool');
        hub.piecesChanged('did:plc:someone-else');
        await new Promise(resolve => setTimeout(resolve, 50));
        await hub.refreshPieces([]);
        assert.equal(hub.piecesFor(board()).length, 1);
        assert.equal(fetched.length, 1);
    });

    it('takes no more pieces from a BBS than assets.boardPieces', async () => {
        records = [record(art('ONE')), record(art('TWO')), record(art('THREE'))];
        const hub = make(true, ['general'], { boardPieces: 2 });
        await hub.refreshPieces();
        assert.equal(hub.piecesFor(board()).length, 2);
        assert.equal(fetched.length, 2);
    });

    it('takes nothing from BBSes not linked here or not allowed, nor ratings the hub does not show', async () => {
        records = [record(art('SKULL'))];
        const unlinked = make(false);
        await unlinked.refreshPieces();
        assert.deepEqual(unlinked.piecesFor(board()), []);
        records = [record(art('SPICY'), { rating: 'adult' })];
        const general = make();
        await general.refreshPieces();
        assert.deepEqual(general.piecesFor(board()), []);
        assert.equal(fetched.length, 0);
        assert.deepEqual(general.piecesFor(board({ name: 'other' })), []);
    });

    it('refuses a file that is not the one its record names', async () => {
        const r = record(art('SKULL'));
        blobs.set(((r.value as { versions: { blob: { ref: { $link: string } } }[] }).versions[0]!.blob.ref.$link), art('OTHER'));
        records = [r];
        const hub = make();
        await hub.refreshPieces();
        assert.deepEqual(hub.piecesFor(board()), []);
    });

    it("takes a piece's record over a splash of the same art", async () => {
        const body = art('LOGO');
        const hub = new BoardArt(
            {
                config: makeConfig({ assets: { boardArt: ['coolbbs'], font: testFont(dir) } }),
                list: () => [board({ connected: true })],
                artOf: (_b, kind) => ('splash' === kind ? { sha256: sha(body), size: body.length } : null),
                fetch: async () => body,
                at: at as never,
                linked: () => true,
            },
            join(dir, 'board-art')
        );
        await hub.refresh();
        assert.match(hub.splashFor(board())!.licence.text!, /consent/);
        //  the same name as the splash took (its file's), so the same art
        records = [record(body, { name: 'coolbbs', credit: {} })];
        await hub.refreshPieces();
        const [piece] = hub.piecesFor(board());
        assert.equal(piece!.id, hub.splashFor(board())!.id, 'one copy of the art');
        assert.equal(piece!.licence.id, 'CC-BY-4.0');
        assert.equal(hub.splashFor(board())!.licence.id, 'CC-BY-4.0', 'one copy, as its record says');
    });

    it('reads only records that are ANSI art keyed by their file, small enough, with a blob', () => {
        const ok = record(art('SKULL'));
        assert.ok(pieceOf(ok.rkey, ok.value));
        assert.equal(pieceOf('other-key', ok.value), null, 'keyed by its hash');
        const v = ok.value as Record<string, unknown>;
        const versions = v.versions as Record<string, unknown>[];
        assert.equal(pieceOf(ok.rkey, { ...v, versions: [{ ...versions[0], form: 'image' }] }), null);
        assert.equal(pieceOf(ok.rkey, { ...v, versions: [{ ...versions[0], blob: {} }] }), null);
        const big = { ...versions[0], file: { ...(versions[0]!.file as object), size: 100 * 1024 } };
        assert.equal(pieceOf(ok.rkey, { ...v, versions: [big] }), null);
        const odd = pieceOf(ok.rkey, { ...v, rating: 'spicy', licence: { url: 'javascript:alert(1)' } })!;
        assert.equal(odd.rating, 'general');
        assert.deepEqual(odd.licence, { id: 'custom' });
    });
});

describe("the gallery and the chat's list, with BBSes' art", () => {
    it("shows each BBS's pieces under its name, and lists them for the chat", () => {
        const item = {
            id: 'ab'.repeat(32),
            name: 'Skull',
            description: { short: 'Skull: ANSI art' },
            credit: { author: 'Ana', note: 'from coolbbs' },
            licence: { id: 'CC-BY-4.0' },
            themes: [],
            rating: 'general',
            image: { url: '/assets/x', width: 8, height: 16 },
            thumb: { url: '/assets/y', width: 4, height: 8 },
            ansi: '/assets/z',
            text: null,
        } as PublicItem;
        const page = artPageBody(null, [{ bbs: 'coolbbs', title: 'Cool BBS', items: [item] }]);
        assert.match(page, /<h2>From Cool BBS<\/h2>/);
        assert.match(page, /<h3>Skull<\/h3>/);
        assert.doesNotMatch(page, /Nothing here yet/);
        const list = artJson(null, [
            { bbs: 'coolbbs', title: 'Cool BBS', items: [item] },
            { bbs: 'otherbbs', title: 'Other', items: [item] },
        ]) as { items: { name: string }[] };
        assert.deepEqual(list.items.map(i => i.name), ['Skull'], 'the same art once');
    });
});
