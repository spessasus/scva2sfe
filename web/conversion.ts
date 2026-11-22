/**
 * The conversion, the same steps as the CLI (src/cli/main.ts): the zone jobs and the bake renders on a pool of Web
 * Workers, the solve cache in IndexedDB, then one bank file after another, each handed over as a Blob before the next
 * is written, so at most one bank's bytes are held at a time.
 *
 * It runs on the page's thread, with only the pool in workers: in Firefox the same code in a worker of its own (the
 * pool's workers nested in it) lost the whole worker tree without an error in 10 of 12 cold conversions, on the page
 * it finished every time. Assembling and writing a bank hold the page for some seconds each, so the stages are shown
 * before them.
 */
import { sha256Hex } from "../src/lib/cache.js";
import type { Conversion } from "../src/lib/convert.js";
import { convert, MAPS } from "../src/lib/convert.js";
import { BANK_CAP, extractMap, MAP_BANKS, writeBank } from "../src/lib/writer.js";
import { IdbCache } from "./idb-cache.js";
import type { ConversionMessage, ConvertRequest, OutputId } from "./messages.js";
import { WebPool } from "./pool.js";

declare const __BUILD_ID__: string;
declare const __STEM__: string;

/**
 * Lets the page draw the stage it was just told about before a step that holds the thread.
 */
const paint = () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

/**
 * The pool of the running conversion. A new conversion closes it first, so two pools never run side by side.
 */
let live: WebPool | undefined;

export async function runConversion(req: ConvertRequest, send: (m: ConversionMessage) => void) {
    try {
        await run(req, send);
    } catch (err) {
        send({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }
}

async function run(req: ConvertRequest, send: (m: ConversionMessage) => void) {
    const log = (line: string) => {
        send({ type: "log", line });
        // the zones came from the cache: the stages before them did not run
        if (line === "Zones from the solve cache") for (const id of ["maps", "waves", "zones"]) send({ type: "stage", id, state: "cached" });
    };
    send({ type: "stage", id: "read", state: "run" });
    const t0 = performance.now();
    const res = await fetch(new URL("./sbr.wasm", import.meta.url));
    if (!res.ok) throw new Error(`the bake renderer (sbr.wasm) did not load: HTTP ${res.status}`);
    const wasmBytes = new Uint8Array(await res.arrayBuffer());
    const wasm = await WebAssembly.compile(wasmBytes);
    // the build id carries the browser's version too: the fits' Math results come from its JavaScript engine. The
    // served renderer's hash goes in as well, in case a deploy pairs the page with another sbr.wasm
    const version = (await sha256Hex(`${__BUILD_ID__} ${await sha256Hex(wasmBytes)} ${navigator.userAgent}`)).slice(0, 16);
    const cache = req.cache ? new IdbCache(version) : undefined;
    const started = new Set<string>();
    const stageOf: Record<string, string> = { maps: "maps", waves: "waves", zones: "zones", bake: "bake" };
    // only what the writes need is kept from the conversion: its zone results go as soon as it returns
    let model: Pick<Conversion, "bank" | "audio" | "presetsFor"> | undefined;
    live?.close();
    live = undefined;
    const times = await (async () => {
        let pool: WebPool | undefined;
        try {
            const r = await convert(req.dll, { defaultMap: "sc55", log, wasm, drk: req.drk, cache, version }, (ctx) => {
                send({ type: "stage", id: "read", state: "done" });
                pool = live = new WebPool(ctx, req.workers);
                pool.progress = (kind, done, total) => {
                    const id = stageOf[kind];
                    if (done === 0) {
                        // the filter maps came from the cache when the waves start without them
                        if (id === "waves" && !started.has("maps")) send({ type: "stage", id: "maps", state: "cached" });
                        started.add(id);
                        send({ type: "stage", id, state: "run" });
                    }
                    send({ type: "progress", id, done, total });
                    if (done === total) {
                        send({ type: "stage", id, state: "done" });
                        if (id === "bake") {
                            // the renders are the pool's last work: its workers' memory goes before the bank is assembled
                            pool?.close();
                            send({ type: "stage", id: "assemble", state: "run" });
                        }
                    }
                };
                return pool;
            });
            model = { bank: r.bank, audio: r.audio, presetsFor: r.presetsFor };
            return r.times;
        } finally {
            // a failed stage leaves the other workers busy: they go with the conversion
            pool?.close();
            if (live === pool) live = undefined;
        }
    })();
    send({ type: "stage", id: "assemble", state: "done" });
    const save = async (suffix: string, data: ArrayBuffer) => {
        const name = `${__STEM__}${suffix}.sf4`;
        const sha256 = await sha256Hex(new Uint8Array(data));
        send({ type: "file", name, blob: new Blob([data], { type: "application/octet-stream" }), sha256, over: data.byteLength > BANK_CAP });
        send({ type: "stage", id: `write${suffix}`, state: "done" });
        log(`Wrote ${name}: ${data.byteLength} bytes`);
    };
    const wanted = new Set(req.outputs);
    let t = performance.now();
    send({ type: "stage", id: "write", state: "run" });
    await paint();
    // the main bank stays only while the map banks are still to be cut out of it
    // one creation date for every bank of this conversion
    const creationDate = new Date();
    let main: ArrayBuffer | undefined = writeBank(model!.bank, model!.audio, { log, creationDate });
    await save("", main);
    times.write = (performance.now() - t) / 1000;
    const maps = MAP_BANKS.filter((m) => wanted.has(`-${m.name}` as OutputId));
    if (!maps.length) main = undefined;
    // the full banks first: they need the bank model, which goes before the map banks load the main bank again
    const tags: Record<string, string> = { sc88: "-88-full", sc88pro: "-88pro-full", sc8820: "-8820-full" };
    const full = MAPS.filter((m) => tags[m] && wanted.has(tags[m] as OutputId));
    if (full.length) {
        t = performance.now();
        for (const map of full) {
            send({ type: "stage", id: `write${tags[map]}`, state: "run" });
            await paint();
            await save(tags[map], writeBank({ ...model!.bank, presets: model!.presetsFor(map) }, model!.audio, { log, creationDate }));
        }
        times.full = (performance.now() - t) / 1000;
    }
    model = undefined;
    if (main) {
        t = performance.now();
        for (const map of maps) {
            send({ type: "stage", id: `write-${map.name}`, state: "run" });
            await paint();
            await save(`-${map.name}`, extractMap(main, map, { log }));
        }
        times.maps = (performance.now() - t) / 1000;
        main = undefined;
    }
    times.total = (performance.now() - t0) / 1000;
    log(`Times (s): ${Object.entries(times).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(", ")}`);
    send({ type: "done", times });
}
