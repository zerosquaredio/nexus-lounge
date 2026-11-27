//  Live objects' programs: the checker and metering (src/wasm_meter.ts) and
//  running a step (src/program.ts), against programs built byte by byte
//  (wasm.ts), good and hostile.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkProgram, DefaultProgramLimits } from '../src/wasm_meter.ts';
import { allowedHosts, DefaultStepLimits, runStep } from '../src/program.ts';
import type { StepInput, StepResult } from '../src/program.ts';
import { HubError } from '../src/errors.ts';
import { buildModule, bytesOf, HostTypes, i32, I32, I64, op, program, sleb, uleb } from './wasm.ts';

const Sites = ['api.open-meteo.com', 'geocoding-api.open-meteo.com'];
const input: StepInput = {
    input: { name: 'Berlin' },
    state: null,
    replies: [],
    time: '2026-11-27T17:00:00Z',
};

function refused(bytes: Uint8Array, why: RegExp) {
    assert.throws(
        () => checkProgram(bytes),
        (e: unknown) => e instanceof HubError && why.test(e.message),
        `expected a refusal matching ${why}`
    );
}

async function step(
    bytes: Uint8Array,
    options: { input?: StepInput; fuel?: number; ms?: number } = {}
): Promise<StepResult> {
    const limits = {
        ...DefaultStepLimits,
        ...(options.fuel ? { fuel: options.fuel } : {}),
        ...(options.ms ? { ms: options.ms } : {}),
    };
    return runStep(checkProgram(bytes), options.input ?? input, { allowedHosts: Sites, limits });
}

//  A loop adding 0..n-1 into memory at 0, n given as a constant
const sumTo = (n: number) =>
    program(
        [
            ...[op.block, op.void, op.loop, op.void],
            ...[op.local_get, 0, ...i32(n), op.i32_ge_u, op.br_if, 1],
            ...[...i32(0), ...i32(0), op.i32_load, 2, 0, op.local_get, 0, op.i32_add, op.i32_store, 2, 0],
            ...[op.local_get, 0, ...i32(1), op.i32_add, op.local_set, 0],
            ...[op.br, 0, op.end, op.end],
        ],
        { locals: [[1, I32]] }
    );

//  A program that writes a string from its data at 1024 to a host function
function sends(name: string, text: string | number[], extra: string[] = []) {
    const bytes = 'string' === typeof text ? bytesOf(text) : text;
    const imports = [name, ...extra];
    return program([...i32(1024), ...i32(bytes.length), op.call, 0, ...('fetch' === name ? [op.drop] : [])], {
        imports,
        data: [{ offset: 1024, bytes }],
    });
}

describe('checking programs', () => {
    it('takes a well-formed program and meters it', () => {
        const checked = checkProgram(sumTo(10));
        assert.ok(WebAssembly.validate(checked.metered));
        const exports = WebAssembly.Module.exports(new WebAssembly.Module(checked.metered)).map(e => e.name);
        assert.deepEqual(exports.sort(), ['__fuel', 'memory', 'step']);
        assert.equal(checked.memoryPages, 16);
        assert.equal(checked.initialize, false);
    });

    it('meters the same program to the same bytes every time', () => {
        assert.deepEqual(checkProgram(sumTo(10)).metered, checkProgram(sumTo(10)).metered);
    });

    it('drops custom sections', () => {
        const withName = buildModule({
            custom: [{ name: 'hidden', bytes: bytesOf('SECRET-MARKER') }],
            types: HostTypes,
            funcs: [{ type: 0, body: [op.end] }],
            memory: { min: 1, max: 1 },
            exports: [
                { name: 'step', kind: 0, index: 0 },
                { name: 'memory', kind: 2, index: 0 },
            ],
        });
        const { metered } = checkProgram(withName);
        assert.equal(Buffer.from(metered).includes('SECRET-MARKER'), false);
    });

    it("puts the fuel after the program's own globals", async () => {
        //  a program with a global of its own, which its step reads and stores
        const bytes = program(
            [...i32(0), op.global_get, 0, op.i32_store, 2, 0, ...i32(4), op.global_get, 0, op.drop, op.drop],
            {
                globals: [[I32, 0x01, ...i32(41), op.end]],
            }
        );
        const r = await step(bytes);
        assert.equal(r.ok, true, JSON.stringify(r));
    });

    it('refuses what is not a module, or too large', () => {
        refused(new Uint8Array([1, 2, 3, 4]), /not a valid WebAssembly module/);
        refused(new Uint8Array(DefaultProgramLimits.moduleBytes + 1), /larger than/);
    });

    it('refuses memory it cannot bound', () => {
        refused(
            buildModule({
                types: HostTypes,
                funcs: [{ type: 0, body: [op.end] }],
                exports: [{ name: 'step', kind: 0, index: 0 }],
            }),
            /no memory/
        );
        refused(program([], { memory: { min: 1 } }), /no maximum/);
        refused(program([], { memory: { min: 1, max: 17 } }), /past 16 pages/);
        refused(
            program([], { memory: { min: 1, max: 1, flags: 0x03 } }),
            /no maximum, or is shared|not a valid/
        );
    });

    it('refuses a start function', () => {
        const bytes = buildModule({
            types: HostTypes,
            funcs: [{ type: 0, body: [op.end] }],
            memory: { min: 1, max: 1 },
            exports: [
                { name: 'step', kind: 0, index: 0 },
                { name: 'memory', kind: 2, index: 0 },
            ],
            start: 0,
        });
        refused(bytes, /start function/);
    });

    it('refuses imports the hub does not give', () => {
        const base = { types: HostTypes, funcs: [{ type: 0, body: [op.end] }], memory: { min: 1, max: 1 } };
        const exportsAfter = (n: number) => [
            { name: 'step', kind: 0, index: n },
            { name: 'memory', kind: 2, index: 0 },
        ];
        refused(
            buildModule({
                ...base,
                imports: [{ module: 'env', name: 'abort', type: 0 }],
                exports: exportsAfter(1),
            }),
            /env\.abort/
        );
        refused(
            buildModule({
                ...base,
                imports: [{ module: 'cyberspace', name: 'open', type: 0 }],
                exports: exportsAfter(1),
            }),
            /does not give/
        );
        refused(
            buildModule({
                ...base,
                imports: [{ module: 'cyberspace', name: 'log', type: 0 }],
                exports: exportsAfter(1),
            }),
            /wrong signature/
        );
        refused(
            buildModule({
                ...base,
                imports: [
                    { module: 'cyberspace', name: 'log', type: 4 },
                    { module: 'cyberspace', name: 'log', type: 4 },
                ],
                exports: exportsAfter(2),
            }),
            /twice/
        );
        //  memory, tables and globals from outside
        refused(
            buildModule({
                ...base,
                memory: null,
                imports: [{ module: 'cyberspace', name: 'memory', kind: 2, desc: [0x01, 1, 1] }],
                exports: exportsAfter(0),
            }),
            /not a host function/
        );
        refused(
            buildModule({
                ...base,
                imports: [{ module: 'cyberspace', name: 'g', kind: 3, desc: [I32, 0] }],
                exports: exportsAfter(0),
            }),
            /not a host function/
        );
        //  imports under the Object prototype's names
        refused(
            buildModule({
                ...base,
                imports: [{ module: 'cyberspace', name: 'constructor', type: 0 }],
                exports: exportsAfter(1),
            }),
            /does not give/
        );
    });

    it("refuses a program without step and memory, or with the hub's own names", () => {
        const base = { types: HostTypes, memory: { min: 1, max: 1 } };
        refused(
            buildModule({
                ...base,
                funcs: [{ type: 0, body: [op.end] }],
                exports: [{ name: 'memory', kind: 2, index: 0 }],
            }),
            /no step/
        );
        refused(
            buildModule({
                ...base,
                funcs: [{ type: 0, body: [op.end] }],
                exports: [{ name: 'step', kind: 0, index: 0 }],
            }),
            /does not export its memory/
        );
        refused(
            buildModule({
                ...base,
                funcs: [{ type: 5, body: [op.local_get, 0, op.end] }],
                exports: [
                    { name: 'step', kind: 0, index: 0 },
                    { name: 'memory', kind: 2, index: 0 },
                ],
            }),
            /take and return nothing/
        );
        refused(
            buildModule({
                ...base,
                funcs: [{ type: 0, body: [op.end] }],
                globals: [[I64, 0x01, op.i64_const, 0, op.end]],
                exports: [
                    { name: 'step', kind: 0, index: 0 },
                    { name: 'memory', kind: 2, index: 0 },
                    { name: '__fuel', kind: 3, index: 0 },
                ],
            }),
            /__fuel/
        );
    });

    it('refuses instructions outside the set it takes', () => {
        //  SIMD: v128.const, then drop
        refused(program([0xfd, 0x0c, ...new Array(16).fill(0), op.drop]), /instruction|type the hub/);
        //  a return_call (tail calls)
        refused(program([0x12, 0]), /instruction|not a valid/);
    });
});

describe('running a step', () => {
    it('runs, counting the same fuel every time, in proportion to the work', async () => {
        const a = await step(sumTo(1000));
        const b = await step(sumTo(1000));
        const c = await step(sumTo(2000));
        assert.equal(a.ok, true, JSON.stringify(a));
        assert.equal(a.fuelUsed, b.fuelUsed);
        assert.ok(a.fuelUsed > 1000 * 10);
        //  each round costs the same: twice the rounds, twice the fuel (but
        //  for the fixed part before and after the loop)
        assert.equal(c.fuelUsed - a.fuelUsed, a.fuelUsed - (await step(sumTo(0))).fuelUsed);
    });

    it('stops a loop that runs past its fuel', async () => {
        const r = await step(sumTo(100_000_000), { fuel: 1_000_000 });
        assert.equal(r.ok, false);
        assert.equal(!r.ok && r.reason, 'fuel');
        assert.equal(r.fuelUsed, 1_000_000);
    });

    it('stops an endless loop by fuel, and by time if fuel is ample', async () => {
        const endless = program([op.loop, op.void, op.br, 0, op.end]);
        const byFuel = await step(endless, { fuel: 5_000_000 });
        assert.equal(!byFuel.ok && byFuel.reason, 'fuel');
        const t0 = Date.now();
        const byTime = await step(endless, { fuel: Number.MAX_SAFE_INTEGER, ms: 300 });
        assert.equal(!byTime.ok && byTime.reason, 'time');
        assert.ok(Date.now() - t0 < 3000);
    });

    it('stops endless recursion on the stack', async () => {
        //  step calls function 1, which calls itself
        const bytes = program([...i32(0), op.call, 1, op.drop], {
            funcs: [{ type: 5, body: [op.local_get, 0, ...i32(1), op.i32_add, op.call, 1] }],
        });
        const r = await step(bytes);
        assert.equal(!r.ok && r.reason, 'stack');
    });

    it("can't grow its memory past its maximum", async () => {
        //  grow by 100 pages, store the answer (-1) at 0, and send it as values
        const bytes = program(
            [
                ...[...i32(0), ...i32(100), op.memory_grow, 0, op.i32_store, 2, 0],
                ...[...i32(0), op.i32_load, 2, 0, ...i32(-1), op.i32_eq, op.if, op.void],
                ...[...i32(1024), ...i32(11), op.call, 0, op.end],
            ],
            { imports: ['values'], data: [{ offset: 1024, bytes: bytesOf('{"ok":true}') }] }
        );
        const r = await step(bytes);
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.deepEqual(r.ok && r.values, { ok: true });
    });

    it('branches correctly when metered: if, else, br_table and calls', async () => {
        //  function 1: n odd ? 3n+1 : n/2. step: count the rounds from 27 to
        //  1 (111), then pick a word by br_table on the count's last two bits
        //  (111 & 3 = 3: "d"), and send {"n":"<word>"} as values
        const collatz = {
            type: 5,
            body: [
                ...[op.local_get, 0, ...i32(1), op.i32_and, op.if, I32],
                ...[op.local_get, 0, ...i32(3), op.i32_mul, ...i32(1), op.i32_add],
                ...[op.else, op.local_get, 0, ...i32(1), op.i32_shr_u, op.end],
            ],
        };
        const word = (c: string) => [...i32(1024 + 6), ...i32(c.charCodeAt(0)), 0x3a, 0, 0]; //  i32.store8
        const bytes = program(
            [
                ...[...i32(27), op.local_set, 0],
                ...[op.block, op.void, op.loop, op.void],
                ...[op.local_get, 0, ...i32(1), op.i32_eq, op.br_if, 1],
                ...[op.local_get, 0, op.call, 2, op.local_set, 0],
                ...[op.local_get, 1, ...i32(1), op.i32_add, op.local_set, 1],
                ...[op.br, 0, op.end, op.end],
                //  four nested blocks, br_table into one of them
                ...[op.block, op.void, op.block, op.void, op.block, op.void, op.block, op.void],
                ...[op.local_get, 1, ...i32(3), op.i32_and, op.br_table, 3, 0, 1, 2, 3, op.end],
                ...[...word('a'), op.br, 2, op.end],
                ...[...word('b'), op.br, 1, op.end],
                ...[...word('c'), op.br, 0, op.end],
                ...word('d'),
                ...[...i32(1024), ...i32(9), op.call, 0],
            ],
            {
                imports: ['values'],
                locals: [[2, I32]],
                funcs: [collatz],
                data: [{ offset: 1024, bytes: bytesOf('{"n":"?"}') }],
            }
        );
        const r = await step(bytes);
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.deepEqual(r.ok && r.values, { n: 'd' });
    });

    it('runs an exported _initialize first, metered with the step', async () => {
        //  _initialize stores 7 at 0; step sends it as values if it's there
        const bytes = program(
            [
                ...i32(0),
                op.i32_load,
                2,
                0,
                ...i32(7),
                op.i32_eq,
                op.if,
                op.void,
                ...i32(1024),
                ...i32(2),
                op.call,
                0,
                op.end,
            ],
            {
                imports: ['values'],
                initialize: [...i32(0), ...i32(7), op.i32_store, 2, 0],
                data: [{ offset: 1024, bytes: bytesOf('{}') }],
            }
        );
        assert.equal(checkProgram(bytes).initialize, true);
        const r = await step(bytes);
        assert.deepEqual(r.ok && r.values, {});
    });
});

describe('the host interface', () => {
    it('gives the step its input, which it can send back as its values', async () => {
        //  len = input_len(); input_read(0); values(0, len)
        const bytes = program(
            [op.call, 0, op.local_set, 0, ...i32(0), op.call, 1, ...i32(0), op.local_get, 0, op.call, 2],
            { imports: ['input_len', 'input_read', 'values'], locals: [[1, I32]] }
        );
        const r = await step(bytes);
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.deepEqual(r.ok && r.values, input as unknown as Record<string, unknown>);
    });

    it('takes fetches only to allowed sites, over https, at most two', async () => {
        const ok = await step(
            sends('fetch', 'https://api.open-meteo.com/v1/forecast?latitude=52.52&longitude=13.41')
        );
        assert.deepEqual(ok.ok && ok.fetches, [
            'https://api.open-meteo.com/v1/forecast?latitude=52.52&longitude=13.41',
        ]);
        for (const url of [
            'http://api.open-meteo.com/v1/forecast',
            'https://example.com/',
            'https://api.open-meteo.com:8443/v1/forecast',
            'https://user:pw@api.open-meteo.com/',
            'https://api.open-meteo.com.evil.example/',
            'https://127.0.0.1/',
            'file:///etc/passwd',
            'not a url',
        ]) {
            const r = await step(sends('fetch', url));
            assert.deepEqual(r.ok && r.fetches, [], url);
        }
        //  three asks: the third is refused
        const url = bytesOf('https://api.open-meteo.com/');
        const ask = [...i32(1024), ...i32(url.length), op.call, 0, op.drop];
        const three = await step(
            program([...ask, ...ask, ...ask], { imports: ['fetch'], data: [{ offset: 1024, bytes: url }] })
        );
        assert.equal(three.ok && three.fetches.length, 2);
        //  and nothing is allowed when the place allows none of the sites
        const none = await runStep(checkProgram(sends('fetch', 'https://api.open-meteo.com/')), input, {
            allowedHosts: allowedHosts(['api.open-meteo.com'], ['example.org']),
        });
        assert.deepEqual(none.ok && none.fetches, []);
    });

    it('allows a site only when both the program and the place name it', () => {
        assert.deepEqual(
            allowedHosts(['API.open-meteo.com', 'example.com'], ['api.open-meteo.com', 'other.org']),
            ['api.open-meteo.com']
        );
    });

    it('keeps working state and log lines, cleaned', async () => {
        const r = await step(sends('keep', '{"lat":52.52}'));
        assert.deepEqual(r.ok && r.keep, { lat: 52.52 });
        const l = await step(sends('log', 'line\u001b[31m red\nnext'));
        assert.deepEqual(l.ok && l.log, ['line [31m red next']);
    });

    it('refuses values that are not a JSON object, too large, or outside memory', async () => {
        for (const bad of ['[1,2]', '42', 'null', '{"a":', 'not json']) {
            const r = await step(sends('values', bad));
            assert.equal(!r.ok && r.reason, 'refused', bad);
        }
        const big = `{"a":"${'x'.repeat(DefaultStepLimits.valuesBytes)}"}`;
        const r = await step(sends('values', big));
        assert.equal(!r.ok && r.reason, 'refused');
        assert.equal(!r.ok && /more than/.test(r.message), true);
        //  invalid UTF-8
        const u = await step(sends('values', [0x7b, 0xff, 0x7d]));
        assert.equal(!u.ok && /UTF-8/.test(u.message), true);
        //  a pointer past the end of memory, and a negative length
        const past = await step(
            program([...i32(65536 - 2), ...i32(10), op.call, 0], {
                imports: ['values'],
                memory: { min: 1, max: 1 },
            })
        );
        assert.equal(!past.ok && /outside/.test(past.message), true);
        const negative = await step(program([...i32(0), ...i32(-1), op.call, 0], { imports: ['values'] }));
        assert.equal(!negative.ok && negative.reason, 'refused');
    });

    it('keeps nothing from a step that fails', async () => {
        //  values, then an unreachable
        const bytes = program([...i32(1024), ...i32(2), op.call, 0, op.unreachable], {
            imports: ['values'],
            data: [{ offset: 1024, bytes: bytesOf('{}') }],
        });
        const r = await step(bytes);
        assert.equal(r.ok, false);
        assert.equal(!r.ok && r.reason, 'trap');
        assert.equal('values' in r, false);
    });
});

//  keep the import used for sleb and uleb
void sleb;
void uleb;

describe('a program from a real compiler', () => {
    it('takes and runs AssemblyScript output (fixtures/programs/as_probe.ts)', async () => {
        const { readFileSync } = await import('node:fs');
        const bytes = readFileSync(new URL('./fixtures/programs/as_probe.wasm', import.meta.url));
        const checked = checkProgram(bytes);
        assert.equal(checked.initialize, true);
        assert.deepEqual(checked.imports, ['log']);
        const r = await runStep(checked, input, { allowedHosts: Sites });
        assert.equal(r.ok, true, JSON.stringify(r));
        assert.deepEqual(r.log, ['temperature -0.8']);
        assert.ok(r.fuelUsed > 0 && r.fuelUsed < 10_000);
    });
});
