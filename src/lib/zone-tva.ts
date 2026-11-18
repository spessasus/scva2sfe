/**
 * A zone's volume envelope: SFe's envelope projected onto the engine's TVA curve at a reference key and velocity,
 * with the engine's key follow and velocity scaling of the times and the level as exact custom curves, and the voice
 * delay. Nothing is rendered: the curve comes from the partial's bytes (tva.ts).
 */
import type { BankModulator } from "./bank.js";
import { pow } from "./math.js";
import { curveModulator } from "./curves.js";
import { projectVolume, SILENCE_DB, timecents, volumeRms } from "./envfit.js";
import type { LevelContext, TvaModel, TvaSegments } from "./tva.js";
import { TICK } from "./tva.js";

/**
 * The curve's grid (s): SC-VA's output in steps of two 64-frame calls.
 */
const DT = 128 / 32000;
/**
 * The grid's point i is the engine's curve at i * DT + GRID: SC-VA's state after two calls (its TVA ramp) sits 2 ms
 * after the point's time. Against SC-VA's output (2481 voices) this offset takes the model's p90 from 1.54 to 0.52 dB.
 */
const GRID = 0.002;
/**
 * The long curve: a hold of 3 s or as long as the engine's segments take (up to MAX_HOLD) and 1.5 s of release, and
 * its 0.3 s twin for the release's start. A segment time past the curve's end projects to any long time, and the
 * key and velocity curves then scale a wrong time (LP Half Drv: 43 s at velocity 127, 4.2 s at 19).
 */
const HOLD = 750;
const MAX_HOLD = 10000;
const RELEASE = 375;
const SHORT = 75;
const TAIL_WEIGHT = 0.5;
/**
 * A voice delay under this is left out (the first call's 2 ms).
 */
export const START_DELAY_MIN = 0.003;
/**
 * Leading silence of the TVA longer than this becomes delayVolEnv.
 */
const LEAD_MIN = 0.02;
const SEGMENT_TIMES = ["attackVolEnv", "holdVolEnv"];
const LATE_TIMES = ["decayVolEnv", "decay2VolEnv"];

export interface TvaZoneQuery {
    b: Uint8Array;
    /**
     * The reference key the envelope is projected at (the voice key: a melodic note, a drum's kit pitch).
     */
    key: number;
    velocity: number;
    levels: LevelContext;
    /**
     * Ignores the note off (a drum key without note off).
     */
    free: boolean;
    /**
     * Where a one shot wave ends the voice (s from the voice's start), undefined for a looped wave. In a zone of more
     * than one key the latest end over its keys (the lowest key plays longest).
     */
    end?: number;
    /**
     * The end at one key, for the split check and the parts of a split (falls back to end).
     */
    endAt?: (key: number) => number | undefined;
    /**
     * The zone's keys (the key curves hold their edge values outside) and the partial's velocity window.
     */
    keyLo: number;
    keyHi: number;
    velLo: number;
    velHi: number;
}

export interface TvaSplit {
    /**
     * The first key of the upper part.
     */
    key?: number;
    /**
     * The first velocity of the upper part.
     */
    velocity?: number;
}

export interface TvaZone {
    gens: Record<string, number>;
    mods: BankModulator[];
    /**
     * The TVA gain at the envelope's 0 dB at the reference key and velocity.
     */
    top: number;
    /**
     * Where the curves miss the engine by more than SPLIT_DB at the zone's edge keys or at a lower velocity: the
     * zone plays better as two, each projected at its own reference (tvaZones does that).
     */
    split?: TvaSplit;
}

/**
 * One part of a zone after the split check, with its own projection.
 */
export interface TvaPart {
    keyLo: number;
    keyHi: number;
    velLo: number;
    velHi: number;
    key: number;
    velocity: number;
    zone: TvaZone;
}

/**
 * SFe's zero time (delay, attack): -32768 itself, anything else under -12000 reads as -12000.
 */
export const INSTANT = -32768;
/**
 * The split check's limit: the envelope's dB RMS against the engine's curve, worse than the projection at that key
 * and velocity by more than this (half the regression's envelope deviation limit).
 */
export const SPLIT_DB = 3;
/**
 * The parts one zone may split into.
 */
export const MAX_PARTS = 8;
/**
 * The velocities the split check looks at below the reference (and the window's bottom).
 */
const CHECK_VELOCITIES = [96, 64, 32];
/**
 * Check points quieter than the reference by more than this (cB) are left out.
 */
const QUIET_CB = 400;
/**
 * Core's generator ranges: delays and holds up to 5000, the other times up to 8000.
 */
const MAX_GEN: Record<string, number> = {
    delayVolEnv: 5000, holdVolEnv: 5000, delayVoice: 5000,
    attackVolEnv: 8000, decayVolEnv: 8000, decay2VolEnv: 8000, releaseVolEnv: 8000
};

const capped = (gens: Record<string, number>) => {
    for (const name of Object.keys(gens)) {
        const max = MAX_GEN[name];
        if (max !== undefined) gens[name] = Math.min(gens[name], max);
    }
    return gens;
};

/**
 * The volume envelope generators at a key and velocity: the zone's generators plus its custom curves, clamped to
 * core's generator ranges.
 */
export function gensAt(zone: TvaZone, key: number, velocity: number) {
    const g = { ...zone.gens };
    for (const m of zone.mods) {
        const y = m.points![m.source === "key" ? key : velocity][1];
        g[m.dest] = (g[m.dest] ?? (m.dest === "initialAttenuation" ? 0 : -12000)) + ((y - 8192) / 8192) * m.amount;
    }
    return capped(g);
}

/**
 * The projection alone at the query's key and velocity: the generators (voice delay, delayVolEnv, instant onset, the
 * caps applied) and the gain at the envelope's 0 dB.
 */
function project(model: TvaModel, q: TvaZoneQuery) {
    const s = model.segments(q.b, q.key, q.velocity, q.levels);
    if (!s) return undefined;
    // a key off partial (byte 0 = 0xff) starts at the note off and runs its segments as if the key were held. The
    // bank plays it on release (sampleModes 2), where only the release shapes it: one slope that keeps the curve's
    // energy (exact for a plain fall in dB)
    if (q.b[0] === 0xff) {
        const segs = s.times.reduce((a, x) => a + x, 0) / 1000;
        const n = Math.min(MAX_HOLD, Math.max(HOLD, Math.ceil((1.2 * segs) / DT)));
        let g = model.curve(s, Float64Array.from({ length: n }, (_, i) => i * DT + GRID));
        if (q.end !== undefined) g = g.subarray(0, Math.max(2, Math.min(n, Math.ceil(q.end / DT))));
        let p = 0;
        for (let i = 1; i < g.length; i++) if (g[i] > g[p]) p = i;
        if (g[p] <= 0) return undefined;
        let energy = 0;
        for (let i = p; i < g.length; i++) energy += pow(g[i] / g[p], 2) * DT;
        const slope = 10 / Math.LN10 / Math.max(energy, DT);
        return {
            top: g[p],
            gens: { attackVolEnv: -12000, holdVolEnv: -12000, decayVolEnv: -12000, sustainVolEnv: 0,
                releaseVolEnv: Math.min(8000, Math.max(-7200, timecents(SILENCE_DB / slope))) } as Record<string, number>
        };
    }
    // the voice waits n ticks (its envelopes with it), the host's note off does not: the hold is that much shorter
    const n = model.delayTicks(q.b, q.velocity);
    const late = n ? n * TICK - 0.002 : 0;
    const lateDt = Math.round(late / DT);
    const segs = s.times.reduce((a, x) => a + x, 0) / 1000;
    const length = HOLD + RELEASE;
    // segments that outlast the hold go on in a held tail (up to MAX_HOLD)
    const full = Math.min(MAX_HOLD, Math.max(length, Math.ceil((1.2 * segs) / DT)));
    const t = Float64Array.from({ length: full }, (_, i) => i * DT + GRID);
    const hold = Math.max(1, HOLD - lateDt);
    const shortHold = Math.max(1, SHORT - lateDt);
    let long = model.curve(s, t.subarray(0, length), q.free ? undefined : hold * DT + GRID);
    let short = model.curve(s, t.subarray(0, SHORT + RELEASE), q.free ? undefined : shortHold * DT + GRID);
    let held = full > length ? model.curve(s, t) : undefined;
    let count = length;
    let heldCount = full;
    if (q.end !== undefined) {
        count = Math.max(2, Math.min(length, Math.ceil(q.end / DT)));
        heldCount = Math.max(2, Math.min(full, Math.ceil(q.end / DT)));
    }
    // a first segment that stays at level 0 (FeedbackGt2: 1.48 s) is a delay of the volume envelope. Every voice
    // starts its first tick's ramp from 0, so only a longer silence counts
    let lead = 0;
    while (lead < count && long[lead] <= 0) lead++;
    const skip = lead > 1 && (lead - 1) * DT > LEAD_MIN ? lead - 1 : 0;
    if (skip) {
        long = long.subarray(skip);
        short = short.subarray(Math.min(skip, short.length));
        held = held?.subarray(skip);
        count -= skip;
        heldCount -= skip;
    }
    const h = q.free ? count : Math.min(hold - skip, count);
    // the twin carries the release: a one shot that ends before the long hold does still has it on the twin
    const shortEnd = Math.min(short.length, count);
    const twin = !q.free && h >= SHORT && shortHold > skip + 1 && shortEnd > shortHold - skip + 2;
    const tailFrom = hold - skip;
    const tail = held && heldCount > tailFrom + 16 ? { gain: held.subarray(0, heldCount), from: tailFrom, weight: TAIL_WEIGHT }
        : undefined;
    const p = h < 1 ? undefined : projectVolume(
        { gain: long.subarray(0, count), dt: DT, holdPoints: h },
        twin ? { gain: short.subarray(0, shortEnd), dt: DT, holdPoints: shortHold - skip } : undefined,
        q.free,
        tail
    );
    if (!p) return undefined;
    const gens = { ...p.gens };
    if (late > START_DELAY_MIN) gens.delayVoice = timecents(late);
    if (skip) gens.delayVolEnv = timecents(skip * DT);
    // an attack of at most one and a half 128 frame blocks is none. A voice at its level from the very first point
    // starts at its peak (SFe -32768 delay and attack skip core's fade in)
    if (gens.attackVolEnv <= timecents(1.5 * DT)) {
        // its time stays in the hold, else a short hold ends early (MC-500 Beep: 0.7 -> 19 dB)
        const sec = (x: number) => (x <= -12000 ? 0 : pow(2, x / 1200));
        gens.holdVolEnv = timecents(sec(gens.attackVolEnv) + sec(gens.holdVolEnv));
        gens.attackVolEnv = -12000;
        let top = 0;
        for (let i = 0; i < Math.min(8, count); i++) top = Math.max(top, long[i]);
        if (!skip && top > 0 && long[0] >= 0.5 * top) {
            gens.attackVolEnv = INSTANT;
            gens.delayVolEnv = INSTANT;
        }
    }
    return { gens: capped(gens), top: p.top };
}

/**
 * The engine's curve as a check plays it (a 3 s hold and 1.5 s release from the voice's start, cut where a one shot
 * wave ends at that key, from the first sound on) against generators: dB RMS.
 */
function checkError(model: TvaModel, q: TvaZoneQuery, key: number, velocity: number, gens: Record<string, number>) {
    const s = model.segments(q.b, key, velocity, q.levels);
    if (!s) return 0;
    const n = model.delayTicks(q.b, velocity);
    const lateDt = Math.round((n ? n * TICK - 0.002 : 0) / DT);
    const length = HOLD + RELEASE;
    const hold = Math.max(1, HOLD - lateDt);
    let g = model.curve(s, Float64Array.from({ length }, (_, i) => i * DT + GRID), q.free ? undefined : hold * DT + GRID);
    const end = q.endAt ? q.endAt(key) : q.end;
    if (end !== undefined) g = g.subarray(0, Math.max(2, Math.min(length, Math.ceil(end / DT))));
    const dv = gens.delayVolEnv ?? -12000;
    const lead = dv > -12000 ? Math.min(g.length - 2, Math.round(pow(2, dv / 1200) / DT)) : 0;
    g = g.subarray(lead);
    let peak = 0;
    for (const x of g) peak = Math.max(peak, x);
    if (peak <= 0) return 0;
    return volumeRms({ gain: g, dt: DT, holdPoints: q.free ? g.length : Math.max(1, hold - lead) }, gens, peak, q.free);
}

export function tvaZone(model: TvaModel, q: TvaZoneQuery) {
    const p = project(model, q);
    if (!p) return undefined;
    const gens = p.gens;
    const keyOff = q.b[0] === 0xff;
    const mods = new Array<BankModulator>();
    const add = (m: BankModulator | undefined) => {
        if (m) mods.push(m);
    };
    // a key off partial keeps its release (an energy, not a segment time) and only takes the level curves
    const live = (name: string) => !keyOff && (gens[name] ?? -12000) > -12000;
    // key follow and velocity scale segments 0-1 by one multiplier, 2-3 by another and the release by a third (the
    // release by the late velocity scale). Taken from the segment times themselves, where the engine's 16 bit time
    // wraps or saturates at the extremes (velocity 1), else from the scales. The level follows the four segment
    // levels' peak
    const sRef = model.segments(q.b, q.key, q.velocity, q.levels)!;
    const [kr, krel] = model.keyScales(q.b, q.key);
    const vRef = model.velocityScales(q.b, q.velocity)!;
    const top = Math.max(...sRef.amps);
    const ratio = (a: number, b: number, scale: number) => (b > 0 ? 1200 * Math.log2(Math.max(a, 1) / b) : 1200 * Math.log2(scale));
    const shifts = (s: TvaSegments, early: number, late: number, release: number) => [
        ratio(s.times[0] + s.times[1], sRef.times[0] + sRef.times[1], early),
        ratio(s.times[2] + s.times[3], sRef.times[2] + sRef.times[3], late),
        ratio(s.release, sRef.release, release),
        s.amps.some((x) => x > 0) && top > 0 ? 200 * Math.log10(top / Math.max(...s.amps)) : 0
    ];
    // an attack or hold that mostly lies past the engine's segments 0-1 (both often 0: the hold is the first part of
    // a decay that starts as a line) scales as the decay does (JzVoice Dow at velocity 96: 22 -> 2.5 dB)
    const sec = (x: number | undefined) => (x === undefined || x <= -12000 ? 0 : pow(2, x / 1200));
    const early01 = (sRef.times[0] + sRef.times[1]) / 1000;
    const attackEnd = sec(gens.attackVolEnv);
    const holdEnd = attackEnd + sec(gens.holdVolEnv);
    const group = (name: string) => (name === "attackVolEnv" ? (early01 < 0.5 * attackEnd ? 1 : 0)
        : name === "holdVolEnv" ? (early01 < 0.5 * holdEnd ? 1 : 0) : 0);
    const write = (source: "key" | "velocity", c: Float64Array[]) => {
        // a silent first segment (delayVolEnv) is segment 0's time and scales with it
        for (const name of [...SEGMENT_TIMES, "delayVolEnv"]) if (live(name)) add(curveModulator(source, c[group(name)], name));
        for (const name of LATE_TIMES) if (live(name)) add(curveModulator(source, c[1], name));
        if (live("releaseVolEnv") && !q.free) add(curveModulator(source, c[2], "releaseVolEnv"));
        add(curveModulator(source, c[3], "initialAttenuation"));
    };
    // melodic zones of more than one key
    if (q.keyHi > q.keyLo) {
        const c = [0, 1, 2, 3].map(() => new Float64Array(128));
        for (let k = 0; k < 128; k++) {
            const kk = Math.max(q.keyLo, Math.min(q.keyHi, k));
            const s = model.segments(q.b, kk, q.velocity, q.levels);
            if (!s) continue;
            const [a, r] = model.keyScales(q.b, kk);
            shifts(s, a / kr, a / kr, r / krel).forEach((x, i) => (c[i][k] = x));
        }
        write("key", c);
    }
    // velocity within the partial's window (the crossfade window)
    {
        const c = [0, 1, 2, 3].map(() => new Float64Array(128));
        for (let v = 0; v < 128; v++) {
            const vv = Math.max(Math.max(1, q.velLo), Math.min(q.velHi, v));
            const s = model.segments(q.b, q.key, vv, q.levels);
            const sc = model.velocityScales(q.b, vv);
            if (!s || !sc) continue;
            shifts(s, sc[0] / vRef[0], sc[1] / vRef[1], sc[1] / vRef[1]).forEach((x, i) => (c[i][v] = x));
        }
        write("velocity", c);
        // the voice delay follows velocity through byte 1
        if (gens.delayVoice !== undefined) {
            const d = new Float64Array(128);
            for (let v = 0; v < 128; v++) {
                const vv = Math.max(Math.max(1, q.velLo), Math.min(q.velHi, v));
                d[v] = timecents(Math.max(model.delayTicks(q.b, vv) * TICK - 0.002, 0.001)) - gens.delayVoice;
            }
            add(curveModulator("velocity", d, "delayVoice"));
        }
    }
    const zone: TvaZone = { gens, mods, top: p.top };
    // the split check: the curves at the zone's edge keys and at lower velocities against the engine's curve there.
    // Where they miss by more than SPLIT_DB over the reference's own error, the projection at that point says
    // whether a zone of its own would do better by more than SPLIT_DB
    if (!keyOff) {
        const base = checkError(model, q, q.key, q.velocity, gens);
        const worse = (key: number, velocity: number) => {
            const at = gensAt(zone, key, velocity);
            // far below the reference the segment levels clamp at the level floor, and nobody hears the shape
            if ((at.initialAttenuation ?? 0) > QUIET_CB) return false;
            const rule = checkError(model, q, key, velocity, at);
            if (rule - base <= SPLIT_DB) return false;
            const own = project(model, { ...q, key, velocity, end: q.endAt ? q.endAt(key) : q.end });
            const o = own ? checkError(model, q, key, velocity, own.gens) : NaN;
            return !!own && rule - o > SPLIT_DB;
        };
        const split: TvaSplit = {};
        // the edge keys and half way to them
        const keys = [q.keyLo, (q.keyLo + q.key) >> 1, (q.key + q.keyHi + 1) >> 1, q.keyHi];
        if (keys.some((k, i) => k !== q.key && keys.indexOf(k) === i && worse(k, q.velocity))) {
            split.key = ((q.keyLo + q.keyHi) >> 1) + 1;
        }
        const bottom = Math.max(1, q.velLo);
        for (const v of [...CHECK_VELOCITIES, bottom]) {
            if (v < bottom || v >= q.velocity || model.velocityScales(q.b, v) === undefined) continue;
            if (worse(q.key, v)) {
                split.velocity = ((v + q.velocity) >> 1) + 1;
                break;
            }
        }
        if (split.key !== undefined || split.velocity !== undefined) zone.split = split;
    }
    return zone;
}

/**
 * A part's one shot end: the latest over its keys (endAt), else the zone's.
 */
function partEnd(q: TvaZoneQuery) {
    if (!q.endAt) return q.end;
    let end: number | undefined;
    for (let k = q.keyLo; k <= q.keyHi; k++) {
        const e = q.endAt(k);
        if (e !== undefined) end = Math.max(end ?? 0, e);
    }
    return end;
}

/**
 * The zone with its splits applied: each part projected at its own reference (the centre key, the window's top
 * velocity) and split again where its own check says so, up to MAX_PARTS parts. The keys split first. A drum zone
 * (one key) splits by velocity only.
 */
export function tvaZones(model: TvaModel, q: TvaZoneQuery) {
    const out = new Array<TvaPart>();
    const todo = [q];
    while (todo.length) {
        const part = todo.shift()!;
        const zone = tvaZone(model, part);
        if (!zone) continue;
        const split = out.length + todo.length + 2 <= MAX_PARTS ? zone.split : undefined;
        if (split?.key !== undefined) {
            const lo = { ...part, keyHi: split.key - 1, key: (part.keyLo + split.key - 1) >> 1 };
            const hi = { ...part, keyLo: split.key, key: (split.key + part.keyHi) >> 1 };
            todo.push({ ...lo, end: partEnd(lo) }, { ...hi, end: partEnd(hi) });
            continue;
        }
        if (split?.velocity !== undefined) {
            todo.push({ ...part, velHi: split.velocity - 1, velocity: split.velocity - 1 }, { ...part, velLo: split.velocity });
            continue;
        }
        out.push({ keyLo: part.keyLo, keyHi: part.keyHi, velLo: part.velLo, velHi: part.velHi, key: part.key,
            velocity: part.velocity, zone });
    }
    return out.sort((a, b) => a.keyLo - b.keyLo || a.velLo - b.velLo);
}
