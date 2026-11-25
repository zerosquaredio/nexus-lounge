//  The art the hub offers (assets.ts), as a page anyone can look at: each
//  piece small, with its credit and licence, and links to the full picture,
//  the ANSI file and its text.

import type { AssetLibrary, PublicItem } from './assets.ts';
import { esc } from './html.ts';

export const ArtPath = '/art';
export const ArtJsonPath = '/art.json';

export function creditLine(item: PublicItem): string {
    const { author, group } = item.credit;
    return [author, group && `of ${group}`].filter(Boolean).join(' ') || 'artist unknown';
}

function itemHtml(item: PublicItem): string {
    const licence = item.licence.url
        ? `<a href="${esc(item.licence.url)}" rel="noopener">${esc(item.licence.id)}</a>`
        : esc(item.licence.text ?? item.licence.id);
    return `<article class="art">
<a href="${esc(item.image.url)}"><img src="${esc(item.thumb.url)}" width="${item.thumb.width}" height="${
        item.thumb.height
    }" alt="${esc(item.description.short)}" loading="lazy"></a>
<h3>${esc(item.name)}</h3>
<p>By ${esc(creditLine(item))}${item.credit.note ? `. ${esc(item.credit.note)}` : ''}</p>
<p class="dim">${esc(item.description.long ?? '')}</p>
<p class="dim">Licence: ${licence}</p>
<p class="dim"><a href="${esc(item.image.url)}">Full size</a> · <a href="${esc(item.ansi)}" download="${esc(
        item.name
    )}.ans">ANSI</a>${item.text ? ` · <a href="${esc(item.text)}">Text</a>` : ''}</p>
</article>`;
}

export function artPageBody(art: AssetLibrary): string {
    return `<style>
.art img { display: block; max-width: 100%; height: auto; image-rendering: pixelated; border: 1px solid var(--line); background: #000; }
</style>
<p>${esc(art.description || 'ANSI art this hub offers.')} Share a piece in the chat with its <strong>Art</strong> button,
or by typing <code>/art</code> and its name.</p>
${art.items.length ? art.items.map(itemHtml).join('\n') : '<p class="dim">Nothing here yet.</p>'}
<p class="hint">Pictures are drawn from the ANSI with the IBM VGA font from VileR's
<a href="https://int10h.org/oldschool-pc-fonts/" rel="noopener">Ultimate Oldschool PC Font Pack</a> (CC BY-SA 4.0).</p>
<p><a href="/space/chat">The chat</a> · <a href="/">The directory</a></p>`;
}

//  What the chat needs, for /art.json
export function artJson(art: AssetLibrary): unknown {
    return {
        name: art.name,
        items: art.items.map(item => ({
            id: item.id,
            name: item.name,
            short: item.description.short,
            credit: creditLine(item),
            image: item.image,
            thumb: item.thumb,
            ansi: item.ansi,
            text: item.text,
        })),
    };
}
