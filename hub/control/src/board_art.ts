//  BBSes' own splash screens (assets spec §4.3, development plan F21). A
//  BBS whose sysop lets the hub show it names its splash in its listing, by
//  the SHA-256 and size of the file as it is, and serves that file at
//  /assets/<sha256>. The hub fetches it through the BBS's tunnel, checks its
//  hash, and bakes it as it would any art: ENiGMA½'s menu codes blanked, so
//  none of the board's live details show, cleaned to characters and
//  colours, drawn, and credited from its SAUCE. What it bakes is kept in
//  its data directory, so a restart fetches nothing again.
//
//  Until the hub's terms cover assets (hub plan §5.2), only the BBSes in
//  assets.boardSplashes are taken.

import { request } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MaxAnsiBytes } from './ansi.ts';
import { readPsf, type Font } from './ansi_image.ts';
import { AssetLibrary, type PublicItem } from './assets.ts';
import { bakeOne, Prefix, type Library, type LibraryItem } from './bake.ts';
import type { HubConfig } from './config.ts';
import type { Bbs } from './registry.ts';

//  the font the web terminal draws with, in its release
export const FontInRelease = 'fonts/pc/cp437-8x16.psf';
const FetchMs = 10_000;

export interface BoardArtDeps {
    config: HubConfig;
    //  the BBSes registered here
    list: () => Bbs[];
    //  the splash a BBS's (linked) listing names, if any
    splashOf: (bbs: Bbs) => { sha256: string; size: number } | null;
    log?: (line: string) => void;
    //  for tests: fetch a BBS's file through its tunnel
    fetch?: (bbs: Bbs, sha256: string) => Promise<Buffer>;
}

interface Kept {
    //  the file as the BBS offered it, and the baked item made from it
    raw: string;
    id: string;
}

export class BoardArt {
    deps: BoardArtDeps;
    dir: string;
    log: (line: string) => void;
    //  by BBS name
    kept = new Map<string, Kept>();
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
            for (const [name, kept] of Object.entries(JSON.parse(readFileSync(index, 'utf8')) as Record<string, Kept>)) {
                this.kept.set(name, kept);
            }
        }
        this.load();
    }

    //  The splash to show for a BBS, if it still offers the one baked
    splashFor(bbs: Bbs): PublicItem | null {
        const kept = this.kept.get(bbs.name);
        const named = this.allowed(bbs) ? this.deps.splashOf(bbs) : null;
        if (!kept || !named || named.sha256 !== kept.raw || !this.library) {
            return null;
        }
        return this.library.items.find(item => item.id === kept.id) ?? null;
    }

    file(sha256: string) {
        return this.library?.file(sha256) ?? null;
    }

    allowed(bbs: Bbs): boolean {
        return 'active' === bbs.state && this.deps.config.assets.boardSplashes.includes(bbs.name);
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
                const named = this.allowed(bbs) && bbs.connected ? this.deps.splashOf(bbs) : null;
                if (!named || this.kept.get(bbs.name)?.raw === named.sha256) {
                    continue;
                }
                const key = `${bbs.name}:${named.sha256}`;
                if (Date.now() - (this.failed.get(key) ?? 0) < 60 * 60 * 1000) {
                    continue;
                }
                try {
                    await this.take(bbs, named);
                } catch (e) {
                    this.failed.set(key, Date.now());
                    this.log(`board art: ${bbs.name}'s splash not taken: ${(e as Error).message}`);
                }
            }
        } finally {
            this.busy = false;
        }
    }

    async take(bbs: Bbs, named: { sha256: string; size: number }): Promise<void> {
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
            note: `${bbs.name}'s splash screen`,
        }, this.font);
        for (const [hash, bytes] of files) {
            writeFileSync(join(this.dir, 'files', hash), bytes);
        }
        const library = this.readLibrary();
        if (!library.items.some(i => i.id === item.id)) {
            library.items.push(item);
        }
        this.save(join(this.dir, 'library.json'), library);
        this.kept.set(bbs.name, { raw: named.sha256, id: item.id });
        this.save(join(this.dir, 'boards.json'), Object.fromEntries(this.kept));
        this.load();
        if (!this.library?.items.some(i => i.id === item.id)) {
            throw new Error("its art didn't pass the hub's checks");
        }
        this.log(`board art: took ${bbs.name}'s splash, ${item.record.name} (${item.id.slice(0, 12)})`);
    }

    readLibrary(): Library {
        const path = join(this.dir, 'library.json');
        return existsSync(path)
            ? (JSON.parse(readFileSync(path, 'utf8')) as Library)
            : {
                  $type: `${Prefix}.asset.catalogue`,
                  name: "BBSes' splash screens",
                  description: 'Splash screens BBSes on this hub offer, with their consent.',
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
