//  Running live objects (src/live_objects.ts): the real weather program,
//  taken from a stand-in for the network as a BBS would publish it, run by
//  the scheduler against Open-Meteo's real replies; its values checked by
//  type (src/object_types.ts); and its page on the hub (src/object_page.ts).

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BoardObjects } from '../src/board_objects.ts';
import { makeConfig } from '../src/config.ts';
import { LiveObjects } from '../src/live_objects.ts';
import { checkValues } from '../src/object_types.ts';
import { Registry } from '../src/registry.ts';
import type { Bbs } from '../src/registry.ts';
import { SignIn } from '../src/signin.ts';
import { createSite } from '../src/site.ts';

const Prefix = 'nexus.cyberspace.dev';
const Weather = join(import.meta.dirname, '..', '..', '..', 'programs', 'weather');
const wasm = readFileSync(join(Weather, 'weather.wasm'));
const source = readFileSync(join(Weather, 'weather.ts'));
const fixture = (name: string) => readFileSync(join(import.meta.dirname, 'fixtures', 'open-meteo', name));
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const Program = sha(wasm);
const Did = 'did:plc:cool';
const Sites = ['api.open-meteo.com', 'geocoding-api.open-meteo.com'];
//  the fixtures' reading was taken at 17:00 GMT on this day
const Noon = Date.parse('2026-11-27T17:05:00Z');

const blob = (b: Buffer, type: string) => ({
    $type: 'blob',
    ref: { $link: `cid-${sha(b).slice(0, 16)}` },
    mimeType: type,
    size: b.length,
});
const programRecord = {
    $type: `${Prefix}.asset.item`,
    name: 'Weather (Open-Meteo)',
    kind: 'program',
    licence: { id: 'BSD-2-Clause', url: 'https://opensource.org/license/bsd-2-clause' },
    credit: { author: 'Cyberspace Framework' },
    description: { short: 'The current weather for a place' },
    manifest: {
        fetch: Sites,
        values: 'weather',
        credit: [{ text: 'Weather data by Open-Meteo.com', url: 'https://open-meteo.com/' }],
    },
    versions: [
        {
            form: 'program',
            file: { sha256: Program, size: wasm.length, mediaType: 'application/wasm' },
            blob: blob(wasm, 'application/wasm'),
        },
        {
            form: 'source',
            file: { sha256: sha(source), size: source.length, mediaType: 'text/plain' },
            blob: blob(source, 'text/plain'),
        },
    ],
};

describe('value types', () => {
    it('keeps the values that hold, and drops the rest one by one', () => {
        const v = checkValues(
            'weather',
            {
                temperature: -0.8,
                precipitation: -1,
                code: 3,
                cloudCover: 101,
                windSpeed: 'fast',
                isDay: 0,
                observedAt: '2026-11-27T17:00:00Z',
                place: 'Berlin,‮ Germany\u0000' + 'x'.repeat(100),
                unknown: 1,
            },
            Noon
        );
        assert.equal(v.temperature, -0.8);
        assert.equal(v.code, 3);
        assert.equal(v.observedAt, '2026-11-27T17:00:00.000Z');
        for (const gone of ['precipitation', 'cloudCover', 'windSpeed', 'isDay', 'unknown']) {
            assert.equal(gone in v, false, gone);
        }
        assert.ok(!/[‮\u0000]/.test(v.place as string));
        assert.equal((v.place as string).length, 60);
    });

    it("takes no time from the future or more than a day old, and no type it doesn't know", () => {
        assert.deepEqual(checkValues('weather', { observedAt: '2026-11-27T19:00:00Z' }, Noon), {});
        assert.deepEqual(checkValues('weather', { observedAt: '2026-11-25T17:00:00Z' }, Noon), {});
        assert.deepEqual(checkValues('weather', { observedAt: 'yesterday' }, Noon), {});
        assert.deepEqual(checkValues('stocks', { price: 1 }, Noon), {});
    });
});

describe('running live objects', () => {
    let dir: string;
    let now: number;
    let fetched: string[];
    let replies: Map<string, { status: number; body: Buffer } | Error>;
    let objects: BoardObjects;
    let running: LiveObjects;
    let changes: number;
    let hubSites: string[];

    const config = () =>
        makeConfig({
            site: { publicUrl: 'https://hub.test', signingKey: 'k' },
            database: ':memory:',
            compute: { enabled: true, owners: ['coolbbs'], programs: [Program], fetch: hubSites },
        });
    const make = () => {
        const c = config();
        objects = new BoardObjects(
            {
                config: c,
                list: () => [{ name: 'coolbbs', state: 'active', connected: true, bbsDid: Did } as Bbs],
                at: {
                    listRecords: async () => [
                        {
                            rkey: 'berlin',
                            cid: 'bafy1',
                            value: {
                                title: 'Weather in Berlin',
                                program: {
                                    sha256: Program,
                                    uri: `at://${Did}/${Prefix}.asset.item/${Program}`,
                                },
                                input: { name: 'Berlin' },
                                interval: 600,
                            },
                        },
                    ],
                    getRecord: async () => ({ cid: 'bafyprogram', value: programRecord }),
                    getBlob: async (_d: string, cid: string) =>
                        cid === blob(wasm, '').ref.$link ? wasm : source,
                } as never,
                linked: () => true,
            },
            join(dir, 'objects')
        );
        running = new LiveObjects(
            {
                config: c,
                objects,
                fetch: async url => {
                    fetched.push(url);
                    const host = new URL(url).hostname;
                    const r = replies.get(host);
                    if (!r) throw new Error('no reply');
                    if (r instanceof Error) throw r;
                    return r;
                },
                changed: () => changes++,
                now: () => now,
            },
            join(dir, 'running')
        );
    };

    beforeEach(async () => {
        dir = mkdtempSync(join(tmpdir(), 'live-objects-'));
        now = Noon;
        fetched = [];
        changes = 0;
        hubSites = Sites;
        replies = new Map([
            ['geocoding-api.open-meteo.com', { status: 200, body: fixture('geocode.json') }],
            ['api.open-meteo.com', { status: 200, body: fixture('current.json') }],
        ]);
        make();
        await objects.refresh();
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('runs an object: looks its place up, fetches the weather, and shows it, credited', async () => {
        await running.tick();
        assert.equal(fetched.length, 2);
        assert.match(fetched[0]!, /^https:\/\/geocoding-api\.open-meteo\.com\/v1\/search\?name=Berlin/);
        assert.match(
            fetched[1]!,
            /^https:\/\/api\.open-meteo\.com\/v1\/forecast\?latitude=52\.52437&longitude=13\.41053/
        );
        const [e] = running.entities();
        assert.equal(e!.id, `object:${Did}/berlin`);
        assert.equal(e!.owner, 'leaf:coolbbs');
        assert.equal(e!.kind, 'weather');
        assert.equal(e!.values.temperature, -0.8);
        assert.equal(e!.values.place, 'Berlin, Germany');
        assert.equal(e!.stale, false);
        assert.deepEqual(e!.look.credit, [
            { text: 'Weather data by Open-Meteo.com', url: 'https://open-meteo.com/' },
        ]);
        assert.equal(e!.page, '/objects/coolbbs/berlin');
        assert.equal(changes, 1);
    });

    it('updates at its interval, not before, and remembers the place across a restart', async () => {
        await running.tick();
        fetched = [];
        now += 5 * 60_000;
        await running.tick();
        assert.deepEqual(fetched, []);
        //  a restart: the next update goes straight to the weather
        make();
        await objects.refresh();
        now += 6 * 60_000;
        await running.tick();
        assert.equal(fetched.length, 1);
        assert.match(fetched[0]!, /api\.open-meteo\.com\/v1\/forecast/);
        assert.equal(running.entities()[0]!.values.temperature, -0.8);
    });

    it('goes stale after three missed updates, keeping its last reading', async () => {
        await running.tick();
        replies.set('api.open-meteo.com', new Error('timed out'));
        for (let i = 1; i <= 3; i++) {
            now += 10 * 60_000;
            await running.tick();
        }
        assert.equal(running.entities()[0]!.stale, false);
        now += 10 * 60_000 + 1;
        await running.tick();
        const e = running.entities()[0]!;
        assert.equal(e.stale, true);
        assert.equal(e.values.temperature, -0.8);
        const status = running.status(objects.objects()[0]!)!;
        assert.deepEqual(status.log, ['the weather failed (0)']);
    });

    it("fetches nothing the hub doesn't allow, even when the program asks", async () => {
        hubSites = ['api.open-meteo.com'];
        make();
        await objects.refresh();
        await running.tick();
        //  the place can't be looked up: the geocoder isn't allowed here
        assert.deepEqual(fetched, []);
        assert.deepEqual(running.status(objects.objects()[0]!)!.log, ['the hub refused the place request']);
        assert.deepEqual(running.entities()[0]!.values, {});
    });

    it("shows an object's page: its reading, credit, program and source, all escaped", async () => {
        await running.tick();
        const c = config();
        const registry = new Registry(':memory:', c.registration);
        const site = createSite({
            config: c,
            registry,
            signin: new SignIn(registry.db, c),
            liveObjects: running,
        });
        await new Promise<void>(done => site.listen(0, '127.0.0.1', done));
        const origin = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
        try {
            const reply = await fetch(`${origin}/objects/coolbbs/berlin`);
            assert.equal(reply.status, 200);
            const body = await reply.text();
            assert.match(body, /<h1>Weather in Berlin<\/h1>/);
            assert.match(body, /-0\.8 °C/);
            assert.match(
                body,
                /<a href="https:\/\/open-meteo\.com\/"[^>]*>Weather data by Open-Meteo\.com<\/a>/
            );
            assert.ok(body.includes(Program));
            assert.match(body, /api\.open-meteo\.com/);
            //  the source, as text: its own markup escaped
            assert.ok(body.includes('@external(&#39;cyberspace&#39;, &#39;fetch&#39;)'));
            assert.ok(!body.includes("@external('cyberspace'"));
            assert.equal((await fetch(`${origin}/objects/coolbbs/nothing`)).status, 404);
            assert.equal((await fetch(`${origin}/objects/other/berlin`)).status, 404);
        } finally {
            site.closeAllConnections();
            await new Promise(done => site.close(done));
        }
    });
});
