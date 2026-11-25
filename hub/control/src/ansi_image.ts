//  ANSI art as pictures (assets spec §2): drawn with the IBM PC's VGA font,
//  as a PNG, and a half-size one for lists and the chat.
//
//  The font is enig-term's (the web terminal the hub serves), a PSF2
//  bitmap: VileR's Ultimate Oldschool PC Font Pack, CC BY-SA 4.0. Pictures
//  drawn with a font aren't covered by the font's licence; it is credited on
//  the gallery page anyway.

import { readFileSync } from 'node:fs';
import { crc32, deflateSync } from 'node:zlib';
import type { Grid } from './ansi.ts';
import { HubError } from './errors.ts';

//  The VGA palette, in ANSI order
export const Palette: [number, number, number][] = [
    [0x00, 0x00, 0x00],
    [0xaa, 0x00, 0x00],
    [0x00, 0xaa, 0x00],
    [0xaa, 0x55, 0x00],
    [0x00, 0x00, 0xaa],
    [0xaa, 0x00, 0xaa],
    [0x00, 0xaa, 0xaa],
    [0xaa, 0xaa, 0xaa],
    [0x55, 0x55, 0x55],
    [0xff, 0x55, 0x55],
    [0x55, 0xff, 0x55],
    [0xff, 0xff, 0x55],
    [0x55, 0x55, 0xff],
    [0xff, 0x55, 0xff],
    [0x55, 0xff, 0xff],
    [0xff, 0xff, 0xff],
];

export interface Font {
    width: number;
    height: number;
    //  256 glyphs, each `height` rows of bits, leftmost pixel highest
    glyphs: Uint8Array[];
}

//  A PSF2 font with 256 glyphs, at most 8 pixels wide
export function readPsf(path: string): Font {
    const data = readFileSync(path);
    if (data.length < 32 || 0x864ab572 !== data.readUInt32LE(0)) {
        throw new HubError('font', `${path} is not a PSF2 font`);
    }
    const headerSize = data.readUInt32LE(8);
    const count = data.readUInt32LE(16);
    const charSize = data.readUInt32LE(20);
    const height = data.readUInt32LE(24);
    const width = data.readUInt32LE(28);
    if (count < 256 || width > 8 || charSize !== height || data.length < headerSize + 256 * charSize) {
        throw new HubError('font', `${path} isn't a 256-glyph font 8 pixels wide`);
    }
    const glyphs = Array.from({ length: 256 }, (_, g) =>
        data.subarray(headerSize + g * charSize, headerSize + (g + 1) * charSize)
    );
    return { width, height, glyphs };
}

function chunk(type: string, body: Buffer): Buffer {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])) >>> 0, 0);
    return Buffer.concat([head, body, crc]);
}

//  A PNG: rows of palette indexes (with a palette) or of RGB bytes
export function encodePng(
    width: number,
    height: number,
    rows: Buffer[],
    palette?: [number, number, number][]
): Buffer {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = palette ? 3 : 2;
    const raw = Buffer.concat(rows.flatMap(r => [Buffer.from([0]), r]));
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', header),
        ...(palette ? [chunk('PLTE', Buffer.from(palette.flat()))] : []),
        chunk('IDAT', deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}

//  Each pixel's colour, as a palette index
function pixels(grid: Grid, font: Font): { width: number; height: number; rows: Buffer[] } {
    const width = grid.width * font.width;
    const height = Math.max(1, grid.rows.length) * font.height;
    const rows = Array.from({ length: height }, () => Buffer.alloc(width, 0));
    grid.rows.forEach((r, cy) => {
        for (let cx = 0; cx < Math.min(r.length, grid.width); cx++) {
            const cell = r[cx];
            if (!cell) {
                continue;
            }
            const glyph = font.glyphs[cell.ch]!;
            for (let gy = 0; gy < font.height; gy++) {
                const bits = glyph[gy] ?? 0;
                const row = rows[cy * font.height + gy]!;
                for (let gx = 0; gx < font.width; gx++) {
                    row[cx * font.width + gx] = bits & (0x80 >> gx) ? cell.fg : cell.bg;
                }
            }
        }
    });
    return { width, height, rows };
}

//  The art at full size: 8 by 16 pixels a character, as a DOS screen
export function renderPng(grid: Grid, font: Font): Buffer {
    const { width, height, rows } = pixels(grid, font);
    return encodePng(width, height, rows, Palette);
}

//  Half size, each pixel the average of four, for lists and the chat
export function renderThumb(grid: Grid, font: Font): Buffer {
    const full = pixels(grid, font);
    const width = Math.max(1, full.width >> 1);
    const height = Math.max(1, full.height >> 1);
    const rows: Buffer[] = [];
    for (let y = 0; y < height; y++) {
        const out = Buffer.alloc(width * 3);
        for (let x = 0; x < width; x++) {
            for (let c = 0; c < 3; c++) {
                const colour = (px: number, py: number): number =>
                    Palette[full.rows[py]?.[px] ?? 0]?.[c] ?? 0;
                const sum =
                    colour(2 * x, 2 * y) +
                    colour(2 * x + 1, 2 * y) +
                    colour(2 * x, 2 * y + 1) +
                    colour(2 * x + 1, 2 * y + 1);
                out[x * 3 + c] = Math.round(sum / 4);
            }
        }
        rows.push(out);
    }
    return encodePng(width, height, rows);
}
