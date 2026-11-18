/**
 * The engine's Chamberlin state variable filter against spessasynth_core's RBJ biquads, generic (no DLL data): the
 * two responses, the map from the SVF's (f, q) to core's lowpass (cutoff cents, resonance cB, passband gain dB) as a
 * least squares fit per grid point, built once at conversion time, the analog design core's highpass, bandpass and
 * peak take, and the level a zone needs where core's filter passes another share of a sample than the SVF.
 */
import { solve } from "./envfit.js";
import { pow } from "./math.js";

/**
 * The engine's rate.
 */
export const SVF_RATE = 32000;
/**
 * The rate the bank's filters are designed for (core runs at the output rate, 44.1 or 48 kHz in practice).
 */
export const DESIGN_RATE = 44100;
/**
 * Core bypasses its lowpass at this cutoff and no resonance, and takes no higher one.
 */
export const OPEN_CENTS = 13500;

export type SvfTap = "low" | "band" | "high" | "peak";

/**
 * Core's filterType for an SVF tap (the engine's low less high is core's peak).
 */
export const CORE_TYPES: Record<SvfTap, number> = { low: 0, high: 1, band: 2, peak: 3 };

/**
 * The SVF's magnitude at frequencies hz (at the engine's rate) for a tap: per sample low += f band, high = in - q band
 * - low, band += f high, solved per unit input.
 */
export function svfResponse(f: number, q: number, hz: ArrayLike<number>, tap: SvfTap) {
    const out = new Float64Array(hz.length);
    for (let i = 0; i < hz.length; i++) {
        const w = (2 * Math.PI * hz[i]) / SVF_RATE;
        // z1 = e^-jw, d = 1 - z1
        const zr = Math.cos(w);
        const zi = -Math.sin(w);
        const dr = 1 - zr;
        const di = -zi;
        // den = d + f q z1 + f^2 z1 / d
        const dd = dr * dr + di * di;
        const qr = (zr * dr + zi * di) / dd;
        const qi = (zi * dr - zr * di) / dd;
        const er = dr + f * q * zr + f * f * qr;
        const ei = di + f * q * zi + f * f * qi;
        const ee = er * er + ei * ei;
        // b = f / den
        const br = (f * er) / ee;
        const bi = (-f * ei) / ee;
        // low = f z1 b / d
        const lr0 = f * (zr * br - zi * bi);
        const li0 = f * (zr * bi + zi * br);
        const lr = (lr0 * dr + li0 * di) / dd;
        const li = (li0 * dr - lr0 * di) / dd;
        // high = 1 - q z1 b - low
        const hr = 1 - q * (zr * br - zi * bi) - lr;
        const hi = -q * (zr * bi + zi * br) - li;
        let mr: number;
        let mi: number;
        if (tap === "low") {
            mr = lr;
            mi = li;
        } else if (tap === "band") {
            mr = br;
            mi = bi;
        } else if (tap === "high") {
            mr = hr;
            mi = hi;
        } else {
            mr = lr - hr;
            mi = li - hi;
        }
        out[i] = Math.hypot(mr, mi);
    }
    return out;
}

/**
 * Core's biquad magnitude (voice_filter.ts computeCoefficients) for filterType type at cutoff cents and resonance cB,
 * the passband loss of the resonance included.
 */
export function coreResponse(type: number, cents: number, qcb: number, hz: ArrayLike<number>, rate = DESIGN_RATE) {
    return coreOn(type, cents, qcb, trigOf(hz, rate), rate);
}

interface Trig {
    c1: Float64Array;
    s1: Float64Array;
    c2: Float64Array;
    s2: Float64Array;
}

function trigOf(hz: ArrayLike<number>, rate: number) {
    const x = Float64Array.from(hz, (h) => (2 * Math.PI * h) / rate);
    return { c1: x.map(Math.cos), s1: x.map(Math.sin), c2: x.map((v) => Math.cos(2 * v)), s2: x.map((v) => Math.sin(2 * v)) };
}

function coreOn(type: number, cents: number, qcb: number, trig: Trig, rate: number) {
    const fc = Math.min(8.176 * pow(2, cents / 1200), rate * 0.45);
    const resonance = pow(10, (qcb - 30.1) / 200);
    const qGain = 1 / Math.sqrt(pow(10, qcb / 200));
    const w = (2 * Math.PI * fc) / rate;
    const cw = Math.cos(w);
    const sw = Math.sin(w);
    const alpha = sw / (2 * resonance);
    let b0: number;
    let b1: number;
    let b2: number;
    if (type === 1) {
        b0 = ((1 + cw) / 2) * qGain;
        b1 = -(1 + cw) * qGain;
        b2 = b0;
    } else if (type === 2) {
        b0 = (sw / 2) * qGain;
        b1 = 0;
        b2 = -b0;
    } else if (type === 3) {
        b0 = -cw * qGain;
        b1 = 2 * qGain;
        b2 = b0;
    } else {
        b1 = (1 - cw) * qGain;
        b0 = b1 / 2;
        b2 = b0;
    }
    const a0 = 1 + alpha;
    const a1 = -2 * cw;
    const a2 = 1 - alpha;
    const n = trig.c1.length;
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const c1 = trig.c1[i];
        const s1 = trig.s1[i];
        const c2 = trig.c2[i];
        const s2 = trig.s2[i];
        const nr = b0 + b1 * c1 + b2 * c2;
        const ni = -(b1 * s1 + b2 * s2);
        const dr = a0 + a1 * c1 + a2 * c2;
        const di = -(a1 * s1 + a2 * s2);
        out[i] = Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di));
    }
    return out;
}

/**
 * The SVF's analog design as core cents and resonance: cutoff fs / pi asin(f / 2), Q = 1 / q, and the passband
 * loss core takes for that resonance given back as gain (dB). Core's highpass, bandpass and peak take it.
 */
export function analogDesign(f: number, q: number) {
    const cents = 1200 * Math.log2(Math.max((SVF_RATE / Math.PI) * Math.asin(Math.min(1, f / 2)), 10) / 8.176);
    const qcb = 200 * Math.log10(1 / q) + 30.1;
    return { cents, qcb, gainDb: qcb / 20 };
}

/**
 * Log spaced frequencies from 30 Hz to 16 kHz.
 */
export function logHz(n: number) {
    return Float64Array.from({ length: n }, (_, i) => Math.exp(Math.log(30) + ((Math.log(16000) - Math.log(30)) * i) / (n - 1)));
}

const HZ = logHz(100);
const HZ_TRIG = trigOf(HZ, DESIGN_RATE);
/**
 * The resonance pull's weight per cB (a 1000 cB resonance weighs like one frequency 1 dB off).
 */
const PULL = 0.001;

export interface MapPoint {
    cents: number;
    qcb: number;
    gainDb: number;
    /**
     * The fit's RMS error (dB, weighted).
     */
    err: number;
}

const toDb = (h: Float64Array) => h.map((x) => 20 * Math.log10(Math.max(x, 1e-12)));

/**
 * Core's (cents, Q cB, gain dB) closest to the SVF lowpass at (f, q) in dB over 30 Hz to 16 kHz, the passband and the
 * corner weighing fully, the stopband less the deeper it goes. signed: the resonance may go under 0 (SFe
 * filterQOffset, a Q under 0.707, for an overdamped SVF), for filters that hold still. starts: extra starting points.
 */
export function fitLowpass(f: number, q: number, signed: boolean, starts: number[][] = []) {
    const target = toDb(svfResponse(f, q, HZ, "low"));
    let peak = -Infinity;
    for (const x of target) peak = Math.max(peak, x);
    const w = target.map((x) => Math.min(1, Math.max(0.1, (x - peak + 60) / 30)));
    const fc0 = (SVF_RATE / Math.PI) * Math.asin(Math.min(1, f / 2));
    const c0 = 1200 * Math.log2(Math.max(fc0, 10) / 8.176);
    const bump = Math.max(0, peak - target[0]);
    // a faint pull of the resonance toward 0 picks the plain one where the fit cannot tell (a cutoff under the
    // grid's lowest frequency, a corner near Nyquist): it leaves a real minimum where it is
    const resid = (x: Float64Array) => {
        const h = toDb(coreOn(0, x[0], x[1], HZ_TRIG, DESIGN_RATE));
        const r = new Float64Array(h.length + 1);
        for (let i = 0; i < h.length; i++) r[i] = (h[i] + x[2] - target[i]) * w[i];
        r[h.length] = x[1] * PULL;
        return r;
    };
    const lo = Float64Array.from([1500, signed ? -960 : 0, signed ? -48 : -1]);
    const hi = Float64Array.from([14500, 960, 48]);
    const scale = Float64Array.from([100, 30, 1]);
    let best: { x: Float64Array; cost: number } | undefined;
    const q0s = [...new Set([...(signed ? [-60] : []), 0, bump * 10, bump * 20])];
    const all = [...q0s.map((q0) => [Math.min(Math.max(c0, 1600), 14400), Math.min(q0, 950), Math.min(q0, 950) / 20]), ...starts];
    for (const s of all) {
        const r = solve(resid, Float64Array.from(s), lo, hi, scale, 200);
        if (!best || r.cost < best.cost) best = r;
    }
    const res = resid(best!.x);
    let e = 0;
    for (let i = 0; i < w.length; i++) e += pow(res[i] / w[i], 2);
    return { cents: best!.x[0], qcb: best!.x[1], gainDb: best!.x[2], err: Math.sqrt(e / w.length) };
}

/**
 * The lowpass map on a grid, f log spaced over 0.004..2 and q over 0.06..2 (every damping the engine makes), looked
 * up bilinearly in log f and log q. Built at conversion time, a few seconds.
 */
export class FilterMap {
    public static readonly F_LO = 0.004;
    public static readonly F_HI = 2.0;
    public static readonly Q_LO = 0.06;
    public static readonly Q_HI = 2.0;
    public static readonly NF = 130;
    public static readonly NQ = 24;
    public readonly signed;
    /**
     * cents, qcb, gainDb, err per (f, q) point, q fastest.
     */
    public readonly table;

    private constructor(signed: boolean, table: Float64Array) {
        this.signed = signed;
        this.table = table;
    }

    public static fAt(i: number) {
        return Math.exp(Math.log(FilterMap.F_LO) + ((Math.log(FilterMap.F_HI) - Math.log(FilterMap.F_LO)) * i) / (FilterMap.NF - 1));
    }

    public static qAt(j: number) {
        return Math.exp(Math.log(FilterMap.Q_LO) + ((Math.log(FilterMap.Q_HI) - Math.log(FilterMap.Q_LO)) * j) / (FilterMap.NQ - 1));
    }

    /**
     * Fits every grid point.
     */
    public static build(signed = false) {
        return new FilterMap(signed, FilterMap.rows(signed, 0, FilterMap.NF));
    }

    /**
     * The table's rows from..to - 1 (each f's NQ points), so a pool can fit them in parts.
     */
    public static rows(signed: boolean, from: number, to: number) {
        const { NQ } = FilterMap;
        const table = new Float64Array((to - from) * NQ * 4);
        for (let i = from; i < to; i++) {
            for (let j = 0; j < NQ; j++) {
                const p = fitLowpass(FilterMap.fAt(i), FilterMap.qAt(j), signed);
                table.set([p.cents, p.qcb, p.gainDb, p.err], ((i - from) * NQ + j) * 4);
            }
        }
        return table;
    }

    public static from(signed: boolean, table: Float64Array) {
        return new FilterMap(signed, table);
    }

    public at(f: number, q: number) {
        const { NF, NQ } = FilterMap;
        const lf = Math.min(Math.max(((Math.log(Math.max(f, 1e-9)) - LOG_F_LO) / LOG_F_SPAN) * (NF - 1), 0), NF - 1.0001);
        const lq = Math.min(Math.max(((Math.log(q) - LOG_Q_LO) / LOG_Q_SPAN) * (NQ - 1), 0), NQ - 1.0001);
        const i = Math.floor(lf);
        const j = Math.floor(lq);
        const a = lf - i;
        const b = lq - j;
        const t = this.table;
        // the four corners' rows, no closures here: this runs millions of times a conversion
        const i00 = (i * NQ + j) * 4;
        const i10 = ((i + 1) * NQ + j) * 4;
        const i01 = (i * NQ + j + 1) * 4;
        const i11 = ((i + 1) * NQ + j + 1) * 4;
        return {
            cents: t[i00] * (1 - a) * (1 - b) + t[i10] * a * (1 - b) + t[i01] * (1 - a) * b + t[i11] * a * b,
            qcb: t[i00 + 1] * (1 - a) * (1 - b) + t[i10 + 1] * a * (1 - b) + t[i01 + 1] * (1 - a) * b + t[i11 + 1] * a * b,
            gainDb: t[i00 + 2] * (1 - a) * (1 - b) + t[i10 + 2] * a * (1 - b) + t[i01 + 2] * (1 - a) * b + t[i11 + 2] * a * b,
            err: t[i00 + 3] * (1 - a) * (1 - b) + t[i10 + 3] * a * (1 - b) + t[i01 + 3] * (1 - a) * b + t[i11 + 3] * a * b
        };
    }
}

const LOG_F_LO = Math.log(FilterMap.F_LO);
const LOG_F_SPAN = Math.log(FilterMap.F_HI) - Math.log(FilterMap.F_LO);
const LOG_Q_LO = Math.log(FilterMap.Q_LO);
const LOG_Q_SPAN = Math.log(FilterMap.Q_HI) - Math.log(FilterMap.Q_LO);

/**
 * A sample's power spectrum as the filter sees it: bins in cycles per sample of the wave and their power.
 */
export interface Spectrum {
    bins: Float64Array;
    power: Float64Array;
}

/**
 * The level and the spectral centroid of a sample through a response: the share of the sample's power a magnitude
 * h(hz) lets through, played at ratio (the wave's frequencies move by it), below 15.5 kHz.
 */
function through(spectrum: Spectrum, ratio: number, h: (hz: Float64Array) => Float64Array) {
    const keep = new Array<number>();
    for (let i = 0; i < spectrum.bins.length; i++) {
        const hz = spectrum.bins[i] * SVF_RATE * ratio;
        if (hz > 0 && hz < 15500) keep.push(i);
    }
    const hz = Float64Array.from(keep, (i) => spectrum.bins[i] * SVF_RATE * ratio);
    const power = Float64Array.from(keep, (i) => spectrum.power[i]);
    const g = h(hz);
    let total = 0;
    let passed = 0;
    let moment = 0;
    for (let i = 0; i < hz.length; i++) {
        const p = power[i] * g[i] * g[i];
        total += power[i];
        passed += p;
        moment += p * hz[i];
    }
    return { total, passed, centroid: passed > 0 ? moment / passed : 0 };
}

/**
 * A static highpass, bandpass or peak as core's live filter of that type (the analog design) against the engine's
 * SVF over a sample's spectrum played at ratio: the octaves the live tone's centroid moves, the level make-up in cB
 * the zone needs (the SVF's share over core's) and the SVF's own power gain in cB (the level of a baked copy).
 */
export function staticFilter(tap: SvfTap, f: number, q: number, ratio: number, spectrum: Spectrum) {
    const d = analogDesign(f, q);
    const svf = through(spectrum, ratio, (hz) => svfResponse(f, q, hz, tap));
    const core = through(spectrum, ratio, (hz) => coreResponse(CORE_TYPES[tap], d.cents, d.qcb, hz).map((x) => x * pow(10, d.qcb / 400)));
    if (svf.total <= 0) return { move: 0, makeUp: 0, svfGain: 0 };
    const move = Math.log2(Math.max(core.centroid, 1) / Math.max(svf.centroid, 1));
    return {
        move, makeUp: 100 * Math.log10(Math.max(svf.passed, 1e-30) / Math.max(core.passed, 1e-30)),
        svfGain: 100 * Math.log10(Math.max(svf.passed, 1e-30) / svf.total)
    };
}

/**
 * The level make-up (cB) a lowpass zone needs beyond the map's passband gain: the SVF lowpass at (f, q) against core's
 * lowpass at the map's point for it, over the sample's spectrum played at ratio.
 */
export function lowpassMakeUp(f: number, q: number, p: MapPoint, ratio: number, spectrum: Spectrum) {
    const svf = through(spectrum, ratio, (hz) => svfResponse(f, q, hz, "low"));
    const core = through(spectrum, ratio, (hz) => coreResponse(0, Math.min(p.cents, OPEN_CENTS), p.qcb, hz).map((x) => x * pow(10, p.gainDb / 20)));
    if (svf.total <= 0) return 0;
    return 100 * Math.log10(Math.max(svf.passed, 1e-30) / Math.max(core.passed, 1e-30));
}
