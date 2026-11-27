//  Live objects BBSes publish (src/board_objects.ts): their records, and the
//  programs they name, read from a stand-in for the network, with the real
//  weather program and its source as the files published.

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { artOnHub, resolveHash } from '../src/asset_blocks.ts';
import { BoardObjects, MaxInputBytes, objectRecordOf, programRecordOf } from '../src/board_objects.ts';
import { makeConfig } from '../src/config.ts';
import type { Bbs } from '../src/registry.ts';
import { runStep } from '../src/program.ts';

const Prefix = 'nexus.cyberspace.dev';
const Weather = join(import.meta.dirname, '..', '..', '..', 'programs', 'weather');
const wasm = readFileSync(join(Weather, 'weather.wasm'));
const source = readFileSync(join(Weather, 'weather.ts'));
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const Program = sha(wasm);
const Did = 'did:plc:cool';
const Author = 'did:plc:framework';

const blob = (b: Buffer, type: string) => ({
    $type: 'blob',
    ref: { $link: `cid-${sha(b).slice(0, 16)}` },
    mimeType: type,
    size: b.length,
});

function programRecord(module = wasm, src = source, extra: Record<string, unknown> = {}) {
    return {
        $type: `${Prefix}.asset.item`,
        name: 'Weather (Open-Meteo)',
        kind: 'program',
        licence: { id: 'BSD-2-Clause', url: 'https://opensource.org/license/bsd-2-clause' },
        credit: { author: 'Cyberspace Framework' },
        description: { short: 'The current weather for a place' },
        manifest: {
            fetch: ['api.open-meteo.com', 'geocoding-api.open-meteo.com'],
            values: 'weather',
            credit: [
                { text: 'Weather data by Open-Meteo.com', url: 'https://open-meteo.com/' },
                { text: 'Place names from GeoNames', url: 'https://www.geonames.org/' },
            ],
        },
        versions: [
            {
                form: 'program',
                file: { sha256: sha(module), size: module.length, mediaType: 'application/wasm' },
                blob: blob(module, 'application/wasm'),
            },
            {
                form: 'source',
                file: { sha256: sha(src), size: src.length, mediaType: 'text/plain' },
                blob: blob(src, 'text/plain'),
            },
        ],
        ...extra,
    };
}

function objectRecord(extra: Record<string, unknown> = {}, program = Program, did = Author) {
    return {
        $type: `${Prefix}.object`,
        title: 'Weather in Berlin',
        program: { sha256: program, uri: `at://${did}/${Prefix}.asset.item/${program}` },
        input: { name: 'Berlin' },
        interval: 600,
        look: 'badge',
        ...extra,
    };
}

describe('object and program records, as the hub reads them', () => {
    it('reads an object: its program, input, interval and title', () => {
        const o = objectRecordOf(objectRecord(), Prefix, 600)!;
        assert.deepEqual(o.program, { sha256: Program, did: Author, rkey: Program });
        assert.deepEqual(o.input, { name: 'Berlin' });
        assert.equal(o.interval, 600);
        assert.equal(o.title, 'Weather in Berlin');
    });

    it("keeps intervals within the hub's limits, and text plain and short", () => {
        assert.equal(objectRecordOf(objectRecord({ interval: 5 }), Prefix, 600)!.interval, 600);
        assert.equal(objectRecordOf(objectRecord({ interval: 999999 }), Prefix, 600)!.interval, 86400);
        assert.equal(objectRecordOf(objectRecord({ interval: 'soon' }), Prefix, 900)!.interval, 900);
        const t = objectRecordOf(objectRecord({ title: 'A‮B\u0000' + 'x'.repeat(100) }), Prefix, 600)!.title;
        assert.ok(!/[‮\u0000]/.test(t));
        assert.equal(t.length, 60);
    });

    it('takes no object without a program named by its hash and record, or with a bad input', () => {
        const none = (extra: Record<string, unknown>) =>
            assert.equal(
                objectRecordOf(objectRecord(extra), Prefix, 600),
                null,
                JSON.stringify(extra).slice(0, 80)
            );
        none({ program: { sha256: Program, uri: `at://${Author}/${Prefix}.other/${Program}` } });
        none({ program: { sha256: Program, uri: `at://${Author}/${Prefix}.asset.item/${'0'.repeat(64)}` } });
        none({ program: { sha256: 'ZZ', uri: `at://${Author}/${Prefix}.asset.item/ZZ` } });
        none({ program: { sha256: Program, uri: `https://example.com/${Program}` } });
        none({ input: [1, 2] });
        none({ input: 'Berlin' });
        none({ input: { name: 'x'.repeat(MaxInputBytes) } });
        assert.equal(objectRecordOf(null, Prefix, 600), null);
    });

    it('reads a program: its module, source and manifest', () => {
        const p = programRecordOf(Program, programRecord())!;
        assert.equal(p.module.sha256, Program);
        assert.equal(p.source.sha256, sha(source));
        assert.deepEqual(p.fetch, ['api.open-meteo.com', 'geocoding-api.open-meteo.com']);
        assert.equal(p.values, 'weather');
        assert.deepEqual(p.dataCredit[0], { text: 'Weather data by Open-Meteo.com', url: 'https://open-meteo.com/' });
        //  a credit with no link, or a link that isn't https, is refused
        const r = programRecord();
        assert.equal(programRecordOf(Program, { ...r, manifest: { ...r.manifest, credit: [{ text: 'X' }] } }), null);
        assert.equal(programRecordOf(Program, { ...r, manifest: { ...r.manifest, credit: [{ text: 'X', url: 'javascript:x' }] } }), null);
    });

    it("takes no program without its source, keyed by another hash, or with a manifest it can't hold to", () => {
        const r = programRecord();
        assert.equal(programRecordOf('0'.repeat(64), r), null);
        assert.equal(programRecordOf(Program, { ...r, versions: [r.versions[0]] }), null, 'no source');
        const typed = structuredClone(r);
        typed.versions[0]!.file.mediaType = 'application/octet-stream';
        assert.equal(programRecordOf(Program, typed), null);
        for (const manifest of [
            { fetch: ['api.open-meteo.com/path'], values: 'weather' },
            { fetch: ['http://api.open-meteo.com'], values: 'weather' },
            { fetch: Array(9).fill('a.example.com'), values: 'weather' },
            { fetch: [], values: 'stocks' },
        ]) {
            assert.equal(programRecordOf(Program, { ...r, manifest }), null, JSON.stringify(manifest));
        }
    });
});

describe('the objects BBSes publish', () => {
    let dir: string;
    let objects: { rkey: string; cid: string; value: unknown }[];
    let programs: Map<string, unknown>;
    let blobs: Map<string, Buffer>;
    let fetched: string[];
    let logs: string[];
    let blocked: Set<string>;
    let refused: Set<string>;
    let linked: boolean;
    let list: Bbs[];

    const at = {
        async listRecords(_did: string, _collection: string, max: number) {
            return objects.slice(0, max);
        },
        async getRecord(did: string, _collection: string, rkey: string) {
            const value = programs.get(`${did}/${rkey}`);
            return value ? { cid: 'bafyprogram', value } : null;
        },
        async getBlob(_did: string, cid: string, maxBytes: number) {
            fetched.push(cid);
            const body = blobs.get(cid);
            if (!body) throw new Error('HTTP 404');
            if (body.length > maxBytes) throw new Error('too large');
            return body;
        },
    };
    const board = (name = 'coolbbs', did = Did) =>
        ({ name, state: 'active', connected: true, bbsDid: did }) as Bbs;
    const publishProgram = (module = wasm, src = source, did = Author) => {
        programs.set(`${did}/${sha(module)}`, programRecord(module, src));
        blobs.set(`cid-${sha(module).slice(0, 16)}`, module);
        blobs.set(`cid-${sha(src).slice(0, 16)}`, src);
    };
    const make = (compute: Record<string, unknown> = {}) =>
        new BoardObjects(
            {
                config: makeConfig({
                    site: { publicUrl: 'https://hub.example', signingKey: 'k' },
                    compute: {
                        enabled: true,
                        owners: ['coolbbs', 'other'],
                        programs: [Program],
                        fetch: ['api.open-meteo.com'],
                        ...compute,
                    },
                }),
                list: () => list,
                at: at as never,
                linked: () => linked,
                blocked: s => blocked.has(s),
                refused: d => refused.has(d),
                log: line => logs.push(line),
            },
            dir
        );

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'objects-'));
        objects = [{ rkey: 'berlin', cid: 'bafy1', value: objectRecord() }];
        programs = new Map();
        blobs = new Map();
        fetched = [];
        logs = [];
        blocked = new Set();
        refused = new Set();
        linked = true;
        list = [board()];
        publishProgram();
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it("takes an object and its vetted program, from the program's own account, ready to run", async () => {
        const o = make();
        await o.refresh();
        assert.deepEqual(
            o.objects().map(x => [x.bbs, x.rkey, x.title, x.program]),
            [['coolbbs', 'berlin', 'Weather in Berlin', Program]]
        );
        assert.equal(o.programs.get(Program)!.did, Author);
        assert.equal(o.sourceOf(Program), source.toString('utf8'));
        assert.ok(existsSync(join(dir, 'files', Program)));
        //  and the program it keeps runs
        const checked = o.checkedProgram(Program)!;
        const r = await runStep(
            checked,
            { input: { name: 'Berlin' }, state: null, replies: [], time: 'x' },
            { allowedHosts: ['geocoding-api.open-meteo.com'] }
        );
        assert.equal(r.ok && r.fetches.length, 1);
        //  read again with nothing changed: nothing fetched again
        const before = fetched.length;
        await o.refresh();
        assert.equal(fetched.length, before);
        //  and what it kept is there after a restart
        const again = make();
        assert.equal(again.objects().length, 1);
        assert.ok(again.checkedProgram(Program));
    });

    it('lists programs among what the admin can block, by a short hash too', async () => {
        await make().refresh();
        const art = artOnHub({ library: '', boardArt: join(dir, 'none'), boardObjects: dir });
        assert.deepEqual(
            art.map(a => [a.owner, a.name, a.files]),
            [[`${Author}'s program`, 'Weather (Open-Meteo)', [Program, sha(source)]]]
        );
        assert.equal(resolveHash(Program.slice(0, 12), art), Program);
    });

    it("fetches no program the admin hasn't vetted, and says so", async () => {
        const o = make({ programs: [] });
        await o.refresh();
        assert.deepEqual(o.objects(), []);
        assert.deepEqual(fetched, []);
        assert.ok(logs.some(l => /hasn't vetted/.test(l)));
    });

    it("stops running a program blocked by its hash, or its source's, or its publisher refused", async () => {
        const o = make();
        await o.refresh();
        blocked.add(Program);
        assert.deepEqual(o.objects(), []);
        assert.equal(o.checkedProgram(Program), null);
        blocked.clear();
        blocked.add(sha(source));
        assert.deepEqual(o.objects(), []);
        blocked.clear();
        refused.add(Author);
        assert.deepEqual(o.objects(), []);
        refused.clear();
        assert.equal(o.objects().length, 1);
    });

    it('takes nothing from a refused BBS, one not in compute.owners, or with compute off', async () => {
        refused.add(Did);
        const o = make();
        await o.refresh();
        assert.deepEqual(o.objects(), []);
        refused.clear();
        const notOwner = make({ owners: ['other'] });
        await notOwner.refresh();
        assert.deepEqual(notOwner.objects(), []);
        const off = make({ enabled: false });
        await off.refresh();
        assert.deepEqual(off.objects(), []);
        const everyone = make({ owners: 'registered' });
        await everyone.refresh();
        assert.equal(everyone.objects().length, 1);
    });

    it("hides a BBS's objects while it isn't linked, and keeps them", async () => {
        const o = make();
        await o.refresh();
        linked = false;
        assert.deepEqual(o.objects(), []);
        await o.refresh();
        linked = true;
        assert.equal(o.objects().length, 1);
    });

    it('lets go of a withdrawn object, and of its program and files when nothing uses them', async () => {
        const o = make();
        await o.refresh();
        objects = [];
        await o.refresh();
        assert.deepEqual(o.objects(), []);
        assert.equal(o.programs.size, 0);
        assert.ok(!existsSync(join(dir, 'files', Program)));
        assert.ok(!existsSync(join(dir, 'files', sha(source))));
    });

    it('reads a changed record again: its new input', async () => {
        const o = make();
        await o.refresh();
        objects = [{ rkey: 'berlin', cid: 'bafy2', value: objectRecord({ input: { name: 'Paris' } }) }];
        await o.refresh();
        assert.deepEqual(o.objects()[0]!.input, { name: 'Paris' });
    });

    it('holds each BBS to its count of objects, and the hub to its total', async () => {
        objects = ['a', 'b', 'c', 'd', 'e'].map(k => ({ rkey: k, cid: 'bafy', value: objectRecord() }));
        const o = make();
        await o.refresh();
        assert.equal(o.objects().length, 3);
        assert.ok(logs.some(l => /more than 3 objects/.test(l)));
        list = [board(), board('other', 'did:plc:other')];
        const capped = make({ maxObjects: 4 });
        await capped.refresh();
        assert.equal(capped.objects().length, 4);
    });

    it("refuses a program that isn't the file its record names, or isn't a program it can run", async () => {
        //  the record names one module; the blob is another
        const other = Buffer.from(wasm);
        other[other.length - 1] = other.at(-1)! ^ 1;
        blobs.set(`cid-${Program.slice(0, 16)}`, other);
        const o = make();
        await o.refresh();
        assert.deepEqual(o.objects(), []);
        assert.ok(logs.some(l => /isn't the module its record names/.test(l)));

        //  a vetted hash whose module the checker refuses
        const junk = Buffer.from('not a WebAssembly module at all');
        publishProgram(junk);
        objects = [{ rkey: 'junk', cid: 'bafy', value: objectRecord({}, sha(junk)) }];
        const j = make({ programs: [sha(junk)] });
        await j.refresh();
        assert.deepEqual(j.objects(), []);
        assert.ok(logs.some(l => /can't be run/.test(l)));

        //  a source that isn't text
        const binary = Buffer.from([0xff, 0xfe, 0x00, 0x80]);
        publishProgram(wasm, binary);
        objects = [{ rkey: 'berlin', cid: 'bafy1', value: objectRecord() }];
        const b = make();
        b.failed.clear();
        await b.refresh();
        assert.deepEqual(b.objects(), []);
        assert.ok(logs.some(l => /not UTF-8/.test(l)));
    });
});
