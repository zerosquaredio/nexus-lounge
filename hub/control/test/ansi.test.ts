import { createHash } from 'node:crypto';
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import {
    blankMci,
    gridText,
    isCleanAnsi,
    MaxAnsiBytes,
    parseAnsi,
    readSauce,
    writeAnsi,
} from '../src/ansi.ts';
import { readPsf, renderPng, renderThumb } from '../src/ansi_image.ts';
import { AssetLibrary } from '../src/assets.ts';
import { bake, type BakeOptions, type Library } from '../src/bake.ts';
import { testFont as makeFont } from './helpers.ts';

const dir = mkdtempSync(join(tmpdir(), 'hub-ansi-'));
after(() => rmSync(dir, { recursive: true, force: true }));

const testFont = () => makeFont(dir);

const bytes = (text: string) => Buffer.from(text, 'latin1');

//  every escape sequence in a file's art (before its SAUCE)
function escapes(file: Buffer): string[] {
    const art = file.subarray(0, file.indexOf(0x1a)).toString('latin1');
    return art.match(/\x1b[^a-zA-Z]*[a-zA-Z]?/g) ?? [];
}

function pngSize(png: Buffer): { width: number; height: number } {
    return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

describe('ANSI art', () => {
    it('plays colours, cursor movement and line ends into a grid', () => {
        const grid = parseAnsi(
            bytes('\x1b[1;31mA\x1b[0;44mB\x1b[3CC\nD\r\n\x1b[2;10HE\x1b[s\x1b[5;1H\x1b[uF')
        );
        const row0 = grid.rows[0]!;
        assert.deepEqual(
            [row0[0], row0[1]],
            [
                { ch: 65, fg: 9, bg: 0 },
                { ch: 66, fg: 7, bg: 4 },
            ]
        );
        assert.equal(row0[5]?.ch, 67, 'three columns forward');
        assert.equal(grid.rows[1]![0]?.ch, 68, 'a bare line feed starts a new line');
        assert.equal(grid.rows[1]![9]?.ch, 69, 'moved to row 2, column 10');
        assert.equal(grid.rows[1]![10]?.ch, 70, 'back where it was saved');
        assert.equal(grid.rows.length, 2, 'no blank rows at the end');
    });

    it('wraps at the width, and takes a full line then a line end as one line', () => {
        const grid = parseAnsi(bytes('ABCD\r\nEFGHIJ'), { width: 4 });
        assert.deepEqual(
            grid.rows.map(r => r.map(c => String.fromCharCode(c.ch)).join('')),
            ['ABCD', 'EFGH', 'IJ']
        );
    });

    it('drops everything but characters, colours and line ends', () => {
        const evil = bytes(
            '\x1b]0;a title\x07\x1b[?25l\x1b[6n\x1bP+q544e\x1b\\\x1b[0;32mOK\x1b[38;2;1;2;3m!\x1b[1t\x07'
        );
        const grid = parseAnsi(evil);
        assert.equal(gridText(grid), 'OK!\n');
        const out = writeAnsi(grid);
        assert.ok(
            escapes(out).every(e => /^\x1b\[[0-9;]*m$/.test(e)),
            `only colours: ${JSON.stringify(escapes(out))}`
        );
        assert.equal(isCleanAnsi(out), true);
        assert.equal(isCleanAnsi(evil), false);
    });

    it('keeps iCE colours, and writes and reads SAUCE', () => {
        const grid = parseAnsi(bytes('\x1b[5;44mX'), { ice: true });
        assert.equal(grid.rows[0]![0]!.bg, 12, 'blink means a bright background');
        assert.equal(grid.ice, true);
        const out = writeAnsi(grid, { title: 'Test', author: 'Ana', group: 'Grp', date: '20261125' });
        const { sauce } = readSauce(out);
        assert.deepEqual(
            [sauce?.title, sauce?.author, sauce?.group, sauce?.date, sauce?.width, sauce?.height, sauce?.ice],
            ['Test', 'Ana', 'Grp', '20261125', 1, 1, true]
        );
        assert.match(out.toString('latin1'), /\x1b\[0;5;37;44mX/);
        assert.equal(isCleanAnsi(out), true);
    });

    it('comes out the same when written and read again, whatever ends its rows', () => {
        //  rows ending in a PC graphic in a control position (written as a
        //  space), in CP437's no-break space, and a last row of nothing but
        //  graphics: none may change the width or the rows on a second pass
        const art = Buffer.from([
            0x41, 0x01, 0x0d, 0x0a, 0x42, 0xff, 0x0d, 0x0a, 0x43, 0x0d, 0x0a, 0x02, 0x03,
        ]);
        const once = writeAnsi(parseAnsi(art, { width: 4 }));
        assert.equal(isCleanAnsi(once), true);
        assert.deepEqual([readSauce(once).sauce?.width, readSauce(once).sauce?.height], [1, 3]);
    });

    it("blanks ENiGMA½'s menu codes, keeping the layout", () => {
        assert.equal(
            Buffer.from(blankMci(bytes('Name: %UN  %TL12!'))).toString('latin1'),
            `Name:${' '.repeat(11)}!`
        );
    });

    it('calls clean what uses only characters, colours and line ends, whoever wrote it', () => {
        //  as another tool might write it: other colour codes from the set,
        //  bare line feeds, no SAUCE at all
        assert.equal(isCleanAnsi(bytes('\x1b[1;32;40mHi\x1b[22;39;49m there\n\xdb\xdb\x1b[m\r\n')), true);
        assert.equal(
            isCleanAnsi(Buffer.concat([bytes('Hi'), Buffer.from([0x1a])])),
            true,
            'an end mark alone'
        );
        for (const bad of [
            '\x1b[2J',
            '\x1b[5C',
            '\x1b]0;title\x07',
            '\x1b[38;5;196m',
            '\x1b[6n',
            'a bell\x07',
            'x'.repeat(161),
        ]) {
            assert.equal(isCleanAnsi(bytes(bad)), false, JSON.stringify(bad));
        }
        assert.equal(isCleanAnsi(Buffer.concat([bytes('Hi'), Buffer.from([0x1a]), bytes('junk')])), false);
    });

    it('has a size limit', () => {
        assert.throws(() => parseAnsi(Buffer.alloc(MaxAnsiBytes + 1, 0x41)), { code: 'too-large' });
    });

    it('turns into text through CP437', () => {
        assert.equal(gridText(parseAnsi(Buffer.from([0xdb, 0xb0, 0x01, 0x20, 0x41]))), '█░☺ A\n');
    });

    it('draws at 8 by 16 a character, and half that for a thumbnail', () => {
        const font = readPsf(testFont());
        const grid = parseAnsi(Buffer.from([0x1b, ...bytes('[1;32m'), 0xdb, 0x20]));
        const png = renderPng(grid, font);
        assert.deepEqual(pngSize(png), { width: 8, height: 16 }, 'the trailing space is trimmed');
        //  the image's rows: a filter byte, then one palette index a pixel
        const at = png.indexOf('IDAT');
        const raw = inflateSync(png.subarray(at + 4, at + 4 + png.readUInt32BE(at - 4)));
        assert.equal(raw.length, 16 * 9);
        assert.ok(
            [...raw].filter((_, k) => k % 9).every(v => 10 === v),
            'all bright green'
        );
        assert.deepEqual(pngSize(renderThumb(grid, font)), { width: 4, height: 8 });
    });
});

describe('baking, and the hub loading what was baked', () => {
    const options = (font: string): BakeOptions => ({
        font,
        mci: true,
        licence: { id: 'CC-BY-4.0' },
        rating: 'general',
        themes: ['cyberpunk'],
        author: 'Ana',
        group: '',
        note: '',
    });

    it('bakes every version, and the hub serves them once checked', () => {
        const font = testFont();
        const art = join(dir, 'one.ans');
        writeFileSync(art, bytes('\x1b[1;36mHELLO %UN\r\n\x1b]0;x\x07\x1b[31mworld'));
        const out = join(dir, 'lib1');
        const library = bake([art, art], out, options(font), { name: 'Test art', description: 'For tests' });
        assert.equal(library.items.length, 1, 'the same art twice is baked once');
        const item = library.items[0]!;
        assert.deepEqual(
            item.record.versions.map(v => [v.form, v.made, v.size]),
            [
                ['ansi', 'hand', { width: 5, height: 2 }],
                ['image', 'derived', { width: 40, height: 32 }],
                ['image', 'derived', { width: 20, height: 16 }],
                ['text', 'derived', undefined],
            ]
        );
        assert.equal(item.record.$type, 'nexus.cyberspace.dev.asset.item');
        assert.equal(item.record.description.short, 'one: ANSI art by Ana');
        assert.equal(
            readFileSync(join(out, 'files', item.record.versions[3]!.file.sha256), 'utf8'),
            'HELLO\nworld\n'
        );

        const logs: string[] = [];
        const hub = AssetLibrary.load(out, line => logs.push(line));
        assert.equal(hub.items.length, 1, logs.join('\n'));
        const served = hub.items[0]!;
        assert.equal(hub.byShortId(item.id.slice(0, 12))?.name, 'one');
        assert.equal(hub.file(served.thumb.url.slice(8))?.type, 'image/png');
        assert.equal(hub.file(served.ansi.slice(8))?.type, 'text/x-ansi');
        assert.equal(hub.file('0'.repeat(64)), null);
    });

    it("passes over versions of kinds it doesn't serve, keeping the rest of the item", () => {
        const out = join(dir, 'lib3');
        writeFileSync(join(dir, 'c.ans'), bytes('third'));
        const library = bake([join(dir, 'c.ans')], out, options(testFont()), { name: 'x', description: '' });
        //  a newer baker's version, of a kind this hub doesn't know
        (library.items[0]!.record.versions as unknown[]).push({
            form: 'voxel',
            file: { sha256: 'f'.repeat(64), size: 1, mediaType: 'application/x-vox' },
            made: 'derived',
        });
        (library.items[0]!.record as unknown as Record<string, unknown>).sparkles = 'a field from the future';
        writeFileSync(join(out, 'library.json'), JSON.stringify(library));
        const logs: string[] = [];
        const hub = AssetLibrary.load(out, line => logs.push(line));
        assert.equal(hub.items.length, 1, logs.join('\n'));
        assert.equal(hub.file('f'.repeat(64)), null, 'and serves nothing for it');
    });

    it("leaves out an item whose files don't match their hashes, or whose ANSI isn't clean", () => {
        const font = testFont();
        const out = join(dir, 'lib2');
        writeFileSync(join(dir, 'a.ans'), bytes('first'));
        writeFileSync(join(dir, 'b.ans'), bytes('second'));
        const library = bake([join(dir, 'a.ans'), join(dir, 'b.ans')], out, options(font), {
            name: 'x',
            description: '',
        });
        //  a: a file changed after baking
        const png = library.items[0]!.record.versions[1]!.file.sha256;
        writeFileSync(join(out, 'files', png), Buffer.from('not the same'));
        //  b: its ANSI swapped for unclean art, under that art's own hash
        const dirty = bytes('\x1b]0;title\x07second');
        const hash = createHash('sha256').update(dirty).digest('hex');
        writeFileSync(join(out, 'files', hash), dirty);
        const b = library.items[1]!;
        b.record.versions[0]!.file = { sha256: hash, size: dirty.length, mediaType: 'text/x-ansi' };
        b.id = hash;
        writeFileSync(join(out, 'library.json'), JSON.stringify(library satisfies Library));

        const logs: string[] = [];
        const hub = AssetLibrary.load(out, line => logs.push(line));
        assert.equal(hub.items.length, 0);
        assert.match(logs.join('\n'), /left out a: a file that doesn't match its hash/);
        assert.match(logs.join('\n'), /left out b: ANSI art that isn't clean/);
    });
});
