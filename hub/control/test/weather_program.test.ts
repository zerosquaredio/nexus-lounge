//  The framework's weather program (programs/weather), run by the hub's own
//  runner against Open-Meteo's real replies, kept as fixtures, with no
//  network: each update is two steps, the first asking for what it needs,
//  the next turning the reply into the object's values.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { checkProgram } from '../src/wasm_meter.ts';
import { runStep } from '../src/program.ts';
import type { Reply, StepResult } from '../src/program.ts';

const wasm = readFileSync(new URL('../../../programs/weather/weather.wasm', import.meta.url));
const fixture = (name: string) =>
    readFileSync(new URL(`./fixtures/open-meteo/${name}`, import.meta.url), 'utf8');
const program = checkProgram(wasm);
const Sites = ['api.open-meteo.com', 'geocoding-api.open-meteo.com'];
const Time = '2026-11-27T17:05:00Z';

async function step(input: unknown, state: unknown = null, replies: Reply[] = [], sites = Sites) {
    const r = await runStep(program, { input, state, replies, time: Time }, { allowedHosts: sites });
    assert.equal(r.ok, true, JSON.stringify(r));
    return r as Extract<StepResult, { ok: true }>;
}

const Forecast =
    'https://api.open-meteo.com/v1/forecast?latitude=52.52437&longitude=13.41053' +
    '&current=temperature_2m,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,is_day&timezone=GMT';

describe('the weather program', () => {
    it('is the module its source builds (programs/weather, npm run build)', () => {
        //  the hash the build gave twice, in two places (stage 2 of the build spec)
        assert.equal(
            createHash('sha256').update(wasm).digest('hex'),
            'a37a816ebddd31c0a301c58a8e2531c3097ef0cd4e8468e3bb4f6a2c6530869e'
        );
        assert.deepEqual([...program.imports].sort(), [
            'fetch',
            'input_len',
            'input_read',
            'keep',
            'log',
            'values',
        ]);
        assert.equal(program.initialize, true);
    });

    it('looks a name up, then fetches the weather there, then sets its values', async () => {
        const first = await step({ name: 'Berlin' });
        assert.deepEqual(first.fetches, [
            'https://geocoding-api.open-meteo.com/v1/search?name=Berlin&count=1&language=en&format=json',
        ]);
        assert.equal(first.values, null);
        assert.deepEqual(first.keep, { name: 'Berlin', place: '', pending: 'geo' });

        const second = await step({ name: 'Berlin' }, first.keep, [
            { status: 200, body: fixture('geocode.json') },
        ]);
        assert.deepEqual(second.fetches, [Forecast]);
        assert.deepEqual(second.keep, {
            name: 'Berlin',
            place: 'Berlin, Germany',
            pending: 'wx',
            lat: 52.52437,
            lon: 13.41053,
        });

        const third = await step({ name: 'Berlin' }, second.keep, [
            { status: 200, body: fixture('current.json') },
        ]);
        assert.deepEqual(third.fetches, []);
        assert.deepEqual(third.values, {
            place: 'Berlin, Germany',
            temperature: -0.8,
            precipitation: 0,
            code: 3,
            cloudCover: 100,
            windSpeed: 12.8,
            windDirection: 80,
            isDay: false,
            observedAt: '2026-11-27T17:00:00Z',
        });
        assert.equal((third.keep as { pending: string }).pending, '');
        assert.ok(third.fuelUsed < 1_000_000, `fuel ${third.fuelUsed}`);

        //  the next update goes straight to the weather: the name is known
        const next = await step({ name: 'Berlin' }, third.keep);
        assert.deepEqual(next.fetches, [Forecast]);
    });

    it('looks a name up again when it changes', async () => {
        const known = { name: 'Berlin', place: 'Berlin, Germany', pending: '', lat: 52.52, lon: 13.41 };
        const r = await step({ name: 'Paris' }, known);
        assert.match(r.fetches[0]!, /geocoding-api.*name=Paris/);
    });

    it('goes straight to the weather for coordinates, with their label', async () => {
        const r = await step({ latitude: 45.5, longitude: -122.25, label: 'A town' });
        assert.deepEqual(r.fetches, [
            'https://api.open-meteo.com/v1/forecast?latitude=45.5&longitude=-122.25' +
                '&current=temperature_2m,precipitation,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,is_day&timezone=GMT',
        ]);
        assert.equal((r.keep as { place: string }).place, 'A town');
        const unlabelled = await step({ latitude: 45.5, longitude: -122.25 });
        assert.equal((unlabelled.keep as { place: string }).place, '45.5, -122.25');
    });

    it('encodes a name for the URL', async () => {
        const r = await step({ name: 'São Paulo & co/?' });
        assert.equal(
            r.fetches[0],
            'https://geocoding-api.open-meteo.com/v1/search?name=S%C3%A3o%20Paulo%20%26%20co%2F%3F&count=1&language=en&format=json'
        );
    });

    it("says so, and sets nothing, for a place it can't find or a failed fetch", async () => {
        const none = await step({ name: 'Xqzzyplace' }, { name: 'Xqzzyplace', pending: 'geo' }, [
            { status: 200, body: fixture('geocode_none.json') },
        ]);
        assert.equal(none.values, null);
        assert.deepEqual(none.fetches, []);
        assert.deepEqual(none.log, ['no place is called "Xqzzyplace"']);

        const bad = await step({ latitude: 95, longitude: 13 }, { pending: 'wx', lat: 52, lon: 13 }, [
            { status: 400, body: fixture('current_bad.json') },
        ]);
        //  the input's latitude is out of range, so it names no place
        assert.deepEqual(bad.log, ['the input names no place: give a name, or a latitude and longitude']);

        const failed = await step({ name: 'Berlin' }, { name: 'Berlin', pending: 'wx', lat: 52, lon: 13 }, [
            { status: 400, body: fixture('current_bad.json') },
        ]);
        assert.equal(failed.values, null);
        assert.deepEqual(failed.log, [
            'the weather failed (400): Latitude must be in range of -90 to 90°. Given: 95.0.',
        ]);

        const lost = await step({ name: 'Berlin' }, { name: 'Berlin', pending: 'wx', lat: 52, lon: 13 }, [
            { status: 0, body: '' },
        ]);
        assert.equal(lost.values, null);
        assert.deepEqual(lost.log, ['the weather failed (0)']);
    });

    it('survives replies that are not what it expects', async () => {
        const state = { name: 'Berlin', place: 'Berlin, Germany', pending: 'wx', lat: 52, lon: 13 };
        //  the worst a reply within the hub's 16 KB limit can be: deep,
        //  all escapes (each doubled again in the step's input), or many
        //  tiny values; none of them may make the program trap
        const Limit = 16 * 1024;
        for (const body of [
            '',
            'not json',
            '{"current":',
            '[1,2,3]',
            '{"current":{"temperature_2m":"warm"}}',
            '{"a":'.repeat(Limit / 5),
            '"'.repeat(Limit),
            JSON.stringify({ current: { pad: '\\"'.repeat(Limit / 4) } }),
            JSON.stringify({ list: Array(Limit / 2 - 10).fill(1) }),
            JSON.stringify({ current: { temperature_2m: 5, pad: 'x'.repeat(Limit - 60) } }),
        ]) {
            const r = await step({ name: 'Berlin' }, state, [{ status: 200, body }]);
            //  either nothing, or only the values it could read
            assert.ok(null === r.values || 'Berlin, Germany' === r.values.place, body.slice(0, 20));
            assert.ok(undefined === r.values?.temperature || 5 === r.values.temperature);
        }
    });

    it('needs a place, and logs when the hub refuses its sites', async () => {
        const none = await step({});
        assert.deepEqual(none.log, ['the input names no place: give a name, or a latitude and longitude']);
        const refused = await step({ name: 'Berlin' }, null, [], []);
        assert.deepEqual(refused.fetches, []);
        assert.deepEqual(refused.log, ['the hub refused the place request']);
    });
});
