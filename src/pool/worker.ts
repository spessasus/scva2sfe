import { BakeRenderer } from "../bake-renderer/index.js";
import type { BakeJob } from "../lib/bake.js";
import { renderBake } from "../lib/bake.js";
import type { RunnerSetup } from "../lib/convert.js";
import { Directory } from "../lib/directory.js";
import { Dll } from "../lib/dll.js";
import { FilterMap } from "../lib/filter-map.js";
import { interpolationFir } from "../lib/samples.js";
import { TvfModel } from "../lib/tvf.js";
import type { Job } from "../lib/zones.js";
import { models, waveInfo, ZoneBuilder } from "../lib/zones.js";

/**
 * A message from the pool (pool.ts): setup, or a batch of one stage's jobs.
 */
export type PoolMessage = { kind: string; from: number; jobs: unknown[] } & Partial<RunnerSetup>;

/**
 * A pool worker's work, whatever thread it runs in: fits filter map rows and wave infos, builds the models once
 * (setup) and answers batches of zone jobs, and with the bake renderer's compiled module (shared by every worker)
 * batches of bake renders. The handler gives the reply and the buffers it can hand over.
 */
export async function poolWorker(bytes: Uint8Array, wasm?: WebAssembly.Module) {
    const dll = new Dll(bytes);
    const dir = new Directory(dll);
    let builder: ZoneBuilder | undefined;
    let infos: { tvf: TvfModel; interp: number[] } | undefined;
    const renderer = wasm ? await BakeRenderer.create(wasm, dll.bytes) : undefined;
    return (m: PoolMessage): [unknown, ArrayBuffer[]] => {
        if (m.kind === "setup") {
            builder = new ZoneBuilder(models(dll, dir, m.tables), m.waves);
            infos = undefined;
            return [{}, []];
        }
        if (m.kind === "maps") {
            const results = (m.jobs as [boolean, number, number][]).map(([signed, from, to]) => FilterMap.rows(signed, from, to));
            return [{ from: m.from, results }, results.map((r) => r.buffer)];
        }
        if (m.kind === "waves") {
            infos ??= { tvf: new TvfModel(dll, dir), interp: interpolationFir(dll) };
            const x = infos;
            return [{ from: m.from, results: (m.jobs as number[]).map((w) => waveInfo(dll, dir, x.tvf, x.interp, w)) }, []];
        }
        if (m.kind === "bake") {
            const results = (m.jobs as BakeJob[]).map((j) => renderBake(renderer!, j));
            return [{ from: m.from, results }, results.filter((r) => r).map((r) => r!.data.buffer as ArrayBuffer)];
        }
        return [{ from: m.from, results: (m.jobs as Job[]).map((j) => builder!.run(j)) }, []];
    };
}
