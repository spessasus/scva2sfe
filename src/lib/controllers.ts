/**
 * The part's envelope and filter controllers as exact zone custom curves: the engine's answer at every controller
 * value.
 *
 * SC-VA latches CC73 (attack), CC75 (decay) and CC72 (release) at note on: the value biases the segment's index into
 * the rate curve by (value - 64) * 2. CC74 adds (value - 64) * 0x100 to the 15 bit cutoff sum, CC71 moves the damping
 * byte by 2 per step. Core maps the NRPNs (01 63 / 64 / 66, 01 20 / 21) onto the same controllers.
 */
import type { BankModulator } from "./bank.js";
import { pow } from "./math.js";
import { ccCurve, ccModulator } from "./curves.js";
import type { Generators } from "./envfit.js";
import type { SvfTap, Spectrum } from "./filter-map.js";
import { analogDesign, OPEN_CENTS, SVF_RATE, svfResponse } from "./filter-map.js";
import type { TvaModel } from "./tva.js";
import type { TvfModel, TvfVoice } from "./tvf.js";
import type { FilterMaps } from "./zone-tvf.js";

const MIN_SEGMENT_TICKS = 9;
// (controller, its default curve, generator, the partial's rate byte for it)
const ENVELOPE_CCS: [number, string, number][] = [
    [73, "attackVolEnv", 0x5e],
    [73, "holdVolEnv", 0x5f],
    [75, "decayVolEnv", 0x60],
    [75, "decay2VolEnv", 0x61],
    [72, "releaseVolEnv", 0x62]
];

/**
 * A segment's base length in rate curve ticks for a rate byte and the part's envelope bias, 0 for an instant one
 * (NativeTS `EnvelopeMachine::segment_milliseconds`).
 */
function segmentTicks(tva: TvaModel, rate: number, bias: number) {
    const index = (rate & 0x7f) + bias;
    if (index < 0) return 0;
    const t = tva.rateCurve(Math.min(index, 0x7f));
    return t < MIN_SEGMENT_TICKS ? 0 : t;
}

/**
 * CC73 / CC75 / CC72 on a melodic zone's volume envelope: the timecent offset of the segment against 64 at every
 * value (a segment the controller makes instant lands on the generator's floor). The writer drops core's defaults.
 */
export function envelopeModulators(tva: TvaModel, b: Uint8Array, gens: Generators) {
    const out = new Array<BankModulator>();
    for (const [cc, dest, byte] of ENVELOPE_CCS) {
        const gen = gens[dest] ?? -12000;
        if (gen <= -12000) continue;
        const base = segmentTicks(tva, b[byte], 0);
        if (base === 0) continue;
        // the curve depends on the rate byte alone (one per byte in the bank): a segment the controller makes
        // instant goes to -12000 below its base, core clamps the sum at the generator's floor
        const y = new Float64Array(128);
        for (let x = 0; x < 128; x++) {
            const t = segmentTicks(tva, b[byte], (x - 64) * 2);
            y[x] = t ? 1200 * Math.log2(t / base) : -12000;
        }
        const m = ccCurve(cc, y, dest);
        if (m && m.amount >= 20) out.push(m);
    }
    return out;
}

/**
 * How many cents one unit of the 15 bit cutoff sum moves the filter at coefficient f (the warp table's slope there):
 * an LFO or a controller adds to that sum.
 */
export function centsPerCutoffUnit(tvf: TvfModel, f: number) {
    const w = (Math.log2(Math.max(f, 1e-9)) + 15) * 4096;
    let h = 0;
    while (h < 127 && tvf.warpAt(h + 1) < w) h++;
    return ((tvf.warpAt(h + 1) - tvf.warpAt(h)) / 256) * 4 * 1200 / 16384;
}

/**
 * The 15 bit cutoff sum whose coefficient (no ceiling) is nearest f.
 */
function sumOf(tvf: TvfModel, f: number) {
    let lo = 0;
    let hi = 0x7fff;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (tvf.coefficient(tvf.warp(mid, 4)) < f) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

/**
 * Zero amount copies of core's CC74 default and the bank's CC71 pair: they switch those off in a zone (by identity).
 */
export function filterDefaultsOff() {
    return [ccModulator(74, "linear", 0, "initialFilterFc"), ccModulator(71, "linear", 0, "filterQOffset"),
        ccModulator(71, "linear", 0, "gain")];
}

const dampOf = (byte: number, cc: number) => Math.max(4, Math.min(0x7f, 2 * (64 - cc) + byte));

/**
 * CC74 and CC71 on a zone with a live filter through the engine's own path, as custom curves. CC74 moves the cutoff
 * (the open filter, the ceiling left to maxFilterFc), CC71 core's resonance, the passband gain and, on a lowpass, the
 * ceiling. A lowpass reads the filter map. A live highpass, bandpass or peak reads the analog design its zone's filter
 * came from (zone-tvf), cutoff in cents, core's resonance and its level term (qcb / 2): without these core's default
 * CC74 would sweep the highpass by its own amount (Fiddle under the cutoff NRPN went 0.5 octave bright). Zero amount
 * copies switch off core's defaults and the bank's CC71 pair.
 */
export function filterCcModulators(tvf: TvfModel, maps: FilterMaps, v: TvfVoice, held: number, tap: SvfTap = "low") {
    const low = tap === "low";
    const design = (f: number, q: number) => (low ? maps.plain.at(f, q) : analogDesign(f, q));
    // CC74's curve depends on the cutoff alone (1/12 octave grid), CC71's on the damping byte, the type and the
    // cutoff in 1/6 octaves: far fewer curves, well within a semitone
    const f = pow(2, Math.round(12 * Math.log2(Math.max(held, 1e-6))) / 12);
    const f71 = pow(2, Math.round(6 * Math.log2(Math.max(held, 1e-6))) / 6);
    const point = (sum: number, damp: number) => {
        const w = tvf.warp(sum, damp);
        const q = tvf.qTarget({ ...v, damp }, w);
        return design(Math.min(tvf.coefficient(w), tvf.fCeiling(q)), q / 131072);
    };
    // the lowpass's map is the open filter's, the other types keep their own response
    const open = low ? { ...v, type: 0, damp: 0x40 } : { ...v, damp: 0x40 };
    const openCents = (sum: number) => {
        const w = tvf.warp(sum, 4);
        return design(tvf.coefficient(w), tvf.qTarget(open, w) / 131072).cents;
    };
    // the analog design has no ceiling of its own, its cutoff stops where the open filter's does
    const capped = (cents: number) => (low ? cents : Math.min(cents, OPEN_CENTS));
    const ceilCents = (damp: number) => Math.min(point(0x7fff, damp).cents, OPEN_CENTS);
    const s0 = sumOf(tvf, f);
    const c0 = capped(openCents(s0));
    const s71 = sumOf(tvf, f71);
    const p0 = point(s71, v.damp);
    const top0 = low ? ceilCents(v.damp) : 0;
    const d74 = new Float64Array(128);
    const dq = new Float64Array(128);
    const dg = new Float64Array(128);
    const dc = new Float64Array(128);
    for (let x = 0; x < 128; x++) {
        d74[x] = capped(openCents(s0 + (x - 64) * 0x100)) - c0;
        const damp = dampOf(v.damp, x);
        const p = point(s71, damp);
        dq[x] = p.qcb - p0.qcb;
        dg[x] = 10 * (p.gainDb - p0.gainDb);
        if (low) dc[x] = ceilCents(damp) - top0;
    }
    const mods = [...filterDefaultsOff(), ccModulator(71, "linear", 0, "initialFilterQ")];
    const curves = [ccCurve(74, d74, "initialFilterFc"), ccCurve(71, dq, "filterQOffset"), ccCurve(71, dg, "gain")];
    if (low) curves.push(ccCurve(71, dc, "maxFilterFc"));
    for (const m of curves) {
        if (m) mods.push(m);
    }
    return mods;
}

/**
 * CC74 and CC71 on a zone whose highpass, bandpass or peak is baked into its sample: the level the engine's filter
 * lets through of the sample when the controller moves its cutoff or damping, as initialAttenuation curves (cB,
 * clamped to -240..600). Core's defaults would move its lowpass on top of the baked filter: zero amount
 * copies switch them off. The timbre stays the baked one.
 */
export function bakedFilterModulators(tvf: TvfModel, v: TvfVoice, tap: SvfTap, f: number, ratio: number, spectrum: Spectrum) {
    const keep = new Array<number>();
    for (let i = 0; i < spectrum.bins.length; i++) {
        const hz = spectrum.bins[i] * SVF_RATE * ratio;
        if (hz > 0 && hz < 15500) keep.push(i);
    }
    const hz = Float64Array.from(keep, (i) => spectrum.bins[i] * SVF_RATE * ratio);
    let total = 0;
    for (const i of keep) total += spectrum.power[i];
    const level = (sum: number, damp: number) => {
        const w = tvf.warp(sum, damp);
        const q = tvf.qTarget({ ...v, damp }, w);
        const h = svfResponse(Math.min(tvf.coefficient(w), tvf.fCeiling(q)), q / 131072, hz, tap);
        let p = 0;
        keep.forEach((i, j) => (p += spectrum.power[i] * h[j] * h[j]));
        return Math.sqrt(p / Math.max(total, 1e-30));
    };
    const s0 = sumOf(tvf, f);
    const base = Math.max(level(s0, v.damp), 1e-9);
    const db = (g: number) => Math.max(-24, Math.min(60, -20 * Math.log10(Math.max(g, 1e-9) / base)));
    const y74 = new Float64Array(128);
    const y71 = new Float64Array(128);
    for (let x = 0; x < 128; x++) {
        y74[x] = 10 * db(level(s0 + (x - 64) * 0x100, v.damp));
        y71[x] = 10 * db(level(s0, dampOf(v.damp, x)));
    }
    const mods = filterDefaultsOff();
    for (const m of [ccCurve(74, y74, "initialAttenuation"), ccCurve(71, y71, "initialAttenuation")]) {
        if (m && m.amount >= 5) mods.push(m);
    }
    return mods;
}
