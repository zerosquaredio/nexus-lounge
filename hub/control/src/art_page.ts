//  The art the hub offers (assets.ts), as a page anyone can look at: each
//  piece small, with its credit and licence, and links to the full picture,
//  the ANSI file and its text.

import type { AssetLibrary, PublicItem } from './assets.ts';
import type { ModelItem } from './board_models.ts';
import { esc } from './html.ts';

export const ArtPath = '/art';
export const ArtJsonPath = '/art.json';

export function creditLine(item: Pick<PublicItem, 'credit'>): string {
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
    )}.ans">ANSI</a>${item.text ? ` · <a href="${esc(item.text)}">Text</a>` : ''} · <a href="/report?kind=art&amp;asset=${esc(
        item.id
    )}">Report</a></p>
</article>`;
}

//  Art BBSes on this hub publish (board_art.ts), by BBS
export interface BoardPieces {
    bbs: string;
    title: string;
    items: PublicItem[];
}

//  The 3D models BBSes on this hub publish (board_models.ts), by BBS
export interface BoardModelGroup {
    bbs: string;
    title: string;
    items: ModelItem[];
}

function licenceHtml(licence: ModelItem['licence']): string {
    return licence.url
        ? `<a href="${esc(licence.url)}" rel="noopener nofollow ugc">${esc(licence.id)}</a>`
        : esc(licence.text ?? licence.id);
}

const kilobytes = (bytes: number) => `${Math.max(1, Math.round(bytes / 1024)).toLocaleString('en')} kB`;

//  what the hub measured of a model, in a line
function figuresLine(item: ModelItem): string {
    const animations = item.model.animations.length;
    return [
        `${item.model.triangles.toLocaleString('en')} triangles`,
        kilobytes(item.model.bytes),
        animations ? `${animations} animation${1 === animations ? '' : 's'}` : '',
    ]
        .filter(Boolean)
        .join(' · ');
}

function modelHtml(item: ModelItem): string {
    return `<article class="art model">
<a href="${esc(item.page)}"><img src="${esc(item.image.url)}" width="${item.image.width}" height="${
        item.image.height
    }" alt="${esc(item.description.short)}" loading="lazy"></a>
<h3>${esc(item.name)}</h3>
<p>By ${esc(creditLine(item))}${item.credit.note ? `. ${esc(item.credit.note)}` : ''}</p>
<p class="dim">${esc(figuresLine(item))}</p>
<p class="dim">Licence: ${licenceHtml(item.licence)}</p>
<p class="dim"><a href="${esc(item.page)}">View in 3D</a> · <a href="/report?kind=art&amp;asset=${esc(
        item.id
    )}">Report</a></p>
</article>`;
}

//  The page for one model: its picture until the person asks for the
//  model, and the viewer then (web/model_page.js). |textOnly|: a view set
//  to text, which shows the description only
export function modelPageBody(item: ModelItem, from: string, textOnly: boolean): string {
    const about = `<p>${esc(item.description.short)}</p>
${item.description.long ? `<p class="pre">${esc(item.description.long)}</p>` : ''}
<p>By ${esc(creditLine(item))}${item.credit.note ? `. ${esc(item.credit.note)}` : ''}. Published by ${esc(
        from
    )} from its own account.</p>
<p class="dim">${esc(figuresLine(item))}${
        item.model.animations.length
            ? `. Animations: ${item.model.animations.map(name => esc(name || 'unnamed')).join(', ')}`
            : ''
    }</p>
<p class="dim">Licence: ${licenceHtml(item.licence)}</p>`;
    const links = `<p><a href="/report?kind=art&amp;asset=${esc(item.id)}">Report</a> · <a href="/art">All the art</a></p>`;
    if (textOnly) {
        return `${about}\n${links}`;
    }
    return `<style>
#model-preview { display: block; max-width: 100%; height: auto; border: 1px solid var(--line); }
#model-preview[hidden], #model-ask[hidden] { display: none; }
#model-viewer { margin: .6rem 0; }
#model-viewer canvas { display: block; width: 100%; aspect-ratio: 4 / 3; border: 1px solid var(--line); touch-action: none; }
.model-viewer-buttons { display: flex; flex-wrap: wrap; gap: .4rem; margin: .4rem 0; }
.model-viewer-buttons button { margin: 0; }
.model-viewer-buttons [aria-pressed="true"] { font-weight: bold; }
</style>
<img id="model-preview" src="${esc(item.image.url)}" width="${item.image.width}" height="${
        item.image.height
    }" alt="${esc(item.description.short)}">
<p id="model-ask"><button type="button" id="model-load" hidden>Load 3D</button> <span class="dim">(${esc(
        kilobytes(item.model.bytes)
    )}, fetched only when you press it)</span></p>
<div id="model-viewer" data-model="${esc(item.model.url)}" data-label="${esc(item.name)}"></div>
<p id="model-stats" class="dim"></p>
<noscript><p class="dim">Turning the model needs scripts; the picture stands for it.</p></noscript>
${about}
${links}
<script type="module" src="/web/model_page.js"></script>`;
}

export function artPageBody(
    art: AssetLibrary | null,
    fromBoards: BoardPieces[] = [],
    models: BoardModelGroup[] = []
): string {
    const boards = fromBoards.filter(b => b.items.length);
    const withModels = models.filter(b => b.items.length);
    return `<style>
.art img { display: block; max-width: 100%; height: auto; image-rendering: pixelated; border: 1px solid var(--line); background: #000; }
.art.model img { image-rendering: auto; background: none; }
</style>
${
    (art && art.items.length) || boards.length
        ? `<p>${esc(art?.description || 'ANSI art this hub offers.')} Share a piece in the chat with its <strong>Art</strong> button,
or by typing <code>/art</code> and its name.</p>`
        : '<p>Art the BBSes on this hub publish.</p>'
}
${art && art.items.length ? art.items.map(itemHtml).join('\n') : boards.length || withModels.length ? '' : '<p class="dim">Nothing here yet.</p>'}
${boards
    .map(
        b => `<h2>From ${esc(b.title)}</h2>
<p class="dim">Published by the BBS from its own account.</p>
${b.items.map(itemHtml).join('\n')}`
    )
    .join('\n')}
${withModels
    .map(
        b => `<h2>3D models from ${esc(b.title)}</h2>
<p class="dim">Published by the BBS from its own account. Each one's page shows its picture, and the model itself when you ask for it.</p>
${b.items.map(modelHtml).join('\n')}`
    )
    .join('\n')}
<p class="hint">Pictures are drawn from the ANSI with the IBM VGA font from VileR's
<a href="https://int10h.org/oldschool-pc-fonts/" rel="noopener">Ultimate Oldschool PC Font Pack</a> (CC BY-SA 4.0).</p>
<p><a href="/space/chat">The chat</a> · <a href="/">The directory</a></p>`;
}

//  What the chat needs, for /art.json
export function artJson(art: AssetLibrary | null, fromBoards: BoardPieces[] = []): unknown {
    //  the same art once, the hub's own first
    const all = [...(art?.items ?? []), ...fromBoards.flatMap(b => b.items)].filter(
        (item, i, list) => list.findIndex(other => other.id === item.id) === i
    );
    return {
        name: art?.name ?? 'Art',
        items: all.map(item => ({
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
