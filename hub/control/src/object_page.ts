//  A live object's own page (build spec of the live object slice, stage 4;
//  compute spec §2.6): what it shows now and where its data comes from, and
//  everything about the program behind it, its source included, so anyone
//  can judge whether to trust it and help find its bugs. Everything on it
//  came from outside, so all of it is escaped, and the source is shown as
//  text, never run.

import type { KeptObject, KeptProgram } from './board_objects.ts';
import { esc } from './html.ts';
import type { ObjectEntity } from './live_objects.ts';
import { ValueTypes } from './object_types.ts';

export interface ObjectPageData {
    object: KeptObject;
    entity: ObjectEntity;
    program: KeptProgram;
    source: string | null;
    status: { lastError: string | null; log: string[]; fuel: number } | null;
    //  the BBS it belongs to, as the directory names it
    from: string;
    //  the sites the hub lets programs reach
    hubSites: string[];
}

function valueText(name: string, value: number | boolean | string, type: string): string {
    const spec = ValueTypes[type]?.[name];
    if ('boolean' === typeof value) {
        return value ? 'yes' : 'no';
    }
    if ('number' === typeof value && spec && 'number' === spec.kind && spec.unit) {
        return `${value} ${spec.unit}`;
    }
    if (spec && 'time' === spec.kind) {
        return `${String(value)
            .replace('T', ' ')
            .replace(/(:00)?\.000Z$|Z$/, '')} UTC`;
    }
    return String(value);
}

export function objectPageBody(d: ObjectPageData): string {
    const { object: o, entity: e, program: p } = d;
    const values = Object.entries(e.values);
    const reading = values.length
        ? `<table>${values
              .map(
                  ([name, v]) =>
                      `<tr><th scope="row">${esc(name)}</th><td>${esc(valueText(name, v, e.kind))}</td></tr>`
              )
              .join('')}</table>`
        : '<p class="dim">No reading yet.</p>';
    const when = e.updatedAt
        ? `Updated ${esc(e.updatedAt.replace('T', ' ').replace(/\.\d+Z$/, ''))} UTC${e.stale ? ', and not since: it is stale' : ''}.`
        : 'Not updated yet.';
    const credit = e.look.credit.length
        ? `<p>${e.look.credit.map(c => `<a href="${esc(c.url)}" rel="noopener nofollow ugc">${esc(c.text)}</a>`).join(' · ')}</p>`
        : '';
    const reaches = p.fetch.map(
        host => `${esc(host)}${d.hubSites.includes(host) ? '' : ' (not allowed by this hub)'}`
    );
    const status = d.status;
    const log =
        status && (status.lastError || status.log.length)
            ? `<h2>How it ran last</h2>
${status.lastError ? `<p class="error">${esc(status.lastError)}</p>` : ''}
${status.log.length ? `<pre class="pre">${esc(status.log.join('\n'))}</pre>` : ''}
<p class="dim">${esc(status.fuel.toLocaleString('en'))} fuel.</p>`
            : '';
    const licence = p.licence.url
        ? `<a href="${esc(p.licence.url)}" rel="noopener nofollow ugc">${esc(p.licence.id)}</a>`
        : esc(p.licence.id);
    return `<p>A live object of ${esc(d.from)}'s, of the shared type <code>${esc(e.kind)}</code>.</p>
${reading}
<p class="dim">${when} It updates every ${esc(Math.round(o.interval / 60))} minutes.</p>
${credit}
<h2>Its program</h2>
<p><strong>${esc(p.name)}</strong>: ${esc(p.description.short)}${p.credit.author ? `. By ${esc(p.credit.author)}` : ''}.</p>
<table>
<tr><th scope="row">Module</th><td><code>${esc(p.sha256)}</code></td></tr>
<tr><th scope="row">Published by</th><td><code>${esc(p.did)}</code></td></tr>
<tr><th scope="row">Licence</th><td>${licence}</td></tr>
<tr><th scope="row">Reaches</th><td>${reaches.join('<br>') || 'nothing'}</td></tr>
<tr><th scope="row">Its input here</th><td><code>${esc(JSON.stringify(o.input))}</code></td></tr>
<tr><th scope="row">The record</th><td><code>${esc(e.record)}</code></td></tr>
</table>
<p class="dim">This hub runs only programs its admin has checked, by their hash, each step within limits on its computing, memory and time, and reaching only sites both the program and the hub allow.</p>
${log}
<h2>Its source</h2>
<p class="dim">As its author published it. The hub has not yet checked that this source builds into the module it runs, so the source is its author's word.</p>
${d.source ? `<pre class="pre" style="font: 13px/1.4 ui-monospace, Consolas, monospace; overflow-x: auto;">${esc(d.source)}</pre>` : '<p class="dim">Not available.</p>'}
<p><a href="/space/map">The map</a></p>`;
}
