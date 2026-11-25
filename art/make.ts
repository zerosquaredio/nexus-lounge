//  The project's own ANSI art, drawn by code: block letters from an
//  alphabet made here (not taken from any font), turned into ANSI's
//  half-block characters, two pixels to a character cell.
//
//    node art/make.ts         writes the .ANS files beside this one
//
//  Everything here is the project's, under CC BY 4.0 (art/README.md).

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Cp437, writeAnsi, type Cell, type Grid } from '../hub/control/src/ansi.ts';

//  ANSI colours by name (ANSI order; 8 to 15 are the bright ones)
const C = {
    black: 0,
    red: 1,
    green: 2,
    brown: 3,
    blue: 4,
    magenta: 5,
    cyan: 6,
    grey: 7,
    dark: 8,
    pink: 9,
    lime: 10,
    yellow: 11,
    sky: 12,
    rose: 13,
    aqua: 14,
    white: 15,
};

//  A 5 by 7 alphabet, drawn here: # is set
const Letters: Record<string, string[]> = {
    A: [' ### ', '#   #', '#   #', '#####', '#   #', '#   #', '#   #'],
    B: ['#### ', '#   #', '#   #', '#### ', '#   #', '#   #', '#### '],
    C: [' ####', '#    ', '#    ', '#    ', '#    ', '#    ', ' ####'],
    E: ['#####', '#    ', '#    ', '#### ', '#    ', '#    ', '#####'],
    N: ['#   #', '##  #', '# # #', '#  ##', '#   #', '#   #', '#   #'],
    P: ['#### ', '#   #', '#   #', '#### ', '#    ', '#    ', '#    '],
    R: ['#### ', '#   #', '#   #', '#### ', '# #  ', '#  # ', '#   #'],
    S: [' ####', '#    ', '#    ', ' ### ', '    #', '    #', '#### '],
    T: ['#####', '  #  ', '  #  ', '  #  ', '  #  ', '  #  ', '  #  '],
    U: ['#   #', '#   #', '#   #', '#   #', '#   #', '#   #', ' ### '],
    X: ['#   #', '#   #', ' # # ', '  #  ', ' # # ', '#   #', '#   #'],
    Y: ['#   #', '#   #', ' # # ', '  #  ', '  #  ', '  #  ', '  #  '],
    2: [' ### ', '#   #', '    #', '   # ', '  #  ', ' #   ', '#####'],
    ' ': ['     ', '     ', '     ', '     ', '     ', '     ', '     '],
};

//  A picture of colours (or -1 for nothing), in pixels
type Pixels = number[][];

function blank(width: number, height: number): Pixels {
    return Array.from({ length: height }, () => Array(width).fill(-1));
}

//  Words in block letters, each pixel scaled up, coloured by row, with a
//  shadow one pixel down and to the right
function words(
    text: string,
    scale: number,
    colourOf: (row: number, rows: number) => number,
    shadow: number
): Pixels {
    const glyphs = [...text.toUpperCase()].map(ch => Letters[ch] ?? Letters[' ']!);
    const width = glyphs.length * 6 * scale + 1;
    const height = 7 * scale + 1;
    const out = blank(width, height);
    glyphs.forEach((glyph, g) => {
        glyph.forEach((line, y) => {
            [...line].forEach((bit, x) => {
                if ('#' !== bit) {
                    return;
                }
                for (let dy = 0; dy < scale; dy++) {
                    for (let dx = 0; dx < scale; dx++) {
                        const px = g * 6 * scale + x * scale + dx;
                        const py = y * scale + dy;
                        if (out[py + 1]![px + 1] === -1) {
                            out[py + 1]![px + 1] = shadow;
                        }
                        out[py]![px] = colourOf(py, 7 * scale);
                    }
                }
            });
        });
    });
    return out;
}

const Space = 32;
const Upper = 0xdf; //  ▀
const Lower = 0xdc; //  ▄
const Full = 0xdb; //  █

//  Pixels into character cells: two pixel rows to a row of cells
function toGrid(pixels: Pixels, background = C.black): Grid {
    const rows: Cell[][] = [];
    for (let y = 0; y < pixels.length; y += 2) {
        const top = pixels[y]!;
        const bottom = pixels[y + 1] ?? top.map(() => -1);
        rows.push(
            top.map((t, x) => {
                const b = bottom[x]!;
                const tc = t < 0 ? background : t;
                const bc = b < 0 ? background : b;
                if (tc === bc) {
                    return tc === background
                        ? { ch: Space, fg: C.grey, bg: background }
                        : { ch: Full, fg: tc, bg: background };
                }
                return { ch: Upper, fg: tc, bg: bc };
            })
        );
    }
    return { width: Math.max(...rows.map(r => r.length)), rows, ice: rows.some(r => r.some(c => c.bg >= 8)) };
}

//  Plain text in a row of cells, in CP437
function text(content: string, fg: number, bg = C.black): Cell[] {
    return [...content].map(ch => ({ ch: Math.max(0, Cp437.indexOf(ch)), fg, bg }));
}

function pad(cells: Cell[], left: number): Cell[] {
    return [...Array.from({ length: left }, () => ({ ch: Space, fg: C.grey, bg: C.black })), ...cells];
}

//  A bar fading from one side: ░▒▓█▓▒░
function bar(width: number, fg: number): Cell[] {
    const shades = [0xb0, 0xb1, 0xb2];
    return Array.from({ length: width }, (_, i) => {
        const edge = Math.min(i, width - 1 - i);
        return { ch: edge < 3 ? shades[edge]! : Full, fg, bg: C.black };
    });
}

function centre(cells: Cell[], width: number): Cell[] {
    return pad(cells, Math.max(0, Math.floor((width - cells.length) / 2)));
}

function save(name: string, grid: Grid, title: string): void {
    const file = writeAnsi(grid, {
        title,
        author: 'Nexus Lounge',
        group: 'cyberspace.nexus',
        date: '20261125',
    });
    writeFileSync(join(import.meta.dirname, name), file);
    console.log(`${name}: ${grid.width}x${grid.rows.length}`);
}

//  test2: pink and white, for the second test board
{
    const logo = toGrid(
        words(
            'test2',
            2,
            (row, rows) => (row < rows * 0.3 ? C.white : row < rows * 0.75 ? C.rose : C.magenta),
            C.dark
        )
    );
    const width = 78;
    const lines: Cell[][] = [
        centre(bar(60, C.rose), width),
        [],
        ...logo.rows.map(r => centre(r, width)),
        [],
        centre(text('the second test board of the nexus lounge', C.white), width),
        centre(text('pink  *  white  *  ansi', C.rose), width),
        [],
        centre(bar(60, C.magenta), width),
    ];
    save('TEST2.ANS', { width, rows: lines, ice: false }, 'test2');
}

//  The small emblem for the map: a pink diamond with T2 in it
{
    const d = [
        '      ##      ',
        '    ######    ',
        '  ##########  ',
        '##############',
        '  ##########  ',
        '    ######    ',
        '      ##      ',
    ];
    const px = d.map((line, y) => [...line].map(ch => ('#' === ch ? (y < 3 ? C.rose : C.magenta) : -1)));
    const grid = toGrid([...px, Array(14).fill(-1)]);
    const label = text('T2', C.white, C.magenta);
    const row = grid.rows[1]!;
    row.splice(6, 2, ...label);
    save('TEST2EMB.ANS', grid, 'test2 emblem');
}

//  Cyberspace Nexus: a banner the hub can use, cyan on black
{
    const big = toGrid(
        words(
            'nexus',
            2,
            (row, rows) => (row < rows * 0.3 ? C.white : row < rows * 0.7 ? C.aqua : C.cyan),
            C.blue
        )
    );
    const width = 78;
    const lines: Cell[][] = [
        centre(text('· · · c y b e r s p a c e · · ·', C.aqua), width),
        [],
        ...big.rows.map(r => centre(r, width)),
        [],
        centre(bar(64, C.blue), width),
        centre(text('a hub for bulletin board systems, on the AT network', C.grey), width),
    ];
    save('NEXUS.ANS', { width, rows: lines, ice: false }, 'Cyberspace Nexus');
}
