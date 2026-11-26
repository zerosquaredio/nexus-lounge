//  Art the hub offers (assets spec, a first slice): a library the baker made
//  (bake.ts), checked here before anything in it is served.
//
//  Every file is named by the SHA-256 of its bytes and checked against it,
//  and against what its form allows (assets spec §6.2, §6.3): ANSI must be
//  clean ANSI (ansi.ts: only characters, colours and line ends, whoever
//  cleaned it), images must be
//  PNGs within the size limits, text must be UTF-8. An item with any file
//  that fails is left out, and said so in the log. Later the same records
//  come from AT repos, and the files from wherever they say.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isCleanAnsi, MaxAnsiBytes } from './ansi.ts';
import type { Library, LibraryItem, Version } from './bake.ts';
import { HubError } from './errors.ts';

export const MaxImageBytes = 2 * 1024 * 1024;
export const MaxImageSide = 4096;
export const MaxTextBytes = 256 * 1024;
//  how much of an item's id names it in the chat
export const ShortIdLength = 12;

const Types: Record<Version['form'], string> = {
    ansi: 'text/x-ansi',
    image: 'image/png',
    text: 'text/plain; charset=utf-8',
};

export interface ServedFile {
    body: Buffer;
    type: string;
}

//  What pages and the chat are told about each item
export interface PublicItem {
    id: string;
    name: string;
    description: { short: string; long?: string };
    credit: { author?: string; group?: string; note?: string };
    licence: { id: string; url?: string; text?: string };
    themes: string[];
    rating: string;
    //  addresses on this hub
    image: { url: string; width: number; height: number };
    thumb: { url: string; width: number; height: number };
    ansi: string;
    text: string | null;
}

const Png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function check(form: Version['form'], body: Buffer): void {
    if ('ansi' === form) {
        if (body.length > MaxAnsiBytes + 256) {
            throw new HubError('asset', 'ANSI art over the size limit');
        }
        if (!isCleanAnsi(body)) {
            throw new HubError('asset', "ANSI art that isn't clean");
        }
    } else if ('image' === form) {
        if (body.length > MaxImageBytes) {
            throw new HubError('asset', 'an image over the size limit');
        }
        if (
            body.length < 33 ||
            !body.subarray(0, 8).equals(Png) ||
            'IHDR' !== body.toString('latin1', 12, 16)
        ) {
            throw new HubError('asset', 'an image that is not a PNG');
        }
        const width = body.readUInt32BE(16);
        const height = body.readUInt32BE(20);
        if (!width || !height || width > MaxImageSide || height > MaxImageSide) {
            throw new HubError('asset', 'an image too large');
        }
    } else if ('text' === form) {
        if (body.length > MaxTextBytes) {
            throw new HubError('asset', 'text over the size limit');
        }
        new TextDecoder('utf-8', { fatal: true }).decode(body);
    } else {
        throw new HubError('asset', `a form the hub doesn't serve yet (${String(form)})`);
    }
}

export class AssetLibrary {
    readonly name: string;
    readonly description: string;
    readonly items: PublicItem[] = [];
    private readonly files = new Map<string, ServedFile>();
    private readonly byShort = new Map<string, PublicItem>();

    constructor(library: Library, read: (sha256: string) => Buffer, log: (line: string) => void = () => {}) {
        this.name = String(library.name ?? 'Art');
        this.description = String(library.description ?? '');
        for (const item of Array.isArray(library.items) ? library.items : []) {
            try {
                this.add(item, read);
            } catch (e) {
                log(`assets: left out ${String(item?.record?.name ?? item?.id)}: ${(e as Error).message}`);
            }
        }
    }

    static load(dir: string, log: (line: string) => void = () => {}): AssetLibrary {
        const library = JSON.parse(readFileSync(join(dir, 'library.json'), 'utf8')) as Library;
        const art = new AssetLibrary(library, sha256 => readFileSync(join(dir, 'files', sha256)), log);
        log(`assets: ${art.items.length} items from ${dir}`);
        return art;
    }

    private add(item: LibraryItem, read: (sha256: string) => Buffer): void {
        const record = item.record;
        const checked = new Map<string, ServedFile>();
        const url = (v: Version) => `/assets/${v.file.sha256}`;
        //  versions of kinds this hub doesn't serve (a newer baker's, or
        //  another tool's) are passed over, not refused: the item keeps the
        //  versions it can show (assets spec §3.5)
        const known = record.versions.filter(v => Object.hasOwn(Types, v.form));
        for (const v of known) {
            const hash = String(v.file?.sha256 ?? '');
            if (!/^[0-9a-f]{64}$/.test(hash)) {
                throw new HubError('asset', 'a file named by something other than its hash');
            }
            const body = read(hash);
            if (createHash('sha256').update(body).digest('hex') !== hash || body.length !== v.file.size) {
                throw new HubError('asset', `a file that doesn't match its hash (${hash.slice(0, 12)})`);
            }
            check(v.form, body);
            checked.set(hash, { body, type: Types[v.form] });
        }
        const ansi = record.versions.find(v => 'ansi' === v.form);
        const images = record.versions
            .filter(v => 'image' === v.form && v.size)
            .sort((a, b) => (b.size?.width ?? 0) - (a.size?.width ?? 0));
        const text = record.versions.find(v => 'text' === v.form);
        if (!ansi || ansi.file.sha256 !== item.id || !images.length) {
            throw new HubError('asset', 'an item without its ANSI art and an image');
        }
        const short = item.id.slice(0, ShortIdLength);
        if (this.byShort.has(short)) {
            throw new HubError('asset', 'already in the library');
        }
        const full = images[0]!;
        const thumb = images[images.length - 1]!;
        const out: PublicItem = {
            id: item.id,
            name: String(record.name),
            description: record.description,
            credit: record.credit ?? {},
            licence: record.licence,
            themes: record.themes ?? [],
            rating: record.rating ?? 'general',
            image: { url: url(full), width: full.size!.width, height: full.size!.height },
            thumb: { url: url(thumb), width: thumb.size!.width, height: thumb.size!.height },
            ansi: url(ansi),
            text: text ? url(text) : null,
        };
        for (const [hash, file] of checked) {
            this.files.set(hash, file);
        }
        this.items.push(out);
        this.byShort.set(short, out);
    }

    file(sha256: string): ServedFile | null {
        return this.files.get(sha256) ?? null;
    }

    byShortId(short: string): PublicItem | null {
        return this.byShort.get(short) ?? null;
    }

    //  A piece by its name (any case) or short id, as a config names it
    find(nameOrId: string): PublicItem | null {
        const wanted = nameOrId.trim().toLowerCase();
        return (
            this.byShort.get(wanted) ??
            this.items.find(item => item.name.toLowerCase() === wanted) ??
            null
        );
    }
}
