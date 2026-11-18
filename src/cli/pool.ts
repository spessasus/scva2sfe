import { Worker } from "node:worker_threads";
import type { RunnerContext } from "../lib/convert.js";
import { Pool } from "../pool/pool.js";

/**
 * The pool (src/pool/pool.ts) on Node worker threads, each holding its own copy of the DLL's bytes and the bake
 * renderer's compiled module.
 */
export class WorkerPool extends Pool {
    private readonly workers = new Array<Worker>();

    public constructor(ctx: RunnerContext, count: number) {
        super(ctx, count);
        // compiled (dist) the worker sits next to this module, run from the sources (tsx) its entry registers tsx
        const url = new URL(import.meta.url.endsWith(".ts") ? "../../bin/worker-dev.mjs" : "./worker.js", import.meta.url);
        for (let i = 0; i < count; i++) {
            const w = new Worker(url, { workerData: { dll: ctx.dll.bytes, wasm: ctx.wasm } });
            w.on("message", (m) => this.received(i, m));
            w.on("error", (e) => this.failed(e));
            this.workers.push(w);
        }
    }

    protected post(worker: number, message: unknown) {
        this.workers[worker].postMessage(message);
    }

    public async close() {
        await Promise.all(this.workers.map((w) => w.terminate()));
    }
}
