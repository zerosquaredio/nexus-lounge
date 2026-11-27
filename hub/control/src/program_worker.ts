//  Runs one step of a live object's program (program.ts), in a worker
//  thread of its own, so a step that runs away can be ended by ending the
//  worker. The program reaches nothing but the host functions below, each
//  of which checks every pointer and length it is given against the
//  program's own memory, and its limit.

import { parentPort, workerData } from 'node:worker_threads';
import type { StepJob, StepResult } from './program.ts';

const job = workerData as StepJob;
const decoder = new TextDecoder('utf-8', { fatal: true });

class Refused extends Error {}

let memory: WebAssembly.Memory | undefined;
function view(ptr: number, len: number, max: number, what: string): Uint8Array {
    if (!memory) throw new Refused('memory used before the module was ready');
    if (!Number.isInteger(ptr) || !Number.isInteger(len) || ptr < 0 || len < 0)
        throw new Refused(`${what}: a bad pointer or length`);
    if (len > max) throw new Refused(`${what}: more than ${max} bytes`);
    if (ptr + len > memory.buffer.byteLength) throw new Refused(`${what}: outside the program's memory`);
    return new Uint8Array(memory.buffer, ptr, len);
}
function text(ptr: number, len: number, max: number, what: string): string {
    try {
        return decoder.decode(view(ptr, len, max, what));
    } catch (e) {
        if (e instanceof Refused) throw e;
        throw new Refused(`${what}: not UTF-8`);
    }
}
function json(ptr: number, len: number, max: number, what: string): unknown {
    const t = text(ptr, len, max, what);
    try {
        return JSON.parse(t);
    } catch {
        throw new Refused(`${what}: not JSON`);
    }
}

const input = new TextEncoder().encode(JSON.stringify(job.input));
const fetches: string[] = [];
const log: string[] = [];
let values: Record<string, unknown> | null = null;
let keep: unknown = undefined;
const allowed = new Set(job.allowedHosts.map(h => h.toLowerCase()));

const host = {
    input_len: () => input.length,
    input_read: (ptr: number) => {
        view(ptr, input.length, input.length, 'input_read').set(input);
    },
    //  A request for the next step: refused (-1) unless https, on a site
    //  both whitelists allow, with no user name or port of its own
    fetch: (ptr: number, len: number) => {
        const t = text(ptr, len, job.limits.urlBytes, 'fetch');
        if (fetches.length >= job.limits.fetches) return -1;
        let url: URL;
        try {
            url = new URL(t);
        } catch {
            return -1;
        }
        if (
            'https:' !== url.protocol ||
            url.username ||
            url.password ||
            url.port ||
            !allowed.has(url.hostname)
        )
            return -1;
        fetches.push(url.href);
        return fetches.length - 1;
    },
    values: (ptr: number, len: number) => {
        const v = json(ptr, len, job.limits.valuesBytes, 'values');
        if (null === v || 'object' !== typeof v || Array.isArray(v))
            throw new Refused('values: not an object');
        values = v as Record<string, unknown>;
    },
    keep: (ptr: number, len: number) => {
        keep = json(ptr, len, job.limits.keepBytes, 'keep');
    },
    log: (ptr: number, len: number) => {
        const t = text(ptr, Math.min(len, job.limits.logBytes), job.limits.logBytes, 'log');
        if (log.length < job.limits.logLines) log.push(t.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' '));
    },
};

function run(): StepResult {
    const module = new WebAssembly.Module(job.module);
    const imports: Record<string, Record<string, (...args: number[]) => number | void>> = { cyberspace: {} };
    for (const { module: m, name } of WebAssembly.Module.imports(module)) {
        if ('cyberspace' === m && Object.hasOwn(host, name)) {
            imports.cyberspace![name] = host[name as keyof typeof host] as (
                ...args: number[]
            ) => number | void;
        }
    }
    const instance = new WebAssembly.Instance(module, imports);
    const exports = instance.exports as {
        memory: WebAssembly.Memory;
        __fuel: WebAssembly.Global;
        step: () => void;
        _initialize?: () => void;
    };
    memory = exports.memory;
    const fuel = exports.__fuel;
    fuel.value = BigInt(job.fuel);
    const used = () => Number(BigInt(job.fuel) - (fuel.value as bigint));
    try {
        exports._initialize?.();
        exports.step();
    } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        const reason =
            (fuel.value as bigint) < 0n
                ? 'fuel'
                : e instanceof Refused
                  ? 'refused'
                  : e instanceof RangeError
                    ? 'stack'
                    : 'trap';
        return {
            ok: false,
            reason,
            message: 'fuel' === reason ? 'ran out of fuel' : message,
            fuelUsed: Math.min(used(), job.fuel),
            log,
        };
    }
    return { ok: true, fuelUsed: used(), fetches, values, keep, log };
}

let result: StepResult;
try {
    result = run();
} catch (e) {
    result = {
        ok: false,
        reason: 'trap',
        message: e instanceof Error ? e.message : String(e),
        fuelUsed: 0,
        log,
    };
}
parentPort!.postMessage(result);
