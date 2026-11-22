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
import { ccCurve, ccModulator, ccScale, curveModulator } from "./curves.js";
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
 * The zone an envelope curve is for: its reference key and velocity (the TVA fit's) and its key and velocity window.
 */
export interface EnvelopeZone {
    key: number;
    velocity: number;
    keyLo: number;
    keyHi: number;
    velLo: number;
    velHi: number;
}

/**
 * CC73 / CC75 / CC72 on a zone's volume envelope: the timecent offset of the segment against 64 at every value (a
 * segment the controller makes instant lands on the generator's floor). The writer drops core's defaults. A drum key
 * gets CC73 only (DLL A/B: attack 96 took drum hits 23 to 37 dB down there). The engine moves drum decays with CC75
 * too, but the fit's drum decays do not follow one rate byte (TR-808 open hat went 15 dB quiet at CC75 32), and the
 * DLL ignores CC72 on drum keys. The drum hold keeps CC73: without it the TR-808 kit's onset at CC73 96 went back from
 * 8 to 30 dB off the DLL.
 */
export function envelopeModulators(tva: TvaModel, b: Uint8Array, gens: Generators, zone: EnvelopeZone, drum = false) {
    const out = new Array<BankModulator>();
    // an absolute segment time takes the key follow and velocity scales the engine applies (TvaModel.segments): the
    // attack and hold the early ones (wrapping at 16 bits as the engine does), the release the release key scale and
    // the late velocity one
    const early = (byte: number) => byte === 0x5e || byte === 0x5f;
    const keyScale = (byte: number, key: number) => tva.keyScales(b, key)[early(byte) ? 0 : 1];
    const velocityScale = (byte: number, velocity: number) => (tva.velocityScales(b, velocity) ?? [0x100, 0x100])[early(byte) ? 0 : 1];
    for (const [cc, dest, byte] of ENVELOPE_CCS) {
        if (drum && cc !== 73) continue;
        const gen = gens[dest] ?? -12000;
        const base = segmentTicks(tva, b[byte], 0);
        // an instant attack, hold or release turns into a timed one above 64 (the bias moves its rate index up the
        // curve), and so does an attack or hold the fit folded to its floor (at most 6 ms, zone-tva) while the hold is
        // instant (a timed hold carries the folded attack, and its ratio curve below scales both). 70 % of the partials
        // start instantly, and CC73 / the attack NRPN did nothing on them (the DLL reaches about a second at 96). The
        // decays stay off this: their generators come from the envelope fit, not from one rate byte each
        const folded = base > 0 && early(byte) && gen <= -12000 && segmentTicks(tva, b[0x5f], 0) === 0;
        if ((base === 0 && byte !== 0x60 && byte !== 0x61) || folded) {
            const k0 = keyScale(byte, zone.key);
            const v0 = velocityScale(byte, zone.velocity);
            const y = new Float64Array(128);
            for (let x = 65; x < 128; x++) {
                const raw = segmentTicks(tva, b[byte], (x - 64) * 2);
                const t = early(byte) ? ((v0 * Math.min((k0 * raw) >>> 8, 0xffff)) >>> 8) & 0xffff : (Math.min((k0 * raw) >>> 8, 0xffff) * v0) >>> 8;
                if (!t) continue;
                // a generator that holds time already (the fit folds short attacks into the hold) gets the segment's
                // time added. One at its floor, or at SFe's -32768 attack (no fade in), gets the time itself: 32767 is
                // the largest amount, so such an attack stops at about a second (the audit's CC73 127 attacks are a
                // median 0.26 log2 off)
                y[x] = gen > -12000 ? 1200 * Math.log2(1 + t / 1000 / pow(2, gen / 1200)) : Math.max(0, Math.min(32767, 1200 * Math.log2(t / 1000) - gen));
            }
            const m = ccCurve(cc, y, dest);
            if (!m || m.amount < 20) continue;
            out.push(m);
            // the time is the reference key's and velocity's: the engine's key follow and velocity scale move it
            // elsewhere. A generator at its floor has no key or velocity curve of its own (zone-tva writes those for
            // the others, which would count twice). These count only where the segment is timed: anywhere else they
            // would move a -32768 attack off its exact value, and core would fade it in
            if (gen > -12000) continue;
            const timed = ccScale(cc, Array.from(y, (v) => (v > 0 ? 1 : 0)));
            const follow = (source: "key" | "velocity", lo: number, hi: number, at: (x: number) => number, ref: number) => {
                if (hi <= lo) return;
                const c = new Float64Array(128);
                for (let x = 0; x < 128; x++) c[x] = 1200 * Math.log2(Math.max(at(Math.max(lo, Math.min(hi, x))), 1) / ref);
                const f = curveModulator(source, c, dest);
                if (f && f.amount >= 20) out.push({ ...f, secondary: timed });
            };
            follow("key", zone.keyLo, zone.keyHi, (k) => keyScale(byte, k), k0);
            follow("velocity", Math.max(1, zone.velLo), zone.velHi, (v) => velocityScale(byte, v), v0);
            continue;
        }
        if (base === 0 || gen <= -12000) continue;
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
 * CC72 on a zone's TVF envelope release (releaseModEnv, the cutoff fit's main envelope): the engine biases the TVF
 * release rate (byte 0x43) like the TVA's (tvf_compute_env_rates). Modulation envelope 2 is left alone: it is the
 * pitch envelope's or the cutoff fit's fast decay, neither of which follows the TVF release. CC75 and CC73 bias the
 * TVF's other rates too, but the fit spreads those segments over its generators freely: a ratio curve on decayModEnv
 * moved the opening sweep with CC75 (Harpsichord 2.5 octaves dull early at CC75 0), so they wait for a fit per
 * controller value. An instant TVF release stays instant here (the TVA's turns timed above 64). Not on drum keys,
 * which ignore CC72.
 */
export function tvfReleaseModulators(tva: TvaModel, b: Uint8Array, gens: Generators) {
    const out = new Array<BankModulator>();
    const base = segmentTicks(tva, b[0x43], 0);
    if (base === 0 || (gens.releaseModEnv ?? -12000) <= -12000) return out;
    const y = new Float64Array(128);
    for (let x = 0; x < 128; x++) {
        const t = segmentTicks(tva, b[0x43], (x - 64) * 2);
        y[x] = t ? 1200 * Math.log2(t / base) : -12000;
    }
    const m = ccCurve(72, y, "releaseModEnv");
    if (m && m.amount >= 20) out.push(m);
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
 * Zero amount copies of the CC74 and CC71 defaults: they switch those off in a zone (by identity). The CC71 default
 * (SFe 7.3) moves filterQOffset above 64 only, through a CC71 switch amount source.
 */
export function filterDefaultsOff() {
    const resonance = ccModulator(71, "linear", 0, "filterQOffset");
    resonance.secondary = { source: "cc", cc: 71, curve: "switch", negative: false, bipolar: false };
    return [ccModulator(74, "linear", 0, "initialFilterFc"), resonance];
}

const dampOf = (byte: number, cc: number) => Math.max(4, Math.min(0x7f, 2 * (64 - cc) + byte));

/**
 * CC74 and CC71 on a zone with a live filter through the engine's own path, as custom curves. CC74 moves the cutoff
 * (the open filter, the ceiling left to maxFilterFc), CC71 core's resonance, the passband gain and, on a lowpass, the
 * ceiling. A lowpass reads the filter map, and there CC71 also moves the cutoff, CC74 above 64 raises the resonance,
 * and each CC71 curve carries a CC74 amount curve (CC71's answer depends on where CC74 put the cutoff). signed: the
 * zone's lowpass came from the signed map, where its CC71 curves start. A live highpass, bandpass or peak reads the
 * analog design its zone's filter came from (zone-tvf), cutoff in cents and core's resonance: without these core's
 * default CC74 would sweep the highpass by its own amount (Fiddle under the cutoff NRPN went 0.5 octave bright). Zero
 * amount copies switch off core's defaults.
 */
export function filterCcModulators(tvf: TvfModel, maps: FilterMaps, v: TvfVoice, held: number, tap: SvfTap = "low", signed = false) {
    const low = tap === "low";
    const design = (f: number, q: number, map = maps.plain) => (low ? map.at(f, q) : analogDesign(f, q));
    // CC74's curve depends on the cutoff alone (1/12 octave grid), CC71's on the damping byte, the type and the
    // cutoff in 1/6 octaves: far fewer curves, well within a semitone
    const f = pow(2, Math.round(12 * Math.log2(Math.max(held, 1e-6))) / 12);
    const f71 = pow(2, Math.round(6 * Math.log2(Math.max(held, 1e-6))) / 6);
    const point = (sum: number, damp: number, map = maps.plain) => {
        const w = tvf.warp(sum, damp);
        const q = tvf.qTarget({ ...v, damp }, w);
        return design(Math.min(tvf.coefficient(w), tvf.fCeiling(q)), q / 131072, map);
    };
    // CC71 starts from the map the zone's own filter came from: a static lowpass took the signed one, and the plain
    // map's Q and cutoff steps from there are not the zone's (Square's resonance NRPN added a fifth of its Q)
    const own = signed ? maps.signed : maps.plain;
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
    const p0 = point(s71, v.damp, own);
    const top0 = low ? ceilCents(v.damp) : 0;
    const d74 = new Float64Array(128);
    const dq = new Float64Array(128);
    const dg = new Float64Array(128);
    const dc = new Float64Array(128);
    const d71 = new Float64Array(128);
    for (let x = 0; x < 128; x++) {
        d74[x] = capped(openCents(s0 + (x - 64) * 0x100)) - c0;
        const damp = dampOf(v.damp, x);
        const p = point(s71, damp, own);
        dq[x] = p.qcb - p0.qcb;
        dg[x] = 10 * (p.gainDb - p0.gainDb);
        // the SVF keeps its coefficient, but core's closest cutoff moves with the damping: a gentle SVF reads as an
        // open core filter, the same SVF with more resonance as one with its peak inside the band (Square under
        // the resonance NRPN went an octave dull without this). Core's cutoff stops at OPEN_CENTS.
        // measured on lowpass zones only (the analog design's cutoff moves with the damping only through the ceiling)
        if (low) d71[x] = Math.min(p.cents, OPEN_CENTS) - Math.min(p0.cents, OPEN_CENTS);
        // the ceiling caps the cutoff envelope's pushes. A static zone has none, and its maxFilterFc sits at or above
        // its own cutoff (zone-tvf): there the ceiling only opens (CC71 below 64), a lower one would clamp the cutoff
        // CC71 and CC74 move together
        if (low) dc[x] = signed ? Math.max(0, ceilCents(damp) - top0) : ceilCents(damp) - top0;
    }
    // core adds the CC71 and CC74 curves, but CC71's answer depends on where CC74 put the cutoff: near the open
    // filter resonance moves core's closest cutoff, Q and level far more than inside the band (with the cutoff NRPN
    // down, Organ 1 under the resonance NRPN went 40 dB quiet). Each CC71 curve gets a CC74 amount curve, the least
    // squares scale of its answer at CC74 values on a grid against the answer at 64 (exactly 1 there)
    const grid = new Array<number>();
    for (let x = 0; x < 128; x += 4) grid.push(x);
    grid.push(127);
    // the analog design taps keep their CC71 curves as they are (their cutoff moves with the damping only at the
    // ceiling)
    const at74 = !low ? [] : grid.map((x74) => {
        const s = Math.max(0, Math.min(0x7fff, s71 + (x74 - 64) * 0x100));
        const q0 = point(s, v.damp, own);
        const t0 = Math.min(q0.cents, OPEN_CENTS);
        // core's own sum at this CC74 value: the lowpass's CC74 curve is not capped, so above the open filter the
        // pull to a cutoff inside the band starts from there (Square at CC74 74 stayed open under resonance 84). d74
        // sits on the 1/12 octave grid and p0 on the 1/6 one, so this base can be up to about 100 cents off
        const sum0 = Math.min(p0.cents, OPEN_CENTS) + d74[x74];
        const rows = { c: new Float64Array(128), q: new Float64Array(128), g: new Float64Array(128), q0 };
        for (let x = 0; x < 128; x++) {
            const p = point(s, dampOf(v.damp, x), own);
            const t = Math.min(p.cents, OPEN_CENTS);
            rows.c[x] = t < OPEN_CENTS && t0 >= OPEN_CENTS ? t - Math.max(sum0, OPEN_CENTS) : t - t0;
            rows.q[x] = p.qcb - q0.qcb;
            rows.g[x] = 10 * (p.gainDb - q0.gainDb);
        }
        return rows;
    });
    // grid values to every CC74 value, linearly
    const spread = (h: number[]) => {
        const full = new Float64Array(128);
        for (let x = 0; x < 128; x++) {
            let j = 0;
            while (j < grid.length - 2 && grid[j + 1] <= x) j++;
            const t = (x - grid[j]) / (grid[j + 1] - grid[j]);
            full[x] = h[j] + (h[j + 1] - h[j]) * t;
        }
        return full;
    };
    const scaled = (m: BankModulator | undefined, g: Float64Array, row: "c" | "q" | "g") => {
        if (!m || !low) return m;
        let gg = 0;
        for (let x = 0; x < 128; x++) gg += g[x] * g[x];
        const full = spread(
            at74.map((r) => {
                let s = 0;
                for (let x = 0; x < 128; x++) s += g[x] * r[row][x];
                return Math.max(0, s / gg);
            })
        );
        let top = 0;
        let off = 0;
        for (let x = 0; x < 128; x++) {
            top = Math.max(top, full[x]);
            off = Math.max(off, Math.abs(full[x] - 1));
        }
        // a curve CC74 hardly changes stays on its own
        if (off < 0.02) return m;
        // the amount is a 16 bit number: past it the scale stops at the top (ccScale clips at 1)
        const amount = Math.min(32767, Math.round(m.amount * top));
        const unit = amount / m.amount;
        m.amount = amount;
        m.secondary = ccScale(74, full.map((y) => y / unit));
        return m;
    };
    const mods = filterDefaultsOff();
    // CC74 above 64 raises the zone's own resonance as well: the map reads a resonant SVF near the top with a higher Q
    // than at the held cutoff, and the CC71 curves above are scaled from that base (Square at CC74 74 kept the held
    // cutoff's Q of -172 cB under resonance 84, a flat peak). Only up and only above 64: the map's lower Qs (and its
    // gain) cost CC74 0 about 1 dB median against the DLL and Sine Wave 7 dB at CC74 96
    const curves = [
        ccCurve(74, d74, "initialFilterFc"),
        low ? ccCurve(74, spread(at74.map((r, j) => (grid[j] >= 64 ? Math.max(0, r.q0.qcb - p0.qcb) : 0))), "filterQOffset") : undefined,
        scaled(ccCurve(71, d71, "initialFilterFc"), d71, "c"),
        scaled(ccCurve(71, dq, "filterQOffset"), dq, "q"),
        scaled(ccCurve(71, dg, "gain"), dg, "g")
    ];
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
