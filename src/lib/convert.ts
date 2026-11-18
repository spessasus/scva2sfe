/**
 * The converter: SCCore.dll's bytes in, the bank model out. The zones come from jobs
 * (zones.ts) that a runner spreads over workers, everything else is assembled here in a fixed order, so the result
 * does not depend on the number of workers.
 */
import type { Bank, BankPresetZone, BankSample, BankZone } from "./bank.js";
import { pow } from "./math.js";
import { Directory, DRUM_ROWS, GM2_DRUM_ROW, MAP_NAMES } from "./directory.js";
import { Dll, DLL_SHA256 } from "./dll.js";
import { FilterMap } from "./filter-map.js";
import { ALTERNATE_KEEP } from "../rules/alternate-keep.js";
import { timecents } from "./envfit.js";
import { interpolationFir, ownGain, SAMPLE_GAIN, SampleTable, svfFir } from "./samples.js";
import type { Job, JobResult, PackedModulator, PackedZone, WaveInfo } from "./zones.js";
import { CORE_GAIN_FACTOR, models, wavesOf, ZoneBuilder } from "./zones.js";
import type { SolveCache } from "./cache.js";
import { cacheGet, cachePut, sha256Hex } from "./cache.js";
import { wheelCents } from "./lfo.js";
import type { BakeJob, BakeRender } from "./bake.js";
import { bakeQuery, renderBake } from "./bake.js";
import type { BakeEntry } from "../rules/bake-plan.js";
import { BAKE_PLAN } from "../rules/bake-plan.js";
import { BakeRenderer } from "../bake-renderer/index.js";
import { Baker } from "./baker.js";
import { readDrk } from "./names.js";
import { INSTANT } from "./zone-tva.js";

export const MAPS = ["sc55", "sc88", "sc88pro", "sc8820"] as const;
export type MapName = (typeof MAPS)[number];
const MAP_NUMBER: Record<MapName, number> = { sc55: 1, sc88: 2, sc88pro: 3, sc8820: 4 };
const MAP_TAGS: Record<MapName, string> = { sc55: "55", sc88: "88", sc88pro: "pro", sc8820: "8820" };
/**
 * Maps whose drum keys are single assign (CLAUDE.md decision: a key without a mute group cuts its previous note).
 */
const SINGLE_ASSIGN: ReadonlySet<string> = new Set(["sc55"]);
const GM2_MSB = 120;
/**
 * Core fades every new voice in over its first 128 output samples.
 */
const RAMP = 128;

export interface ConvertOptions {
    /**
     * The map bank LSB 0 answers with (sc55 by default).
     */
    defaultMap?: MapName;
    /**
     * Also the GM2 drum kits on MSB 120 (default true).
     */
    gm2?: boolean;
    log?: (line: string) => void;
    /**
     * The bake renderer (sbr.wasm's bytes or its compiled module). Without it the bank has no bakes.
     */
    wasm?: ArrayBuffer | Uint8Array | WebAssembly.Module;
    /**
     * SC-VA's drum key name lists (SCVSC.drk, GM2.drk), optional: without them a key is named after its tone.
     */
    drk?: Uint8Array[];
    /**
     * The bake plan (default: the generated decision list in src/rules). A caller can pass another plan, to try candidates.
     */
    bakePlan?: readonly BakeEntry[];
    /**
     * The solve cache (cache.ts) and the converter's build id its keys carry: without both nothing is cached. The
     * host makes the id from the converter's code and the runtime's version (the CLI: src/cli/cache.ts buildId).
     */
    cache?: SolveCache;
    version?: string;
}

/**
 * The filter maps' tables.
 */
export interface FilterTables {
    plain: Float64Array;
    signed: Float64Array;
}

/**
 * What the zone jobs need besides the DLL: the filter maps' tables and the wave infos computed up front.
 */
export interface RunnerSetup {
    tables: FilterTables;
    waves?: Map<number, WaveInfo | undefined>;
}

/**
 * Runs zone jobs, in the main thread or in workers. Results come back in job order. A runner with setup gets the
 * tables (and the wave infos) before its first run: filterMaps and waves let it compute those itself (the pool
 * spreads them), else the main thread does. A runner without setup looks after itself (one that answers from its own cache).
 */
export interface ZoneRunner {
    filterMaps?(): Promise<FilterTables>;
    waves?(waves: number[]): Promise<(WaveInfo | undefined)[]>;
    setup?(s: RunnerSetup): Promise<void>;
    run(jobs: Job[]): Promise<JobResult[]>;
    /**
     * Bake renders (the WASM bake renderer), in job order.
     */
    bake?(jobs: BakeJob[]): Promise<(BakeRender | undefined)[]>;
}

export interface Conversion {
    bank: Bank;
    /**
     * The audio files the bank's samples point into (bank sample "file", samples.f32 by default).
     */
    audio: Record<string, Float32Array>;
    /**
     * Instrument indices by tone and slot, and by kit key (the bake step and the checks find zones by these).
     */
    toneInstruments: Map<string, number>;
    keyInstruments: Map<string, number>;
    /**
     * The presets with another map on bank LSB 0 (and the fallbacks that follow from it): the rest of the bank stays,
     * so one conversion writes every full bank.
     */
    presetsFor: (map: MapName) => Bank["presets"];
}

interface MapPresets {
    map: number | undefined;
    presets: { bank: number; program: number; tone: number }[];
    kits: { program: number; kit: number }[];
}

/**
 * Every map's presets and kits: the native (unresolved) tone of every bank and program, the kit of every
 * drum program.
 */
export function mapPresets(dir: Directory, gm2: boolean) {
    const out = new Map<string, MapPresets>();
    for (const name of MAPS) {
        const m = MAP_NUMBER[name];
        const presets = new Array<{ bank: number; program: number; tone: number }>();
        for (let bank = 0; bank < 128; bank++) {
            for (let program = 0; program < 128; program++) {
                const tone = dir.programTone(program, m, bank, false);
                if (tone >= 0) presets.push({ bank, program, tone });
            }
        }
        const kits = new Array<{ program: number; kit: number }>();
        for (let program = 0; program < 128; program++) {
            const kit = dir.kitForProgram(program, DRUM_ROWS[m]);
            if (kit !== undefined) kits.push({ program, kit });
        }
        out.set(name, { map: m, presets, kits });
    }
    if (gm2) {
        const kits = new Array<{ program: number; kit: number }>();
        for (let program = 0; program < 128; program++) {
            const kit = dir.kitForProgram(program, GM2_DRUM_ROW);
            if (kit !== undefined) kits.push({ program, kit });
        }
        out.set("gm2", { map: undefined, presets: [], kits });
    }
    return out;
}

/**
 * The jobs of a conversion: every melodic tone a map reaches, every sounding key of every kit (twice for a kit a
 * single assign map uses).
 */
export function jobsOf(dir: Directory, maps: Map<string, MapPresets>) {
    const tones = new Set<number>();
    const kitUses = new Set<string>();
    for (const [name, m] of maps) {
        for (const p of m.presets) tones.add(p.tone);
        for (const k of m.kits) kitUses.add(`${k.kit}:${SINGLE_ASSIGN.has(name) ? 1 : 0}`);
    }
    const jobs = new Array<Job>();
    for (const tone of [...tones].sort((a, b) => a - b)) jobs.push({ kind: "tone", tone });
    const uses = [...kitUses].map((s) => s.split(":").map(Number)).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    for (const [kit, single] of uses) {
        const k = dir.kit(kit);
        k.keys.forEach((key, note) => {
            if (key.sounding) jobs.push({ kind: "key", kit, note, single: single === 1 });
        });
    }
    return jobs;
}

/**
 * The bank from the jobs' results: samples, instruments, levels, onset padding, alternating loops, presets per map,
 * fallbacks, shared curves and the modulator table.
 */
export function assemble(dll: Dll, dir: Directory, maps: Map<string, MapPresets>, results: JobResult[], options: ConvertOptions = {},
                         bakes?: Map<number, BakeRender | undefined>): Conversion {
    const log = options.log ?? (() => undefined);
    const defaultMap = options.defaultMap ?? "sc55";
    const table = new SampleTable(dll, dir);
    for (const w of [...new Set(results.flatMap((r) => r.waves))].sort((a, b) => a - b)) table.of(w);
    const samples = table.samples;
    const interp = interpolationFir(dll);
    // the samples' own gains from the workers (any wave of a sample gives the same), else computed here
    const known = new Map<number, number | undefined>();
    for (const r of results) {
        r.gains?.forEach((g, i) => {
            const k = table.ofWave.get(r.waves[i]);
            if (k !== undefined && !known.has(k)) known.set(k, g);
        });
    }
    for (let k = 0; k < samples.length; k++) {
        const g = known.has(k) ? known.get(k) : ownGain(table.data(k), interp);
        if (g !== undefined) samples[k].gain = g;
    }
    // filter copies, one per distinct filter of a sample
    const copies = new Map<string, number>();
    const copyOf = (k: number, z: PackedZone) => {
        const c = z.copy!;
        const key = JSON.stringify([k, c.tap, c.f.toFixed(4), c.q.toFixed(4), c.ratio.toFixed(4)]);
        let n = copies.get(key);
        if (n === undefined) {
            n = samples.length;
            // the first zone's FIR and gain, from its worker when it has them
            const fir = c.fir ?? svfFir(Math.round(c.f * 1e4) / 1e4, c.q, c.tap, Math.round(c.ratio * 1e4) / 1e4);
            const copy: BankSample = { ...samples[k], name: `${samples[k].name} ${c.tap}`, fir };
            delete copy.gain;
            const g = c.fir ? c.gain : ownGain(table.data(k), interp, fir);
            if (g !== undefined) copy.gain = g;
            samples.push(copy);
            copies.set(key, n);
        }
        return n;
    };
    // every distinct modulator once (exact), zones refer to it by index
    const shapes = new ShapeIndex();
    const modTable = new Map<string, number>();
    const packedMods = new Array<PackedModulator>();
    const globalOf = (m: PackedModulator) => {
        const { ys, ...rest } = m;
        const key = JSON.stringify(rest) + (ys ? `#${shapes.id(ys)}` : "");
        let n = modTable.get(key);
        if (n === undefined) {
            n = packedMods.length;
            packedMods.push(m);
            modTable.set(key, n);
        }
        return n;
    };
    const names = options.drk?.length ? readDrk(options.drk) : undefined;
    const kitPage = kitPages(maps);
    const baker = new Baker(dll, dir, samples, packedMods, bakes ?? new Map(), options.bakePlan ?? BAKE_PLAN);
    const instruments = new Array<{ name: string; zones: (BankZone & { peak: number; mods: number[] })[] }>();
    const toneInstruments = new Map<string, number>();
    const keyInstruments = new Map<string, number>();
    // instruments of one tone or one kit key start together (the onset padding goes to all of them)
    const groupOf = new Array<string>();
    for (const r of results) {
        const g = r.mods.map(globalOf);
        r.instruments.forEach((instIn, n) => {
            let inst = instIn;
            let zones = inst.zones.map((z) => {
                const k = table.ofWave.get(z.wave)!;
                return { sample: z.copy ? copyOf(k, z) : k, key_lo: z.key_lo, key_hi: z.key_hi, vel_lo: z.vel_lo, vel_hi: z.vel_hi, gens: z.gens, peak: z.peak, mods: z.mods.map((i) => g[i]), src: z };
            });
            if (bakes) zones = baker.apply(r.job, zones);
            if (r.job.kind === "key" && names) {
                // the key's name on the first map that uses the kit record
                const page = kitPage.get(r.job.kit);
                const name = page && names.get(page[0])?.get(page[1])?.get(r.job.note);
                if (name) inst = { ...inst, name: `${name} ${r.job.note}` };
            }
            if (r.job.kind === "tone") {
                toneInstruments.set(`${r.job.tone}:${inst.zones[0].slot}`, instruments.length);
                groupOf.push(`tone:${r.job.tone}`);
            } else {
                keyInstruments.set(`${r.job.kit}:${r.job.note}:${r.job.single ? 1 : 0}`, instruments.length);
                groupOf.push(`key:${instruments.length - n}`);
            }
            instruments.push({ name: inst.name, zones });
        });
    }
    // levels: the zone peaks on core's scale (the engine's level chain over core's)
    const coreLevelDb = -20 * Math.log10(SAMPLE_GAIN * CORE_GAIN_FACTOR);
    for (const inst of instruments) {
        for (const z of inst.zones) {
            const s = samples[z.sample];
            const peak = z.peak * (s.gain !== undefined ? SAMPLE_GAIN / s.gain : 1);
            const att = (-20 * Math.log10(Math.max(peak, 1e-7)) - coreLevelDb) * 10;
            // SFe stores initialAttenuation in true centibels, gain takes what its range leaves (a boost)
            const gen = Math.max(0, Math.min(1440, Math.round(att)));
            if (gen) z.gens.initialAttenuation = gen;
            else delete z.gens.initialAttenuation;
            const rest = Math.round(att - gen);
            if (rest) z.gens.gain = Math.max(-1440, Math.min(1440, -rest));
        }
    }
    padOnsets(samples, (k) => (samples[k].baked ? baker.data(k) : table.dataAt(samples[k].offset)), instruments, groupOf);
    alternateLoops(samples, instruments);
    const presets = presetsOf(dir, maps, defaultMap, toneInstruments, keyInstruments);
    log(`${instruments.length} instruments, ${instruments.reduce((s, i) => s + i.zones.length, 0)} zones, ${presets.length} presets, ${samples.length} samples`);
    const before = new Set(packedMods.filter((m) => m.ys).map((m) => shapes.id(m.ys!))).size;
    // the keys and velocities each modulator plays at (the union over its zones)
    const domain = packedMods.map(() => [127, 0, 127, 0]);
    for (const inst of instruments) {
        for (const z of inst.zones) {
            for (const i of z.mods) {
                const d = domain[i];
                d[0] = Math.min(d[0], z.key_lo);
                d[1] = Math.max(d[1], z.key_hi);
                d[2] = Math.min(d[2], z.vel_lo);
                d[3] = Math.max(d[3], z.vel_hi);
            }
        }
    }
    const shared = shareCurves(packedMods, domain);
    // shared curves can make modulators equal: renumber
    const final = new Map<string, number>();
    const finalMods = new Array<PackedModulator>();
    const remap = shared.map((m) => {
        if (!m) return -1;
        const { ys, ...rest } = m;
        const key = JSON.stringify(rest) + (ys ? `#${shapes.id(ys)}` : "");
        let n = final.get(key);
        if (n === undefined) {
            n = finalMods.length;
            finalMods.push(m);
            final.set(key, n);
        }
        return n;
    });
    for (const inst of instruments) for (const z of inst.zones) z.mods = [...new Set(z.mods.filter((i) => shared[i]).map((i) => remap[i]))];
    // each curve with as few points as its users' tolerances allow (core interpolates linearly between them)
    const epsOf = new Map<Uint16Array, number>();
    for (const m of finalMods) {
        if (!m.ys) continue;
        const e = (curveTolerance(m.dest) * 8192) / Math.max(Math.abs(m.amount), 1);
        epsOf.set(m.ys, Math.min(epsOf.get(m.ys) ?? Infinity, e));
    }
    const pointsOf = new Map<Uint16Array, [number, number][]>();
    for (const [ys, e] of epsOf) pointsOf.set(ys, simplify(ys, Math.max(e * 0.5, 0.5)));
    const modulators = finalMods.map((m) => {
        const { ys, ...rest } = m;
        return ys ? { ...rest, points: pointsOf.get(ys)! } : rest;
    });
    const curves = new Set(finalMods.filter((m) => m.ys).map((m) => shapes.id(m.ys!))).size;
    log(`${modulators.length} modulators, custom curves ${before} shared down to ${curves}`);
    const bankInstruments = instruments.map((inst) => ({
        name: inst.name,
        zones: inst.zones.map((z) => {
            const out: BankZone = { sample: z.sample, key_lo: z.key_lo, key_hi: z.key_hi, vel_lo: z.vel_lo, vel_hi: z.vel_hi, gens: z.gens };
            if (z.mods.length) out.mods = z.mods;
            return out;
        })
    }));
    const bank: Bank = {
        name: "SOUND Canvas VA", sample_rate: 32000, sample_gain: SAMPLE_GAIN, sample_fir: interp, wheel_cents: wheelCents(),
        samples, modulators, instruments: bankInstruments, presets
    };
    const audio: Record<string, Float32Array> = { "samples.f32": table.audio() };
    if (baker.count) audio["bake.f32"] = baker.audio();
    log(`Baked: ${baker.stats.zones} zones from ${baker.count} renders (${baker.stats.none} entries without a render), ${((2 * baker.audioLength) / 1e6).toFixed(1)} MB of 16 bit audio`);
    const presetsFor = (map: MapName) => (map === defaultMap ? presets : presetsOf(dir, maps, map, toneInstruments, keyInstruments));
    return { bank, audio, toneInstruments, keyInstruments, presetsFor };
}

/**
 * Core's fade in over its first 128 output samples takes most of a click: where a zone's sample would lose more than
 * half a dB of its loudest 20 ms to it, the sample gets leading silence for the fade to run over and every zone of
 * it skips what it does not need. The zones of one tone or kit key are padded together.
 */
function padOnsets(samples: BankSample[], dataOf: (k: number) => Float32Array, instruments: { zones: (BankZone & { peak: number })[] }[], groupOf: string[]) {
    const loss = (k: number, n: number) => {
        const s = samples[k];
        const w = Math.max(8, Math.trunc((640 * n) / RAMP));
        const src = dataOf(k);
        const x = Float64Array.from(src.subarray(0, 40 * w));
        if (x.length < 2) return 0;
        const ramped = x.slice();
        for (let i = 0; i < Math.min(n, x.length); i++) ramped[i] *= i / n;
        const peak = (y: Float64Array) => {
            const m = Math.min(w, y.length);
            let acc = 0;
            for (let i = 0; i < m; i++) acc += y[i] * y[i];
            let best = acc;
            for (let i = m; i < y.length; i++) {
                acc += y[i] * y[i] - y[i - m] * y[i - m];
                best = Math.max(best, acc);
            }
            return best;
        };
        return 10 * Math.log10(Math.max(peak(x), 1e-30) / Math.max(peak(ramped), 1e-30));
    };
    const wanted = new Set<string>();
    const needs = new Map<string, number>();
    instruments.forEach((inst, idx) => {
        inst.zones.forEach((z, zi) => {
            const g = z.gens;
            if (g.sampleModes === 2) return;
            const cents = (z.key_hi - (g.overridingRootKey ?? 60)) * (g.scaleTuning ?? 100) + (g.coarseTune ?? 0) * 100 + (g.fineTune ?? 0);
            const n = Math.ceil(RAMP * pow(2, cents / 1200));
            needs.set(`${idx}:${zi}`, n);
            const attack = g.attackVolEnv ?? -12000;
            if (INSTANT < attack && attack <= timecents(0.01) && loss(z.sample, n) > 0.5) wanted.add(groupOf[idx]);
        });
    });
    const pad = new Map<number, number>();
    const zonePad = new Map<string, number>();
    for (const [id, n] of needs) {
        const [idx, zi] = id.split(":").map(Number);
        if (!wanted.has(groupOf[idx])) continue;
        const z = instruments[idx].zones[zi];
        zonePad.set(id, n);
        pad.set(z.sample, Math.max(pad.get(z.sample) ?? 0, n));
    }
    instruments.forEach((inst, idx) => {
        inst.zones.forEach((z, zi) => {
            const p = pad.get(z.sample);
            if (p === undefined) return;
            const skip = p - (zonePad.get(`${idx}:${zi}`) ?? 0);
            if (skip) z.gens.startAddrsOffset = skip;
        });
    });
    for (const [k, n] of pad) samples[k].pad = n;
}

/**
 * SFe's alternating loop for the ping-pong waves (sampleModes 4): the sample keeps its forward data up to the end
 * turn E, the loop runs from the start turn L to E + 1. Waves on the keep list play the engine's round trip. A key
 * off zone (sampleModes 2) cannot be mode 4 too: it gets its own copy with the round trip.
 */
function alternateLoops(samples: BankSample[], instruments: { zones: BankZone[] }[]) {
    const alternate = new Map<number, [number, number]>();
    samples.forEach((s, k) => {
        if (s.mode !== "pingpong" || ALTERNATE_KEEP.has(Number(s.name.slice(1).split(" ")[0]))) return;
        const n = (s.loop_end - s.loop_start) >> 1;
        const end = s.loop_start - 1;
        alternate.set(k, [end, end - n]);
    });
    const unrolled = new Map<number, number>();
    for (const inst of instruments) {
        for (const z of inst.zones) {
            if (!alternate.has(z.sample)) continue;
            if (z.gens.sampleModes === 2) {
                if (!unrolled.has(z.sample)) {
                    unrolled.set(z.sample, samples.length);
                    samples.push({ ...samples[z.sample], name: `${samples[z.sample].name} rt` });
                }
                z.sample = unrolled.get(z.sample)!;
            } else {
                z.gens.sampleModes = 4;
            }
        }
    }
    for (const [k, [end, start]] of alternate) {
        const s = samples[k];
        Object.assign(s, { length: end + 1, loop_start: start, loop_end: end + 1, mode: "alternate" });
        if (start < 0 && !s.pad) {
            s.pad = 1;
            for (const inst of instruments) {
                for (const z of inst.zones) if (z.sample === k) z.gens.startAddrsOffset = (z.gens.startAddrsOffset ?? 0) + 1;
            }
        }
    }
}

type Preset = Bank["presets"][number] & { tone?: number };

/**
 * Every map on its own LSB, the default map also on LSB 0, the GM2 kits on MSB 120, and the fallback presets where
 * core's GS fallback would play another tone than SC-VA.
 */
function presetsOf(dir: Directory, maps: Map<string, MapPresets>, defaultMap: string, toneInstruments: Map<string, number>, keyInstruments: Map<string, number>) {
    const presets = new Array<Preset>();
    const tag = (name: string, m: string) => (m in MAP_TAGS ? `${name} [${MAP_TAGS[m as MapName]}]` : name);
    const toneZones = (tone: number) => [0, 1].filter((s) => toneInstruments.has(`${tone}:${s}`)).map((s) => ({ instrument: toneInstruments.get(`${tone}:${s}`)! }));
    for (const [name, m] of maps) {
        const lsbs = m.map === undefined ? [] : [m.map, ...(name === defaultMap ? [0] : [])];
        const single = SINGLE_ASSIGN.has(name) ? 1 : 0;
        for (const e of m.presets) {
            const zones = toneZones(e.tone);
            if (!zones.length) continue;
            for (const lsb of lsbs) presets.push({ name: tag(dir.toneName(e.tone), name), bank_msb: e.bank, bank_lsb: lsb, program: e.program, drum: false, zones, tone: e.tone });
        }
        for (const e of m.kits) {
            const zones = new Array<BankPresetZone>();
            for (let note = 0; note < 128; note++) {
                const i = keyInstruments.get(`${e.kit}:${note}:${single}`);
                if (i !== undefined) zones.push({ instrument: i, key_lo: note, key_hi: note });
            }
            const kit = dir.kit(e.kit);
            for (const [msb, lsb] of m.map === undefined ? [[GM2_MSB, 0]] : lsbs.map((x) => [0, x])) {
                presets.push({ name: tag(kit.name, name), bank_msb: msb, bank_lsb: lsb, program: e.program, drum: true, zones });
            }
        }
    }
    // core's pick for a melodic (MSB, LSB, program): exact, the capital of the same LSB, the same MSB, max(MSB, LSB)
    // on either, the first of the program
    const melodic = presets.filter((p) => !p.drum).sort((a, b) => a.program - b.program || a.bank_msb - b.bank_msb || a.bank_lsb - b.bank_lsb);
    const byProgram = new Map<number, Preset[]>();
    for (const p of melodic) {
        if (!byProgram.has(p.program)) byProgram.set(p.program, []);
        byProgram.get(p.program)!.push(p);
    }
    const first = [...presets].sort((a, b) => Number(a.drum) - Number(b.drum) || a.program - b.program || a.bank_msb - b.bank_msb || a.bank_lsb - b.bank_lsb)[0];
    const pick = (msb: number, lsb: number, program: number) => {
        const c = byProgram.get(program) ?? [];
        return c.find((p) => p.bank_msb === msb && p.bank_lsb === lsb) ?? (c.length === 0 ? first
            : c.find((p) => p.bank_msb === 0 && p.bank_lsb === lsb) ?? c.find((p) => p.bank_msb === msb)
              ?? c.find((p) => p.bank_lsb === Math.max(msb, lsb) || p.bank_msb === Math.max(msb, lsb)) ?? c[0]);
    };
    const extra = new Array<Preset>();
    for (const [name, m] of maps) {
        if (m.map === undefined) continue;
        for (const lsb of [m.map, ...(name === defaultMap ? [0] : [])]) {
            for (let program = 0; program < 128; program++) {
                for (let msb = 0; msb < 128; msb++) {
                    const tone = dir.programTone(program, m.map, msb);
                    if (tone < 0 || pick(msb, lsb, program).tone === tone) continue;
                    const zones = toneZones(tone);
                    if (zones.length) extra.push({ name: tag(dir.toneName(tone), name), bank_msb: msb, bank_lsb: lsb, program, drum: false, zones, tone, fallback: true });
                }
            }
        }
    }
    return [...presets, ...extra].map((p) => {
        const { tone: _tone, ...rest } = p;
        return rest;
    });
}

export { MAP_NAMES };

/**
 * The first map (its number, 120 for GM2) and program that select each kit: its keys' names and bake renders.
 */
function kitPages(maps: Map<string, MapPresets>) {
    const kitPage = new Map<number, [number, number]>();
    for (const m of maps.values()) for (const k of m.kits) if (!kitPage.has(k.kit)) kitPage.set(k.kit, [m.map ?? 120, k.program]);
    return kitPage;
}

/**
 * A runner in the calling thread.
 */
export class LocalRunner implements ZoneRunner {
    private readonly ctx;
    private builder?: ZoneBuilder;
    private readonly renderer?: BakeRenderer;

    public constructor(ctx: RunnerContext, renderer?: BakeRenderer) {
        this.ctx = ctx;
        this.renderer = renderer;
    }

    public async setup(s: RunnerSetup) {
        this.builder = new ZoneBuilder(models(this.ctx.dll, this.ctx.dir, s.tables), s.waves);
    }

    public async run(jobs: Job[]) {
        const b = this.builder;
        if (!b) throw new Error("runner not set up");
        return jobs.map((j) => b.run(j));
    }

    public async bake(jobs: BakeJob[]) {
        const r = this.renderer;
        if (!r) throw new Error("no bake renderer");
        return jobs.map((j) => renderBake(r, j));
    }
}

/**
 * What a runner starts from: the DLL and its directory.
 */
export interface RunnerContext {
    dll: Dll;
    dir: Directory;
    /**
     * The bake renderer's compiled module (undefined: no bakes).
     */
    wasm?: WebAssembly.Module;
}

/**
 * The whole conversion: the DLL's bytes (checked by size and hash) to the bank model and its audio. makeRunner
 * gives the zone runner (workers in the CLI), the default runs in this thread.
 */
export async function convert(data: ArrayBuffer | Uint8Array, options: ConvertOptions = {},
                              makeRunner?: (ctx: RunnerContext) => ZoneRunner | Promise<ZoneRunner>) {
    const log = options.log ?? (() => undefined);
    const times: Record<string, number> = {};
    let t = performance.now();
    const lap = (name: string) => {
        const now = performance.now();
        times[name] = (now - t) / 1000;
        t = now;
    };
    const dll = await Dll.open(data);
    const dir = new Directory(dll);
    const maps = mapPresets(dir, options.gm2 ?? true);
    const jobs = jobsOf(dir, maps);
    lap("read");
    const wasm = options.wasm === undefined ? undefined : options.wasm instanceof WebAssembly.Module ? options.wasm : await WebAssembly.compile(options.wasm as BufferSource);
    const ctx: RunnerContext = { dll, dir, wasm };
    const runner: ZoneRunner = makeRunner ? await makeRunner(ctx) : new LocalRunner(ctx, wasm ? await BakeRenderer.create(wasm, dll.bytes) : undefined);
    log(`${jobs.length} jobs`);
    // the cache's keys: the converter's build, the DLL, the jobs (every rule input of a zone is in the build and the
    // DLL, the jobs say which zones)
    const cache = options.cache && options.version ? options.cache : undefined;
    // a cache that cannot be written is reported once, the conversion goes on without it
    let warned = false;
    const cacheFailed = (e: unknown) => {
        if (warned) return;
        warned = true;
        log(`Warning: the solve cache could not be written (${e instanceof Error ? e.message : String(e)}), going on without it`);
    };
    const zonesKey = cache ? `scva2sfe/${options.version}/${DLL_SHA256}/zones/${await sha256Hex(JSON.stringify(jobs))}` : "";
    let results = cache ? await cacheGet<JobResult[]>(cache, zonesKey) : undefined;
    if (results) {
        log("Zones from the solve cache");
        lap("zones (cache)");
    } else {
        if (runner.setup) {
            const mapsKey = `scva2sfe/${options.version}/filter-maps`;
            let tables = cache ? await cacheGet<FilterTables>(cache, mapsKey) : undefined;
            if (!tables) {
                tables = runner.filterMaps ? await runner.filterMaps() : { plain: FilterMap.build(false).table, signed: FilterMap.build(true).table };
                if (cache) await cachePut(cache, mapsKey, tables, cacheFailed);
            }
            lap("filter maps");
            let waves: Map<number, WaveInfo | undefined> | undefined;
            if (runner.waves) {
                const list = wavesOf(dir, jobs);
                const infos = await runner.waves(list);
                waves = new Map(list.map((w, i) => [w, infos[i]]));
                lap("waves");
            }
            await runner.setup({ tables, waves });
        }
        results = await runner.run(jobs);
        lap("zones");
        if (cache) {
            await cachePut(cache, zonesKey, results, cacheFailed);
            lap("cache write");
        }
    }
    let bakes: Map<number, BakeRender | undefined> | undefined;
    if (wasm && runner.bake) {
        const kitPage = kitPages(maps);
        const keyOf = new Map<string, number>();
        const unique = new Array<BakeJob>();
        const entryJob = (options.bakePlan ?? BAKE_PLAN).map((e) => {
            const job: BakeJob = { query: bakeQuery(e, kitPage), slot: e.slot, velocity: e.velocity, tap: e.tap };
            const key = JSON.stringify(job);
            if (!keyOf.has(key)) {
                keyOf.set(key, unique.length);
                unique.push(job);
            }
            return keyOf.get(key)!;
        });
        const renders = await runner.bake(unique);
        bakes = new Map(entryJob.map((j, i) => [i, renders[j]]));
        lap("bake renders");
    }
    const out = assemble(dll, dir, maps, results, options, bakes);
    lap("assemble");
    return { ...out, times, results };
}

/**
 * Curve shapes by content: equal y values get the same number (a hash, then a full compare), a cheap stand-in for
 * the values themselves in a key.
 */
class ShapeIndex {
    private readonly byHash = new Map<number, { ys: Uint16Array; id: number }[]>();
    private count = 0;

    public id(ys: Uint16Array) {
        let h = 0x811c9dc5;
        for (let i = 0; i < ys.length; i++) h = Math.imul(h ^ ys[i], 0x01000193);
        const list = this.byHash.get(h);
        if (list) {
            for (const e of list) {
                if (e.ys === ys) return e.id;
                if (e.ys.length !== ys.length) continue;
                let same = true;
                for (let i = 0; i < ys.length && same; i++) same = e.ys[i] === ys[i];
                if (same) return e.id;
            }
        }
        const e = { ys, id: this.count++ };
        if (list) list.push(e);
        else this.byHash.set(h, [e]);
        return e.id;
    }
}

/**
 * A curve's points (x = value * 128, the last at 16383) reduced to those a linear interpolation needs to stay within
 * eps of every 7 bit value (Douglas-Peucker on the 128 values).
 */
function simplify(ys: Uint16Array, eps: number): [number, number][] {
    const keep = new Uint8Array(128);
    keep[0] = keep[127] = 1;
    const stack: [number, number][] = [[0, 127]];
    while (stack.length) {
        const [a, b] = stack.pop()!;
        let worst = -1;
        let err = eps;
        for (let x = a + 1; x < b; x++) {
            const line = ys[a] + ((ys[b] - ys[a]) * (x - a)) / (b - a);
            const d = Math.abs(ys[x] - line);
            if (d > err) {
                err = d;
                worst = x;
            }
        }
        if (worst >= 0) {
            keep[worst] = 1;
            stack.push([a, worst], [worst, b]);
        }
    }
    const points = new Array<[number, number]>();
    for (let x = 0; x < 128; x++) if (keep[x]) points.push([x * 128, ys[x]]);
    points.push([16383, ys[127]]);
    return points;
}

/**
 * The destination's tolerance for a shared curve, in its units: level 5 cB, cutoff 50 cents, LFO rate 20 cents,
 * resonance 10 cB, envelope and LFO times 30 timecents, pan 5, pitch 2 cents.
 */
function curveTolerance(dest: string) {
    if (dest === "initialAttenuation" || dest === "gain") return 5;
    if (dest === "initialFilterFc" || dest === "maxFilterFc" || dest.endsWith("ToFilterFc")) return 50;
    if (dest.startsWith("freq")) return 20;
    if (dest === "filterQOffset" || dest === "initialFilterQ") return 10;
    if (dest === "pan") return 5;
    if (/^(attack|hold|decay|release|delay|fade)/.test(dest)) return 30;
    return 2;
}

/**
 * Custom curves shared by shape: a curve's y values are its shape at full scale (the amount carries the size), so a
 * modulator takes an earlier curve where the two shapes differ by at most the destination's tolerance over its amount
 * at every value it plays at (its zones' keys or velocities, every value of a controller, and outside them the curve
 * holds its edge values). A key or velocity curve that moves its destination by less than the tolerance where it
 * plays goes (undefined). Candidates are found through a quantized shape (cells no wider than the tolerance, two offsets), the
 * largest amounts first. Deterministic.
 */
function shareCurves(mods: PackedModulator[], domain: number[][]) {
    const out: (PackedModulator | undefined)[] = mods.slice();
    const order = mods.map((_, i) => i).filter((i) => mods[i].ys).sort((a, b) => Math.abs(mods[b].amount) - Math.abs(mods[a].amount) || a - b);
    const LEVELS = 14;
    // a cell is its level, its offset and the quantized shape, found by a hash and compared in full (the first curve
    // put into a cell keeps it)
    const cells = new Map<number, { level: number; shift: number; q: Uint16Array; ys: Uint16Array }[]>();
    const quantize = (ys: Uint16Array, level: number, shift: number) => {
        // a power of two: the product is the quotient exactly
        const c = 2 ** level / 8192;
        const q = new Uint16Array(ys.length);
        let h = Math.imul(0x811c9dc5 ^ level, 0x01000193);
        h = Math.imul(h ^ (shift ? 1 : 0), 0x01000193);
        for (let i = 0; i < ys.length; i++) {
            q[i] = Math.floor(ys[i] * c + shift) & 0xffff;
            h = Math.imul(h ^ q[i], 0x01000193);
        }
        return { h, q };
    };
    const cellOf = (level: number, shift: number, k: { h: number; q: Uint16Array }) => {
        const list = cells.get(k.h);
        if (!list) return undefined;
        for (const e of list) {
            if (e.level !== level || e.shift !== shift) continue;
            let same = true;
            for (let i = 0; i < k.q.length && same; i++) same = e.q[i] === k.q[i];
            if (same) return e;
        }
        return undefined;
    };
    for (const i of order) {
        const m = mods[i];
        const tol = curveTolerance(m.dest);
        let ys = m.ys!;
        if (m.source === "key" || m.source === "velocity") {
            const [lo, hi] = m.source === "key" ? [domain[i][0], domain[i][1]] : [domain[i][2], domain[i][3]];
            let top = 0;
            for (let x = lo; x <= hi; x++) top = Math.max(top, Math.abs(((ys[x] - 8192) / 8192) * m.amount));
            if (top <= tol) {
                out[i] = undefined;
                continue;
            }
            ys = Uint16Array.from(ys, (_, x) => ys[Math.max(lo, Math.min(hi, x))]);
        }
        const eps = (tol * 8192) / Math.max(Math.abs(m.amount), 1);
        // the coarsest cell that still guarantees the tolerance
        const level = Math.min(LEVELS, Math.max(0, Math.ceil(Math.log2(8192 / eps))));
        // candidates from the cells at this level and a few coarser ones (checked point by point), the curve
        // itself and its mirror (the same shape with the amount's sign turned)
        const mirror = Uint16Array.from(ys, (y) => 16384 - y);
        const close = (r: Uint16Array, y: Uint16Array) => {
            for (let x = 0; x < 128; x++) if (Math.abs(r[x] - y[x]) > eps) return false;
            return true;
        };
        let rep: Uint16Array | undefined;
        let sign = 1;
        // the curve's own cells, kept for its insertion below
        const own = new Map<number, ReturnType<typeof quantize>>();
        search: for (let l = Math.min(level, LEVELS - 1); l >= Math.max(0, level - 4); l--) {
            for (const [y, sg] of [[ys, 1], [mirror, -1]] as const) {
                for (const shift of [0, 0.5]) {
                    const k = quantize(y, l, shift);
                    if (sg > 0) own.set(2 * l + (shift ? 1 : 0), k);
                    const r = cellOf(l, shift, k)?.ys;
                    if (r && close(r, y)) {
                        rep = r;
                        sign = sg;
                        break search;
                    }
                }
            }
        }
        if (rep) {
            out[i] = { ...m, ys: rep, amount: sign * m.amount };
            continue;
        }
        out[i] = { ...m, ys };
        for (let l = 0; l < LEVELS; l++) {
            for (const shift of [0, 0.5]) {
                const k = own.get(2 * l + (shift ? 1 : 0)) ?? quantize(ys, l, shift);
                if (cellOf(l, shift, k)) continue;
                const list = cells.get(k.h);
                const e = { level: l, shift, q: k.q, ys };
                if (list) list.push(e);
                else cells.set(k.h, [e]);
            }
        }
    }
    return out;
}
