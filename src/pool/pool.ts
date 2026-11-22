import type { RunnerContext, RunnerSetup, ZoneRunner } from "../lib/convert.js";
import type { BakeJob, BakeRender } from "../lib/bake.js";
import { FilterMap } from "../lib/filter-map.js";
import type { Job, JobResult, WaveInfo } from "../lib/zones.js";

/**
 * A batch of jobs one worker answers in one go: the jobs' indices and the weight it is handed out by.
 */
interface Batch {
    idx: number[];
    weight: number;
}

/**
 * What a worker sends back: a batch's results, an empty answer to setup, or the error that stopped it.
 */
interface Reply {
    from?: number;
    results?: unknown[];
    error?: string;
}

/**
 * Zone jobs on workers, whatever the host's workers are (Node worker threads in the CLI, Web Workers on the page):
 * the workers fit the filter maps' rows and the wave infos between them, then each builds its models once from the
 * DLL's bytes, the tables and the infos (setup) and takes batches as it gets free, the heaviest first, so no long
 * tone is left for the end. Kit keys that play the same drum the same way go to one worker in one batch: its
 * projections memo answers the repeats. The results land at their job's index, so the merge order does not depend on
 * timing or on the number of workers. A host only sends messages and passes back what its workers answer.
 */
export abstract class Pool implements ZoneRunner {
    /**
     * Called as a stage's jobs come back (maps, waves, zones, bake).
     */
    public progress?: (kind: string, done: number, total: number) => void;
    protected readonly count;
    private readonly dir;
    private readonly listeners = new Array<((m: Reply) => void) | undefined>();
    private reject?: (e: unknown) => void;
    // set once a stage has failed: no batch goes out after that, late replies are dropped
    private stopped = false;

    protected constructor(ctx: RunnerContext, count: number) {
        this.dir = ctx.dir;
        this.count = count;
    }

    /**
     * Sends a message to one worker.
     */
    protected abstract post(worker: number, message: unknown): void;

    /**
     * A worker's answer, from the host.
     */
    protected received(worker: number, message: Reply) {
        if (message.error !== undefined) this.failed(new Error(message.error));
        else this.listeners[worker]?.(message);
    }

    /**
     * A worker that stopped, from the host: the running stage fails.
     */
    protected failed(e: unknown) {
        this.stopped = true;
        this.reject?.(e);
    }

    public async filterMaps() {
        // a few rows per task, both maps in one list
        const ROWS = 5;
        const tasks = new Array<[boolean, number, number]>();
        for (const signed of [false, true]) for (let i = 0; i < FilterMap.NF; i += ROWS) tasks.push([signed, i, Math.min(FilterMap.NF, i + ROWS)]);
        const parts = await this.spread<[boolean, number, number], Float64Array>("maps", tasks, tasks.map((_, i) => ({ idx: [i], weight: 1 })));
        const size = FilterMap.NQ * 4;
        const out = { plain: new Float64Array(FilterMap.NF * size), signed: new Float64Array(FilterMap.NF * size) };
        tasks.forEach(([signed, from], i) => (signed ? out.signed : out.plain).set(parts[i], from * size));
        return out;
    }

    public waves(list: number[]) {
        // batches of waves, each worker's results in list order
        const SIZE = 16;
        const batches = new Array<Batch>();
        for (let i = 0; i < list.length; i += SIZE) batches.push({ idx: list.slice(i, i + SIZE).map((_, j) => i + j), weight: 1 });
        return this.spread<number, WaveInfo | undefined>("waves", list, batches);
    }

    public setup(s: RunnerSetup) {
        let left = this.count;
        return new Promise<void>((resolve, reject) => {
            this.reject = reject;
            if (this.stopped) reject(new Error("the pool has stopped"));
            for (let w = 0; w < this.count && !this.stopped; w++) {
                this.listeners[w] = () => {
                    this.listeners[w] = undefined;
                    if (--left === 0) resolve();
                };
                this.post(w, { kind: "setup", tables: s.tables, waves: s.waves });
            }
        });
    }

    public run(jobs: Job[]) {
        const dir = this.dir;
        const batches = new Array<Batch>();
        const drums = new Map<string, Batch>();
        // a tone's weight: its partials' key zones (each runs the three projections and their checks), a drum's one
        // zone per partial counts once for the group
        const zonesOf = (tone: number) => {
            let n = 0;
            for (let slot = 0; slot < dir.partialCount(tone); slot++) {
                const b = dir.partial(tone, slot);
                if (!b) continue;
                let last: string | undefined;
                for (let k = 0; k < 128; k++) {
                    const z = dir.selectWave(b, k);
                    const id = z ? `${z.wave}:${z.zone}` : undefined;
                    if (id !== undefined && id !== last) n++;
                    last = id;
                }
            }
            return n;
        };
        jobs.forEach((job, i) => {
            if (job.kind === "tone") {
                batches.push({ idx: [i], weight: 4 * zonesOf(job.tone) });
                return;
            }
            const key = dir.kit(job.kit).keys[job.note];
            const sig = `${key.tone}:${key.pitch}:${key.noteOff ? 1 : 0}`;
            const b = drums.get(sig);
            if (b) {
                b.idx.push(i);
                b.weight += 0.1;
            } else {
                const nb = { idx: [i], weight: 1 };
                drums.set(sig, nb);
                batches.push(nb);
            }
        });
        // heaviest first, ties in job order
        const order = batches.map((b, i) => i).sort((a, b) => batches[b].weight - batches[a].weight || a - b).map((i) => batches[i]);
        return this.spread<Job, JobResult>("zones", jobs, order);
    }

    public bake(jobs: BakeJob[]) {
        return this.spread<BakeJob, BakeRender | undefined>("bake", jobs, jobs.map((_, i) => ({ idx: [i], weight: 1 })));
    }

    private spread<J, R>(kind: string, jobs: J[], batches: Batch[]) {
        const results = new Array<R>(jobs.length);
        let next = 0;
        let done = 0;
        return new Promise<R[]>((resolve, reject) => {
            this.reject = reject;
            if (this.stopped) reject(new Error("the pool has stopped"));
            const feed = (w: number) => {
                if (this.stopped || next >= batches.length) return;
                const from = next++;
                this.post(w, { kind, from, jobs: batches[from].idx.map((i) => jobs[i]) });
            };
            this.progress?.(kind, 0, jobs.length);
            if (!jobs.length) resolve(results);
            for (let w = 0; w < this.count; w++) {
                this.listeners[w] = (m) => {
                    if (this.stopped) return;
                    const idx = batches[m.from!].idx;
                    m.results!.forEach((r, i) => (results[idx[i]] = r as R));
                    done += m.results!.length;
                    this.progress?.(kind, done, jobs.length);
                    if (done === jobs.length) resolve(results);
                    else feed(w);
                };
                feed(w);
            }
        });
    }
}
