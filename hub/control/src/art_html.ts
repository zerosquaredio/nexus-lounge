//  Art drawn on the hub's pages by the hub itself, with no scripts: a board's
//  splash screen on the directory and on its own page, in the form the
//  viewer's view asks for (views.ts): a picture, ANSI drawn as coloured
//  characters in the VGA font, or its description.

import { Cp437, parseAnsi, readSauce } from './ansi.ts';
import { Palette } from './ansi_image.ts';
import type { AssetLibrary, PublicItem } from './assets.ts';
import { esc } from './html.ts';
import type { ArtForm } from './views.ts';

//  The IBM VGA font, for art drawn as characters: VileR's, CC BY-SA 4.0,
//  served unchanged (fonts/LICENSE-int10h.txt)
export const VgaFontPath = '/fonts/vga-8x16.woff';

//  The VGA colours, as classes for art drawn as characters. A view with
//  colours of its own overrides them (views.ts)
export const AnsiColours = Palette.map(([r, g, b], i) => {
    const hex = `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`;
    return `.ansi .f${i} { color: ${hex}; } .ansi .b${i} { background: ${hex}; }`;
}).join('\n');

//  For pages that show art. The VGA font's characters are half as wide as
//  they are tall, so --cols sets a size at which the art fits the page:
//  at most 16px (the font's own size) for a splash, 8px on a card
export const ArtStyle = `@font-face { font-family: "Hub VGA"; src: url("${VgaFontPath}") format("woff"); font-display: swap; }
pre.ansi { display: block; width: max-content; max-width: 100%; margin: .5rem 0; padding: 2px; overflow: hidden;
  background: #000; color: #aaa; border: 1px solid var(--line);
  font-family: "Hub VGA", ui-monospace, Consolas, monospace; line-height: 1;
  font-size: min(16px, calc((min(100vw, 44rem) - 2.5rem) / var(--cols, 80) * 2)); }
pre.ansi.card { font-size: min(8px, calc((min(100vw, 44rem) - 2.5rem) / var(--cols, 80) * 2)); }
img.splash { display: block; max-width: 100%; height: auto; margin: .5rem 0; image-rendering: pixelated;
  border: 1px solid var(--line); background: #000; }
img.splash.card { max-height: 12rem; width: auto; }
${AnsiColours}`;

//  ANSI art as HTML: a <pre> of runs of characters, each run classed with
//  its colours. The library's art is clean (ansi.ts), and every character
//  is escaped, so nothing in it can be anything but text
export function ansiHtml(file: Uint8Array, label: string, size: 'card' | 'full'): string {
    const { body, sauce } = readSauce(file);
    const grid = parseAnsi(body, { width: sauce?.width || undefined, ice: sauce?.ice });
    const rows = [...grid.rows];
    while (rows.length && rows.at(-1)!.every(c => (0 === c.ch || 32 === c.ch) && 0 === c.bg)) {
        rows.pop();
    }
    const lines = rows.map(row => {
        let out = '';
        let i = 0;
        while (i < row.length) {
            const { fg, bg } = row[i]!;
            let run = '';
            while (i < row.length && row[i]!.fg === fg && row[i]!.bg === bg) {
                const ch = row[i]!.ch;
                run += 0 === ch ? ' ' : Cp437[ch];
                i++;
            }
            out += `<span class="f${fg} b${bg}">${esc(run)}</span>`;
        }
        return out;
    });
    return `<pre class="ansi${'card' === size ? ' card' : ''}" role="img" aria-label="${esc(label)}" style="--cols: ${
        grid.width
    }">${lines.join('\n')}</pre>`;
}

//  A piece from the library, as the viewer's view would have it. base: the
//  hub site's address, for pages at a BBS's own address, where /assets/ is
//  the BBS's
export function artHtml(
    art: AssetLibrary,
    item: PublicItem,
    form: ArtForm,
    size: 'card' | 'full',
    base = ''
): string {
    const label = item.description.short || item.name;
    if ('ansi' === form) {
        const file = art.file(item.ansi.replace(/^\/assets\//, ''));
        if (file) {
            try {
                return ansiHtml(file.body, label, size);
            } catch {
                //  fall through to the picture, which the hub checked too
            }
        }
    }
    if ('text' === form) {
        return `<p class="dim">[Art: ${esc(label)}]${
            item.text ? ` <a href="${esc(base + item.text)}">As text</a>` : ''
        }</p>`;
    }
    const picture = 'card' === size ? item.thumb : item.image;
    return `<img class="splash${'card' === size ? ' card' : ''}" src="${esc(base + picture.url)}" width="${
        picture.width
    }" height="${picture.height}" alt="${esc(label)}" loading="lazy">`;
}
