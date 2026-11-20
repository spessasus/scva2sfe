/**
 * The zones of one tone (a melodic instrument per partial) or one drum kit key (one instrument): the engine's key zones of a partial, cut where the static pitch leaves a 6 cent band around the SFe
 * key follow line, then where the TVA, pitch or TVF rule asks for a split, each part with its volume envelope, pitch
 * envelope, filter, LFOs, tuning, pan, controllers and level. Runs in a worker: everything here comes from the DLL's
 * bytes, a job's result is plain data.
 */
import type { BankModulator } from "./bank.js";
import { pow } from "./math.js";
import { bakedFilterModulators, centsPerCutoffUnit, envelopeModulators, filterCcModulators, filterDefaultsOff } from "./controllers.js";
import { curveModulator, sourceX } from "./curves.js";
import type { Directory, KitKey } from "./directory.js";
import type { Dll } from "./dll.js";
import { fileOffset } from "./dll.js";
import type { Generators } from "./envfit.js";
import { resetWarm } from "./envfit.js";
import type { Spectrum, SvfTap } from "./filter-map.js";
import { FilterMap } from "./filter-map.js";
import { LfoModel, wheelCents } from "./lfo.js";
import type { PitchZone } from "./pitch-env.js";
import { loops, PitchEnvModel, pitchZone } from "./pitch-env.js";
import { decodeWave } from "./rom.js";
import { interpolationFir, ownGain, svfFir } from "./samples.js";
import type { LevelContext } from "./tva.js";
import { TvaModel } from "./tva.js";
import { TvfModel } from "./tvf.js";
import type { TvaZone, TvaZoneQuery } from "./zone-tva.js";
import { tvaZone } from "./zone-tva.js";
import type { FilterMaps, TvfZone } from "./zone-tvf.js";
import { tvfZone } from "./zone-tvf.js";

const KF_PAN = fileOffset(0x181a01fa0);
const PAN_CURVE = fileOffset(0x1819a2fa0);
/**
 * The static pitch's band inside one zone (cents around the SFe key follow line).
 */
const TUNING_BAND = 6;
/**
 * The most parts the split checks cut one tuning group into (zone-tva.ts MAX_PARTS).
 */
const MAX_PARTS = 8;
/**
 * The user's named bakes (decision 2026-11-13): a static non-lowpass filter of these tones keeps its exact SVF copy.
 */
const USER_BAKED = new Set(["Pai Ban", "TR-707 SD 3"]);
/**
 * Core's gain chain: SPESSASYNTH_GAIN_FACTOR, its CC7 / CC11 defaults after a reset (100, 127) through the negative
 * concave sources at 960 cB each (center-max source values, SFe 4.0 7.2, so 127 is no attenuation), its pan law.
 */
export const CORE_GAIN_FACTOR = 0.6;
const concaveNegative = (value: number) => {
    const j = 16384 - Math.trunc((1 - sourceX(value) / 16384) * 16384);
    if (j >= 16384) return 0;
    if (j <= 0) return 1;
    return Math.min(1, (-400 / 960) * Math.log10(j / 16384));
};
export const CORE_VOLUME_GAIN = pow(10, -(960 * concaveNegative(100) + 960 * concaveNegative(127)) / 200);
export const corePanSum = (pan: number) => {
    const x = (Math.max(-500, Math.min(500, pan)) + 500) / 1000;
    return Math.cos((Math.PI / 2) * x) + Math.sin((Math.PI / 2) * x);
};
const panGen = (r: number) => Math.max(-500, Math.min(500, Math.round(((r - 64) / 64) * 500)));

export type Job = { kind: "tone"; tone: number } | { kind: "key"; kit: number; note: number; single: boolean };

/**
 * A static highpass, bandpass or peak baked into a copy of the zone's sample (the SVF at f, q played at ratio).
 */
export interface FilterCopy {
    tap: SvfTap;
    f: number;
    q: number;
    ratio: number;
    /**
     * The copy's FIR and its sample's own gain through it (samples.ts svfFir / ownGain), computed in the worker.
     */
    fir?: number[];
    gain?: number;
}

export interface RawZone {
    wave: number;
    key_lo: number;
    key_hi: number;
    vel_lo: number;
    vel_hi: number;
    gens: Generators;
    mods: BankModulator[];
    /**
     * The zone's peak gain on the engine's scale over core's chain (before the sample gains and the bank level).
     */
    peak: number;
    copy?: FilterCopy;
    /**
     * The filter's level terms in the peak (cB): a bake before the filter keeps them, one after it does not.
     */
    filterCb: number;
    /**
     * The engine's tone, partial slot and reference key / velocity (the bake step finds its zones by these).
     */
    tone: number;
    slot: number;
}

export interface RawInstrument {
    name: string;
    zones: RawZone[];
}

/**
 * A modulator as a job hands it over: a custom curve's points as its 128 y values (x = sourceX of each value), every
 * zone of the job refers to it by index.
 */
export type PackedModulator = Omit<BankModulator, "points"> & { ys?: Uint16Array };

export interface PackedZone extends Omit<RawZone, "mods"> {
    mods: number[];
}

export interface JobResult {
    job: Job;
    instruments: { name: string; zones: PackedZone[] }[];
    mods: PackedModulator[];
    /**
     * Waves the zones play (the main thread numbers the samples) and each one's own gain (samples.ts ownGain,
     * undefined for a silent wave).
     */
    waves: number[];
    gains?: (number | undefined)[];
}

export interface Models {
    dll: Dll;
    dir: Directory;
    tva: TvaModel;
    tvf: TvfModel;
    pe: PitchEnvModel;
    lfo: LfoModel;
    maps: FilterMaps;
    wheel: number;
    /**
     * The interpolation FIR (samples.ts interpolationFir): the samples' own gains.
     */
    interp: number[];
}

/**
 * The models a worker needs. The filter maps take a few seconds: the main thread builds them once and hands their
 * tables over.
 */
export function models(dll: Dll, dir: Directory, tables?: { plain: Float64Array; signed: Float64Array }) {
    const maps = tables
        ? { plain: FilterMap.from(false, tables.plain), signed: FilterMap.from(true, tables.signed) }
        : { plain: FilterMap.build(false), signed: FilterMap.build(true) };
    return {
        dll, dir, tva: new TvaModel(dll, dir), tvf: new TvfModel(dll, dir), pe: new PitchEnvModel(dll, dir), lfo: new LfoModel(dll), maps,
        wheel: wheelCents(), interp: interpolationFir(dll)
    };
}

/**
 * What the zones need of a wave: its length and loop, its spectrum (the filter rules) and its own gain.
 */
export interface WaveInfo {
    length: number;
    oneShot: boolean;
    looped: boolean;
    spectrum?: Spectrum;
    gain?: number;
}

/**
 * A wave's info, undefined for a wave without data.
 */
export function waveInfo(dll: Dll, dir: Directory, tvf: TvfModel, interp: number[], w: number) {
    const d = decodeWave(dll, dir.wave(w));
    if (!d || !d.data.length) return undefined;
    return {
        length: d.data.length, oneShot: d.mode === "oneshot" || d.mode === "reverse", looped: d.loopEnd > d.loopStart,
        spectrum: tvf.spectrum(d.data), gain: ownGain(d.data, interp)
    };
}

/**
 * Every wave the jobs' zones can play (a superset: the key zones of every partial), for the wave infos up front.
 */
export function wavesOf(dir: Directory, jobs: Job[]) {
    const waves = new Set<number>();
    const add = (tone: number, keys: number[]) => {
        for (let slot = 0; slot < 2; slot++) {
            const b = dir.partial(tone, slot);
            if (!b) continue;
            for (const k of keys) {
                const z = dir.selectWave(b, k);
                if (z) waves.add(z.wave);
            }
        }
    };
    const all = Array.from({ length: 128 }, (_, k) => k);
    for (const job of jobs) {
        if (job.kind === "tone") {
            add(job.tone, all);
        } else {
            const key = dir.kit(job.kit).keys[job.note];
            add(key.tone, [key.pitch]);
        }
    }
    return [...waves].sort((a, b) => a - b);
}

/**
 * Runs jobs in one context (a worker, or the main thread for a single threaded run).
 */
export class ZoneBuilder {
    private readonly m;
    private readonly waves;
    /**
     * Filter copies' FIRs and gains by their inputs (kits repeat drums).
     */
    private readonly firs = new Map<string, { fir: number[]; gain?: number }>();
    /**
     * Milliseconds spent per family (for the timing report).
     */
    public readonly timing = { tva: 0, pitch: 0, tvf: 0, rest: 0 };

    /**
     * waves: wave infos computed up front (waveInfo), the rest are computed here when met.
     */
    public constructor(m: Models, waves?: Map<number, WaveInfo | undefined>) {
        this.m = m;
        this.waves = waves ?? new Map();
    }

    private wave(w: number) {
        if (!this.waves.has(w)) this.waves.set(w, waveInfo(this.m.dll, this.m.dir, this.m.tvf, this.m.interp, w));
        return this.waves.get(w);
    }

    /**
     * A filter copy's FIR and its sample's gain through it (convert.ts takes the first zone's per copy).
     */
    private copyFir(wave: number, c: FilterCopy) {
        const key = JSON.stringify([wave, c.tap, c.f, c.q, c.ratio]);
        let r = this.firs.get(key);
        if (!r) {
            const fir = svfFir(Math.round(c.f * 1e4) / 1e4, c.q, c.tap, Math.round(c.ratio * 1e4) / 1e4);
            r = { fir, gain: ownGain(decodeWave(this.m.dll, this.m.dir.wave(wave))!.data, this.m.interp, fir) };
            this.firs.set(key, r);
        }
        return r;
    }

    public run(job: Job) {
        // the projections' warm starts begin empty in every job: its result depends on the job alone
        resetWarm();
        const instruments = new Array<RawInstrument>();
        const { dir } = this.m;
        if (job.kind === "tone") {
            const header = dir.toneHeader(job.tone);
            const name = dir.toneName(job.tone);
            for (let slot = 0; slot < 2; slot++) {
                const b = dir.partial(job.tone, slot);
                if (!b) continue;
                // a tone that starts one of its partials at random (header 0x22 = 1) keeps the first: core has no
                // random choice
                if (header[0x22] === 1 && slot > 0 && dir.partial(job.tone, 0)) continue;
                const zones = this.partial(job.tone, slot, header, b, undefined);
                if (zones.length) instruments.push({ name: `${name} ${slot + 1}`, zones });
            }
        } else {
            const kit = dir.kit(job.kit);
            const key = kit.keys[job.note];
            const header = dir.toneHeader(key.tone);
            const zones = new Array<RawZone>();
            const exclusive = key.group || (job.single ? 128 + job.note : 0);
            for (let slot = 0; slot < 2; slot++) {
                const b = dir.partial(key.tone, slot);
                if (!b) continue;
                if (header[0x22] === 1 && slot > 0 && dir.partial(key.tone, 0)) continue;
                for (const z of this.partial(key.tone, slot, header, b, key)) {
                    if (exclusive) z.gens.exclusiveClass = exclusive;
                    // the kit's reverb, chorus and delay depths scale the part's sends: core's CC91 / 93 / 94 send
                    // modulators (1000) replaced per key by 1000 * depth / 127
                    for (const [cc, dest, depth] of [[91, "reverbEffectsSend", key.reverb], [93, "chorusEffectsSend", key.chorus], [94, "variationEffectsSend", key.delay]] as const) {
                        if (depth !== 127) {
                            z.mods.push({ source: "cc", cc, curve: "linear", negative: false, bipolar: false, dest, amount: Math.min(1000, Math.round((1000 * depth) / 127)) });
                        }
                    }
                    zones.push(z);
                }
            }
            if (zones.length) instruments.push({ name: `${dir.toneName(key.tone)} ${job.note}`, zones });
        }
        const waves = [...new Set(instruments.flatMap((i) => i.zones.map((z) => z.wave)))].sort((a, b) => a - b);
        const gains = waves.map((w) => this.wave(w)?.gain);
        for (const inst of instruments) {
            for (const z of inst.zones) if (z.copy) Object.assign(z.copy, this.copyFir(z.wave, z.copy));
        }
        // the job's modulators once, the curves as 16 bit y values (a zone carries dozens of 129 point curves)
        const mods = new Array<PackedModulator>();
        const index = new Map<string, number>();
        const packed = instruments.map((inst) => ({
            name: inst.name,
            zones: inst.zones.map((z) => ({
                ...z,
                mods: z.mods.map((m) => {
                    const { points, ...rest } = m;
                    const pm: PackedModulator = rest;
                    if (points) pm.ys = Uint16Array.from(points.slice(0, 128), (p) => p[1]);
                    const key = JSON.stringify(rest) + (pm.ys ? String.fromCharCode(...pm.ys) : "");
                    let n = index.get(key);
                    if (n === undefined) {
                        n = mods.length;
                        mods.push(pm);
                        index.set(key, n);
                    }
                    return n;
                })
            }))
        }));
        return { job, instruments: packed, mods, waves, gains };
    }

    /**
     * One partial's zones. key: the kit key for a drum (its pitch is the voice key, every MIDI key of the
     * instrument plays it), undefined for a melodic partial.
     */
    private partial(tone: number, slot: number, header: Uint8Array, b: Uint8Array, key: KitKey | undefined) {
        const { dir, pe } = this.m;
        const drum = key !== undefined;
        const out = new Array<RawZone>();
        const velLo = Math.min(b[0x4f], b[0x51]);
        const velHi = Math.max(b[0x4f], b[0x51]);
        const scale = drum ? 0 : (b[0x13] - 0x40) * 10;
        // the engine's key zones (wave and multisample zone per voice key)
        const runs = new Array<{ lo: number; hi: number; wave: number; level: number }>();
        if (drum) {
            const z = dir.selectWave(b, key.pitch);
            if (z) runs.push({ lo: 0, hi: 127, wave: z.wave, level: z.level });
        } else {
            for (let k = 0; k < 128; k++) {
                const z = dir.selectWave(b, k);
                if (!z) continue;
                const last = runs[runs.length - 1];
                const prev = last && last.hi === k - 1 ? dir.selectWave(b, k - 1) : undefined;
                if (prev && prev.wave === z.wave && prev.zone === z.zone) last.hi = k;
                else runs.push({ lo: k, hi: k, wave: z.wave, level: z.level });
            }
        }
        for (const run of runs) {
            const info = this.wave(run.wave);
            if (!info) continue;
            const d = dir.wave(run.wave);
            const looped = loops(d);
            const voiceKey = (k: number) => (drum ? key.pitch : k);
            const cents = (k: number) => pe.pitch.cents(header, b, voiceKey(k), drum, looped)!;
            const offsets = new Array<number>();
            for (let k = run.lo; k <= run.hi; k++) offsets.push(cents(k) - (k - d.rootKey) * scale);
            // groups where the static pitch stays in the band
            const groups = new Array<[number, number]>();
            let start = 0;
            let lo = Infinity;
            let hi = -Infinity;
            for (let k = 0; k <= offsets.length; k++) {
                if (k < offsets.length) {
                    const nlo = Math.min(lo, offsets[k]);
                    const nhi = Math.max(hi, offsets[k]);
                    if (nhi - nlo <= TUNING_BAND || drum) {
                        lo = nlo;
                        hi = nhi;
                        continue;
                    }
                }
                groups.push([start, k]);
                start = k;
                lo = hi = k < offsets.length ? offsets[k] : 0;
            }
            for (const [g0, g1] of groups) {
                const part = offsets.slice(g0, g1);
                const tuneBase = (Math.max(...part) + Math.min(...part)) / 2;
                const ctx: PartContext = {
                    tone, slot, header, b, key, drum, run, info, scale, root: d.rootKey, looped, tuneBase,
                    levels: { zoneLevel: run.level, toneLevel: header[0x0c], holdsOn: (header[0x0d] & 2) !== 0 }
                };
                let parts = 0;
                const cut = (klo: number, khi: number, vlo: number, vhi: number) => {
                    const z = this.zone(ctx, klo, khi, vlo, vhi, parts >= MAX_PARTS - 1);
                    if (!z) return;
                    if ("split" in z) {
                        parts++;
                        if (z.split.key !== undefined && z.split.key > klo && z.split.key <= khi) {
                            cut(klo, z.split.key - 1, vlo, vhi);
                            cut(z.split.key, khi, vlo, vhi);
                        } else {
                            const v = z.split.velocity!;
                            cut(klo, khi, vlo, v - 1);
                            cut(klo, khi, v, vhi);
                        }
                        return;
                    }
                    out.push(z);
                };
                cut(run.lo + g0, run.lo + g1 - 1, velLo, velHi);
            }
        }
        return out;
    }

    /**
     * One zone of keys klo..khi and velocities vlo..vhi, or the split the rules ask for (noSplit: no more splits).
     */
    private zone(c: PartContext, klo: number, khi: number, vlo: number, vhi: number, noSplit: boolean) {
        const { dir, tva, tvf, pe, maps, lfo } = this.m;
        const { b, header, drum, info } = c;
        const keyOff = b[0] === 0xff;
        const refKey = drum ? c.key!.pitch : (klo + khi) >> 1;
        const refVel = Math.min(127, vhi);
        const keyLo = drum ? refKey : klo;
        const keyHi = drum ? refKey : khi;
        const free = drum && !c.key!.noteOff;
        const centsAt = (k: number) => this.m.pe.pitch.cents(header, b, k, drum, c.looped)!;
        const endAt = (k: number) => (info.oneShot ? info.length / (32000 * pow(2, centsAt(k) / 1200)) : undefined);
        let end: number | undefined;
        for (let k = keyLo; k <= keyHi; k++) {
            const e = endAt(k);
            if (e !== undefined) end = Math.max(end ?? 0, e);
        }
        const base = { b, key: refKey, velocity: refVel, levels: c.levels, free, end, keyLo, keyHi, velLo: vlo, velHi: vhi };
        let t0 = performance.now();
        const tv: TvaZone | undefined = tvaZone(tva, { ...base, endAt, noSplit } as TvaZoneQuery);
        if (!tv) return undefined;
        let t1 = performance.now();
        this.timing.tva += t1 - t0;
        let pz: PitchZone | undefined = keyOff ? undefined : pitchZone(pe, { ...base, header, drum, scale: c.scale, noSplit });
        const ratio = pow(2, centsAt(refKey) / 1200);
        // a fine tune step (no pitch envelope) gives modulation envelope 2 up to the filter's fast segment where it
        // is small or over soon (TB303 Bass)
        const stepYields = pz?.kind === "step" && (Math.abs(pz.step ?? 0) < 5 || pow(2, (pz.gens.releaseModEnv2 ?? -12000) / 1200) < 0.05);
        t0 = performance.now();
        this.timing.pitch += t0 - t1;
        const tf: TvfZone | undefined = keyOff ? undefined : tvfZone(tvf, maps, {
            ...base, header, modEnv2Free: !pz || stepYields, spectrum: info.spectrum, ratio, noSplit,
            forceBake: USER_BAKED.has(dir.toneName(c.tone))
        });
        t1 = performance.now();
        this.timing.tvf += t1 - t0;
        if (tf?.gens.modEnv2ToFilterFc !== undefined && pz?.kind === "step") pz = undefined;
        const split = tv.split ?? pz?.split ?? tf?.split;
        if (split && !noSplit && (split.key !== undefined || split.velocity !== undefined)) return { split };
        // generators
        const tune = c.tuneBase + (pz?.tune ?? 0);
        const coarse = Math.round(tune / 100);
        const kp = drum ? c.key!.pan : 64;
        const panAt = (k: number) => {
            const v = Math.max(1, Math.min(127, (this.m.dll.u8(KF_PAN + b[0x6b] * 0x80 + k) << 24 >> 24) + b[0x0f]));
            // a kit key pan of 0 is random: the centre is its average
            return kp === 0 ? 64 : Math.max(0, Math.min(127, kp + v - 64));
        };
        const r = panAt(refKey);
        const gens: Generators = {
            ...tv.gens, ...(pz?.gens ?? {}), overridingRootKey: c.root, scaleTuning: c.scale, coarseTune: coarse,
            fineTune: Math.round(tune - coarse * 100), pan: panGen(r), sampleModes: keyOff ? 2 : c.looped || info.looped ? 1 : 0
        };
        const liveFilter = tf && !tf.bake && tf.gens.initialFilterFc !== undefined;
        const l = lfo.generators(header, b, liveFilter ? centsPerCutoffUnit(tvf, tf.f) : undefined, this.m.wheel);
        Object.assign(gens, l.gens);
        if (tf && !keyOff) Object.assign(gens, tf.gens);
        for (const n of ["holdVolEnv", "holdModEnv2", "holdModEnv"]) if (n in gens) gens[n] = Math.min(5000, gens[n]);
        for (const n of ["attackVolEnv", "decayVolEnv", "decay2VolEnv", "releaseVolEnv", "attackModEnv2", "decayModEnv2", "releaseModEnv2", "attackModEnv", "decayModEnv", "releaseModEnv"]) {
            if (n in gens) gens[n] = Math.min(8000, gens[n]);
        }
        const mods = [...tv.mods, ...(pz?.mods ?? []), ...(tf?.mods ?? []), ...l.mods];
        if (!drum && khi > klo) {
            const p = new Float64Array(128);
            for (let k = 0; k < 128; k++) p[k] = panGen(panAt(Math.max(klo, Math.min(khi, k)))) - gens.pan;
            const m = curveModulator("key", p, "pan");
            if (m) mods.push(m);
        }
        if (!keyOff && !drum) mods.push(...envelopeModulators(tva, b, gens));
        // a drum part's cutoff and resonance NRPNs move its kit keys' filters the same way
        if (!keyOff && liveFilter) {
            const fv = tvf.voice(header, b, tf.refKey, tf.refVel);
            mods.push(...filterCcModulators(tvf, maps, fv, tf.f, fv.tap));
        } else if (!keyOff && tf?.bake && info.spectrum) {
            mods.push(...bakedFilterModulators(tvf, tvf.voice(header, b, refKey, refVel), tf.bake.tap as SvfTap, tf.bake.f, ratio, info.spectrum));
        } else {
            // no filter in the zone (types 3 and 7 up have no TVF, a note off zone plays its sample as it is): core's
            // CC74 / CC71 defaults would move a lowpass the engine does not have
            mods.push(...filterDefaultsOff());
        }
        // the level: the TVA at its 0 dB, the engine's part level stage over core's CC7 / CC11 gain and the engine's
        // dry sends over core's pan law (the checks hear the mono sum), the filter's level terms
        const send = (this.m.dll.u8(PAN_CURVE + r) + this.m.dll.u8(PAN_CURVE + 128 - r)) / 128;
        const gainCb = (tf?.gainCb ?? 0) + (tf?.bake?.gainCb ?? 0);
        const peak = (tv.top * tva.partGain(drum ? c.key!.level : undefined) / CORE_VOLUME_GAIN) * (send / corePanSum(gens.pan)) * pow(10, gainCb / 200);
        const zone: RawZone = {
            wave: c.run.wave, key_lo: klo, key_hi: khi, vel_lo: vlo, vel_hi: vhi, gens, mods, peak, filterCb: gainCb, tone: c.tone, slot: c.slot
        };
        if (tf?.bake) zone.copy = { tap: tf.bake.tap as SvfTap, f: tf.bake.f, q: tf.bake.q, ratio: tf.bake.ratio };
        return zone;
    }
}

interface PartContext {
    tone: number;
    slot: number;
    header: Uint8Array;
    b: Uint8Array;
    key: KitKey | undefined;
    drum: boolean;
    run: { lo: number; hi: number; wave: number; level: number };
    info: WaveInfo;
    scale: number;
    root: number;
    looped: boolean;
    tuneBase: number;
    levels: LevelContext;
}
