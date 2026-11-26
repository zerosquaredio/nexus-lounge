//  People's Bluesky pictures, for the map (assets spec §11 step 1, vision
//  §7.2): for someone the common space shows as their own account, the hub
//  reads the avatar of their public Bluesky profile (app.bsky.actor.profile),
//  fetches it from their account's host, checks it (a JPEG or PNG, small
//  enough in bytes and in size) and serves its own copy, at /pictures/<sha256>,
//  so viewers' browsers never reach Bluesky. Each picture is read again at
//  most every few hours; one nobody has needed for a week is deleted, and
//  so is one its owner turns off (their profile's setting).

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AtClient } from './atproto.ts';

//  Bluesky takes avatars up to 1 MB
export const MaxPictureBytes = 1_000_000;
export const MaxPictureSide = 2048;
//  read again after this long
const FreshMs = 6 * 60 * 60 * 1000;
//  deleted when nobody has needed it this long
const KeepMs = 7 * 24 * 60 * 60 * 1000;
//  a failed reading waits this long before another
const RetryMs = 60 * 60 * 1000;

export const PictureTypes = { jpeg: 'image/jpeg', png: 'image/png' } as const;

export interface PictureInfo {
    url: string;
    width: number;
    height: number;
}

interface Kept {
    //  the profile record's blob, and the file the hub keeps of it
    cid: string;
    sha256: string;
    type: keyof typeof PictureTypes;
    width: number;
    height: number;
    checkedAt: number;
    wantedAt: number;
}

//  The size of a PNG or JPEG, and which it is; null for anything else
export function pictureSize(body: Buffer): { type: keyof typeof PictureTypes; width: number; height: number } | null {
    if (
        body.length >= 24 &&
        body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) &&
        'IHDR' === body.toString('latin1', 12, 16)
    ) {
        return { type: 'png', width: body.readUInt32BE(16), height: body.readUInt32BE(20) };
    }
    if (body.length < 4 || 0xff !== body[0] || 0xd8 !== body[1] || 0xff !== body[2]) {
        return null;
    }
    //  JPEG: the frame header (SOF0 to SOF15, but not DHT, JPG or DAC)
    //  holds the size; segments before it are skipped by their lengths
    let at = 2;
    while (at + 4 <= body.length) {
        if (0xff !== body[at]) {
            return null;
        }
        const marker = body[at + 1]!;
        if (0xff === marker) {
            at += 1;
            continue;
        }
        if (0xd8 === marker || (marker >= 0xd0 && marker <= 0xd7) || 0x01 === marker) {
            at += 2;
            continue;
        }
        const length = body.readUInt16BE(at + 2);
        if (length < 2) {
            return null;
        }
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
            if (at + 9 > body.length) {
                return null;
            }
            return { type: 'jpeg', height: body.readUInt16BE(at + 5), width: body.readUInt16BE(at + 7) };
        }
        if (0xd9 === marker || 0xda === marker) {
            return null; //  the image data, or its end, before any size
        }
        at += 2 + length;
    }
    return null;
}

//  The avatar blob a profile record names, if it names a usable one
export function avatarOf(record: unknown): { cid: string; size: number } | null {
    const avatar = (record as { avatar?: unknown } | null)?.avatar as
        | { ref?: { $link?: unknown }; mimeType?: unknown; size?: unknown }
        | undefined;
    const cid = avatar?.ref?.$link;
    const size = avatar?.size;
    if (
        'string' !== typeof cid ||
        !['image/jpeg', 'image/png'].includes(String(avatar?.mimeType)) ||
        'number' !== typeof size ||
        size < 1 ||
        size > MaxPictureBytes
    ) {
        return null;
    }
    return { cid, size };
}

export class Pictures {
    dir: string;
    at: AtClient;
    log: (line: string) => void;
    now: () => number;
    //  told when a picture arrives or goes, so the live model can say so
    onChange: () => void = () => {};
    private kept = new Map<string, Kept>();
    private failed = new Map<string, number>();
    private queue: string[] = [];
    private busy = false;

    constructor(dir: string, at: AtClient, log: (line: string) => void = () => {}, now: () => number = Date.now) {
        this.dir = dir;
        this.at = at;
        this.log = log;
        this.now = now;
        mkdirSync(join(dir, 'files'), { recursive: true });
        try {
            const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as Record<string, Kept>;
            for (const [did, k] of Object.entries(index)) {
                if (existsSync(join(dir, 'files', k.sha256))) {
                    this.kept.set(did, k);
                }
            }
        } catch {
            //  none yet
        }
    }

    //  The picture to show for |did| now, if the hub has one; asking for it
    //  also has it fetched, or read again, in the background
    pictureOf(did: string): PictureInfo | null {
        const k = this.kept.get(did);
        const now = this.now();
        if (k) {
            k.wantedAt = now;
        }
        if ((!k || now - k.checkedAt > FreshMs) && now - (this.failed.get(did) ?? 0) > RetryMs) {
            this.want(did);
        }
        return k ? { url: `/pictures/${k.sha256}`, width: k.width, height: k.height } : null;
    }

    file(sha256: string): { body: Buffer; type: string } | null {
        if (!/^[0-9a-f]{64}$/.test(sha256)) {
            return null;
        }
        const k = [...this.kept.values()].find(p => p.sha256 === sha256);
        if (!k) {
            return null;
        }
        try {
            return { body: readFileSync(join(this.dir, 'files', sha256)), type: PictureTypes[k.type] };
        } catch {
            return null;
        }
    }

    //  Their picture deleted (they turned it off, or removed their profile)
    forget(did: string): void {
        const k = this.kept.get(did);
        if (!k) {
            return;
        }
        this.kept.delete(did);
        this.deleteFile(k.sha256);
        this.save();
        this.onChange();
    }

    //  Pictures nobody has needed for a week, deleted
    prune(): void {
        const now = this.now();
        let changed = false;
        for (const [did, k] of this.kept) {
            if (now - k.wantedAt > KeepMs) {
                this.kept.delete(did);
                this.deleteFile(k.sha256);
                changed = true;
            }
        }
        if (changed) {
            this.save();
        }
    }

    //  Fetch what is wanted, one at a time; resolves once the queue is empty
    //  (for tests)
    settled: Promise<void> = Promise.resolve();

    private want(did: string): void {
        if (this.queue.includes(did)) {
            return;
        }
        this.queue.push(did);
        if (!this.busy) {
            this.settled = this.drain();
        }
    }

    private async drain(): Promise<void> {
        this.busy = true;
        try {
            for (let did = this.queue.shift(); did; did = this.queue.shift()) {
                try {
                    if (await this.read(did)) {
                        this.onChange();
                    }
                } catch (e) {
                    this.failed.set(did, this.now());
                    this.log(`pictures: ${did}: ${(e as Error).message}`);
                }
            }
        } finally {
            this.busy = false;
        }
    }

    //  Read one person's picture; true if what is shown changed
    private async read(did: string): Promise<boolean> {
        const before = this.kept.get(did);
        const profile = await this.at.getRecord(did, 'app.bsky.actor.profile', 'self');
        const avatar = profile ? avatarOf(profile.value) : null;
        if (!avatar) {
            //  no picture (any more)
            if (before) {
                this.kept.delete(did);
                this.deleteFile(before.sha256);
                this.save();
                return true;
            }
            this.failed.set(did, this.now());
            return false;
        }
        if (before && before.cid === avatar.cid) {
            before.checkedAt = this.now();
            this.save();
            return false;
        }
        const body = await this.at.getBlob(did, avatar.cid, MaxPictureBytes);
        const size = pictureSize(body);
        if (!size) {
            throw new Error('its picture is neither a JPEG nor a PNG');
        }
        if (!size.width || !size.height || size.width > MaxPictureSide || size.height > MaxPictureSide) {
            throw new Error(`its picture is ${size.width} by ${size.height}, too large`);
        }
        const sha256 = createHash('sha256').update(body).digest('hex');
        writeFileSync(join(this.dir, 'files', sha256), body);
        this.kept.set(did, {
            cid: avatar.cid,
            sha256,
            type: size.type,
            width: size.width,
            height: size.height,
            checkedAt: this.now(),
            wantedAt: this.now(),
        });
        if (before && before.sha256 !== sha256) {
            this.deleteFile(before.sha256);
        }
        this.save();
        return true;
    }

    private deleteFile(sha256: string): void {
        if (![...this.kept.values()].some(k => k.sha256 === sha256)) {
            rmSync(join(this.dir, 'files', sha256), { force: true });
        }
    }

    private save(): void {
        const path = join(this.dir, 'index.json');
        writeFileSync(`${path}.new`, JSON.stringify(Object.fromEntries(this.kept)) + '\n');
        renameSync(`${path}.new`, path);
    }
}
