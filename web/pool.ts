import type { BakeJob } from "../src/lib/bake.js";
import type { RunnerContext, RunnerSetup } from "../src/lib/convert.js";
import { Pool } from "../src/pool/pool.js";

/**
 * How long the pool waits for any reply while work is out before it gives up. A batch takes seconds, a slow device
 * with one worker maybe a minute, so this only catches a worker the browser lost without telling.
 */
const WATCHDOG_MS = 10 * 60 * 1000;

/**
 * The pool (src/pool/pool.ts) on Web Workers: every worker gets a copy of the DLL's bytes and the one compiled bake
 * renderer module, and opens its own renderer.
 */
export class WebPool extends Pool {
    private readonly workers = new Array<Worker>();
    private readonly ctx;
    private fitted = false;
    // messages sent that have not been answered yet, and the timer that runs while there are any
    private waiting = 0;
    private watchdog?: ReturnType<typeof setTimeout>;

    public constructor(ctx: RunnerContext, count: number) {
        super(ctx, count);
        this.ctx = ctx;
        this.spawn();
    }

    private spawn() {
        for (let i = 0; i < this.count; i++) {
            const w = new Worker(new URL("./zone-worker.js", import.meta.url), { type: "module", name: `zones ${i + 1}` });
            w.onmessage = (e) => {
                this.waiting = Math.max(0, this.waiting - 1);
                this.arm();
                this.received(i, e.data);
            };
            // a reply the browser could not read would otherwise leave its batch waiting for good
            w.onmessageerror = () => this.failed(new Error(`a reply from worker ${i + 1} could not be read`));
            w.onerror = (e) => {
                e.preventDefault();
                this.failed(new Error(e.message || "a worker stopped"));
            };
            w.postMessage({ kind: "init", dll: this.ctx.dll.bytes, wasm: this.ctx.wasm });
            this.workers.push(w);
        }
    }

    protected post(worker: number, message: unknown) {
        this.waiting++;
        this.arm();
        this.workers[worker].postMessage(message);
    }

    /**
     * Restarts the watchdog while replies are due, stops it when none are.
     */
    private arm() {
        clearTimeout(this.watchdog);
        this.watchdog = undefined;
        if (this.waiting > 0)
            this.watchdog = setTimeout(() => this.failed(new Error(`no worker answered for ${WATCHDOG_MS / 60000} minutes. The browser may have stopped a worker (often for lack of memory), try again with fewer workers`)), WATCHDOG_MS);
    }

    /**
     * The renders on fresh workers: after the zone fits a worker holds their models and memos, which the renders do
     * not need, so the renderers' memory does not come on top of them.
     */
    public override bake(jobs: BakeJob[]) {
        if (this.fitted) {
            this.close();
            this.spawn();
        }
        return super.bake(jobs);
    }

    public override setup(s: RunnerSetup) {
        this.fitted = true;
        return super.setup(s);
    }

    public close() {
        for (const w of this.workers) w.terminate();
        this.workers.length = 0;
        this.waiting = 0;
        this.arm();
    }
}
