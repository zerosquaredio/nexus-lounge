//  Running live objects' programs (compute spec §2; build spec of the live
//  object slice, §2 decisions 1 and 2, §3 "the host interface").
//
//  Each step runs in a new worker thread (program_worker.ts) with a fuel
//  limit counted by the module itself (wasm_meter.ts), its memory's own
//  maximum, and a time limit after which the worker is ended. A step is a
//  pure function of its input: the object's input from its record, its
//  working state, the replies to what the previous step asked to fetch, and
//  the time. What it asks to fetch is fetched by the hub between steps,
//  never inside one, so a slow site holds up nothing but its own object.

import { Worker } from 'node:worker_threads';
import type { CheckedProgram } from './wasm_meter.ts';

export interface StepLimits {
    fuel: number; //       fuel per step
    ms: number; //         time per step, the backstop to fuel
    fetches: number; //    requests a step may make for the next
    urlBytes: number;
    valuesBytes: number;
    keepBytes: number;
    logBytes: number; //   each line
    logLines: number; //   lines a step may log
}

export const DefaultStepLimits: StepLimits = {
    fuel: 50_000_000,
    ms: 2000,
    fetches: 2,
    urlBytes: 2048,
    valuesBytes: 4096,
    keepBytes: 4096,
    logBytes: 200,
    logLines: 20,
};

export interface Reply {
    status: number; //  0 when the fetch failed or was refused
    body: string;
}

export interface StepInput {
    input: unknown; //   the object record's input
    state: unknown; //   what the last step kept, or null
    replies: Reply[]; // to what the last step asked for, in order
    time: string; //     the hub's time, ISO 8601
}

export interface StepJob {
    module: Uint8Array<ArrayBuffer>;
    input: StepInput;
    fuel: number;
    allowedHosts: string[];
    limits: StepLimits;
}

export type StepResult =
    | {
          ok: true;
          fuelUsed: number;
          fetches: string[]; //  for the next step
          values: Record<string, unknown> | null; //  null: not set this step
          keep: unknown; //  undefined: not set this step
          log: string[];
      }
    | {
          ok: false;
          reason: 'fuel' | 'time' | 'stack' | 'trap' | 'refused' | 'worker';
          message: string;
          fuelUsed: number;
          log: string[];
      };

const WorkerFile = new URL('./program_worker.ts', import.meta.url);

//  The sites a program may reach: those its manifest names that the place
//  running it also allows (compute spec §7)
export function allowedHosts(manifest: string[], place: string[]): string[] {
    const ours = new Set(place.map(h => h.toLowerCase()));
    return [...new Set(manifest.map(h => h.toLowerCase()))].filter(h => ours.has(h)).sort();
}

export function runStep(
    program: CheckedProgram,
    input: StepInput,
    options: { allowedHosts: string[]; limits?: StepLimits }
): Promise<StepResult> {
    const limits = options.limits ?? DefaultStepLimits;
    const job: StepJob = {
        module: program.metered,
        input,
        fuel: limits.fuel,
        allowedHosts: options.allowedHosts,
        limits,
    };
    return new Promise(resolve => {
        let done = false;
        const finish = (result: StepResult) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            void worker.terminate();
            resolve(result);
        };
        const worker = new Worker(WorkerFile, {
            workerData: job,
            env: {},
            //  none of the hub's own Node flags (an inspector, say)
            execArgv: [],
            stdout: true,
            stderr: true,
            resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
        });
        const timer = setTimeout(
            () =>
                finish({
                    ok: false,
                    reason: 'time',
                    message: `took longer than ${limits.ms} ms`,
                    fuelUsed: limits.fuel,
                    log: [],
                }),
            limits.ms
        );
        worker.once('message', (result: StepResult) => finish(result));
        worker.once('error', e =>
            finish({ ok: false, reason: 'worker', message: e.message, fuelUsed: 0, log: [] })
        );
        worker.once('exit', () =>
            finish({ ok: false, reason: 'worker', message: 'the worker ended', fuelUsed: 0, log: [] })
        );
    });
}
