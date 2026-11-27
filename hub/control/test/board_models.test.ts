import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { modelPageBody } from '../src/art_page.ts';
import { artOnHub, resolveHash } from '../src/asset_blocks.ts';
import { BoardModels, MaxPreviewBytes, modelRecordOf } from '../src/board_models.ts';
import { makeConfig } from '../src/config.ts';
import { checkGlb, checkPreviewPng } from '../src/gltf.ts';
import { modelPagePolicy, VendoredScripts, viewerFile, ViewerScripts } from '../src/model_files.ts';
import { Registry } from '../src/registry.ts';
import type { Bbs } from '../src/registry.ts';
import { SignIn } from '../src/signin.ts';
import { createSite } from '../src/site.ts';

const Models = join(import.meta.dirname, 'fixtures', 'models');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const animated = readFileSync(join(Models, 'animated.glb'));
const animatedPng = readFileSync(join(Models, 'animated.png'));
const still = readFileSync(join(Models, 'still.glb'));
const stillPng = readFileSync(join(Models, 'still.png'));
const Did = 'did:plc:cool';

//  a model's record, as the fork publishes it (core/atproto/assets.js)
function record(model: Buffer, image: Buffer, extra: Record<string, unknown> = {}) {
    const blob = (b: Buffer, type: string) => ({
        $type: 'blob',
        ref: { $link: `cid-${sha(b).slice(0, 16)}` },
        mimeType: type,
        size: b.length,
    });
    return {
        rkey: sha(model),
        cid: 'bafyrecord',
        value: {
            $type: 'nexus.cyberspace.dev.asset.item',
            name: 'Spinning boxes',
            kind: 'art',
            rating: 'general',
            licence: { id: 'CC-BY-4.0', url: 'https://creativecommons.org/licenses/by/4.0/' },
            credit: { author: 'Ana' },
            description: { short: 'Two boxes and a ball' },
            versions: [
                {
                    form: 'model',
                    class: 'light',
                    file: { sha256: sha(model), size: model.length, mediaType: 'model/gltf-binary' },
                    blob: blob(model, 'model/gltf-binary'),
                },
                {
                    form: 'image',
                    file: { sha256: sha(image), size: image.length, mediaType: 'image/png' },
                    blob: blob(image, 'image/png'),
                },
            ],
            ...extra,
        },
    };
}

describe('model records, as the hub reads them', () => {
    const max = 8 * 1024 * 1024;
    it('reads a model and its preview, and what it says of itself', () => {
        const r = record(animated, animatedPng);
        const m = modelRecordOf(r.rkey, r.value, max)!;
        assert.equal(m.model.sha256, sha(animated));
        assert.equal(m.image.sha256, sha(animatedPng));
        assert.equal(m.name, 'Spinning boxes');
        assert.deepEqual(m.credit, { author: 'Ana' });
        assert.equal(m.licence.url, 'https://creativecommons.org/licenses/by/4.0/');
    });

    it('takes nothing that is not a light model, keyed by its own hash, with a preview', () => {
        const r = record(animated, animatedPng);
        const v = r.value as { versions: Record<string, unknown>[] };
        const changed = (edit: (value: typeof v) => void) => {
            const copy = structuredClone(v);
            edit(copy);
            return modelRecordOf(r.rkey, copy, max);
        };
        assert.equal(modelRecordOf('0'.repeat(64), v, max), null, 'keyed by another hash');
        assert.equal(changed(c => (c.versions[0]!.form = 'ansi')), null);
        assert.equal(changed(c => (c.versions[0]!.class = 'full')), null);
        assert.equal(changed(c => c.versions.pop()), null, 'no preview');
        assert.equal(changed(c => ((c.versions[1]!.file as { size: number }).size = MaxPreviewBytes + 1)), null);
        assert.equal(modelRecordOf(r.rkey, v, animated.length - 1), null, 'over the size limit');
        assert.equal(changed(c => ((c.versions[0]!.file as { sha256: string }).sha256 = 'ZZ')), null);
        assert.equal(modelRecordOf(r.rkey, null, max), null);
    });

    it('keeps text from outside short, plain, and its links to https', () => {
        const r = record(animated, animatedPng, {
            name: 'A‮B\u0000C' + 'x'.repeat(200),
            licence: { id: 'X', url: 'javascript:alert(1)' },
            rating: 'nonsense',
        });
        const m = modelRecordOf(r.rkey, r.value, 8 * 1024 * 1024)!;
        assert.ok(!/[‮\u0000]/.test(m.name));
        assert.equal(m.name.length, 80);
        assert.equal(m.licence.url, undefined);
        assert.equal(m.rating, 'general');
    });
});

describe('the models BBSes publish', () => {
    let dir: string;
    let records: ReturnType<typeof record>[];
    let blobs: Map<string, Buffer>;
    let fetched: string[];
    let logs: string[];
    let blocked: Set<string>;
    let refused: Set<string>;
    let list: Bbs[];
    let clock: number;
    let linked: boolean;
    let listed: number[];

    const at = {
        async listRecords(_did: string, _collection: string, max: number) {
            listed.push(max);
            return records.slice(0, max);
        },
        async getBlob(_did: string, cid: string, maxBytes: number) {
            fetched.push(cid);
            const body = blobs.get(cid);
            if (!body) {
                throw new Error('HTTP 404');
            }
            if (body.length > maxBytes) {
                throw new Error('too large');
            }
            return body;
        },
    };
    const board = (extra: Partial<Bbs> = {}) =>
        ({ name: 'coolbbs', state: 'active', connected: true, bbsDid: Did, ...extra }) as Bbs;
    const publish = (model: Buffer, image: Buffer, extra: Record<string, unknown> = {}) => {
        const r = record(model, image, extra);
        for (const v of r.value.versions) {
            blobs.set(v.blob.ref.$link, v === r.value.versions[0] ? model : image);
        }
        records.push(r);
        return r;
    };
    const make = (models: Record<string, unknown> = {}, more: { ratings?: string[]; boardArt?: string[] } = {}) =>
        new BoardModels(
            {
                config: makeConfig({
                    assets: { boardArt: more.boardArt ?? ['coolbbs'], models: { enabled: true, ...models } },
                    directory: { ratings: more.ratings ?? ['general'] },
                }),
                list: () => list,
                at: at as never,
                linked: () => linked,
                blocked: hash => blocked.has(hash),
                refused: did => refused.has(did),
                log: line => logs.push(line),
                now: () => clock,
            },
            join(dir, 'board-models')
        );

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'hub-board-models-'));
        records = [];
        blobs = new Map();
        fetched = [];
        logs = [];
        blocked = new Set();
        refused = new Set();
        list = [board()];
        clock = 1_000_000;
        linked = true;
        listed = [];
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('takes a model and its preview, checked, and serves them from disk', async () => {
        const models = make();
        publish(animated, animatedPng);
        await models.refresh();
        const [item, ...rest] = models.items();
        assert.equal(rest.length, 0);
        const checked = checkGlb(animated);
        assert.equal(item!.id, checked.sha256);
        assert.equal(item!.page, `/art/${checked.sha256.slice(0, 12)}`);
        assert.equal(item!.model.triangles, 192);
        assert.deepEqual(item!.model.animations, ['idle', 'spin']);
        assert.equal(item!.name, 'Spinning boxes');
        assert.deepEqual(item!.credit, { author: 'Ana' });
        const preview = checkPreviewPng(animatedPng, 2048, MaxPreviewBytes);
        assert.equal(item!.image.url, `/assets/${preview.sha256}`);
        assert.equal(item!.image.width, preview.width);

        const file = models.file(item!.id)!;
        assert.equal(file.type, 'model/gltf-binary');
        assert.ok(readFileSync(file.path).equals(checked.cleaned));
        assert.equal(models.file(preview.sha256)!.type, 'image/png');
        assert.equal(models.byShortId(item!.short)?.id, item!.id);
        assert.equal(models.byShortId('nothing'), null);
        assert.equal(models.file('0'.repeat(64)), null);

        //  a second reading fetches nothing again, and a restart keeps them
        fetched.length = 0;
        await models.refresh();
        assert.deepEqual(fetched, []);
        assert.equal(make().items()[0]?.id, item!.id);
    });

    it('withdraws a model whose record is gone, and deletes its files', async () => {
        const models = make();
        publish(animated, animatedPng);
        await models.refresh();
        assert.equal(readdirSync(join(dir, 'board-models', 'files')).length, 2);
        records = [];
        await models.refresh();
        assert.deepEqual(models.items(), []);
        assert.deepEqual(readdirSync(join(dir, 'board-models', 'files')), []);
    });

    it('hides a model at once when any of its files is blocked, and shows it again when unblocked', async () => {
        const models = make();
        publish(animated, animatedPng);
        await models.refresh();
        const item = models.items()[0]!;
        for (const hash of [sha(animated), item.id, item.image.url.slice('/assets/'.length)]) {
            blocked.add(hash);
            assert.deepEqual(models.items(), [], hash);
            assert.equal(models.file(item.id), null);
            blocked.delete(hash);
        }
        assert.equal(models.items().length, 1);
    });

    it('takes nothing blocked, and nothing from an account the hub refuses', async () => {
        publish(animated, animatedPng);
        blocked.add(sha(animated));
        const models = make();
        await models.refresh();
        assert.deepEqual(fetched, []);
        blocked.clear();
        refused.add(Did);
        await models.refresh();
        assert.deepEqual(fetched, []);
        assert.deepEqual(models.items(), []);
    });

    it('takes from BBSes in assets.boardArt only, while turned on, and active', async () => {
        publish(animated, animatedPng);
        await make({}, { boardArt: ['other'] }).refresh();
        await make({ enabled: false }).refresh();
        list = [board({ state: 'suspended' })];
        await make().refresh();
        assert.deepEqual(fetched, []);
    });

    it('lets go of a removed BBS\'s models, and of those it stops being taken from', async () => {
        const models = make();
        publish(animated, animatedPng);
        await models.refresh();
        assert.equal(models.items().length, 1);
        list = [];
        await models.refresh();
        assert.equal(models.kept.size, 0);
        assert.deepEqual(readdirSync(join(dir, 'board-models', 'files')), []);
    });

    it('holds each BBS to its count', async () => {
        publish(animated, animatedPng);
        publish(still, stillPng, { name: 'Still' });
        const one = make({ perBoard: 1 });
        await one.refresh();
        assert.equal(one.items().length, 1);
        assert.ok(logs.some(line => /more than 1 models/.test(line)));
    });

    it('holds them all to the bytes the hub keeps, before fetching anything more', async () => {
        const first = animated.length + animatedPng.length;
        const models = make({ maxBytes: Math.max(animated.length, still.length), totalBytes: first + 10 });
        publish(animated, animatedPng);
        publish(still, stillPng, { name: 'Still' });
        await models.refresh();
        assert.deepEqual(
            models.items().map(item => item.name),
            ['Spinning boxes']
        );
        assert.ok(models.totalBytes() <= first + 10);
        assert.ok(logs.some(line => /Still not taken: no room/.test(line)));
        assert.equal(fetched.length, 2, "the second model's files were never asked for");
    });

    it('leaves out a model larger than assets.models.maxBytes without fetching it', async () => {
        publish(animated, animatedPng);
        const models = make({ maxBytes: 1024 });
        await models.refresh();
        assert.deepEqual(fetched, []);
        assert.deepEqual(models.items(), []);
    });

    it('refuses a model its checker refuses, or files that are not the ones named, and tries again an hour later', async () => {
        const models = make();
        const broken = Buffer.from('glTF but not really');
        publish(broken, animatedPng);
        await models.refresh();
        assert.deepEqual(models.items(), []);
        assert.ok(logs.some(line => /not taken/.test(line)));
        const tries = fetched.length;
        await models.refresh();
        assert.equal(fetched.length, tries, 'not again so soon');
        clock += 61 * 60 * 1000;
        await models.refresh();
        assert.ok(fetched.length > tries);

        records = [];
        const r = publish(animated, animatedPng);
        blobs.set(r.value.versions[1]!.blob.ref.$link, stillPng);
        logs.length = 0;
        await models.refresh();
        assert.ok(logs.some(line => /preview picture isn't the file/.test(line)));
        assert.deepEqual(models.items(), []);
    });

    it('reads a record again when it changes: its words, and its preview if that is another picture', async () => {
        const models = make();
        const r = publish(animated, animatedPng);
        await models.refresh();
        const before = models.items()[0]!;
        fetched.length = 0;
        //  the same model, renamed, relicensed, rerated within what is shown
        r.cid = 'bafyrecord2';
        Object.assign(r.value, { name: 'Renamed', licence: { id: 'CC-BY-NC-4.0' }, credit: { author: 'Bo' } });
        await models.refresh();
        const after = models.items()[0]!;
        assert.equal(after.id, before.id);
        assert.equal(after.name, 'Renamed');
        assert.deepEqual(after.licence, { id: 'CC-BY-NC-4.0' });
        assert.deepEqual(after.credit, { author: 'Bo' });
        assert.deepEqual(fetched, [], 'nothing fetched for words alone');
        //  a rating the directory doesn't show: hidden
        r.cid = 'bafyrecord3';
        Object.assign(r.value, { rating: 'mature' });
        await models.refresh();
        assert.deepEqual(models.items(), []);
        //  a new preview: fetched, and the old one's file let go
        r.cid = 'bafyrecord4';
        Object.assign(r.value, { rating: 'general' });
        const image = r.value.versions[1]!;
        image.file = { sha256: sha(stillPng), size: stillPng.length, mediaType: 'image/png' };
        image.blob = { ...image.blob, ref: { $link: 'cid-new-preview' }, size: stillPng.length };
        blobs.set('cid-new-preview', stillPng);
        await models.refresh();
        const fresh = models.items()[0]!;
        assert.equal(fresh.image.url, `/assets/${checkPreviewPng(stillPng, 2048, MaxPreviewBytes).sha256}`);
        assert.ok(!existsSync(join(dir, 'board-models', 'files', before.image.url.slice('/assets/'.length))));
    });

    it('makes room with what a BBS withdrew before taking what replaces it', async () => {
        const first = animated.length + animatedPng.length;
        const models = make({ maxBytes: Math.max(animated.length, still.length), totalBytes: first + 10 });
        publish(animated, animatedPng);
        await models.refresh();
        records = [];
        publish(still, stillPng, { name: 'Still' });
        await models.refresh();
        assert.deepEqual(
            models.items().map(item => item.name),
            ['Still']
        );
    });

    it('reads past the art in the same collection, and withdraws nothing from a listing cut short', async () => {
        const models = make({}, {});
        publish(animated, animatedPng);
        await models.refresh();
        //  boardPieces (50) + perBoard (5) + 100
        assert.deepEqual(listed, [155]);
        //  a listing that comes back full may have more after it: the model
        //  kept is not taken for withdrawn
        const filler = Array.from({ length: 155 }, (_, i) => ({ rkey: `art${i}`, cid: `c${i}`, value: { versions: [{ form: 'ansi' }] } })) as unknown as typeof records;
        records = [...filler, ...records];
        await models.refresh();
        assert.equal(models.items().length, 1);
        //  one that is whole, and doesn't name it, does withdraw it
        records = filler.slice(0, 10);
        await models.refresh();
        assert.deepEqual(models.items(), []);
    });

    it('holds a BBS to what it may have the hub fetch in an hour', async () => {
        const models = make({ perBoard: 1, maxBytes: 64 * 1024 });
        const allowance = 2 * 1 * (64 * 1024 + MaxPreviewBytes);
        const json = JSON.parse(animated.subarray(20, 20 + animated.readUInt32LE(12)).toString('utf8'));
        //  a BBS swapping its one record for a new model, again and again
        let fetchedBytes = 0;
        let refused = false;
        for (let i = 0; i < 1000 && !refused; i++) {
            json.asset.generator = `swap ${i}`;
            const glb = rewrap(animated, json);
            records = [];
            publish(glb, animatedPng);
            logs.length = 0;
            fetched.length = 0;
            await models.refresh();
            refused = logs.some(line => /its limit/.test(line));
            fetchedBytes += fetched.length ? glb.length + (fetched.length > 1 ? animatedPng.length : 0) : 0;
        }
        assert.ok(refused, 'held to it');
        assert.ok(fetchedBytes <= allowance, `${fetchedBytes} <= ${allowance}`);
        //  an hour later it may fetch again
        clock += 61 * 60 * 1000;
        await models.refresh();
        assert.equal(models.items().length, 1);
    });

    it('hides the models of a BBS not linked to its account just now, and keeps their files', async () => {
        const models = make();
        publish(animated, animatedPng);
        await models.refresh();
        linked = false;
        assert.deepEqual(models.items(), []);
        await models.refresh();
        assert.equal(readdirSync(join(dir, 'board-models', 'files')).length, 2);
        linked = true;
        fetched.length = 0;
        await models.refresh();
        assert.equal(models.items().length, 1);
        assert.deepEqual(fetched, []);
    });

    it('leaves out models of a rating the directory does not show', async () => {
        publish(animated, animatedPng, { rating: 'adult' });
        const models = make();
        await models.refresh();
        assert.deepEqual(fetched, []);
    });

    it("are in the admin's list of art, so they can be blocked by a short hash", async () => {
        const models = make();
        publish(animated, animatedPng);
        await models.refresh();
        const item = models.items()[0]!;
        const art = artOnHub({ library: '', boardArt: join(dir, 'none'), boardModels: join(dir, 'board-models') });
        const mine = art.find(a => a.id === item.id)!;
        assert.equal(mine.owner, "coolbbs's model");
        //  the model as published is the one served: nothing in it to clean
        assert.deepEqual(mine.files, [item.id, item.image.url.slice('/assets/'.length)]);
        assert.equal(resolveHash(item.short, art), item.id);
    });
});

//  a .glb with its JSON chunk replaced
function rewrap(glb: Buffer, json: unknown): Buffer {
    const jsonLength = glb.readUInt32LE(12);
    const rest = glb.subarray(20 + jsonLength);
    let text = Buffer.from(JSON.stringify(json), 'utf8');
    text = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4, 0x20)]);
    const head = Buffer.alloc(20);
    head.write('glTF', 0, 'latin1');
    head.writeUInt32LE(2, 4);
    head.writeUInt32LE(20 + text.length + rest.length, 8);
    head.writeUInt32LE(text.length, 12);
    head.writeUInt32LE(0x4e4f534a, 16);
    return Buffer.concat([head, text, rest]);
}

describe("a model's pages", () => {
    let dir: string;
    let origin: string;
    let site: ReturnType<typeof createSite>;
    let models: BoardModels;

    beforeEach(async () => {
        dir = mkdtempSync(join(tmpdir(), 'hub-model-pages-'));
        const r = record(animated, animatedPng);
        const blobs = new Map<string, Buffer>([
            [r.value.versions[0]!.blob.ref.$link, animated],
            [r.value.versions[1]!.blob.ref.$link, animatedPng],
        ]);
        const config = makeConfig({
            database: ':memory:',
            site: { publicUrl: 'https://hub.test' },
            assets: { boardArt: ['coolbbs'], models: { enabled: true } },
        });
        models = new BoardModels(
            {
                config,
                list: () => [{ name: 'coolbbs', state: 'active', bbsDid: Did } as Bbs],
                at: { listRecords: async () => [r], getBlob: async (_d: string, cid: string) => blobs.get(cid)! } as never,
                linked: () => true,
            },
            join(dir, 'board-models')
        );
        await models.refresh();
        const registry = new Registry(':memory:', config.registration);
        site = createSite({ config, registry, signin: new SignIn(registry.db, config), boardModels: models });
        await new Promise<void>(done => site.listen(0, '127.0.0.1', done));
        origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
    });
    afterEach(async () => {
        site.closeAllConnections();
        await new Promise(done => site.close(done));
        rmSync(dir, { recursive: true, force: true });
    });

    it('lists a model in the gallery by its picture, with a link to its page', async () => {
        const item = models.items()[0]!;
        const reply = await fetch(`${origin}/art`);
        assert.equal(reply.status, 200);
        const body = await reply.text();
        assert.match(body, /3D models from coolbbs/);
        assert.ok(body.includes(`href="${item.page}">View in 3D</a>`));
        assert.ok(body.includes(`src="${item.image.url}"`));
        assert.match(body, /192 triangles/);
        assert.ok(body.includes(`/report?kind=art&amp;asset=${item.id}`));
        //  the gallery itself runs no scripts
        assert.doesNotMatch(String(reply.headers.get('content-security-policy')), /script-src/);
    });

    it("serves a model's page under its own narrow policy, the model fetched only when asked for", async () => {
        const item = models.items()[0]!;
        const reply = await fetch(`${origin}${item.page}`);
        assert.equal(reply.status, 200);
        assert.equal(reply.headers.get('content-security-policy'), modelPagePolicy('https://hub.test'));
        const body = await reply.text();
        assert.ok(body.includes(`data-model="${item.model.url}"`));
        assert.ok(body.includes('<script type="module" src="/web/model_page.js"></script>'));
        assert.match(body, /id="model-load" hidden/);
        assert.match(body, /Animations: idle, spin/);
        assert.equal((await fetch(`${origin}/art/000000000000`)).status, 404);
        assert.equal((await fetch(`${origin}/art/nothing`)).status, 404);
    });

    it('warns that a model with glass takes longer to get ready', () => {
        const item = models.items()[0]!;
        assert.doesNotMatch(modelPageBody(item, 'Cool BBS', false), /glass/);
        const glass = { ...item, model: { ...item.model, effects: ['KHR_materials_transmission'] } };
        assert.match(modelPageBody(glass, 'Cool BBS', false), /It has glass, which can take a phone a few seconds more/);
    });

    it('shows the description only in a view set to text, with no script and no viewer', () => {
        const body = modelPageBody(models.items()[0]!, 'Cool BBS', true);
        assert.match(body, /Two boxes and a ball/);
        assert.match(body, /Published by Cool BBS/);
        assert.doesNotMatch(body, /<script|<img|model-viewer/);
    });

    it('serves the model and its picture by hash, never as a page, with their own types', async () => {
        const item = models.items()[0]!;
        const glb = await fetch(`${origin}${item.model.url}`);
        assert.equal(glb.status, 200);
        assert.equal(glb.headers.get('content-type'), 'model/gltf-binary');
        assert.equal(glb.headers.get('x-content-type-options'), 'nosniff');
        assert.equal(glb.headers.get('content-security-policy'), "default-src 'none'; sandbox");
        assert.equal(glb.headers.get('cross-origin-resource-policy'), 'same-site');
        assert.ok(Buffer.from(await glb.arrayBuffer()).equals(checkGlb(animated).cleaned));
        const png = await fetch(`${origin}${item.image.url}`);
        assert.equal(png.headers.get('content-type'), 'image/png');
        assert.equal(Number(png.headers.get('content-length')), (await png.arrayBuffer()).byteLength);
        const head = await fetch(`${origin}${item.model.url}`, { method: 'HEAD' });
        assert.equal(head.status, 200);
    });

    it("serves the viewer's scripts from a fixed list, with a tag to ask again by", async () => {
        for (const path of [...ViewerScripts.map(n => `/web/${n}`), ...VendoredScripts.map(p => `/vendor/three/${p}`)]) {
            const reply = await fetch(`${origin}${path}`);
            assert.equal(reply.status, 200, path);
            assert.equal(reply.headers.get('content-type'), 'text/javascript; charset=utf-8');
            assert.equal(reply.headers.get('etag'), viewerFile(path)!.etag);
            await reply.arrayBuffer();
            const again = await fetch(`${origin}${path}`, { headers: { 'if-none-match': viewerFile(path)!.etag } });
            assert.equal(again.status, 304, path);
        }
        for (const path of ['/web/../src/main.ts', '/web/nothing.js', '/vendor/three/LICENSE', '/vendor/three/build/three.cjs']) {
            assert.equal((await fetch(`${origin}${path}`)).status, 404, path);
        }
    });

    it('takes a blocked model off its page and its file at once', async () => {
        const item = models.items()[0]!;
        models.deps.blocked = hash => hash === item.id;
        assert.equal((await fetch(`${origin}${item.page}`)).status, 404);
        assert.equal((await fetch(`${origin}${item.model.url}`)).status, 404);
        assert.doesNotMatch(await (await fetch(`${origin}/art`)).text(), /View in 3D/);
        assert.ok(!existsSync(join(dir, 'nothing')));
    });
});
