//  The baker, first slice (world.md §7; assets spec §2, §3): ANSI art in,
//  every version a hub needs out.
//
//    npm run bake -- --out DIR --font cp437-8x16.psf [options] FILE.ans...
//
//  For each file it writes, under DIR/files, named by the SHA-256 of their
//  bytes:
//
//    - the art again, cleaned (ansi.ts), with its SAUCE record;
//    - a PNG at full size, drawn with the VGA font, and one at half size;
//    - its plain text.
//
//  and in DIR/library.json, a catalogue holding one asset record per file,
//  in the shapes the assets spec drafts (development names). A hub serves
//  the directory as it is (assets.library in its config); later the same
//  records are published to an AT repo instead.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { blankMci, gridText, parseAnsi, readSauce, writeAnsi, type Sauce } from './ansi.ts';
import { readPsf, renderPng, renderThumb } from './ansi_image.ts';

export const ToolName = 'nexus-lounge-baker 0.1';
export const Prefix = 'nexus.cyberspace.dev';

export interface FileRef {
    sha256: string;
    size: number;
    mediaType: string;
}

export interface Version {
    form: 'ansi' | 'image' | 'text';
    file: FileRef;
    size?: { width: number; height: number };
    made: 'hand' | 'derived';
    tool?: string;
}

export interface AssetRecord {
    $type: string;
    name: string;
    description: { short: string; long?: string };
    kind: string;
    themes: string[];
    versions: Version[];
    rating: string;
    licence: { id: string; url?: string; text?: string };
    permissions: Record<string, string>;
    credit: { author?: string; group?: string; note?: string };
    createdAt: string;
}

export interface LibraryItem {
    //  the SHA-256 of its cleaned ANSI: its name on the hub
    id: string;
    record: AssetRecord;
}

export interface Library {
    $type: string;
    name: string;
    description: string;
    createdAt: string;
    items: LibraryItem[];
}

export interface BakeOptions {
    font: string;
    //  blank ENiGMA½'s MCI codes (%TL1 and the like)
    mci: boolean;
    licence: AssetRecord['licence'];
    rating: string;
    themes: string[];
    //  credit for art whose SAUCE names nobody
    author: string;
    group: string;
    note: string;
}

function sha256(bytes: Buffer): string {
    return createHash('sha256').update(bytes).digest('hex');
}

function nameFrom(path: string, sauce: Sauce | null): string {
    if (sauce?.title) {
        return sauce.title;
    }
    return basename(path).replace(/\.[^.]*$/, '');
}

//  Bake one file: its outputs, by hash, and its record
export function bakeOne(
    path: string,
    file: Buffer,
    options: BakeOptions,
    font = readPsf(options.font),
    now = new Date()
): { files: Map<string, Buffer>; item: LibraryItem } {
    const { body, sauce } = readSauce(file);
    const grid = parseAnsi(options.mci ? blankMci(body) : body, { width: sauce?.width, ice: sauce?.ice });
    //  SAUCE's own credit wins; "Anonymous" says nothing
    const named = (value: string | undefined) => (value && !/^anonymous$/i.test(value) ? value : '');
    const author = named(sauce?.author) || options.author;
    const group = named(sauce?.group) || options.group;
    const name = nameFrom(path, sauce);
    const files = new Map<string, Buffer>();
    const add = (bytes: Buffer, mediaType: string): FileRef => {
        const hash = sha256(bytes);
        files.set(hash, bytes);
        return { sha256: hash, size: bytes.length, mediaType };
    };

    const cleaned = writeAnsi(grid, { title: name, author, group, date: sauce?.date ?? '' });
    const ansi = add(cleaned, 'text/x-ansi');
    //  its size as written, which leaves off what shows nothing
    const columns = readSauce(cleaned).sauce;
    const png = add(renderPng(grid, font), 'image/png');
    const thumb = add(renderThumb(grid, font), 'image/png');
    const text = add(Buffer.from(gridText(grid), 'utf8'), 'text/plain; charset=utf-8');
    const pixels = { width: grid.width * font.width, height: Math.max(1, grid.rows.length) * font.height };
    const by = [author, group && `of ${group}`].filter(Boolean).join(' ');

    const record: AssetRecord = {
        $type: `${Prefix}.asset.item`,
        name,
        description: {
            short: `${name}: ANSI art${by ? ` by ${by}` : ''}`,
            long: [
                `${columns?.width} by ${columns?.height} characters of ANSI art`,
                by ? `by ${by}` : '',
                sauce?.date ? `dated ${sauce.date.slice(0, 4)}` : '',
            ]
                .filter(Boolean)
                .join(', '),
        },
        kind: 'art',
        themes: options.themes,
        versions: [
            {
                form: 'ansi',
                file: ansi,
                size: { width: columns?.width ?? 0, height: columns?.height ?? 0 },
                made: 'hand',
            },
            { form: 'image', file: png, size: pixels, made: 'derived', tool: ToolName },
            {
                form: 'image',
                file: thumb,
                size: { width: pixels.width >> 1, height: pixels.height >> 1 },
                made: 'derived',
                tool: ToolName,
            },
            { form: 'text', file: text, made: 'derived', tool: ToolName },
        ],
        rating: options.rating,
        licence: options.licence,
        //  shown by the hub; anything more needs a licence that allows it
        permissions: { use: 'anyone', copy: 'nobody', restyle: 'nobody', remix: 'nobody' },
        credit: {
            ...(author ? { author } : {}),
            ...(group ? { group } : {}),
            ...(options.note ? { note: options.note } : {}),
        },
        createdAt: now.toISOString(),
    };
    return { files, item: { id: ansi.sha256, record } };
}

export function bake(
    paths: string[],
    out: string,
    options: BakeOptions,
    catalogue: { name: string; description: string },
    log: (line: string) => void = () => {}
): Library {
    const font = readPsf(options.font);
    mkdirSync(join(out, 'files'), { recursive: true });
    //  added to what is there already, so packs with different credits can
    //  share a library
    const existing = join(out, 'library.json');
    const before: Library | null = existsSync(existing) ? JSON.parse(readFileSync(existing, 'utf8')) : null;
    const items: LibraryItem[] = before?.items ?? [];
    for (const path of paths) {
        try {
            const { files, item } = bakeOne(path, readFileSync(path), options, font);
            for (const [hash, bytes] of files) {
                writeFileSync(join(out, 'files', hash), bytes);
            }
            if (items.some(i => i.id === item.id)) {
                log(`${path}: the same art as one already baked; skipped`);
                continue;
            }
            items.push(item);
            const ansi = item.record.versions[0];
            log(
                `${path}: ${item.record.name} (${ansi?.size?.width}x${ansi?.size?.height}) ${item.id.slice(0, 12)}`
            );
        } catch (e) {
            log(`${path}: not baked: ${(e as Error).message}`);
        }
    }
    const library: Library = {
        $type: `${Prefix}.asset.catalogue`,
        name: before?.name ?? catalogue.name,
        description: before?.description ?? catalogue.description,
        createdAt: before?.createdAt ?? new Date().toISOString(),
        items,
    };
    writeFileSync(join(out, 'library.json'), JSON.stringify(library, null, 2) + '\n');
    return library;
}

if (import.meta.main) {
    const { values, positionals } = parseArgs({
        allowPositionals: true,
        options: {
            out: { type: 'string' },
            font: { type: 'string' },
            mci: { type: 'boolean', default: false },
            name: { type: 'string', default: 'ANSI art' },
            description: { type: 'string', default: '' },
            licence: { type: 'string', default: 'custom' },
            'licence-url': { type: 'string' },
            'licence-text': { type: 'string' },
            rating: { type: 'string', default: 'general' },
            theme: { type: 'string', multiple: true, default: [] },
            author: { type: 'string', default: '' },
            group: { type: 'string', default: '' },
            note: { type: 'string', default: '' },
        },
    });
    if (!values.out || !values.font || !positionals.length) {
        console.error(
            'npm run bake -- --out DIR --font cp437-8x16.psf [--mci] [--name NAME] [--licence ID]\n' +
                '    [--licence-url URL] [--licence-text TEXT] [--rating general] [--theme TAG]...\n' +
                '    [--author NAME] [--group NAME] [--note TEXT] FILE...'
        );
        process.exit(2);
    }
    const already = join(values.out, 'library.json');
    const before = existsSync(already)
        ? (JSON.parse(readFileSync(already, 'utf8')) as Library).items.length
        : 0;
    const library = bake(
        positionals,
        values.out,
        {
            font: values.font,
            mci: values.mci,
            licence: {
                id: values.licence,
                ...(values['licence-url'] ? { url: values['licence-url'] } : {}),
                ...(values['licence-text'] ? { text: values['licence-text'] } : {}),
            },
            rating: values.rating,
            themes: values.theme,
            author: values.author,
            group: values.group,
            note: values.note,
        },
        { name: values.name, description: values.description },
        line => console.log(line)
    );
    console.log(
        `\n${library.items.length - before} of ${positionals.length} added; ${library.items.length} in ${values.out}`
    );
}
