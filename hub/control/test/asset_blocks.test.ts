import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artOnHub, AssetBlocks, resolveHash } from '../src/asset_blocks.ts';
import { AssetLibrary } from '../src/assets.ts';
import { bakeOne } from '../src/bake.ts';
import { readPsf } from '../src/ansi_image.ts';
import { Moderation } from '../src/moderation.ts';
import type { Registry } from '../src/registry.ts';
import { testFont, testRegistry } from './helpers.ts';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

describe('blocked art', () => {
    let registry: Registry;
    let dir: string;

    beforeEach(() => {
        registry = testRegistry();
        dir = mkdtempSync(join(tmpdir(), 'hub-blocks-'));
    });
    afterEach(() => {
        registry.close();
        rmSync(dir, { recursive: true, force: true });
    });

    //  a library of two pieces, baked as the hub's own
    function library(path: string) {
        const font = readPsf(testFont(dir));
        mkdirSync(join(path, 'files'), { recursive: true });
        const items = ['FIRST', 'SECOND'].map(text => {
            const { files, item } = bakeOne(
                `${text.toLowerCase()}.ans`,
                Buffer.from(`\x1b[1;32m${text}\x1b[0m\r\n`, 'latin1'),
                {
                    font: '',
                    mci: false,
                    licence: { id: 'CC-BY-4.0' },
                    rating: 'general',
                    themes: [],
                    author: 'Ana',
                    group: '',
                    note: '',
                },
                font
            );
            for (const [hash, body] of files) {
                writeFileSync(join(path, 'files', hash), body);
            }
            return item;
        });
        writeFileSync(
            join(path, 'library.json'),
            JSON.stringify({ $type: 'x', name: 'Art', description: '', createdAt: '', items })
        );
        return items;
    }

    it('blocks and unblocks by hash, in the moderation log, read again by refresh()', () => {
        const blocks = new AssetBlocks(registry.db);
        const other = new AssetBlocks(registry.db);
        const hash = sha(Buffer.from('x'));
        blocks.block(hash.toUpperCase(), 'not\x01 ours');
        assert.equal(blocks.has(hash), true);
        assert.equal(other.has(hash), false, 'another process sees it at its next refresh');
        assert.equal(other.refresh(), true);
        assert.equal(other.has(hash), true);
        assert.equal(other.refresh(), false, 'nothing new');
        assert.deepEqual(
            blocks.list().map(b => [b.sha256, b.reason]),
            [[hash, 'not  ours']]
        );
        assert.equal(blocks.unblock(hash), true);
        assert.equal(blocks.unblock(hash), false);
        other.refresh();
        assert.equal(other.has(hash), false);
        const log = new Moderation(registry.db).history().map(e => [e.action, e.subject]);
        assert.deepEqual(log, [
            ['asset-block', hash],
            ['asset-unblock', hash],
        ]);
        assert.throws(() => blocks.block('abc', ''), /64 hex digits/);
    });

    it("hides a library's piece, and stops serving all its files, while any of them is blocked", () => {
        const items = library(join(dir, 'lib'));
        const blocked = new Set<string>();
        const art = AssetLibrary.load(join(dir, 'lib'), () => {}, hash => blocked.has(hash));
        const [first] = art.items;
        assert.equal(art.items.length, 2);
        const image = first!.image.url.replace('/assets/', '');
        blocked.add(image);
        assert.deepEqual(art.items.map(i => i.name), [items[1]!.record.name]);
        assert.equal(art.file(first!.ansi.replace('/assets/', '')), null, 'its other files too');
        assert.equal(art.find(first!.id.slice(0, 12)), null);
        blocked.clear();
        assert.equal(art.items.length, 2, 'back once unblocked');
        assert.ok(art.file(image));
    });

    it("lists the hub's art by whose it is, and finds a file by the start of its hash", () => {
        const ours = library(join(dir, 'lib'));
        const boards = join(dir, 'board-art');
        library(boards);
        writeFileSync(
            join(boards, 'boards.json'),
            JSON.stringify({ 'splash:coolbbs': { raw: 'r', id: ours[0]!.id }, [`piece:coolbbs:${'b'.repeat(64)}`]: { raw: 'r', id: ours[1]!.id } })
        );
        const art = artOnHub({ library: join(dir, 'lib'), boardArt: boards });
        assert.deepEqual(
            art.map(a => a.owner),
            ["the hub's library", "the hub's library", "coolbbs's splash", "coolbbs's art"]
        );
        assert.equal(art[0]!.files[0], ours[0]!.id, 'its id first');
        assert.equal(resolveHash(ours[0]!.id.slice(0, 12), art), ours[0]!.id);
        assert.equal(resolveHash('c'.repeat(64), art), 'c'.repeat(64), 'a whole hash as it is');
        assert.throws(() => resolveHash('abc', art), /first 12 or more/);
        assert.throws(() => resolveHash('f'.repeat(12), art), /No file on the hub/);
        assert.deepEqual(artOnHub({ library: '', boardArt: join(dir, 'none') }), []);
    });
});
