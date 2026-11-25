//  ANSI art (assets spec §6.2): read it into a grid of character cells, and
//  write it out again with nothing but characters, colours and line ends.
//
//  An ANSI file is a stream of terminal commands, so it is never passed on
//  as it came. It is played into a grid here, the way a DOS terminal would
//  show it, and the grid is written out afresh: whatever else was in the
//  stream (window titles, terminal queries, device modes, other escape
//  strings) has nowhere to go. SAUCE, the metadata block at the end of most
//  BBS art, is read for width, iCE colours and credit, and written back.

import { HubError } from './errors.ts';

//  limits (assets spec §6.3)
export const MaxAnsiBytes = 64 * 1024;
export const MaxAnsiColumns = 160;
export const MaxAnsiRows = 1000;

//  CP437, the IBM PC's character set, as Unicode. The low 32 are the PC's
//  graphics characters, which is how DOS showed them in art.
export const Cp437 = Array.from(
    '\u0000☺☻♥♦♣♠•◘○◙♂♀♪♫☼►◄↕‼¶§▬↨↑↓→←∟↔▲▼' +
        ' !"#$%&\'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~⌂' +
        'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»' +
        '░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀' +
        'αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ '
);
if (256 !== Cp437.length) {
    throw new Error(`the CP437 table has ${Cp437.length} entries`);
}

export interface Sauce {
    title: string;
    author: string;
    group: string;
    //  CCYYMMDD, as SAUCE has it
    date: string;
    //  columns and rows, when the file says (0 when it doesn't)
    width: number;
    height: number;
    //  background colours 8 to 15 instead of blinking
    ice: boolean;
    //  the font the art was drawn for ("IBM VGA", …)
    font: string;
    comments: string[];
}

export interface Cell {
    ch: number;
    //  0 to 15, in ANSI order (black, red, green, yellow, blue, magenta,
    //  cyan, white, then the bright ones)
    fg: number;
    bg: number;
}

export interface Grid {
    width: number;
    rows: Cell[][];
    //  any background from 8 to 15
    ice: boolean;
}

function cp437Text(bytes: Uint8Array): string {
    return Array.from(bytes, b => (0 === b ? ' ' : Cp437[b]))
        .join('')
        .trim();
}

//  The art and its SAUCE record, if it has one. The art ends at the first
//  end-of-file mark (Ctrl-Z), or where SAUCE's comments or record begin.
export function readSauce(file: Uint8Array): { body: Uint8Array; sauce: Sauce | null } {
    let end = file.length;
    let sauce: Sauce | null = null;
    const at = file.length - 128;
    if (at >= 0 && 'SAUCE00' === Buffer.from(file.subarray(at, at + 7)).toString('latin1')) {
        const r = Buffer.from(file.subarray(at));
        const count = r[104] ?? 0;
        const comments: string[] = [];
        end = at;
        const block = at - 5 - 64 * count;
        if (
            count > 0 &&
            block >= 0 &&
            'COMNT' === Buffer.from(file.subarray(block, block + 5)).toString('latin1')
        ) {
            for (let i = 0; i < count; i++) {
                comments.push(cp437Text(file.subarray(block + 5 + 64 * i, block + 5 + 64 * (i + 1))));
            }
            end = block;
        }
        //  only character art says anything about columns and rows
        const character = 1 === r[94];
        sauce = {
            title: cp437Text(r.subarray(7, 42)),
            author: cp437Text(r.subarray(42, 62)),
            group: cp437Text(r.subarray(62, 82)),
            date: r
                .subarray(82, 90)
                .toString('latin1')
                .replace(/[^0-9]/g, ''),
            width: character ? r.readUInt16LE(96) : 0,
            height: character ? r.readUInt16LE(98) : 0,
            ice: character && 1 === ((r[105] ?? 0) & 1),
            font: r.subarray(106, 128).toString('latin1').replace(/\0.*$/s, '').trim(),
            comments,
        };
    }
    const eof = file.subarray(0, end).indexOf(0x1a);
    return { body: file.subarray(0, eof >= 0 ? eof : end), sauce };
}

//  ENiGMA½'s theme screens hold places for its menus to fill in (MCI codes
//  such as %TL1 or %VM2), which mean nothing outside it. Blanked, keeping
//  the layout.
export function blankMci(body: Uint8Array): Uint8Array {
    const text = Buffer.from(body)
        .toString('latin1')
        .replace(/%[A-Z]{2}[0-9]{0,2}/g, m => ' '.repeat(m.length));
    return Buffer.from(text, 'latin1');
}

const Esc = 0x1b;

//  Play the art into a grid, as a DOS terminal would. Only printing,
//  cursor movement, erasing and colours are acted on; everything else is
//  read past and dropped.
export function parseAnsi(body: Uint8Array, options: { width?: number; ice?: boolean } = {}): Grid {
    if (body.length > MaxAnsiBytes) {
        throw new HubError('too-large', `ANSI art is limited to ${MaxAnsiBytes / 1024} KB`);
    }
    const width = Math.min(MaxAnsiColumns, options.width && options.width > 0 ? options.width : 80);
    const ice = !!options.ice;
    const rows: Cell[][] = [];
    let x = 0;
    let y = 0;
    let fg = 7;
    let bg = 0;
    let bold = false;
    let blink = false;
    let reverse = false;
    let saved = { x: 0, y: 0 };

    const row = (n: number): Cell[] => {
        while (rows.length <= n) {
            rows.push([]);
        }
        return rows[n]!;
    };
    const put = (ch: number) => {
        if (x >= width) {
            x = 0;
            y++;
        }
        if (y >= MaxAnsiRows) {
            return;
        }
        const r = row(y);
        while (r.length < x) {
            r.push({ ch: 32, fg: 7, bg: 0 });
        }
        let f = fg < 8 && bold ? fg + 8 : fg;
        let b = blink && ice ? bg + 8 : bg;
        if (reverse) {
            [f, b] = [b, f];
        }
        r[x] = { ch, fg: f, bg: b };
        x++;
    };
    const sgr = (params: number[]) => {
        for (const p of params.length ? params : [0]) {
            if (0 === p) {
                fg = 7;
                bg = 0;
                bold = blink = reverse = false;
            } else if (1 === p) {
                bold = true;
            } else if (2 === p || 22 === p) {
                bold = false;
            } else if (5 === p || 6 === p) {
                blink = true;
            } else if (25 === p) {
                blink = false;
            } else if (7 === p) {
                reverse = true;
            } else if (27 === p) {
                reverse = false;
            } else if (p >= 30 && p <= 37) {
                fg = p - 30;
            } else if (39 === p) {
                fg = 7;
            } else if (p >= 40 && p <= 47) {
                bg = p - 40;
            } else if (49 === p) {
                bg = 0;
            } else if (p >= 90 && p <= 97) {
                fg = p - 90 + 8;
            } else if (p >= 100 && p <= 107) {
                bg = p - 100;
                blink = ice;
            }
        }
    };

    //  a byte of the art, or 0 past its end
    const at = (k: number): number => body[k] ?? 0;
    let i = 0;
    while (i < body.length) {
        const c = at(i);
        if (Esc === c) {
            const next = at(i + 1);
            if (0x5b === next) {
                //  CSI: parameters, then one final byte
                let j = i + 2;
                const isPrivate = j < body.length && at(j) >= 0x3c && at(j) <= 0x3f;
                while (j < body.length && at(j) >= 0x20 && at(j) <= 0x3f) {
                    j++;
                }
                const final = at(j);
                const text = Buffer.from(body.subarray(i + 2, j)).toString('latin1');
                i = j + 1;
                if (isPrivate || /[ -/]/.test(text)) {
                    continue;
                }
                const params = text.split(';').map(v => (/^\d+$/.test(v) ? Math.min(9999, Number(v)) : -1));
                const n = (k: number, dflt: number): number => {
                    const v = params[k] ?? -1;
                    return v > 0 ? v : dflt;
                };
                switch (String.fromCharCode(final)) {
                    case 'm':
                        sgr(text ? params.filter(p => p >= 0) : []);
                        break;
                    case 'A':
                        y = Math.max(0, y - n(0, 1));
                        break;
                    case 'B':
                        y = Math.min(MaxAnsiRows - 1, y + n(0, 1));
                        break;
                    case 'C':
                        x = Math.min(width - 1, x + n(0, 1));
                        break;
                    case 'D':
                        x = Math.max(0, Math.min(x, width - 1) - n(0, 1));
                        break;
                    case 'H':
                    case 'f':
                        y = Math.min(MaxAnsiRows - 1, n(0, 1) - 1);
                        x = Math.min(width - 1, n(1, 1) - 1);
                        break;
                    case 'J':
                        if (2 === params[0]) {
                            rows.length = 0;
                            x = y = 0;
                        }
                        break;
                    case 'K': {
                        const r = row(y);
                        r.length = Math.min(r.length, x);
                        break;
                    }
                    case 's':
                        saved = { x, y };
                        break;
                    case 'u':
                        ({ x, y } = saved);
                        break;
                    //  anything else (24-bit colour, scrolling, queries) is dropped
                }
                continue;
            }
            if (0x5d === next || 0x50 === next || 0x58 === next || 0x5e === next || 0x5f === next) {
                //  OSC, DCS, SOS, PM, APC: a string up to BEL or ESC \, all dropped
                let j = i + 2;
                while (j < body.length && 0x07 !== at(j) && !(Esc === at(j) && 0x5c === at(j + 1))) {
                    j++;
                }
                i = j + (Esc === at(j) ? 2 : 1);
                continue;
            }
            //  any other escape: it and the byte after it, dropped
            i += 2;
            continue;
        }
        i++;
        if (0x0d === c) {
            x = 0;
        } else if (0x0a === c) {
            //  a new line, as art viewers (and ENiGMA½) take it: art saved
            //  with Unix line ends has no carriage returns
            y++;
            x = 0;
        } else if (0x08 === c) {
            x = Math.max(0, Math.min(x, width) - 1);
        } else if (0x09 === c) {
            x = Math.min(width - 1, (Math.floor(x / 8) + 1) * 8);
        } else if (0x07 === c || 0x00 === c) {
            //  a bell, or nothing
        } else {
            put(c);
        }
    }

    //  no trailing blank rows, and as wide as the widest row without the
    //  blanks at its end
    while (rows.length && rows[rows.length - 1]!.every(isBlank)) {
        rows.pop();
    }
    const used = rows.reduce((most, r) => Math.max(most, usedLength(r)), 0);
    return {
        width: Math.max(1, Math.min(width, used)),
        rows,
        ice: rows.some(r => r.some(cell => cell.bg >= 8)),
    };
}

//  A cell that shows nothing: a space (or NUL, or CP437's no-break space) on
//  black. The parser and the writer must agree on this exactly, or art
//  written out and read again would come out a different width.
function isBlank(cell: Cell): boolean {
    return (32 === cell.ch || 0 === cell.ch || 255 === cell.ch) && 0 === cell.bg;
}

function usedLength(row: Cell[]): number {
    let end = row.length;
    while (end > 0 && isBlank(row[end - 1]!)) {
        end--;
    }
    return end;
}

//  The character a cell is written as. The PC's graphics in the control
//  positions (☺, ♥, ►, …) would reach a terminal as controls, so they become
//  spaces; the images keep them.
function written(cell: Cell): Cell {
    return cell.ch < 32 || 127 === cell.ch ? { ...cell, ch: 32 } : cell;
}

function sauceField(text: string, size: number): Buffer {
    const out = Buffer.alloc(size, 0x20);
    const bytes = Buffer.from(
        Array.from(text.slice(0, size), ch => {
            const at = Cp437.indexOf(ch);
            return at >= 32 ? at : 0x3f;
        })
    );
    bytes.copy(out);
    return out;
}

//  The grid as ANSI again: characters, colours and line ends only, then a
//  SAUCE record with what the original said about itself.
export function writeAnsi(grid: Grid, sauce: Partial<Sauce> = {}): Buffer {
    const parts: Buffer[] = [Buffer.from('\x1b[0m', 'latin1')];
    //  the rows as they will be written, without what reads back as nothing
    const rows = grid.rows.map(r => {
        const cells = Array.from({ length: Math.min(r.length, grid.width) }, (_, i) =>
            written(r[i] ?? { ch: 32, fg: 7, bg: 0 })
        );
        return cells.slice(0, usedLength(cells));
    });
    while (rows.length && !rows[rows.length - 1]!.length) {
        rows.pop();
    }
    const width = Math.max(1, ...rows.map(r => r.length));
    for (const r of rows) {
        let current = '';
        const bytes: number[] = [];
        for (const cell of r) {
            const attr = `0;${cell.fg >= 8 ? '1;' : ''}${cell.bg >= 8 ? '5;' : ''}${30 + (cell.fg % 8)};${40 + (cell.bg % 8)}`;
            if (attr !== current) {
                bytes.push(...Buffer.from(`\x1b[${attr}m`, 'latin1'));
                current = attr;
            }
            bytes.push(cell.ch);
        }
        parts.push(Buffer.from(bytes), Buffer.from('\x1b[0m\r\n', 'latin1'));
    }
    const art = Buffer.concat(parts);

    const record = Buffer.alloc(128, 0);
    Buffer.from('SAUCE00', 'latin1').copy(record, 0);
    sauceField(sauce.title ?? '', 35).copy(record, 7);
    sauceField(sauce.author ?? '', 20).copy(record, 42);
    sauceField(sauce.group ?? '', 20).copy(record, 62);
    Buffer.from((sauce.date ?? '').padEnd(8, ' ').slice(0, 8), 'latin1').copy(record, 82);
    record.writeUInt32LE(art.length, 90);
    record[94] = 1; //  character art
    record[95] = 1; //  ANSI
    record.writeUInt16LE(width, 96);
    record.writeUInt16LE(rows.length, 98);
    record[104] = 0;
    record[105] = grid.ice ? 1 : 0;
    Buffer.from('IBM VGA', 'latin1').copy(record, 106);
    return Buffer.concat([art, Buffer.from([0x1a]), record]);
}

//  The grid as plain text, for screen readers and anything that can't show
//  colour (assets spec §2)
export function gridText(grid: Grid): string {
    const lines = grid.rows.map(r =>
        r
            .map(cell => (0 === cell.ch ? ' ' : Cp437[cell.ch]))
            .join('')
            .replace(/[\s ]+$/, '')
    );
    return lines.join('\n') + '\n';
}

//  Whether a file is already clean: written out again, it is the same.
//  (The hub's check of baked art, assets spec §6.2.)
export function isCleanAnsi(file: Uint8Array): boolean {
    const { body, sauce } = readSauce(file);
    const grid = parseAnsi(body, { width: sauce?.width, ice: sauce?.ice });
    return Buffer.from(file).equals(writeAnsi(grid, sauce ?? {}));
}
