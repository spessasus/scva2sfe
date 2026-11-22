import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { convert, MAPS } from "../lib/convert.js";
import { Dll } from "../lib/dll.js";
import { BANK_CAP, extractMap, MAP_BANKS, writeBank, writeVorbisBank } from "../lib/writer.js";
import { buildId, defaultCacheDir, FolderCache } from "./cache.js";
import { WorkerPool } from "./pool.js";
import { encodeVorbis } from "./vorbis.js";

/**
 * scva2sfe <SCCore.dll> [--out dir] [--maps] [--full-maps] [--vorbis] [--jobs n] [--cache-dir dir] [--no-cache]
 * Writes scva-<ver>.sf4 into the out folder (default out), every map on its bank LSB and SC-55 on LSB 0. With --maps
 * also the per map banks scva-<ver>-55 / 88 / 88pro / 8820.sf4, with --full-maps the full bank with each other map on
 * LSB 0 (scva-<ver>-88-full.sf4, -88pro-full, -8820-full, from the same conversion), with --vorbis
 * scva-<ver>-vorbis.sf4 (ffmpeg). <ver> is the converter's major version (package.json 7.x.y gives v7). The solve
 * cache (the zones of this DLL and this converter build) sits in the user's cache folder unless --no-cache. --jobs
 * defaults to one worker per core, at most 16 and one per GB of memory: each worker holds its own copy of the DLL and
 * the bake renderer's memory, and the zone fits need room on top.
 */
const USAGE = "usage: scva2sfe <SCCore.dll> [--out dir] [--maps] [--full-maps] [--vorbis] [--jobs n] [--cache-dir dir] [--no-cache]";
const fail = (why: string) => {
    console.error(`${why}\n${USAGE}`);
    process.exit(2);
};
const args = process.argv.slice(2);
const flag = (name: string) => {
    const i = args.indexOf(name);
    if (i < 0) return false;
    args.splice(i, 1);
    return true;
};
const option = (name: string) => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const v = args[i + 1];
    if (v === undefined || v.startsWith("--")) fail(`${name} needs a value`);
    args.splice(i, 2);
    return v;
};
const outDir = option("--out") ?? "out";
const jobsArg = option("--jobs");
const jobs = jobsArg === undefined ? Math.max(1, Math.min(os.availableParallelism(), 16, Math.floor(os.totalmem() / 2 ** 30))) : Number(jobsArg);
if (!Number.isInteger(jobs) || jobs < 1) fail(`--jobs takes a whole number of 1 or more, not ${jobsArg}`);
const vorbis = flag("--vorbis");
const perMap = flag("--maps");
const fullMaps = flag("--full-maps");
const noCache = flag("--no-cache");
const cacheDir = option("--cache-dir") ?? defaultCacheDir();
const unknown = args.find((a) => a.startsWith("-"));
if (unknown) fail(`unknown option ${unknown}`);
const epoch = process.env.SOURCE_DATE_EPOCH?.trim();
const epochDate = epoch ? new Date(Number(epoch) * 1000) : undefined;
if (epoch && (!/^\d+$/.test(epoch) || Number.isNaN(epochDate!.getTime()))) fail(`SOURCE_DATE_EPOCH takes whole seconds since 1970, not ${epoch}`);
if (args.length !== 1) fail(args.length ? `one DLL only, got ${args.join(" ")}` : "no SCCore.dll given");
const [dllPath] = args;
const log = (line: string) => console.log(line);
// every bank file carries the converter's version: scva-v7.sf4, scva-v7-55.sf4, scva-v7-vorbis.sf4
const pkg = JSON.parse(fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
const stem = `scva-v${pkg.version.split(".")[0]}`;
const raw = (() => {
    try {
        return fs.readFileSync(dllPath);
    } catch (e) {
        console.error(`Cannot read ${dllPath}: ${e instanceof Error ? e.message : String(e)}`);
        return process.exit(2);
    }
})();
// the build check up front, so a wrong file stops here with one line and not after the workers started
const dllBytes = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
try {
    await Dll.open(dllBytes);
} catch (e) {
    console.error(`${dllPath}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
}
// the Vorbis bank needs ffmpeg with libvorbis: find out now, not after the zones
if (vorbis) {
    const ff = spawnSync("ffmpeg", ["-hide_banner", "-encoders"], { stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" });
    if (ff.error || ff.status !== 0 || !/libvorbis/.test(ff.stdout)) {
        console.error(ff.error || ff.status !== 0 ? "--vorbis needs ffmpeg on PATH, it was not found" : "--vorbis needs ffmpeg with libvorbis, this ffmpeg has no libvorbis encoder");
        process.exit(2);
    }
}
let pool: WorkerPool | undefined;
const t0 = performance.now();
// the bake renderer ships next to the compiled converter (dist/sbr.wasm), from the sources it is build:wasm's output
const shipped = new URL("../sbr.wasm", import.meta.url);
const wasmPath = fs.existsSync(shipped) ? shipped : new URL("../../build/bake-renderer/sbr.wasm", import.meta.url);
if (!fs.existsSync(wasmPath)) {
    console.error("The bake renderer (sbr.wasm) is missing: build it with npm run build:wasm (Emscripten 6.0.13), then npm run build:dist");
    process.exit(1);
}
const wasm = new Uint8Array(fs.readFileSync(wasmPath));
// the drum key name lists, when they sit next to the DLL
const drk = ["SCVSC.drk", "GM2.drk"].map((n) => path.join(path.dirname(dllPath), n)).filter((f) => fs.existsSync(f)).map((f) => new Uint8Array(fs.readFileSync(f)));
// the build id carries the JavaScript engine's version too: the fits' Math results come from it
const version = buildId(wasmPath, process.versions.v8);
const cache = noCache ? undefined : new FolderCache(cacheDir, version);
const result = await convert(dllBytes, { defaultMap: "sc55", log, wasm, drk, cache, version }, (ctx) => {
    pool = new WorkerPool(ctx, jobs);
    return pool;
});
await pool?.close();
const times = result.times;
fs.mkdirSync(outDir, { recursive: true });
let t = performance.now();
// every file is written, one past the size cap fails the run at the end
let over = 0;
const save = (name: string, data: ArrayBuffer) => {
    const file = path.join(outDir, name);
    fs.writeFileSync(file, new Uint8Array(data));
    log(`Wrote ${file}: ${data.byteLength} bytes`);
    if (data.byteLength > BANK_CAP) {
        console.error(`${file} is ${data.byteLength} bytes, over the cap of ${BANK_CAP}`);
        over++;
    }
};
// one creation date for every bank of this conversion: now, or SOURCE_DATE_EPOCH (seconds) for a build that has to
// write the same bytes again
const creationDate = epochDate ?? new Date();
const bank = writeBank(result.bank, result.audio, { log, creationDate });
save(`${stem}.sf4`, bank);
times.write = (performance.now() - t) / 1000;
if (perMap) {
    t = performance.now();
    for (const map of MAP_BANKS) save(`${stem}-${map.name}.sf4`, extractMap(bank, map, { log }));
    times.maps = (performance.now() - t) / 1000;
}
if (fullMaps) {
    // only the presets differ from the main bank (SC-55 on LSB 0)
    t = performance.now();
    const tags: Record<string, string> = { sc88: "88", sc88pro: "88pro", sc8820: "8820" };
    for (const map of MAPS) {
        if (map === "sc55") continue;
        save(`${stem}-${tags[map]}-full.sf4`, writeBank({ ...result.bank, presets: result.presetsFor(map) }, result.audio, { log, creationDate }));
    }
    times.full = (performance.now() - t) / 1000;
}
if (vorbis) {
    t = performance.now();
    save(`${stem}-vorbis.sf4`, await writeVorbisBank(bank, encodeVorbis, jobs, { log }));
    times.vorbis = (performance.now() - t) / 1000;
}
times.total = (performance.now() - t0) / 1000;
log(`Times (s): ${Object.entries(times).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(", ")}`);
if (over) process.exitCode = 1;
