//  Programs for live objects (build spec of the live object slice, §2
//  decision 1, §3 "the host interface"): checking a WebAssembly module, and
//  writing it again with fuel metering added.
//
//  Every byte comes from outside, so this is a security boundary, as the
//  glTF checker is. The engine's own validation runs first, so the reader
//  below only ever walks modules the engine already found well formed; it
//  refuses whatever it does not know rather than guessing.
//
//  Metering: a mutable i64 global, exported as "__fuel", which the host
//  sets before each call. Each function body is split into segments at
//  every instruction that branches or ends a block; each segment begins by
//  subtracting its own number of instructions from the fuel, and traps
//  when the fuel falls below zero. Calls charge in the callee. The same
//  module always gives the same bytes, so a step costs the same fuel on any
//  host (compute spec §2.3).

import { HubError } from './errors.ts';

export interface ProgramLimits {
    moduleBytes: number; //  the module's size, before metering
    memoryPages: number; //  the most memory, in 64 KB pages
}

export const DefaultProgramLimits: ProgramLimits = { moduleBytes: 1024 * 1024, memoryPages: 16 };

//  The host interface: each import a program may have, with its signature
//  (params, results), all numbers as i32 (0x7f)
export const HostImports: Record<string, [number[], number[]]> = {
    input_len: [[], [0x7f]],
    input_read: [[0x7f], []],
    fetch: [[0x7f, 0x7f], [0x7f]],
    values: [[0x7f, 0x7f], []],
    keep: [[0x7f, 0x7f], []],
    log: [[0x7f, 0x7f], []],
};
export const HostModule = 'cyberspace';

export interface CheckedProgram {
    metered: Uint8Array<ArrayBuffer>; //  the module to run: metered, custom sections dropped
    imports: string[]; //  the host functions it uses
    initialize: boolean; //  whether it exports _initialize
    memoryPages: number; //  its memory's maximum
}

function refuse(why: string): never {
    throw new HubError('program-refused', `This program can't be run: ${why}.`);
}

class Reader {
    readonly b: Uint8Array;
    p: number;
    constructor(b: Uint8Array, p = 0) {
        this.b = b;
        this.p = p;
    }
    byte(): number {
        if (this.p >= this.b.length) refuse('it ends early');
        return this.b[this.p++]!;
    }
    u32(): number {
        let result = 0;
        for (let shift = 0; shift < 35; shift += 7) {
            const byte = this.byte();
            result += (byte & 0x7f) * 2 ** shift;
            if (!(byte & 0x80)) {
                if (result > 0xffffffff) refuse('a number is too large');
                return result;
            }
        }
        return refuse('a number is malformed');
    }
    skipLeb(maxBytes: number): void {
        for (let i = 0; i < maxBytes; i++) if (!(this.byte() & 0x80)) return;
        refuse('a number is malformed');
    }
    bytes(n: number): Uint8Array {
        if (n > this.b.length - this.p) refuse('it ends early');
        const out = this.b.subarray(this.p, this.p + n);
        this.p += n;
        return out;
    }
    name(): string {
        return new TextDecoder('utf-8', { fatal: true }).decode(this.bytes(this.u32()));
    }
}

function u32(n: number): number[] {
    const out: number[] = [];
    do {
        let byte = n & 0x7f;
        n = Math.floor(n / 128);
        if (n) byte |= 0x80;
        out.push(byte);
    } while (n);
    return out;
}

function s64(value: number): number[] {
    let n = BigInt(value);
    const out: number[] = [];
    for (;;) {
        const byte = Number(n & 0x7fn);
        n >>= 7n;
        const done = (0n === n && !(byte & 0x40)) || (-1n === n && byte & 0x40);
        out.push(done ? byte : byte | 0x80);
        if (done) return out;
    }
}

const NumTypes = new Set([0x7f, 0x7e, 0x7d, 0x7c]); //  i32 i64 f32 f64
const RefTypes = new Set([0x70, 0x6f]); //               funcref externref

function skipBlockType(r: Reader): void {
    const b = r.b[r.p];
    if (undefined === b) refuse('it ends early');
    if (0x40 === b || NumTypes.has(b)) r.p++;
    else if (b & 0x40) refuse('a block has a type the hub does not take');
    else r.skipLeb(5); //  a type index (multiple values)
}

//  Reads the instruction at r.p and returns its opcode. Only the core
//  instructions, with bulk memory, saturating conversions, sign extension
//  and reference types; SIMD, threads, exceptions, tail calls, garbage
//  collection and more than one memory are refused.
function instruction(r: Reader): number {
    const op = r.byte();
    if (op <= 0x01 || 0x05 === op || 0x0b === op || 0x0f === op) return op;
    if (op >= 0x02 && op <= 0x04) return (skipBlockType(r), op);
    if (0x0c === op || 0x0d === op || 0x10 === op) return (r.u32(), op);
    if (0x0e === op) {
        const n = r.u32();
        for (let i = 0; i <= n; i++) r.u32();
        return op;
    }
    if (0x11 === op) return (r.u32(), r.u32(), op);
    if (0x1a === op || 0x1b === op) return op;
    if (0x1c === op) {
        const n = r.u32();
        for (let i = 0; i < n; i++)
            if (!NumTypes.has(r.byte())) refuse('a select has a type the hub does not take');
        return op;
    }
    if (op >= 0x20 && op <= 0x26) return (r.u32(), op);
    if (op >= 0x28 && op <= 0x3e) {
        if (r.u32() >= 64) refuse('it uses more than one memory');
        r.u32();
        return op;
    }
    if (0x3f === op || 0x40 === op) {
        if (0 !== r.byte()) refuse('it uses more than one memory');
        return op;
    }
    if (0x41 === op) return (r.skipLeb(5), op);
    if (0x42 === op) return (r.skipLeb(10), op);
    if (0x43 === op) return (r.bytes(4), op);
    if (0x44 === op) return (r.bytes(8), op);
    if (op >= 0x45 && op <= 0xc4) return op;
    if (0xd0 === op) return (r.byte(), op);
    if (0xd1 === op) return op;
    if (0xd2 === op) return (r.u32(), op);
    if (0xfc === op) {
        const sub = r.u32();
        if (sub <= 7) return op;
        if (8 === sub) {
            r.u32();
            if (0 !== r.byte()) refuse('it uses more than one memory');
            return op;
        }
        if (9 === sub || 13 === sub || (sub >= 15 && sub <= 17)) return (r.u32(), op);
        if (10 === sub) {
            if (0 !== r.byte() || 0 !== r.byte()) refuse('it uses more than one memory');
            return op;
        }
        if (11 === sub) {
            if (0 !== r.byte()) refuse('it uses more than one memory');
            return op;
        }
        if (12 === sub || 14 === sub) return (r.u32(), r.u32(), op);
    }
    return refuse(`it uses an instruction the hub does not take (0x${op.toString(16)})`);
}

//  Instructions after which a new segment starts: a branch target may
//  follow any of them
const Boundary = new Set([0x02, 0x03, 0x04, 0x05, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f]);

function charge(global: number, cost: number): number[] {
    const g = u32(global);
    return [
        ...[0x23, ...g, 0x42, ...s64(cost), 0x7d, 0x24, ...g], //  fuel -= cost
        ...[0x23, ...g, 0x42, 0x00, 0x53], //                       fuel < 0
        ...[0x04, 0x40, 0x00, 0x0b], //                             if: unreachable
    ];
}

function meterBody(body: Uint8Array, global: number): number[] {
    const r = new Reader(body);
    const groups = r.u32();
    for (let i = 0; i < groups; i++) {
        r.u32();
        const t = r.byte();
        if (!NumTypes.has(t) && !RefTypes.has(t)) refuse('a local has a type the hub does not take');
    }
    const out = [...body.subarray(0, r.p)];
    let start = r.p;
    let count = 0;
    let depth = 1;
    while (r.p < body.length) {
        if (depth <= 0) refuse('a function goes on past its end');
        const op = instruction(r);
        count++;
        if (op >= 0x02 && op <= 0x04) depth++;
        if (0x0b === op) depth--;
        if (Boundary.has(op) || r.p === body.length) {
            out.push(...charge(global, count), ...body.subarray(start, r.p));
            start = r.p;
            count = 0;
        }
    }
    if (0 !== depth) refuse('a function does not end');
    return out;
}

function section(id: number, content: number[] | Uint8Array): number[] {
    return [id, ...u32(content.length), ...content];
}

interface FuncType {
    params: number[];
    results: number[];
}

const same = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => x === b[i]);

//  Checks a program and returns it metered, or refuses it with a HubError
export function checkProgram(
    given: Uint8Array,
    limits: ProgramLimits = DefaultProgramLimits
): CheckedProgram {
    if (given.length > limits.moduleBytes) refuse(`it is larger than ${limits.moduleBytes} bytes`);
    //  a copy of its own, which nothing else can change while it is read
    const bytes = new Uint8Array(given);
    if (!WebAssembly.validate(bytes)) refuse('it is not a valid WebAssembly module');
    const r = new Reader(bytes, 0);
    const header = r.bytes(8);
    if (!same([...header], [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]))
        refuse('it is not a WebAssembly module of version 1');

    const sections: { id: number; body: Uint8Array }[] = [];
    while (r.p < bytes.length) {
        const id = r.byte();
        sections.push({ id, body: r.bytes(r.u32()) });
    }
    const body = (id: number) => sections.find(s => s.id === id)?.body;

    //  types
    const types: FuncType[] = [];
    const typeBody = body(1);
    if (typeBody) {
        const tr = new Reader(typeBody);
        for (let n = tr.u32(); n > 0; n--) {
            if (0x60 !== tr.byte()) refuse('it has a type the hub does not take');
            const vec = () => {
                const out: number[] = [];
                for (let k = tr.u32(); k > 0; k--) {
                    const t = tr.byte();
                    if (!NumTypes.has(t)) refuse('a function has a type the hub does not take');
                    out.push(t);
                }
                return out;
            };
            types.push({ params: vec(), results: vec() });
        }
    }
    const typeAt = (i: number) => types[i] ?? refuse('a type is missing');

    //  imports: host functions only, each with its own signature, once
    const funcTypes: FuncType[] = [];
    const imports: string[] = [];
    const importBody = body(2);
    if (importBody) {
        const ir = new Reader(importBody);
        for (let n = ir.u32(); n > 0; n--) {
            const module = ir.name();
            const field = ir.name();
            const kind = ir.byte();
            if (0 !== kind) refuse(`it imports "${module}.${field}", which is not a host function`);
            const t = typeAt(ir.u32());
            const want = Object.hasOwn(HostImports, field) ? HostImports[field] : undefined;
            if (HostModule !== module || !want)
                refuse(`it imports "${module}.${field}", which the hub does not give`);
            if (!same(t.params, want[0]) || !same(t.results, want[1]))
                refuse(`it imports "${field}" with the wrong signature`);
            if (imports.includes(field)) refuse(`it imports "${field}" twice`);
            imports.push(field);
            funcTypes.push(t);
        }
    }
    const funcBody = body(3);
    if (funcBody) {
        const fr = new Reader(funcBody);
        for (let n = fr.u32(); n > 0; n--) funcTypes.push(typeAt(fr.u32()));
    }

    //  memory: exactly one, with a maximum within the limit, not shared
    const memBody = body(5);
    if (!memBody) refuse('it has no memory of its own');
    const mr = new Reader(memBody);
    if (1 !== mr.u32()) refuse('it has more than one memory');
    const flags = mr.byte();
    if (0x01 !== flags) refuse('its memory has no maximum, or is shared or 64-bit');
    mr.u32();
    const memoryPages = mr.u32();
    if (memoryPages > limits.memoryPages) refuse(`its memory may grow past ${limits.memoryPages} pages`);

    if (body(8)) refuse('it has a start function (export one as _initialize instead)');

    //  exports: memory and step(), perhaps _initialize(); no __fuel
    const exports = new Map<string, [number, number]>();
    const exportBody = body(7);
    if (exportBody) {
        const er = new Reader(exportBody);
        for (let n = er.u32(); n > 0; n--) {
            const field = er.name();
            exports.set(field, [er.byte(), er.u32()]);
        }
    }
    if (exports.has('__fuel')) refuse('it exports "__fuel", the hub\'s own name');
    const exportedFunc = (name: string) => {
        const e = exports.get(name);
        if (!e) return false;
        if (0 !== e[0]) refuse(`its "${name}" is not a function`);
        const t = funcTypes[e[1]] ?? refuse(`its "${name}" is missing`);
        if (t.params.length || t.results.length) refuse(`its "${name}" must take and return nothing`);
        return true;
    };
    if (!exportedFunc('step')) refuse('it has no step function');
    const initialize = exportedFunc('_initialize');
    const memExport = exports.get('memory');
    if (!memExport || 2 !== memExport[0]) refuse('it does not export its memory as "memory"');

    //  the fuel global goes after every other global (only functions are
    //  imported, so the module's own globals are all there are)
    const globalBody = body(6);
    const fuel = globalBody ? new Reader(globalBody).u32() : 0;

    //  write it again: custom sections dropped, the global and its export
    //  added (in their places if the module had none), every body metered
    const out: number[] = [...header];
    const order = [1, 2, 3, 4, 5, 6, 7, 9, 12, 10, 11];
    const present = sections.filter(s => 0 !== s.id);
    for (const s of present) if (!order.includes(s.id)) refuse('it has a section the hub does not know');
    const ids = new Set(present.map(s => s.id));
    ids.add(6);
    ids.add(7);
    for (const id of order) {
        if (!ids.has(id)) continue;
        const sb = body(id);
        //  a vector's count, and the entries after it
        const vector = (): [number, Uint8Array] => {
            if (!sb) return [0, new Uint8Array()];
            const vr = new Reader(sb);
            const n = vr.u32();
            return [n, sb.subarray(vr.p)];
        };
        if (6 === id) {
            const [n, rest] = vector();
            out.push(...section(6, [...u32(n + 1), ...rest, 0x7e, 0x01, 0x42, 0x00, 0x0b]));
        } else if (7 === id) {
            const [n, rest] = vector();
            const name = new TextEncoder().encode('__fuel');
            out.push(
                ...section(7, [...u32(n + 1), ...rest, ...u32(name.length), ...name, 0x03, ...u32(fuel)])
            );
        } else if (10 === id) {
            const cr = new Reader(sb!);
            const n = cr.u32();
            const bodies = [...u32(n)];
            for (let i = 0; i < n; i++) {
                const metered = meterBody(cr.bytes(cr.u32()), fuel);
                bodies.push(...u32(metered.length), ...metered);
            }
            out.push(...section(10, bodies));
        } else {
            out.push(...section(id, sb!));
        }
    }
    const metered = new Uint8Array(out);
    if (!WebAssembly.validate(metered)) refuse('it could not be metered');
    return { metered, imports, initialize, memoryPages };
}
