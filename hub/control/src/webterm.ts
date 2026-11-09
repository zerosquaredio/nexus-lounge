//  The web terminal the hub serves for every BBS (hub plan H5; hub.md §4): a
//  pinned copy of enig-term, so visitors always get a known client and a BBS
//  can't put pages of its own under the hub's domain.
//
//  enig-term runs in the visitor's browser; the hub only hands out its
//  files. Its config.json is made per BBS, locked to wss://<name>.<domain>/ws,
//  which the edge forwards down that BBS's tunnel.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { HubConfig } from './config.ts';
import { HubError } from './errors.ts';

export const WebTermPath = '/_enig/ws-term/';

const Types: Record<string, string> = {
    html: 'text/html; charset=utf-8',
    js: 'text/javascript; charset=utf-8',
    mjs: 'text/javascript; charset=utf-8',
    json: 'application/json',
    wasm: 'application/wasm',
    psf: 'application/octet-stream',
    txt: 'text/plain; charset=utf-8',
    css: 'text/css; charset=utf-8',
    woff2: 'font/woff2',
    png: 'image/png',
    svg: 'image/svg+xml',
};

interface WebTermFile {
    body: Buffer;
    type: string;
    etag: string;
}

export interface WebTerm {
    //  the release's fingerprint: a hash over every file's path and hash
    digest: string;
    files: Map<string, WebTermFile>;
    //  hashes of index.html's inline scripts, for the page's policy
    inlineScriptHashes: string[];
}

function typeOf(path: string): string {
    const dot = path.lastIndexOf('.');
    const slash = path.lastIndexOf('/');
    return dot > slash
        ? (Types[path.slice(dot + 1).toLowerCase()] ?? 'application/octet-stream')
        : 'text/plain; charset=utf-8';
}

//  Read the whole release into memory (about 5 MB) once. Only these files
//  are ever served, by exact path, so nothing outside it can be reached.
export function loadWebTerm(root: string, expectedDigest?: string): WebTerm {
    const files = new Map<string, WebTermFile>();
    const listing: string[] = [];
    const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                walk(full);
            } else if (entry.isFile() && statSync(full).size < 32 * 1024 * 1024) {
                const path = relative(root, full).split(sep).join('/');
                if ('config.json' === path) {
                    continue; //  made per BBS
                }
                const body = readFileSync(full);
                const hash = createHash('sha256').update(body).digest('hex');
                listing.push(`${hash}  ${path}`);
                files.set(path, { body, type: typeOf(path), etag: `"${hash.slice(0, 32)}"` });
            }
        }
    };
    walk(root);
    const index = files.get('index.html');
    if (!index) {
        throw new HubError('webterm', `No enig-term in ${root} (no index.html)`);
    }
    listing.sort();
    const digest = createHash('sha256').update(listing.join('\n')).digest('hex');
    if (expectedDigest && expectedDigest !== digest) {
        throw new HubError(
            'webterm',
            `The enig-term in ${root} isn't the pinned release (its fingerprint is ${digest}, not ${expectedDigest})`
        );
    }
    const inlineScriptHashes = [
        ...index.body.toString('utf8').matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi),
    ].map(
        m =>
            `'sha256-${createHash('sha256')
                .update(m[1] ?? '')
                .digest('base64')}'`
    );
    return { digest, files, inlineScriptHashes };
}

//  Where a BBS's terminal connects: its own name, the edge's port, /ws
export function endpointFor(config: HubConfig, name: string): string {
    const port = 443 === config.edge.httpsPort ? '' : `:${config.edge.httpsPort}`;
    return `wss://${name}.${config.domain}${port}/ws`;
}

export function clientConfig(config: HubConfig, name: string): string {
    return JSON.stringify({
        version: 1,
        endpoint: endpointFor(config, name),
        //  a crafted link can't point this page at another host
        lockEndpoint: true,
        title: `${name}.${config.domain}`,
    });
}

export function policy(term: WebTerm, config: HubConfig, name: string): string {
    const wss = endpointFor(config, name).replace(/\/ws$/, '');
    return [
        "default-src 'self'",
        `script-src 'self' 'wasm-unsafe-eval' ${term.inlineScriptHashes.join(' ')}`.trim(),
        "worker-src 'self' blob:",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "media-src 'self' blob:",
        `connect-src 'self' ${wss}`,
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "form-action 'none'",
    ].join('; ');
}

//  The file for a request path under /_enig/ws-term/, or null
export function fileFor(term: WebTerm, path: string): { file: WebTermFile; name: string } | null {
    if (!path.startsWith(WebTermPath)) {
        return null;
    }
    const name = path.slice(WebTermPath.length) || 'index.html';
    const file = term.files.get(name);
    return file ? { file, name } : null;
}
