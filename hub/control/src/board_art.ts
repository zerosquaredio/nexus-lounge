//  BBSes' own splash screens and emblems (assets spec §4.3, development plan
//  F21). A BBS whose sysop lets the hub show them names each in its listing,
//  by the SHA-256 and size of the file as it is, and serves that file at
//  /assets/<sha256>. The hub fetches it through the BBS's tunnel, checks its
//  hash, and bakes it as it would any art: ENiGMA½'s menu codes blanked, so
//  none of the board's live details show, cleaned to characters and
//  colours, drawn, and credited from its SAUCE. What it bakes is kept in
//  its data directory, so a restart fetches nothing again.
//
//  Until the hub's terms cover assets (hub plan §5.2), only the BBSes in
//  assets.boardArt are taken.

import { request } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MaxAnsiBytes } from './ansi.ts';
import { readPsf, type Font } from './ansi_image.ts';
import { AssetLibrary, type PublicItem } from './assets.ts';
import { bakeOne, Prefix, type Library, type LibraryItem } from './bake.ts';
import type { AtClient } from './atproto.ts';
import type { HubConfig } from './config.ts';
import type { Bbs } from './registry.ts';

//  the font the web terminal draws with, in its release
export const FontInRelease = 'fonts/pc/cp437-8x16.psf';
const FetchMs = 10_000;

//  what a BBS may offer: its splash screen, and its emblem for the map
export type ArtKind = 'splash' | 'emblem';
export const ArtKinds: ArtKind[] = ['splash', 'emblem'];
const KindName: Record<ArtKind, string> = { splash: 'splash screen', emblem: 'emblem' };

export interface BoardArtDeps {
    config: HubConfig;
    //  the BBSes registered here
    list: () => Bbs[];
    //  the file of this kind a BBS's (linked) listing names, if any
    artOf: (bbs: Bbs, kind: ArtKind) => { sha256: string; size: number } | null;
    log?: (line: string) => void;
    //  for tests: fetch a BBS's file through its tunnel
    fetch?: (bbs: Bbs, sha256: string) => Promise<Buffer>;
    //  for the art BBSes publish from their accounts: the AT network, and
    //  whether a BBS's account is linked to it here (its listing names it)
    at?: AtClient | null;
    linked?: (bbs: Bbs) => boolean;
}

//  A piece a BBS publishes (its asset.item record), as the hub reads it
export interface Piece {
    sha256: string;
    size: number;
    cid: string;
    name: string;
    rating: string;
    licence: { id: string; url?: string; text?: string };
    credit: { author?: string; group?: string; note?: string };
}

const Ratings = ['general', 'mature', 'adult'];

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && 'object' === typeof v && !Array.isArray(v) ? (v as Json) : {});
const str = (v: unknown, max: number): string | undefined =>
    'string' === typeof v && v.trim() ? v.trim().slice(0, max) : undefined;

//  A record, if it is a piece the hub can take: ANSI art, by a file named
//  by its hash and keyed by it, small enough, with a blob to fetch
export function pieceOf(rkey: string, value: unknown): Piece | null {
    const v = obj(value);
    const version = obj(Array.isArray(v.versions) ? v.versions[0] : null);
    const file = obj(version.file);
    const blob = obj(version.blob);
    const ref = obj(blob.ref);
    const size = file.size;
    if (
        'ansi' !== version.form ||
        'string' !== typeof file.sha256 ||
        !/^[0-9a-f]{64}$/.test(file.sha256) ||
        file.sha256 !== rkey ||
        !Number.isInteger(size) ||
        (size as number) < 1 ||
        (size as number) > MaxAnsiBytes ||
        'string' !== typeof ref.$link
    ) {
        return null;
    }
    const licence = obj(v.licence);
    const url = str(licence.url, 512);
    const credit = obj(v.credit);
    return {
        sha256: file.sha256,
        size: size as number,
        cid: ref.$link,
        name: str(v.name, 80) ?? '',
        rating: Ratings.includes(v.rating as string) ? (v.rating as string) : 'general',
        licence: {
            id: str(licence.id, 64) ?? 'custom',
            ...(url && /^https:\/\//.test(url) ? { url } : {}),
            ...(str(licence.text, 500) ? { text: str(licence.text, 500) } : {}),
        },
        credit: {
            ...(str(credit.author, 80) ? { author: str(credit.author, 80) } : {}),
            ...(str(credit.group, 80) ? { group: str(credit.group, 80) } : {}),
            ...(str(credit.note, 200) ? { note: str(credit.note, 200) } : {}),
        },
    };
}

interface Kept {
    //  the file as the BBS offered it, and the baked item made from it
    raw: string;
    id: string;
}

//  where what was taken is kept: "<kind>:<name>" (a bare name, from before
//  emblems, is a splash)
const keyOf = (kind: ArtKind, name: string) => `${kind}:${name}`;

export class BoardArt {
    deps: BoardArtDeps;
    dir: string;
    log: (line: string) => void;
    //  by keyOf()
    kept = new Map<string, Kept>();
    //  by BBS name: the baked items of the pieces it publishes now
    pieces = new Map<string, string[]>();
    library: AssetLibrary | null = null;
    //  files that failed, so they aren't fetched again each time
    failed = new Map<string, number>();
    busy = false;
    font: Font | null = null;

    constructor(deps: BoardArtDeps, dir: string) {
        this.deps = deps;
        this.dir = dir;
        this.log = deps.log ?? (() => {});
        mkdirSync(join(dir, 'files'), { recursive: true });
        const index = join(dir, 'boards.json');
        if (existsSync(index)) {
            for (const [key, kept] of Object.entries(JSON.parse(readFileSync(index, 'utf8')) as Record<string, Kept>)) {
                this.kept.set(key.includes(':') ? key : keyOf('splash', key), kept);
            }
        }
        const published = join(dir, 'pieces.json');
        if (existsSync(published)) {
            for (const [name, ids] of Object.entries(JSON.parse(readFileSync(published, 'utf8')) as Record<string, string[]>)) {
                this.pieces.set(name, ids);
            }
        }
        this.load();
    }

    //  The pieces a BBS publishes, as the hub took them
    piecesFor(bbs: Bbs): PublicItem[] {
        if (!this.allowed(bbs) || !this.library) {
            return [];
        }
        const library = this.library;
        return (this.pieces.get(bbs.name) ?? [])
            .map(id => library.items.find(item => item.id === id))
            .filter((item): item is PublicItem => !!item);
    }

    //  Read what each BBS publishes from its account, and take what is new.
    //  Pieces with a rating this hub's directory doesn't show are left out
    async refreshPieces(): Promise<void> {
        const at = this.deps.at;
        if (!at) {
            return;
        }
        const collection = `${this.deps.config.directory.nsidPrefix}.asset.item`;
        const ratings = this.deps.config.directory.ratings;
        for (const bbs of this.deps.list()) {
            if (!this.allowed(bbs) || !bbs.bbsDid || !(this.deps.linked?.(bbs) ?? false)) {
                this.pieces.delete(bbs.name);
                continue;
            }
            let records: { rkey: string; cid: string; value: unknown }[];
            try {
                records = await at.listRecords(bbs.bbsDid, collection, 100);
            } catch (e) {
                this.log(`board art: can't read ${bbs.name}'s art: ${(e as Error).message}`);
                continue;
            }
            const ids: string[] = [];
            for (const record of records) {
                const piece = pieceOf(record.rkey, record.value);
                if (!piece || !ratings.includes(piece.rating)) {
                    continue;
                }
                const key = `piece:${bbs.name}:${piece.sha256}`;
                if (!this.kept.has(key)) {
                    if (Date.now() - (this.failed.get(key) ?? 0) < 60 * 60 * 1000) {
                        continue;
                    }
                    try {
                        await this.takePiece(bbs, piece, key);
                    } catch (e) {
                        this.failed.set(key, Date.now());
                        this.log(`board art: ${bbs.name}'s ${piece.name || 'piece'} not taken: ${(e as Error).message}`);
                        continue;
                    }
                }
                const id = this.kept.get(key)?.id;
                if (id && !ids.includes(id)) {
                    ids.push(id);
                }
            }
            this.pieces.set(bbs.name, ids);
        }
        this.save(join(this.dir, 'pieces.json'), Object.fromEntries(this.pieces));
    }

    async takePiece(bbs: Bbs, piece: Piece, key: string): Promise<void> {
        const body = await this.deps.at!.getBlob(bbs.bbsDid!, piece.cid, MaxAnsiBytes);
        if (createHash('sha256').update(body).digest('hex') !== piece.sha256 || body.length !== piece.size) {
            throw new Error("the file isn't the one its record names");
        }
        this.font ??= readPsf(fontPath(this.deps.config));
        const { files, item } = bakeOne(`${piece.name || bbs.name}.ans`, body, {
            font: '',
            mci: true,
            licence: piece.licence,
            rating: piece.rating,
            themes: [],
            author: piece.credit.author ?? '',
            group: piece.credit.group ?? '',
            note: piece.credit.note ?? `from ${bbs.name}`,
        }, this.font);
        //  the name the BBS gives it, over its SAUCE title
        if (piece.name) {
            item.record.name = piece.name;
        }
        this.keep(files, item, key, piece.sha256);
        this.log(`board art: took ${bbs.name}'s ${item.record.name} (${item.id.slice(0, 12)})`);
    }

    //  The art of this kind to show for a BBS, if it still offers the one
    //  baked
    artFor(bbs: Bbs, kind: ArtKind): PublicItem | null {
        const kept = this.kept.get(keyOf(kind, bbs.name));
        const named = this.allowed(bbs) ? this.deps.artOf(bbs, kind) : null;
        if (!kept || !named || named.sha256 !== kept.raw || !this.library) {
            return null;
        }
        return this.library.items.find(item => item.id === kept.id) ?? null;
    }

    splashFor(bbs: Bbs): PublicItem | null {
        return this.artFor(bbs, 'splash');
    }

    emblemFor(bbs: Bbs): PublicItem | null {
        return this.artFor(bbs, 'emblem');
    }

    file(sha256: string) {
        return this.library?.file(sha256) ?? null;
    }

    allowed(bbs: Bbs): boolean {
        return 'active' === bbs.state && this.deps.config.assets.boardArt.includes(bbs.name);
    }

    //  Fetch and bake what BBSes offer that isn't baked yet. Each BBS's
    //  failures wait an hour before another try
    async refresh(): Promise<void> {
        if (this.busy) {
            return;
        }
        this.busy = true;
        try {
            for (const bbs of this.deps.list()) {
                for (const kind of ArtKinds) {
                    const named = this.allowed(bbs) && bbs.connected ? this.deps.artOf(bbs, kind) : null;
                    if (!named || this.kept.get(keyOf(kind, bbs.name))?.raw === named.sha256) {
                        continue;
                    }
                    const key = `${bbs.name}:${named.sha256}`;
                    if (Date.now() - (this.failed.get(key) ?? 0) < 60 * 60 * 1000) {
                        continue;
                    }
                    try {
                        await this.take(bbs, kind, named);
                    } catch (e) {
                        this.failed.set(key, Date.now());
                        this.log(`board art: ${bbs.name}'s ${KindName[kind]} not taken: ${(e as Error).message}`);
                    }
                }
            }
        } finally {
            this.busy = false;
        }
    }

    async take(bbs: Bbs, kind: ArtKind, named: { sha256: string; size: number }): Promise<void> {
        if (named.size > MaxAnsiBytes) {
            throw new Error('larger than ANSI art may be');
        }
        const body = await (this.deps.fetch ?? fetchThroughTunnel(this.deps.config))(bbs, named.sha256);
        if (createHash('sha256').update(body).digest('hex') !== named.sha256 || body.length !== named.size) {
            throw new Error("the file isn't the one its listing names");
        }
        this.font ??= readPsf(fontPath(this.deps.config));
        const { files, item } = bakeOne(`${bbs.name}.ans`, body, {
            font: '',
            mci: true,
            licence: { id: 'custom', text: "Shown on this hub with the BBS's consent" },
            rating: 'general',
            themes: [],
            author: '',
            group: '',
            note: `${bbs.name}'s ${KindName[kind]}`,
        }, this.font);
        this.keep(files, item, keyOf(kind, bbs.name), named.sha256);
        this.log(`board art: took ${bbs.name}'s ${KindName[kind]}, ${item.record.name} (${item.id.slice(0, 12)})`);
    }

    //  Baked files and item into the library, kept under |key|; refused if
    //  the library's own checks refuse it
    keep(files: Map<string, Buffer>, item: LibraryItem, key: string, raw: string): void {
        for (const [hash, bytes] of files) {
            writeFileSync(join(this.dir, 'files', hash), bytes);
        }
        const library = this.readLibrary();
        const same = library.items.findIndex(i => i.id === item.id);
        if (same < 0) {
            library.items.push(item);
        } else if (key.startsWith('piece:')) {
            //  the same art as a splash or emblem: what its own record says
            //  (name, licence, credit) is better than what the hub assumed
            library.items[same] = item;
        }
        this.save(join(this.dir, 'library.json'), library);
        this.load();
        if (!this.library?.items.some(i => i.id === item.id)) {
            throw new Error("its art didn't pass the hub's checks");
        }
        this.kept.set(key, { raw, id: item.id });
        this.save(join(this.dir, 'boards.json'), Object.fromEntries(this.kept));
    }

    readLibrary(): Library {
        const path = join(this.dir, 'library.json');
        return existsSync(path)
            ? (JSON.parse(readFileSync(path, 'utf8')) as Library)
            : {
                  $type: `${Prefix}.asset.catalogue`,
                  name: "BBSes' splash screens and emblems",
                  description: 'Splash screens and emblems BBSes on this hub offer, with their consent.',
                  createdAt: new Date().toISOString(),
                  items: [] as LibraryItem[],
              };
    }

    //  written whole, then put in place
    save(path: string, value: unknown): void {
        writeFileSync(`${path}.new`, JSON.stringify(value, null, 2) + '\n');
        renameSync(`${path}.new`, path);
    }

    load(): void {
        if (!existsSync(join(this.dir, 'library.json'))) {
            return;
        }
        try {
            this.library = AssetLibrary.load(this.dir, this.log);
        } catch (e) {
            this.log(`board art: can't load ${this.dir}: ${(e as Error).message}`);
        }
    }
}

//  The font art is drawn with: assets.font, or the web terminal's own
export function fontPath(config: HubConfig): string {
    if (config.assets.font) {
        return config.assets.font;
    }
    if (config.webTerminal.root) {
        return join(config.webTerminal.root, FontInRelease);
    }
    throw new Error('no font to draw art with: set assets.font or webTerminal.root');
}

//  A BBS's file, through its tunnel: frps routes by the BBS's host name, as
//  it does for visitors, and only to the paths the BBS's agent serves
export function fetchThroughTunnel(config: HubConfig) {
    return (bbs: Bbs, sha256: string): Promise<Buffer> =>
        new Promise((resolve, reject) => {
            const req = request(
                {
                    host: '127.0.0.1',
                    port: config.tunnel.vhostHttpPort,
                    path: `/assets/${sha256}`,
                    headers: { Host: `${bbs.name}.${config.domain}`, 'X-Forwarded-Proto': 'https' },
                    timeout: FetchMs,
                },
                res => {
                    if (200 !== res.statusCode) {
                        res.resume();
                        return reject(new Error(`the BBS answered ${res.statusCode}`));
                    }
                    const chunks: Buffer[] = [];
                    let size = 0;
                    res.on('data', (chunk: Buffer) => {
                        size += chunk.length;
                        if (size > MaxAnsiBytes) {
                            req.destroy(new Error('larger than ANSI art may be'));
                            return;
                        }
                        chunks.push(chunk);
                    });
                    res.on('end', () => resolve(Buffer.concat(chunks)));
                    res.on('error', reject);
                }
            );
            req.on('timeout', () => req.destroy(new Error('no answer in time')));
            req.on('error', reject);
            req.end();
        });
}
