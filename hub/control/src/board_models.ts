//  3D models BBSes publish from their own accounts (build_3d_slice.md, the
//  assets spec's "model" form). A model is an asset.item record with two
//  versions: a binary glTF file (.glb), then a PNG that stands for it where
//  a model can't be shown. The hub fetches both from the BBS's account
//  host, checks the model with its own checker (gltf.ts) and the picture
//  likewise, and keeps what they come out as, cleaned, on disk: a model is
//  served from there, never held in memory, and named by the hash of what
//  the hub serves.
//
//  As for the art BBSes publish (board_art.ts): only BBSes in
//  assets.boardArt, and only while assets.models.enabled; a record that's
//  gone is withdrawn; a blocked file, or an account the hub refuses, is
//  neither taken nor shown. Each BBS has a count (assets.models.perBoard)
//  and all of them together a number of bytes (assets.models.totalBytes).

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ShortIdLength } from './assets.ts';
import type { AtClient } from './atproto.ts';
import type { HubConfig } from './config.ts';
import { checkGlb, checkPreviewPng, LightBudget, type ModelFigures } from './gltf.ts';
import type { Bbs } from './registry.ts';

//  a model's preview picture: no more than this, either way
export const MaxPreviewBytes = 2 * 1024 * 1024;
export const MaxPreviewSide = 2048;
export const ModelType = 'model/gltf-binary';
//  a file that failed is not fetched again for this long
const RetryMs = 60 * 60 * 1000;
//  a BBS's records are read no more often than this, however often the
//  network's stream says they changed
const MinReadGapMs = 60 * 1000;
//  what one BBS may have the hub fetch in an hour: its whole allowance
//  of models and previews, twice over. A BBS that keeps swapping its
//  records for new ones is then held to that, and told so in the log.
const FetchWindowMs = 60 * 60 * 1000;

export interface BoardModelsDeps {
    config: HubConfig;
    list: () => Bbs[];
    at: AtClient | null;
    //  whether a BBS's account is linked to it here (its listing names it)
    linked: (bbs: Bbs) => boolean;
    blocked?: (sha256: string) => boolean;
    refused?: (did: string) => boolean;
    log?: (line: string) => void;
    now?: () => number;
}

//  A file a record names: its hash and size, and the blob to fetch it by
interface Named {
    sha256: string;
    size: number;
    cid: string;
}

//  A model's record, as the hub reads it
export interface ModelRecord {
    model: Named;
    image: Named;
    name: string;
    rating: string;
    licence: { id: string; url?: string; text?: string };
    credit: { author?: string; group?: string; note?: string };
    description: { short: string; long?: string };
}

const Ratings = ['general', 'mature', 'adult'];

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && 'object' === typeof v && !Array.isArray(v) ? (v as Json) : {});
//  text from outside: trimmed, cut short, and without control or direction
//  characters, which could turn a page's text around
const str = (v: unknown, max: number): string | undefined => {
    if ('string' !== typeof v) {
        return undefined;
    }
    const plain = v.replace(/(?!‍)[\p{Cc}\p{Cf}]/gu, ' ').trim();
    const clean = Array.from(plain).slice(0, max).join('').trim();
    return clean || undefined;
};

function namedFile(version: Json, maxBytes: number): Named | null {
    const file = obj(version.file);
    const ref = obj(obj(version.blob).ref);
    const size = file.size;
    if (
        'string' !== typeof file.sha256 ||
        !/^[0-9a-f]{64}$/.test(file.sha256) ||
        !Number.isInteger(size) ||
        (size as number) < 1 ||
        (size as number) > maxBytes ||
        'string' !== typeof ref.$link ||
        ref.$link.length > 200
    ) {
        return null;
    }
    return { sha256: file.sha256, size: size as number, cid: ref.$link };
}

//  A record, if it is a model the hub can take: its first version a model
//  of class "light", keyed by its file's hash and no larger than |maxBytes|,
//  and a PNG preview after it
export function modelRecordOf(rkey: string, value: unknown, maxBytes: number): ModelRecord | null {
    const v = obj(value);
    const versions = Array.isArray(v.versions) ? v.versions.slice(0, 8).map(obj) : [];
    const first = versions[0] ?? {};
    if ('model' !== first.form || 'light' !== first.class) {
        return null;
    }
    const model = namedFile(first, maxBytes);
    const preview = versions.slice(1).find(version => 'image' === version.form);
    const image = preview ? namedFile(preview, MaxPreviewBytes) : null;
    if (!model || model.sha256 !== rkey || !image) {
        return null;
    }
    const licence = obj(v.licence);
    const url = str(licence.url, 512);
    const credit = obj(v.credit);
    const description = obj(v.description);
    const name = str(v.name, 80) ?? '';
    const long = str(description.long, 2000);
    return {
        model,
        image,
        name,
        rating: Ratings.includes(v.rating as string) ? (v.rating as string) : 'general',
        licence: {
            id: str(licence.id, 64) ?? 'custom',
            ...(url && /^https:\/\/[^\s"'<>]+$/.test(url) ? { url } : {}),
            ...(str(licence.text, 500) ? { text: str(licence.text, 500) } : {}),
        },
        credit: {
            ...(str(credit.author, 80) ? { author: str(credit.author, 80) } : {}),
            ...(str(credit.group, 80) ? { group: str(credit.group, 80) } : {}),
            ...(str(credit.note, 200) ? { note: str(credit.note, 200) } : {}),
        },
        description: { short: str(description.short, 300) ?? (name || 'A 3D model'), ...(long ? { long } : {}) },
    };
}

//  What the hub keeps of a model it took
export interface KeptModel {
    bbs: string;
    //  the record's version: when it changes, what it says is read again
    cid: string;
    //  the record's key: the hash of the model as the BBS published it
    raw: string;
    //  the hash of the model as the hub serves it, cleaned: the item's id
    id: string;
    //  the hash of the cleaned preview, and of the picture it was made from
    preview: string;
    previewSource: string;
    previewSize: { width: number; height: number };
    name: string;
    rating: string;
    licence: ModelRecord['licence'];
    credit: ModelRecord['credit'];
    description: ModelRecord['description'];
    figures: ModelFigures;
    //  the bytes of both files, as kept, for the hub's total
    bytes: number;
}

//  What pages are told about a model
export interface ModelItem {
    id: string;
    short: string;
    bbs: string;
    name: string;
    description: { short: string; long?: string };
    credit: { author?: string; group?: string; note?: string };
    licence: { id: string; url?: string; text?: string };
    rating: string;
    //  the page for it, and its preview picture, on this hub
    page: string;
    image: { url: string; width: number; height: number };
    model: { url: string; bytes: number; triangles: number; animations: string[]; effects: string[] };
}

export interface ModelFile {
    path: string;
    type: string;
}

export class BoardModels {
    deps: BoardModelsDeps;
    dir: string;
    log: (line: string) => void;
    now: () => number;
    //  by keyOf()
    kept = new Map<string, KeptModel>();
    failed = new Map<string, number>();
    settleMs = 5_000;
    private queue: Promise<void> = Promise.resolve();
    private soon = new Map<string, ReturnType<typeof setTimeout>>();
    //  by BBS: when its records were last read, and what it had fetched
    //  in the current hour
    private lastRead = new Map<string, number>();
    private fetchedIn = new Map<string, { since: number; bytes: number }>();

    constructor(deps: BoardModelsDeps, dir: string) {
        this.deps = deps;
        this.dir = dir;
        this.log = deps.log ?? (() => {});
        this.now = deps.now ?? Date.now;
        mkdirSync(join(dir, 'files'), { recursive: true });
        const index = join(dir, 'models.json');
        if (existsSync(index)) {
            for (const kept of JSON.parse(readFileSync(index, 'utf8')) as KeptModel[]) {
                this.kept.set(keyOf(kept.bbs, kept.raw), kept);
            }
        }
    }

    get settings() {
        return this.deps.config.assets.models;
    }

    allowed(bbs: Bbs): boolean {
        return (
            this.settings.enabled &&
            'active' === bbs.state &&
            this.deps.config.assets.boardArt.includes(bbs.name) &&
            !(bbs.bbsDid && (this.deps.refused?.(bbs.bbsDid) ?? false))
        );
    }

    isBlocked(sha256: string): boolean {
        return this.deps.blocked?.(sha256) ?? false;
    }

    //  whether a model kept may be shown now: its BBS still taken from and
    //  linked to its account here, and none of its files blocked
    private shown(kept: KeptModel, bbses: Map<string, Bbs>): boolean {
        const bbs = bbses.get(kept.bbs);
        return (
            !!bbs &&
            this.allowed(bbs) &&
            this.deps.linked(bbs) &&
            !this.isBlocked(kept.raw) &&
            !this.isBlocked(kept.id) &&
            !this.isBlocked(kept.preview) &&
            this.deps.config.directory.ratings.includes(kept.rating)
        );
    }

    private shownModels(): KeptModel[] {
        const bbses = new Map(this.deps.list().map(bbs => [bbs.name, bbs]));
        return [...this.kept.values()].filter(kept => this.shown(kept, bbses));
    }

    //  The models shown, the first of each id only, in the order taken
    items(): ModelItem[] {
        const seen = new Set<string>();
        return this.shownModels()
            .filter(kept => !seen.has(kept.id) && !!seen.add(kept.id))
            .map(itemOf);
    }

    itemsFor(bbs: string): ModelItem[] {
        return this.items().filter(item => item.bbs === bbs);
    }

    byShortId(short: string): ModelItem | null {
        if (!/^[0-9a-f]{12}$/.test(short)) {
            return null;
        }
        return this.items().find(item => item.short === short) ?? null;
    }

    //  A file to serve, if a model shown now has it: the model or its preview
    file(sha256: string): ModelFile | null {
        if (!/^[0-9a-f]{64}$/.test(sha256)) {
            return null;
        }
        for (const kept of this.shownModels()) {
            if (kept.id === sha256 || kept.preview === sha256) {
                return { path: join(this.dir, 'files', sha256), type: kept.id === sha256 ? ModelType : 'image/png' };
            }
        }
        return null;
    }

    //  The bytes the files of all the models kept take on disk, together: a
    //  file two BBSes publish is kept, and counted, once
    totalBytes(): number {
        const sizes = new Map<string, number>();
        for (const kept of this.kept.values()) {
            sizes.set(kept.id, kept.figures.bytes);
            sizes.set(kept.preview, kept.bytes - kept.figures.bytes);
        }
        return [...sizes.values()].reduce((sum, bytes) => sum + bytes, 0);
    }

    //  Read what each BBS publishes (or only those named), and take what is
    //  new. One reading at a time.
    refresh(only?: string[]): Promise<void> {
        const run = this.queue.then(() => this.read(only));
        this.queue = run.catch(() => {});
        return run;
    }

    //  One account's records changed (the network's stream says so): read
    //  that BBS's again, soon, once however many changes come
    changed(did: string): void {
        const bbs = this.deps.list().find(b => b.bbsDid === did);
        if (!bbs || this.soon.has(bbs.name) || !this.settings.enabled) {
            return;
        }
        //  no sooner than a minute after the last reading of it
        const wait = Math.max(this.settleMs, (this.lastRead.get(bbs.name) ?? -Infinity) + MinReadGapMs - this.now());
        const timer = setTimeout(() => {
            this.soon.delete(bbs.name);
            void this.refresh([bbs.name]).catch(e => this.log(`board models: ${(e as Error).message}`));
        }, wait);
        timer.unref?.();
        this.soon.set(bbs.name, timer);
    }

    private async read(only?: string[]): Promise<void> {
        const bbses = this.deps.list();
        //  a BBS removed from the hub leaves nothing behind
        const registered = new Set(bbses.map(b => b.name));
        this.drop(kept => !registered.has(kept.bbs));
        for (const [key, at] of this.failed) {
            if (this.now() - at >= RetryMs) {
                this.failed.delete(key);
            }
        }
        for (const bbs of bbses.filter(b => !only || only.includes(b.name))) {
            await this.readOne(bbs);
        }
        this.prune();
    }

    private async readOne(bbs: Bbs): Promise<void> {
        if (!this.allowed(bbs)) {
            //  not taken from (any more): what was taken goes
            this.drop(kept => kept.bbs === bbs.name);
            return;
        }
        const at = this.deps.at;
        //  not linked to its account here just now: its models are hidden
        //  (shown()), and kept, so a short gap costs nothing to fetch again
        if (!at || !bbs.bbsDid || !this.deps.linked(bbs)) {
            return;
        }
        this.lastRead.set(bbs.name, this.now());
        //  the collection holds the BBS's ANSI art too: read far enough for
        //  all it may publish of both
        const listMax = this.deps.config.assets.boardPieces + this.settings.perBoard + 100;
        let records: { rkey: string; cid: string; value: unknown }[];
        try {
            records = await at.listRecords(bbs.bbsDid, `${this.deps.config.directory.nsidPrefix}.asset.item`, listMax);
        } catch (e) {
            this.log(`board models: can't read ${bbs.name}'s records: ${(e as Error).message}`);
            return;
        }
        //  first what it publishes now, so what it withdrew makes room before
        //  anything new is taken
        const published = new Map<string, { record: ModelRecord; cid: string }>();
        let over = false;
        for (const entry of records) {
            const model = modelRecordOf(entry.rkey, entry.value, this.settings.maxBytes);
            if (
                !model ||
                !this.deps.config.directory.ratings.includes(model.rating) ||
                this.isBlocked(model.model.sha256) ||
                this.isBlocked(model.image.sha256)
            ) {
                continue;
            }
            if (published.size >= this.settings.perBoard) {
                over = true;
                break;
            }
            published.set(keyOf(bbs.name, model.model.sha256), { record: model, cid: entry.cid });
        }
        if (over) {
            this.log(`board models: ${bbs.name} publishes more than ${this.settings.perBoard} models; the rest are left out`);
        }
        //  a model whose record is gone is withdrawn (assets spec §6.5); not
        //  when the listing was cut short, where it may only be further on
        if (records.length < listMax) {
            this.drop(kept => kept.bbs === bbs.name && !published.has(keyOf(kept.bbs, kept.raw)));
            this.prune();
        }
        for (const [key, { record, cid }] of published) {
            const kept = this.kept.get(key);
            if (kept?.cid === cid || this.now() - (this.failed.get(key) ?? -Infinity) < RetryMs) {
                continue;
            }
            try {
                if (kept) {
                    await this.update(bbs, kept, record, cid);
                } else {
                    await this.take(bbs, record, cid);
                }
            } catch (e) {
                this.failed.set(key, this.now());
                this.log(`board models: ${bbs.name}'s ${record.name || 'model'} not taken: ${(e as Error).message}`);
            }
        }
    }

    //  Count |bytes| against what the BBS may have fetched this hour; refuse
    //  if it would go over
    private spend(bbs: Bbs, bytes: number): void {
        const allowance = 2 * this.settings.perBoard * (this.settings.maxBytes + MaxPreviewBytes);
        const now = this.now();
        let spent = this.fetchedIn.get(bbs.name);
        if (!spent || now - spent.since >= FetchWindowMs) {
            spent = { since: now, bytes: 0 };
            this.fetchedIn.set(bbs.name, spent);
        }
        if (spent.bytes + bytes > allowance) {
            throw new Error(`${bbs.name} has had the hub fetch ${spent.bytes} bytes this hour, its limit`);
        }
        spent.bytes += bytes;
    }

    //  A model kept whose record changed: what it says of the model is read
    //  again, and its preview fetched again if that is another picture. The
    //  model itself is the record's key, so it hasn't changed.
    async update(bbs: Bbs, kept: KeptModel, record: ModelRecord, cid: string): Promise<void> {
        let preview = { sha256: kept.preview, size: kept.previewSize, bytes: kept.bytes - kept.figures.bytes };
        if (record.image.sha256 !== kept.previewSource) {
            const fresh = await this.fetchPreview(bbs, record, kept.bytes - kept.figures.bytes);
            this.write(fresh.sha256, fresh.cleaned);
            preview = {
                sha256: fresh.sha256,
                size: { width: fresh.width, height: fresh.height },
                bytes: fresh.cleaned.length,
            };
        }
        const now: KeptModel = {
            ...kept,
            ...this.said(record),
            cid,
            preview: preview.sha256,
            previewSource: record.image.sha256,
            previewSize: preview.size,
            bytes: kept.figures.bytes + preview.bytes,
        };
        this.kept.set(keyOf(bbs.name, kept.raw), now);
        this.save();
        this.prune();
        this.log(`board models: read ${bbs.name}'s ${now.name} (${now.id.slice(0, ShortIdLength)}) again`);
    }

    //  What a record says of its model, as kept
    private said(record: ModelRecord) {
        return {
            name: record.name || 'Untitled model',
            rating: record.rating,
            licence: record.licence,
            credit: record.credit,
            description: record.description,
        };
    }

    //  A model's preview, fetched, checked and cleaned; |freed|: the bytes
    //  of the one it replaces, if any, for the hub's total
    private async fetchPreview(bbs: Bbs, record: ModelRecord, freed = 0) {
        if (record.image.size > this.settings.totalBytes - this.totalBytes() + freed) {
            throw new Error(`no room: the hub keeps ${this.settings.totalBytes} bytes of models in all`);
        }
        this.spend(bbs, record.image.size);
        const picture = await this.deps.at!.getBlob(bbs.bbsDid!, record.image.cid, MaxPreviewBytes);
        if (picture.length !== record.image.size || sha256Of(picture) !== record.image.sha256) {
            throw new Error("the preview picture isn't the file its record names");
        }
        const preview = checkPreviewPng(picture, MaxPreviewSide, MaxPreviewBytes);
        if (this.isBlocked(preview.sha256)) {
            throw new Error('the preview picture is blocked on this hub');
        }
        return preview;
    }

    async take(bbs: Bbs, record: ModelRecord, cid: string): Promise<void> {
        const at = this.deps.at!;
        const room = this.settings.totalBytes - this.totalBytes();
        //  what the BBS says the files are; the hub's own copies are no larger
        if (record.model.size + record.image.size > room) {
            throw new Error(`no room: the hub keeps ${this.settings.totalBytes} bytes of models in all`);
        }
        this.spend(bbs, record.model.size);
        const body = await at.getBlob(bbs.bbsDid!, record.model.cid, this.settings.maxBytes);
        if (body.length !== record.model.size || sha256Of(body) !== record.model.sha256) {
            throw new Error("the model isn't the file its record names");
        }
        const checked = checkGlb(body, { ...LightBudget, fileBytes: this.settings.maxBytes });
        if (this.isBlocked(checked.sha256)) {
            throw new Error('the model is blocked on this hub');
        }
        //  (its room was held above, with the model's)
        const preview = await this.fetchPreview(bbs, record);
        this.write(checked.sha256, checked.cleaned);
        this.write(preview.sha256, preview.cleaned);
        const kept: KeptModel = {
            bbs: bbs.name,
            cid,
            raw: record.model.sha256,
            id: checked.sha256,
            preview: preview.sha256,
            previewSource: record.image.sha256,
            previewSize: { width: preview.width, height: preview.height },
            ...this.said(record),
            figures: checked.measured,
            bytes: checked.cleaned.length + preview.cleaned.length,
        };
        this.kept.set(keyOf(bbs.name, kept.raw), kept);
        this.save();
        this.log(
            `board models: took ${bbs.name}'s ${kept.name} (${kept.id.slice(0, ShortIdLength)}, ${
                kept.figures.triangles
            } triangles, ${kept.figures.bytes} bytes)`
        );
    }

    //  Forget the models |which| picks; prune() then deletes their files
    drop(which: (kept: KeptModel) => boolean): void {
        const gone = [...this.kept.entries()].filter(([, kept]) => which(kept));
        if (!gone.length) {
            return;
        }
        for (const [key] of gone) {
            this.kept.delete(key);
        }
        this.save();
        this.log(`board models: let go of ${gone.map(([, kept]) => `${kept.bbs}'s ${kept.name}`).join(', ')}`);
    }

    //  The files no model kept uses, deleted
    prune(): void {
        const used = new Set([...this.kept.values()].flatMap(kept => [kept.id, kept.preview]));
        for (const name of readdirSync(join(this.dir, 'files'))) {
            if (!used.has(name)) {
                rmSync(join(this.dir, 'files', name), { force: true });
            }
        }
    }

    private write(sha256: string, body: Buffer): void {
        const path = join(this.dir, 'files', sha256);
        writeFileSync(`${path}.new`, body);
        renameSync(`${path}.new`, path);
    }

    private save(): void {
        const path = join(this.dir, 'models.json');
        writeFileSync(`${path}.new`, JSON.stringify([...this.kept.values()], null, 2) + '\n');
        renameSync(`${path}.new`, path);
    }
}

const keyOf = (bbs: string, raw: string) => `${bbs}:${raw}`;
const sha256Of = (body: Buffer) => createHash('sha256').update(body).digest('hex');

function itemOf(kept: KeptModel): ModelItem {
    const short = kept.id.slice(0, ShortIdLength);
    return {
        id: kept.id,
        short,
        bbs: kept.bbs,
        name: kept.name,
        description: kept.description,
        credit: kept.credit,
        licence: kept.licence,
        rating: kept.rating,
        page: `/art/${short}`,
        image: { url: `/assets/${kept.preview}`, ...kept.previewSize },
        model: {
            url: `/assets/${kept.id}`,
            bytes: kept.figures.bytes,
            triangles: kept.figures.triangles,
            animations: kept.figures.animations.map(a => a.name),
            effects: kept.figures.effects,
        },
    };
}
