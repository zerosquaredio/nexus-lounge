//  Builds small WebAssembly modules for the program tests, byte by byte, so
//  the tests need no assembler. Function bodies are given as bytes, using
//  the opcodes below.

export const I32 = 0x7f;
export const I64 = 0x7e;
export const F64 = 0x7c;

export const op = {
    unreachable: 0x00,
    block: 0x02,
    loop: 0x03,
    if: 0x04,
    else: 0x05,
    end: 0x0b,
    br: 0x0c,
    br_if: 0x0d,
    br_table: 0x0e,
    return: 0x0f,
    call: 0x10,
    drop: 0x1a,
    local_get: 0x20,
    local_set: 0x21,
    local_tee: 0x22,
    global_get: 0x23,
    global_set: 0x24,
    i32_load: 0x28,
    i32_store: 0x36,
    memory_grow: 0x40,
    i32_const: 0x41,
    i64_const: 0x42,
    i32_eqz: 0x45,
    i32_eq: 0x46,
    i32_lt_u: 0x49,
    i32_ge_u: 0x4f,
    i32_add: 0x6a,
    i32_sub: 0x6b,
    i32_mul: 0x6c,
    i32_and: 0x71,
    i32_shr_u: 0x76,
    void: 0x40,
};

export function uleb(n: number): number[] {
    const out: number[] = [];
    do {
        let byte = n & 0x7f;
        n = Math.floor(n / 128);
        if (n) byte |= 0x80;
        out.push(byte);
    } while (n);
    return out;
}

export function sleb(n: number): number[] {
    const out: number[] = [];
    for (;;) {
        const byte = n & 0x7f;
        n >>= 7;
        const done = (0 === n && !(byte & 0x40)) || (-1 === n && byte & 0x40);
        out.push(done ? byte : byte | 0x80);
        if (done) return out;
    }
}

export const i32 = (n: number) => [op.i32_const, ...sleb(n)];

const str = (s: string) => {
    const b = [...new TextEncoder().encode(s)];
    return [...uleb(b.length), ...b];
};
const vec = (items: number[][]) => [...uleb(items.length), ...items.flat()];
const section = (id: number, content: number[]) => [id, ...uleb(content.length), ...content];

export interface ModuleSpec {
    types?: [number[], number[]][];
    imports?: { module: string; name: string; type?: number; kind?: number; desc?: number[] }[];
    funcs?: { type: number; locals?: [number, number][]; body: number[] }[];
    memory?: { min: number; max?: number; flags?: number } | null;
    globals?: number[][]; //   each: type, mut, init expr (with end)
    exports?: { name: string; kind: number; index: number }[];
    start?: number;
    data?: { offset: number; bytes: number[] }[];
    custom?: { name: string; bytes: number[] }[];
    extraSection?: number[]; // raw bytes of one more section, at the end
}

export function buildModule(m: ModuleSpec): Uint8Array {
    const out = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
    for (const c of m.custom ?? []) out.push(...section(0, [...str(c.name), ...c.bytes]));
    if (m.types)
        out.push(
            ...section(
                1,
                vec(m.types.map(([p, r]) => [0x60, ...vec(p.map(x => [x])), ...vec(r.map(x => [x]))]))
            )
        );
    if (m.imports)
        out.push(
            ...section(
                2,
                vec(
                    m.imports.map(i => [
                        ...str(i.module),
                        ...str(i.name),
                        i.kind ?? 0,
                        ...(i.desc ?? uleb(i.type ?? 0)),
                    ])
                )
            )
        );
    if (m.funcs) out.push(...section(3, vec(m.funcs.map(f => uleb(f.type)))));
    if (m.memory) {
        const { min, max, flags } = m.memory;
        const f = flags ?? (undefined === max ? 0 : 1);
        out.push(...section(5, vec([[f, ...uleb(min), ...(undefined === max ? [] : uleb(max))]])));
    }
    if (m.globals) out.push(...section(6, vec(m.globals)));
    if (m.exports)
        out.push(...section(7, vec(m.exports.map(e => [...str(e.name), e.kind, ...uleb(e.index)]))));
    if (undefined !== m.start) out.push(...section(8, uleb(m.start)));
    if (m.funcs)
        out.push(
            ...section(
                10,
                vec(
                    m.funcs.map(f => {
                        const body = [...vec((f.locals ?? []).map(([n, t]) => [...uleb(n), t])), ...f.body];
                        return [...uleb(body.length), ...body];
                    })
                )
            )
        );
    if (m.data)
        out.push(
            ...section(
                11,
                vec(m.data.map(d => [0x00, ...i32(d.offset), op.end, ...vec(d.bytes.map(b => [b]))]))
            )
        );
    if (m.extraSection) out.push(...m.extraSection);
    return new Uint8Array(out);
}

//  The host interface's imports, in this order, with their types
export const HostTypes: [number[], number[]][] = [
    [[], []], //            0: step, _initialize
    [[], [I32]], //         1: input_len
    [[I32], []], //         2: input_read
    [[I32, I32], [I32]], // 3: fetch
    [[I32, I32], []], //    4: values, keep, log
    [[I32], [I32]], //      5: (i32) -> i32, for programs' own functions
];

//  A program with a step function of the given body (type 0) and others,
//  importing the host functions named, with 1 to 16 pages of memory
export function program(
    body: number[],
    {
        imports = [] as string[],
        funcs = [] as { type: number; locals?: [number, number][]; body: number[] }[],
        locals = [] as [number, number][],
        data = [] as { offset: number; bytes: number[] }[],
        initialize = null as number[] | null,
        memory = { min: 1, max: 16 } as ModuleSpec['memory'],
        globals = undefined as number[][] | undefined,
    } = {}
): Uint8Array {
    const typeOf: Record<string, number> = {
        input_len: 1,
        input_read: 2,
        fetch: 3,
        values: 4,
        keep: 4,
        log: 4,
    };
    const imported = imports.map(name => ({ module: 'cyberspace', name, type: typeOf[name] ?? 0 }));
    const n = imported.length;
    const all = [
        { type: 0, locals, body: [...body, op.end] },
        ...funcs.map(f => ({ ...f, body: [...f.body, op.end] })),
    ];
    if (initialize) all.push({ type: 0, locals: [], body: [...initialize, op.end] });
    const exports = [
        { name: 'step', kind: 0, index: n },
        { name: 'memory', kind: 2, index: 0 },
    ];
    if (initialize) exports.push({ name: '_initialize', kind: 0, index: n + all.length - 1 });
    return buildModule({ types: HostTypes, imports: imported, funcs: all, memory, exports, data, globals });
}

//  The index of a host import in a program built with these imports
export const importIndex = (imports: string[], name: string) => imports.indexOf(name);
export const bytesOf = (s: string) => [...new TextEncoder().encode(s)];
