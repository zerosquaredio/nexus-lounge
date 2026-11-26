import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { avatarOf, Pictures, pictureSize, selfLabelRatings, type PictureRules } from '../src/pictures.ts';
import type { AtClient } from '../src/atproto.ts';

const Did = 'did:plc:abcdefghijklmnopqrstuvwx';

//  the smallest JPEG that says its size: start, an APP0 segment, a frame
//  header (SOF0) of |w| by |h|
function jpeg(w: number, h: number): Buffer {
    const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
    const sof = Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, h >> 8, h & 255, w >> 8, w & 255, 0x01, 0x01, 0x11, 0x00]);
    return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}

function png(w: number, h: number): Buffer {
    const b = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
    b.writeUInt32BE(13, 8);
    b.write('IHDR', 12, 'latin1');
    b.writeUInt32BE(w, 16);
    b.writeUInt32BE(h, 20);
    return b;
}

describe("people's Bluesky pictures", () => {
    it('reads the size of a JPEG or PNG, and nothing else', () => {
        assert.deepEqual(pictureSize(jpeg(400, 300)), { type: 'jpeg', width: 400, height: 300 });
        assert.deepEqual(pictureSize(png(64, 32)), { type: 'png', width: 64, height: 32 });
        assert.equal(pictureSize(Buffer.from('<svg></svg>')), null);
        assert.equal(pictureSize(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0, 2])), null, 'no size before the data');
        assert.equal(pictureSize(Buffer.from([0xff, 0xd8, 0xff])), null);
    });

    it("takes a profile's avatar only as a JPEG or PNG blob of up to 1 MB", () => {
        const avatar = (extra: Record<string, unknown> = {}) => ({
            avatar: { $type: 'blob', ref: { $link: 'bafkreiabc' }, mimeType: 'image/jpeg', size: 5000, ...extra },
        });
        assert.deepEqual(avatarOf(avatar()), { cid: 'bafkreiabc', size: 5000 });
        assert.equal(avatarOf(avatar({ mimeType: 'image/svg+xml' })), null);
        assert.equal(avatarOf(avatar({ size: 2_000_000 })), null);
        assert.equal(avatarOf({}), null);
        assert.equal(avatarOf(null), null);
    });

    it("reads a profile's own labels as the ratings they need", () => {
        const labels = (...vals: string[]) => ({ labels: { values: vals.map(val => ({ val })) } });
        assert.deepEqual(selfLabelRatings(labels('nudity', 'porn')), ['mature', 'adult']);
        assert.deepEqual(selfLabelRatings(labels('something-new')), ['adult'], 'unknown counts as adult');
        assert.deepEqual(selfLabelRatings(labels('!no-unauthenticated')), [], 'not a content label');
        assert.deepEqual(selfLabelRatings({}), []);
    });

    describe('kept by the hub', () => {
        let dir: string;
        let profile: unknown;
        let blobs: Map<string, Buffer>;
        let asked: string[];
        let clock: number;
        const at = {
            async getRecord(did: string, collection: string, rkey: string) {
                asked.push(`record ${did} ${collection} ${rkey}`);
                return profile ? { cid: 'rec', value: profile } : null;
            },
            async getBlob(_did: string, cid: string) {
                asked.push(`blob ${cid}`);
                const body = blobs.get(cid);
                if (!body) {
                    throw new Error('HTTP 404');
                }
                return body;
            },
        } as unknown as AtClient;
        const withAvatar = (cid: string, body: Buffer) => {
            blobs.set(cid, body);
            profile = { avatar: { ref: { $link: cid }, mimeType: 'image/jpeg', size: body.length } };
        };
        const make = (rules: PictureRules = {}) =>
            new Pictures(join(dir, 'pictures'), at, () => {}, () => clock, rules);

        beforeEach(() => {
            dir = mkdtempSync(join(tmpdir(), 'hub-pictures-'));
            profile = null;
            blobs = new Map();
            asked = [];
            clock = Date.parse('2026-11-26T12:00:00Z');
        });
        afterEach(() => rmSync(dir, { recursive: true, force: true }));

        it('fetches a picture when first asked, serves its copy, and says when it arrives', async () => {
            withAvatar('cid-a', jpeg(400, 400));
            const pictures = make();
            let changes = 0;
            pictures.onChange = () => changes++;
            assert.equal(pictures.pictureOf(Did), null, 'not yet');
            await pictures.settled;
            assert.equal(changes, 1);
            const shown = pictures.pictureOf(Did)!;
            assert.match(shown.url, /^\/pictures\/[0-9a-f]{64}$/);
            assert.deepEqual([shown.width, shown.height], [400, 400]);
            const file = pictures.file(shown.url.slice('/pictures/'.length))!;
            assert.equal(file.type, 'image/jpeg');
            assert.deepEqual(file.body, jpeg(400, 400));
            assert.deepEqual(asked, [`record ${Did} app.bsky.actor.profile self`, 'blob cid-a']);
            assert.ok(make().pictureOf(Did), 'kept across a restart');
        });

        it('reads it again only after a few hours, and follows a new picture', async () => {
            withAvatar('cid-a', jpeg(100, 100));
            const pictures = make();
            pictures.pictureOf(Did);
            await pictures.settled;
            const first = pictures.pictureOf(Did)!.url;
            await pictures.settled;
            assert.equal(asked.length, 2, 'nothing asked again so soon');
            withAvatar('cid-b', png(200, 200));
            clock += 7 * 60 * 60 * 1000;
            pictures.pictureOf(Did);
            await pictures.settled;
            const second = pictures.pictureOf(Did)!;
            assert.notEqual(second.url, first);
            assert.equal(pictures.file(first.slice('/pictures/'.length)), null, 'the old one is gone');
            assert.equal(existsSync(join(dir, 'pictures', 'files', first.slice('/pictures/'.length))), false);
        });

        it('refuses a picture too large or not a picture, and waits before trying again', async () => {
            withAvatar('cid-a', jpeg(5000, 5000));
            const pictures = make();
            pictures.pictureOf(Did);
            await pictures.settled;
            assert.equal(pictures.pictureOf(Did), null);
            await pictures.settled;
            assert.equal(asked.length, 2, 'not fetched again at once');
            withAvatar('cid-b', Buffer.from('<svg/>'));
            clock += 2 * 60 * 60 * 1000;
            pictures.pictureOf(Did);
            await pictures.settled;
            assert.equal(pictures.pictureOf(Did), null);
        });

        it('neither shows nor serves a blocked picture, and has it back once unblocked', async () => {
            withAvatar('cid-a', jpeg(100, 100));
            const blocked = new Set<string>();
            const pictures = make({ blocked: hash => blocked.has(hash) });
            pictures.pictureOf(Did);
            await pictures.settled;
            const hash = pictures.pictureOf(Did)!.url.slice('/pictures/'.length);
            assert.deepEqual(pictures.held(), [{ did: Did, sha256: hash }]);
            blocked.add(hash);
            assert.equal(pictures.pictureOf(Did), null);
            assert.equal(pictures.file(hash), null);
            blocked.clear();
            assert.ok(pictures.pictureOf(Did));
            assert.ok(pictures.file(hash));
        });

        it('keeps nothing for an account the hub refuses, and fetches nothing', async () => {
            withAvatar('cid-a', jpeg(100, 100));
            const refused = new Set<string>();
            const pictures = make({ refused: did => refused.has(did) });
            pictures.pictureOf(Did);
            await pictures.settled;
            const hash = pictures.pictureOf(Did)!.url.slice('/pictures/'.length);
            refused.add(Did);
            assert.equal(pictures.pictureOf(Did), null);
            assert.equal(existsSync(join(dir, 'pictures', 'files', hash)), false, 'deleted');
            const asks = asked.length;
            clock += 7 * 60 * 60 * 1000;
            pictures.pictureOf(Did);
            await pictures.settled;
            assert.equal(asked.length, asks, 'not asked for again');
        });

        it("shows no picture for a profile labelled beyond the hub's ratings", async () => {
            withAvatar('cid-a', jpeg(100, 100));
            (profile as { labels?: unknown }).labels = {
                $type: 'com.atproto.label.defs#selfLabels',
                values: [{ val: 'nudity' }],
            };
            const general = make();
            general.pictureOf(Did);
            await general.settled;
            assert.equal(general.pictureOf(Did), null);
            assert.equal(asked.filter(a => a.startsWith('blob')).length, 0, 'not even fetched');

            rmSync(join(dir, 'pictures'), { recursive: true, force: true });
            const mature = make({ ratings: ['general', 'mature'] });
            mature.pictureOf(Did);
            await mature.settled;
            assert.ok(mature.pictureOf(Did), 'a hub that lists mature shows it');

            //  labelled after it was taken: it goes at the next reading
            (profile as { labels?: unknown }).labels = { values: [{ val: 'porn' }] };
            clock += 7 * 60 * 60 * 1000;
            mature.pictureOf(Did);
            await mature.settled;
            assert.equal(mature.pictureOf(Did), null);
        });

        it('deletes a picture its owner turns off, one gone from their profile, and one unused for a week', async () => {
            withAvatar('cid-a', jpeg(100, 100));
            const pictures = make();
            pictures.pictureOf(Did);
            await pictures.settled;
            const hash = pictures.pictureOf(Did)!.url.slice('/pictures/'.length);
            pictures.forget(Did);
            assert.equal(pictures.file(hash), null);
            assert.equal(existsSync(join(dir, 'pictures', 'files', hash)), false);

            pictures.pictureOf(Did);
            await pictures.settled;
            profile = { displayName: 'no picture now' };
            clock += 7 * 60 * 60 * 1000;
            pictures.pictureOf(Did);
            await pictures.settled;
            assert.equal(pictures.pictureOf(Did), null, 'gone from the profile');

            withAvatar('cid-a', jpeg(100, 100));
            clock += 2 * 60 * 60 * 1000;
            pictures.pictureOf(Did);
            await pictures.settled;
            assert.ok(pictures.pictureOf(Did));
            clock += 8 * 24 * 60 * 60 * 1000;
            pictures.prune();
            assert.equal(existsSync(join(dir, 'pictures', 'files', hash)), false, 'unused for a week');
        });
    });
});
