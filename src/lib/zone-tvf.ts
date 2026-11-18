/**
 * A zone's filter: the engine's TVF curve at a reference key and velocity (tvf.ts, exact), mapped through the generic
 * SVF-to-biquad map (filter-map.ts) to core's cutoff in cents, then SFe's modulation envelope projected onto it (or a
 * static cutoff where it holds still), modulation envelope 2 for a fast first fall where the pitch side leaves it
 * free. The cutoff key follow, the envelope's velocity depth and the key and velocity scaling of its times become
 * exact custom curves. Filter types, the static filter rule (live with a level make-up or a baked copy) and the level
 * make-up all come from the two filters' responses. Nothing is rendered.
 */
import type { BankModulator } from "./bank.js";
import { pow } from "./math.js";
import { curveModulator } from "./curves.js";
import { bestOf, Memo, modEnv, warmMemo, modGenerators, modParams, solve, timecents } from "./envfit.js";
import type { FilterMap, Spectrum } from "./filter-map.js";
import { analogDesign, CORE_TYPES, lowpassMakeUp, OPEN_CENTS, staticFilter } from "./filter-map.js";
import type { LevelContext } from "./tva.js";
import type { Tap, TvfModel, TvfVoice } from "./tvf.js";
import { TICK_BLOCKS } from "./tvf.js";

/**
 * The grid (s): two 64-frame calls, 4 blocks.
 */
const DT = 128 / 32000;
const GRID_BLOCKS = 4;
/**
 * The curve: a 3 s hold and 1.5 s of release, the setup the rules were tuned on.
 */
const HOLD = 750;
const RELEASE = 375;
/**
 * The first control tick runs 7 blocks into the voice (the engine's tick phase against a note on at a call's start),
 * a note off reaches the voice on the first tick at least one block after the host's note off frame.
 */
export const FIRST_TICK = 7;
const OFF_BLOCKS = 1;
/**
 * The voice's first block plays 3 blocks after the note on.
 */
export const START_BLOCKS = 3;
/**
 * A curve that moves less than this (weighted RMS, cents) is a static cutoff.
 */
export const FILTER_FLAT = 30;
/**
 * A static highpass, bandpass or peak plays live unless core's filter moves the tone's centroid more than this
 * (octaves, the user's rule): then the zone takes a copy of its sample with the SVF baked in.
 */
export const STATIC_MOVE = 0.3;
/**
 * The fast segment on modulation envelope 2 stays where it takes a third off the error and moves 100 cents.
 */
const FAST_KEEP = 0.67;
const FAST_MIN = 100;
/**
 * The reference moves off the query's note when that note's curve moves less than this share of the most moving
 * candidate's (weighted RMS): first the velocities below, then the zone's keys.
 */
const REF_SHARE = 0.5;
const REF_VELOCITIES = [112, 96, 80, 64, 48, 32, 16];
/**
 * A key or velocity whose curve sits at the ceiling on more than this share of its weight is fitted as pinned there.
 */
const CLAMP_SHARE = 0.25;
/**
 * The split check's limit (cents of weighted RMS, a quarter octave) and the velocities it looks at below the reference.
 */
const SPLIT_CENTS = 300;
const SPLIT_VELOCITIES = [96, 64, 32];
/**
 * The TVA curve's point i sits at i * DT + GRID on the model's time axis (zone-tva.ts), the loudness weights follow
 * it. The TVF's own grid needs no offset: point i is the voice's block 4 i exactly.
 */
const GRID = 0.002;
const MIN_TIME = 0.001;
const MAX_HOLD = pow(2, 5000 / 1200);
const MAX_TIME = pow(2, 8000 / 1200);
/**
 * soft_l1's scale (cents times weight), as envfit.ts's modulation envelope fit.
 */
const SOFT = 5;
/**
 * Residual evaluations per start.
 */
const MAX_EVAL = 200;
/**
 * A step that takes less than this share off the cost ends a start (scipy's ftol).
 */
const FTOL = 1e-8;
/**
 * Projections by their inputs (envfit.ts Memo).
 */
// no warm start in these: their memos may keep answering across jobs (variations share partials)
const cutoffs = new Memo<{ value: ModEnvFit | undefined; x?: Float64Array }>(1000);
const fastCutoffs = new Memo<{ value: ModEnvFit | undefined; x?: Float64Array }>(1000);

export interface TvfZoneQuery {
    header: Uint8Array;
    b: Uint8Array;
    /**
     * The reference key (the voice key: a melodic note, a drum's kit pitch) and velocity.
     */
    key: number;
    velocity: number;
    levels: LevelContext;
    /**
     * Ignores the note off (a drum key without note off).
     */
    free: boolean;
    keyLo: number;
    keyHi: number;
    velLo: number;
    velHi: number;
    /**
     * Where a one shot wave ends the voice (s from the voice's start), undefined for a looped wave.
     */
    end?: number;
    /**
     * The pitch side leaves modulation envelope 2 free (no pitch envelope, no fine tune step).
     */
    modEnv2Free: boolean;
    /**
     * The sample's spectrum and its playback ratio at the reference key: the level make-up and the static filter rule.
     */
    spectrum?: Spectrum;
    ratio?: number;
    /**
     * Skips the split check (a part already split, or the check's own projection).
     */
    noSplit?: boolean;
    /**
     * Bakes a static highpass, bandpass or peak whatever the rule says (the user's named bakes).
     */
    forceBake?: boolean;
}

/**
 * A static highpass, bandpass or peak the rule bakes into a copy of the sample (the SVF at f, q played at ratio).
 */
export interface TvfBake {
    tap: Tap;
    f: number;
    q: number;
    ratio: number;
    /**
     * The SVF's power gain over the sample's spectrum through the engine's interpolation (cB): the copy's level
     * against the source, from the responses (a peak ratio of the zero phase copy overstates it, Pai Ban +3.5 dB).
     */
    gainCb: number;
}

/**
 * Where a zone plays better as two (the same shape as zone-tva.ts TvaSplit): the first key or velocity of the upper part.
 */
export interface TvfSplit {
    key?: number;
    velocity?: number;
}

export interface TvfZone {
    gens: Record<string, number>;
    mods: BankModulator[];
    /**
     * The level the zone adds (cB, positive is louder): core's passband loss for the resonance given back, and what
     * core's filter passes of the sample less than the SVF.
     */
    gainCb: number;
    /**
     * Set when the filter goes into the sample: gens then carry no filter.
     */
    bake?: TvfBake;
    /**
     * The projection's weighted RMS against the mapped curve and the curve's own around its mean (cents).
     */
    rms: number;
    raw: number;
    /**
     * The mapped curve at the reference (cents per grid point) and its weights, for checks.
     */
    curve: Float64Array;
    weights: Float64Array;
    /**
     * The weighted medians the zone uses: the coefficient, the damping.
     */
    f: number;
    q: number;
    /**
     * The key and velocity the envelope was projected at.
     */
    refKey: number;
    refVel: number;
    split?: TvfSplit;
}

export interface ModEnvFit {
    offset: number;
    amount: number;
    attack: number;
    hold: number;
    decay: number;
    sustain: number;
    release: number;
    fast?: number;
    fastDecay?: number;
    rms: number;
    raw: number;
}

/**
 * The points a projection scores: every second point of the first half second, every 8th after (the curve is lines
 * between 10 ms ticks).
 */
function pick(w: Float64Array) {
    const at = new Array<number>();
    const dense = Math.round(0.5 / DT);
    for (let i = 0; i < w.length; i++) if (w[i] > 0 && (i < dense ? i % 2 === 0 : i % 8 === 0)) at.push(i);
    return at;
}

const soft = (r: number) => Math.sign(r) * SOFT * Math.sqrt(2 * (Math.sqrt(1 + pow(r / SOFT, 2)) - 1));

interface Points {
    tv: Float64Array;
    cv: Float64Array;
    wv: Float64Array;
    off: number;
}

function pointsOf(c: Float64Array, w: Float64Array, holdPoints: number) {
    const at = pick(w);
    if (at.length < 10) return undefined;
    return {
        tv: Float64Array.from(at, (i) => i * DT), cv: Float64Array.from(at, (i) => c[i]), wv: Float64Array.from(at, (i) => w[i]),
        off: holdPoints * DT
    };
}

/**
 * The weighted least squares coefficients of c on the columns (2 or 3), each clamped to its bounds.
 */
function linear(cols: Float64Array[], p: Points, lo: number[], hi: number[]) {
    // plain loops: tsx names every closure it creates, and the solver calls this a few hundred times per projection
    const n = cols.length;
    const m = n + 1;
    // the sums in a flat array, each product as (w2 * column i) * column j like the plain triple loop
    const S = new Float64Array(n * m);
    const { wv, cv } = p;
    const c0 = cols[0];
    const c1 = cols[1];
    const c2 = n > 2 ? cols[2] : c1;
    for (let k = 0; k < wv.length; k++) {
        const w2 = wv[k] * wv[k];
        const x0 = c0[k];
        const x1 = c1[k];
        const u0 = w2 * x0;
        const u1 = w2 * x1;
        if (n === 2) {
            S[0] += u0 * x0;
            S[1] += u0 * x1;
            S[2] += u0 * cv[k];
            S[3] += u1 * x0;
            S[4] += u1 * x1;
            S[5] += u1 * cv[k];
        } else {
            const x2 = c2[k];
            const u2 = w2 * x2;
            S[0] += u0 * x0;
            S[1] += u0 * x1;
            S[2] += u0 * x2;
            S[3] += u0 * cv[k];
            S[4] += u1 * x0;
            S[5] += u1 * x1;
            S[6] += u1 * x2;
            S[7] += u1 * cv[k];
            S[8] += u2 * x0;
            S[9] += u2 * x1;
            S[10] += u2 * x2;
            S[11] += u2 * cv[k];
        }
    }
    const A = new Array<Float64Array>(n);
    for (let i = 0; i < n; i++) A[i] = S.subarray(i * m, i * m + m);
    for (let i = 0; i < n; i++) A[i][i] += 1e-9 * (A[i][i] + 1);
    for (let col = 0; col < n; col++) {
        let piv = col;
        for (let i = col + 1; i < n; i++) if (Math.abs(A[i][col]) > Math.abs(A[piv][col])) piv = i;
        const tmp = A[col];
        A[col] = A[piv];
        A[piv] = tmp;
        for (let i = col + 1; i < n; i++) {
            const f = A[i][col] / A[col][col];
            for (let j = col; j <= n; j++) A[i][j] -= f * A[col][j];
        }
    }
    const x = new Array<number>(n).fill(0);
    for (let i = n - 1; i >= 0; i--) {
        let v = A[i][n];
        for (let j = i + 1; j < n; j++) v -= A[i][j] * x[j];
        x[i] = v / A[i][i];
    }
    for (let i = 0; i < n; i++) x[i] = Math.min(hi[i], Math.max(lo[i], x[i]));
    return x;
}

/**
 * SFe's modulation envelope projected onto a cutoff curve (cents per grid point, weights per point): offset + amount
 * env(t) with envfit.ts's starts and soft_l1 loss. Unlike envfit.ts projectModEnv the offset and the
 * amount are linear here: each step of the solver over the four times and the sustain takes their weighted least
 * squares (a variable projection), a few times faster on the filter's long curves. Undefined when too little of the
 * curve sounds.
 */
export function projectCutoff(c: Float64Array, w: Float64Array, holdPoints: number, offsetRange: [number, number]) {
    return warmMemo(cutoffs, undefined, [c, w, holdPoints, offsetRange[0], offsetRange[1]], () => projectCutoffOnce(c, w, holdPoints, offsetRange));
}

function projectCutoffOnce(c: Float64Array, w: Float64Array, holdPoints: number, offsetRange: [number, number]) {
    const p = pointsOf(c, w, holdPoints);
    if (!p) return undefined;
    const { tv, cv, wv, off } = p;
    let sw = 0;
    let mean = 0;
    for (let k = 0; k < tv.length; k++) {
        sw += wv[k];
        mean += cv[k] * wv[k];
    }
    mean /= sw;
    const heldIdx = new Array<number>();
    const after = new Array<number>();
    for (let k = 0; k < tv.length; k++) {
        if (tv[k] < off) heldIdx.push(k);
        else after.push(cv[k]);
    }
    const late = heldIdx.length ? heldIdx.slice(-Math.max(1, Math.floor(heldIdx.length / 8))).map((k) => cv[k]) : [cv[cv.length - 1]];
    const base0 = median(late);
    let iPeak = 0;
    let best0 = -1;
    for (const k of heldIdx) {
        const v = Math.abs(cv[k] - base0) * wv[k];
        if (v > best0) {
            best0 = v;
            iPeak = k;
        }
    }
    const r0 = after.length ? median(after.slice(0, Math.max(1, Math.floor(after.length / 4)))) - base0 : 0;
    const linLo = [offsetRange[0], -12000];
    const linHi = [offsetRange[1], 12000];
    const one = new Float64Array(tv.length).fill(1);
    const shapeOf = (x: Float64Array) => {
        const ea = Math.exp(x[0]);
        const eh = Math.exp(x[1]);
        const ed = Math.exp(x[2]);
        const er = Math.exp(x[4]);
        return modEnv(tv, off, { attack: ea, hold: eh, decay: ed, sustain: x[3], release: er });
    };
    const resid = (x: Float64Array) => {
        const e = shapeOf(x);
        const [o, a] = linear([one, e], p, linLo, linHi);
        const r = new Float64Array(tv.length);
        for (let k = 0; k < tv.length; k++) r[k] = soft((o + a * e[k] - cv[k]) * wv[k]);
        return r;
    };
    const lo = Float64Array.from([Math.log(MIN_TIME), Math.log(MIN_TIME), Math.log(MIN_TIME), 0, Math.log(MIN_TIME)]);
    const hi = Float64Array.from([Math.log(MAX_TIME), Math.log(MAX_HOLD), Math.log(MAX_TIME), 1, Math.log(MAX_TIME)]);
    const scale = Float64Array.from([1, 1, 1, 0.2, 1]);
    const tPeak = Math.max(tv[iPeak], MIN_TIME * 2);
    const starts: number[][] = [[MIN_TIME * 1.5, 0.2, 0], [tPeak, 0.5, 0], [MIN_TIME * 1.5, 2.0, 0], [tPeak, 0.05, 0]];
    if (Math.abs(r0) > 5) starts.push([MIN_TIME * 1.5, 1.0, 1.0]);
    // no warm start here: a neighbour's cutoff led Celestial Pd into a valley of lower cost that sounds 9 dB louder
    // than the engine (the loudness weights do not see it)
    const best = bestOf(undefined, starts.map(([at0, d0, s0]) => Float64Array.from([Math.log(at0), Math.log(MIN_TIME * 1.5), Math.log(d0), s0, Math.log(0.05)])),
        (x0) => solve(resid, x0, lo, hi, scale, MAX_EVAL, FTOL));
    const x = best.x;
    const e = shapeOf(x);
    const [o, a] = linear([one, e], p, linLo, linHi);
    let norm = 0;
    let err = 0;
    let raw = 0;
    for (let k = 0; k < tv.length; k++) {
        norm += pow(wv[k], 2);
        err += pow((o + a * e[k] - cv[k]) * wv[k], 2);
        raw += pow((cv[k] - mean) * wv[k], 2);
    }
    return {
        offset: o, amount: a, attack: Math.exp(x[0]), hold: Math.exp(x[1]), decay: Math.exp(x[2]), sustain: x[3], release: Math.exp(x[4]),
        rms: Math.sqrt(err / norm), raw: Math.sqrt(raw / norm)
    };
}

/**
 * A fast component on modulation envelope 2 on top of a projection: an instant start that falls in a line to 0 over
 * fastDecay (its release the same), fitted with the base from where it stood, the first 300 ms weighing double.
 * The offset and both amounts are linear, as above.
 */
export function projectCutoffFast(c: Float64Array, w0: Float64Array, holdPoints: number, base: ModEnvFit, offsetRange: [number, number]) {
    return warmMemo(fastCutoffs, undefined, [c, w0, holdPoints, base.attack, base.hold, base.decay, base.sustain, base.release, base.raw, offsetRange[0], offsetRange[1]],
        () => projectCutoffFastOnce(c, w0, holdPoints, base, offsetRange));
}

function projectCutoffFastOnce(c: Float64Array, w0: Float64Array, holdPoints: number, base: ModEnvFit, offsetRange: [number, number]) {
    const w = w0.map((x, i) => x * (i * DT < 0.3 ? 2 : 1));
    const p = pointsOf(c, w, holdPoints);
    if (!p) return undefined;
    const { tv, cv, wv, off } = p;
    const linLo = [offsetRange[0], -12000, -12000];
    const linHi = [offsetRange[1], 12000, 12000];
    const one = new Float64Array(tv.length).fill(1);
    const shapes = (x: Float64Array) => {
        const ea = Math.exp(x[0]);
        const eh = Math.exp(x[1]);
        const ed = Math.exp(x[2]);
        const er = Math.exp(x[4]);
        const fd = Math.exp(x[5]);
        return [modEnv(tv, off, { attack: ea, hold: eh, decay: ed, sustain: x[3], release: er }),
            modEnv(tv, off, { attack: 0, hold: 0, decay: fd, sustain: 0, release: fd })];
    };
    const resid = (x: Float64Array) => {
        const [e, e2] = shapes(x);
        const [o, a, f] = linear([one, e, e2], p, linLo, linHi);
        const r = new Float64Array(tv.length);
        for (let k = 0; k < tv.length; k++) r[k] = soft((o + a * e[k] + f * e2[k] - cv[k]) * wv[k]);
        return r;
    };
    const lo = Float64Array.from([Math.log(MIN_TIME), Math.log(MIN_TIME), Math.log(MIN_TIME), 0, Math.log(MIN_TIME), Math.log(MIN_TIME * 2)]);
    const hi = Float64Array.from([Math.log(MAX_TIME), Math.log(MAX_HOLD), Math.log(MAX_TIME), 1, Math.log(MAX_TIME), Math.log(2)]);
    const scale = Float64Array.from([1, 1, 1, 0.2, 1, 1]);
    // the three fast decays, no warm start (as the cutoff above)
    const best = bestOf(undefined, [0.03, 0.1, 0.3].map((fd0) => Float64Array.from([Math.log(base.attack), Math.log(base.hold), Math.log(base.decay), base.sustain, Math.log(base.release), Math.log(fd0)])),
        (x0) => solve(resid, x0, lo, hi, scale, MAX_EVAL, FTOL));
    const x = best.x;
    const [e, e2] = shapes(x);
    const [o, a, f] = linear([one, e, e2], p, linLo, linHi);
    let norm = 0;
    let err = 0;
    for (let k = 0; k < tv.length; k++) {
        norm += pow(wv[k], 2);
        err += pow((o + a * e[k] + f * e2[k] - cv[k]) * wv[k], 2);
    }
    return {
        offset: o, amount: a, attack: Math.exp(x[0]), hold: Math.exp(x[1]), decay: Math.exp(x[2]), sustain: x[3], release: Math.exp(x[4]),
        fast: f, fastDecay: Math.exp(x[5]), rms: Math.sqrt(err / norm), raw: base.raw
    };
}

function median(a: number[]) {
    const s = [...a].sort((x, y) => x - y);
    return s.length ? s[Math.floor(s.length / 2)] : 0;
}

/**
 * The weighted median of x.
 */
function wmed(x: Float64Array, w: Float64Array) {
    const idx = Array.from(x.keys()).sort((a, b) => x[a] - x[b]);
    let total = 0;
    for (const i of idx) total += w[i];
    let acc = 0;
    for (const i of idx) {
        acc += w[i];
        if (acc >= total / 2) return x[i];
    }
    return x[idx[idx.length - 1]];
}

/**
 * The maps a zone looks its cutoffs up in: the plain one (resonance 0 and up) and the signed one (a static cutoff).
 */
export interface FilterMaps {
    plain: FilterMap;
    signed: FilterMap;
}

/**
 * Core's cutoff, resonance and passband gain for one SVF point of a tap.
 */
function mapPoint(maps: FilterMaps, tap: Tap, f: number, q: number, signed: boolean) {
    if (tap === "low") return (signed ? maps.signed : maps.plain).at(f, q);
    return { ...analogDesign(f, q), err: 0 };
}

/**
 * The note off as the voice's tick index (the first tick that sees it).
 */
export function releaseTickOf(holdPoints: number) {
    const offBlock = holdPoints * GRID_BLOCKS + OFF_BLOCKS - START_BLOCKS;
    return Math.max(0, Math.ceil((offBlock - FIRST_TICK) / TICK_BLOCKS));
}

/**
 * The SVF's coefficient and damping per grid point, exact: point k is the last 8 samples of the voice's block 4 k,
 * where SC-VA's state is read (its point k is the state after call 2 k + 1, the voice starts in call 1).
 */
export function gridOf(model: TvfModel, v: TvfVoice, points: number, holdPoints?: number) {
    const s = model.stream(v, points * GRID_BLOCKS, { firstTick: FIRST_TICK, releaseTick: holdPoints === undefined ? undefined : releaseTickOf(holdPoints) });
    const f = new Float64Array(points);
    const q = new Float64Array(points);
    for (let k = 0; k < points; k++) {
        const i = k * GRID_BLOCKS * 4 + 3;
        f[k] = s.f[i];
        q[k] = s.q[i];
    }
    return { f, q };
}

/**
 * The cutoff per control tick in core cents (each tick's target, capped by the damping), at the tick times (s from
 * the voice's start): the key and velocity curves compare against it.
 */
function tickCents(model: TvfModel, maps: FilterMaps, v: TvfVoice, use: Uint8Array, releaseTick: number | undefined, signed: boolean) {
    const ticks = model.ticks(v, use.length, releaseTick);
    const c = new Float64Array(use.length);
    for (let k = 0; k < use.length; k++) {
        if (!use[k]) continue;
        const tk = ticks[k + 2];
        const f = Math.min(model.coefficient(tk.warped), model.fCeiling(tk.q));
        c[k] = Math.min(mapPoint(maps, v.tap!, f, tk.q / 131072, signed).cents, OPEN_CENTS);
    }
    return c;
}

/**
 * When control tick k's target is reached (s from the voice's start): one tick after it is set.
 */
const tickTime = (k: number) => ((FIRST_TICK + 1 + (k + 1) * TICK_BLOCKS) * 32) / 32000;

const TWIN_HOLD = 75;

/**
 * The modulation envelope's release time fitted alone on the engine's curve of a TWIN_HOLD note (0.3 s), the rest of
 * the projection kept: a grid of release times, the loudness weights of that note's TVA.
 */
function twinRelease(model: TvfModel, maps: FilterMaps, tap: Tap, v: TvfVoice, seg: NonNullable<ReturnType<TvfModel["tva"]["segments"]>>,
                     p: ModEnvFit, fast: ModEnvFit | undefined) {
    const points = TWIN_HOLD + RELEASE;
    const { f, q } = gridOf(model, v, points, TWIN_HOLD);
    const t = Float64Array.from({ length: points }, (_, i) => i * DT + GRID);
    const gain = model.tva.curve(seg, t, TWIN_HOLD * DT + GRID);
    let peak = 0;
    for (let i = 0; i < points; i++) peak = Math.max(peak, gain[i]);
    if (peak <= 0) return p.release;
    const tv = new Array<number>();
    const cv = new Array<number>();
    const wv = new Array<number>();
    for (let i = TWIN_HOLD; i < points; i++) {
        const w = Math.min(1, Math.max(0, (20 * Math.log10(Math.max(gain[i], 1e-12) / peak) + 60) / 40));
        if (w <= 0) continue;
        tv.push(i * DT);
        cv.push(Math.min(mapPoint(maps, tap, f[i], q[i], false).cents, OPEN_CENTS));
        wv.push(w);
    }
    if (tv.length < 4) return p.release;
    const tt = Float64Array.from(tv);
    const off = TWIN_HOLD * DT;
    const e2 = fast ? modEnv(tt, off, { attack: 0, hold: 0, decay: fast.fastDecay!, sustain: 0, release: fast.fastDecay! }) : undefined;
    let best = p.release;
    let bestErr = Infinity;
    for (let tc = -7200; tc <= 8000; tc += 50) {
        const r = pow(2, tc / 1200);
        const e = modEnv(tt, off, { attack: p.attack, hold: p.hold, decay: p.decay, sustain: p.sustain, release: r });
        let err = 0;
        for (let k = 0; k < tt.length; k++) {
            const y = p.offset + p.amount * e[k] + (e2 ? fast!.fast! * e2[k] : 0);
            err += pow(wv[k] * (Math.min(y, OPEN_CENTS) - cv[k]), 2);
        }
        if (err < bestErr - 1e-9) {
            bestErr = err;
            best = r;
        }
    }
    return best;
}

export function tvfZone(model: TvfModel, maps: FilterMaps, q: TvfZoneQuery) {
    const v0 = model.voice(q.header, q.b, q.key, q.velocity);
    if (v0.tap === undefined) return undefined;
    const tap = v0.tap;
    const points = HOLD + RELEASE;
    const hold = q.free ? undefined : HOLD;
    // the loudness weights from the TVA at the query's note
    const seg = model.tva.segments(q.b, q.key, q.velocity, q.levels);
    if (!seg) return undefined;
    const t = Float64Array.from({ length: points }, (_, i) => i * DT + GRID);
    const gain = model.tva.curve(seg, t, hold === undefined ? undefined : hold * DT + GRID);
    let count = points;
    if (q.end !== undefined) count = Math.max(2, Math.min(points, Math.ceil(q.end / DT)));
    let peak = 0;
    for (let i = 0; i < count; i++) peak = Math.max(peak, gain[i]);
    if (peak <= 0) return undefined;
    const w = new Float64Array(points);
    for (let i = 0; i < count; i++) w[i] = Math.min(1, Math.max(0, (20 * Math.log10(Math.max(gain[i], 1e-12) / peak) + 60) / 40));
    // the control ticks that sound, every one of the first half second and every 4th after: the key and velocity
    // curves and the reference choice compare curves there
    const nT = Math.ceil((count * GRID_BLOCKS - FIRST_TICK) / TICK_BLOCKS);
    const rt = hold === undefined ? undefined : releaseTickOf(hold);
    const tt = Float64Array.from({ length: nT }, (_, k) => tickTime(k));
    const tw = tt.map((x, k) => (x < 0.5 || k % 4 === 0 ? w[Math.min(points - 1, Math.round(x / DT))] : 0));
    const use = Uint8Array.from(tw, (x) => (x > 0 ? 1 : 0));
    const vLo = Math.max(1, q.velLo);
    // the reference: the query's note, unless its cutoff holds still where other keys or velocities of the zone
    // move (a curve pinned at the ceiling at the top velocity shows no envelope to scale)
    const rawOf = (vk: TvfVoice) => {
        const c = tickCents(model, maps, vk, use, rt, false);
        let s0 = 0;
        let s1 = 0;
        for (let k = 0; k < nT; k++) {
            s0 += tw[k];
            s1 += tw[k] * c[k];
        }
        const mean = s1 / Math.max(s0, 1e-12);
        let e = 0;
        for (let k = 0; k < nT; k++) e += tw[k] * pow(c[k] - mean, 2);
        return Math.sqrt(e / Math.max(s0, 1e-12));
    };
    const pickRef = (at: number, cands: number[], voiceAt: (x: number) => TvfVoice) => {
        const raws = cands.map((x) => rawOf(voiceAt(x)));
        const top = Math.max(...raws);
        if (raws[0] >= REF_SHARE * top || top < FILTER_FLAT) return at;
        return cands[raws.findIndex((r) => r >= REF_SHARE * top)];
    };
    const refVel = pickRef(q.velocity, [q.velocity, ...REF_VELOCITIES.filter((x) => x < q.velocity && x >= vLo && x <= q.velHi)],
        (x) => model.voice(q.header, q.b, q.key, x));
    const refKey = q.keyHi > q.keyLo
        ? pickRef(q.key, [q.key, q.keyLo, q.keyHi, (q.keyLo + q.key) >> 1, (q.key + q.keyHi) >> 1], (k) => model.voice(q.header, q.b, k, refVel))
        : q.key;
    const v = model.voice(q.header, q.b, refKey, refVel);
    const { f, q: qs } = gridOf(model, v, points, hold);
    const mapped = (signed: boolean) => {
        const c = new Float64Array(points);
        const qcb = new Float64Array(points);
        const gdb = new Float64Array(points);
        for (let i = 0; i < points; i++) {
            const p = mapPoint(maps, tap, f[i], qs[i], signed);
            c[i] = Math.min(p.cents, OPEN_CENTS);
            qcb[i] = p.qcb;
            gdb[i] = p.gainDb;
        }
        return { c, qcb, gdb };
    };
    let m = mapped(false);
    const fMed = wmed(f, w);
    const qMed = wmed(qs, w);
    const range: [number, number] = [1500, OPEN_CENTS];
    const fit = projectCutoff(m.c, w, hold ?? points, range);
    if (!fit) return undefined;
    const gens: Record<string, number> = {};
    const mods = new Array<BankModulator>();
    const add = (x: BankModulator | undefined) => {
        if (x) mods.push(x);
    };
    const moving = fit.raw >= FILTER_FLAT;
    let fast: ModEnvFit | undefined;
    let shape: (x: Float64Array) => Float64Array = (x) => new Float64Array(x.length);
    const off = (hold ?? points) * DT;
    if (!moving) {
        // a filter that holds still takes the signed map (a Q under 0.707 too)
        if (tap === "low") m = mapped(true);
        const stat = wmed(m.c, w);
        gens.initialFilterFc = Math.round(Math.min(stat, OPEN_CENTS));
    } else {
        const tried = q.modEnv2Free ? projectCutoffFast(m.c, w, hold ?? points, fit, range) : undefined;
        fast = tried && Math.abs(tried.fast!) >= FAST_MIN && tried.rms < FAST_KEEP * fit.rms ? tried : undefined;
        const p0 = fast ?? fit;
        // the 3 s hold leaves a decaying voice's release with no weight: its time comes from a short note instead
        // (TWIN_HOLD, the TVA's twin), where the release still sounds (Celesta closed its filter in 5 ms)
        const p = hold === undefined ? p0 : { ...p0, release: twinRelease(model, maps, tap, v, seg, p0, fast) };
        Object.assign(gens, modGenerators(p, "ModEnv"), { initialFilterFc: Math.round(p.offset), modEnvToFilterFc: Math.round(p.amount) });
        if (fast) {
            Object.assign(gens, {
                attackModEnv2: -12000, holdModEnv2: -12000, decayModEnv2: timecents(fast.fastDecay!), sustainModEnv2: 1000,
                releaseModEnv2: timecents(fast.fastDecay!), modEnv2ToFilterFc: Math.round(fast.fast!)
            });
        }
        shape = (x) => {
            const e = modEnv(x, off, p);
            const e2 = fast ? modEnv(x, off, { attack: 0, hold: 0, decay: fast.fastDecay!, sustain: 0, release: fast.fastDecay! }) : undefined;
            return e.map((y, i) => p.amount * y + (e2 ? fast!.fast! * e2[i] : 0));
        };
    }
    const qcb = wmed(m.qcb, w);
    const gdb = wmed(m.gdb, w);
    let gainCb = 10 * gdb;
    let bake: TvfBake | undefined;
    // the highest cutoff core may reach (maxFilterFc, or the open lowpass)
    let ceiling = OPEN_CENTS;
    if (tap === "low") {
        if (!moving && gens.initialFilterFc >= OPEN_CENTS - 20 && Math.abs(qcb) < 5) {
            delete gens.initialFilterFc;
            gainCb = 0;
        } else {
            if (Math.round(qcb)) gens.filterQOffset = Math.round(qcb);
            // the engine's ceiling for the damping byte as maxFilterFc: envelope and controller pushes stop there
            const wTop = model.warp(0x7fff, v.damp);
            const cTop = Math.round(maps.plain.at(Math.min(model.coefficient(wTop), model.fCeiling(model.qTarget(v, wTop))), model.qTarget(v, wTop) / 131072).cents);
            // a static cutoff from the signed map can sit above the plain map's ceiling: the ceiling moves up to it
            const top0 = moving ? cTop : Math.max(cTop, gens.initialFilterFc);
            if (top0 < OPEN_CENTS) gens.maxFilterFc = top0;
            ceiling = Math.min(top0, OPEN_CENTS);
            if (q.spectrum) gainCb += lowpassMakeUp(fMed, qMed, maps.plain.at(fMed, qMed), q.ratio ?? 1, q.spectrum);
        }
    } else {
        gens.filterType = CORE_TYPES[tap];
        if (Math.round(qcb)) gens.filterQOffset = Math.round(qcb);
        if (q.spectrum) {
            const sf = staticFilter(tap, fMed, qMed, q.ratio ?? 1, q.spectrum);
            if (!moving && (Math.abs(sf.move) > STATIC_MOVE || q.forceBake)) {
                bake = { tap, f: fMed, q: qMed, ratio: q.ratio ?? 1, gainCb: sf.svfGain };
                for (const k of Object.keys(gens)) delete gens[k];
                gainCb = 0;
            } else {
                gainCb += sf.makeUp;
            }
        }
    }
    if (!bake && gens.initialFilterFc !== undefined) {
        // key follow and velocity: the cutoff curve at each key / velocity with the reference's times, fitted as
        // offset + scale * the reference's shape (weighted) on the points under the ceiling, plus the times' own
        // scaling
        const signed = !moving && tap === "low";
        const e = shape(tt);
        // voices with the same levels and cutoff give the same curve (the velocity sensitivity row maps many
        // velocities to one value)
        const fits = new Map<string, { o: number; s: number }>();
        const fitCurve = (vk: TvfVoice, s1ref: number) => {
            const c = tickCents(model, maps, { ...vk, times: v.times, release: v.release }, use, rt, signed);
            // core clamps at the ceiling: a point the curve holds there and the fit reaches too says nothing more
            let o = 0;
            let sc = 1;
            for (let pass = 0; pass < 5; pass++) {
                let s0 = 0;
                let s1 = 0;
                let s2 = 0;
                let y0 = 0;
                let y1 = 0;
                let all = 0;
                for (let k = 0; k < nT; k++) {
                    all += tw[k];
                    if (pass > 0 && c[k] >= ceiling - 1 && o + sc * e[k] >= ceiling - 1) continue;
                    s0 += tw[k];
                    s1 += tw[k] * e[k];
                    s2 += tw[k] * e[k] * e[k];
                    y0 += tw[k] * c[k];
                    y1 += tw[k] * c[k] * e[k];
                }
                if (s0 < CLAMP_SHARE * all) {
                    // mostly at the ceiling: keep the shape, the offset from the points under it, high enough that
                    // the ones at the ceiling stay there
                    let top = -Infinity;
                    for (let k = 0; k < nT; k++) if (tw[k] > 0 && c[k] >= ceiling - 1) top = Math.max(top, ceiling - s1ref * e[k]);
                    const under = s0 > 0 ? (y0 - s1ref * s1) / s0 : -Infinity;
                    const best = Math.max(top, under);
                    return { o: Number.isFinite(best) ? best : ceiling, s: s1ref };
                }
                if (!moving || s2 * s0 - s1 * s1 < 1e-9 * s0 * s0) {
                    o = y0 / s0;
                    sc = 1;
                } else {
                    sc = (s0 * y1 - s1 * y0) / (s0 * s2 - s1 * s1);
                    o = (y0 - sc * s1) / s0;
                }
            }
            return { o, s: sc };
        };
        // the reference is the projection itself (its points at the ceiling would leave the fit too little)
        const r0 = { o: moving ? (fast ?? fit).offset : gens.initialFilterFc, s: 1 };
        const fitOf = (vk: TvfVoice) => {
            const sig = `${vk.base} ${vk.levels.join(" ")} ${vk.releaseLevel}`;
            let r = fits.get(sig);
            if (!r) {
                r = fitCurve(vk, r0.s);
                fits.set(sig, r);
            }
            return r;
        };
        const envDests = moving ? ["modEnvToFilterFc", ...(fast ? ["modEnv2ToFilterFc"] : [])] : [];
        const early = ["attackModEnv", "holdModEnv", ...(fast ? ["decayModEnv2"] : [])];
        const late = ["decayModEnv"];
        const curvesOf = (source: "key" | "velocity", lo: number, hi: number, voiceAt: (x: number) => TvfVoice) => {
            const fc = new Float64Array(128);
            const amt = envDests.map(() => new Float64Array(128));
            const cache = new Map<number, { o: number; s: number }>();
            for (let x = 0; x < 128; x++) {
                const xx = Math.max(lo, Math.min(hi, x));
                if (!cache.has(xx)) cache.set(xx, fitOf(voiceAt(xx)));
                const r = cache.get(xx)!;
                fc[x] = r.o - r0.o;
                for (let j = 0; j < envDests.length; j++) amt[j][x] = gens[envDests[j]] * (r.s / r0.s - 1);
            }
            add(curveModulator(source, fc, "initialFilterFc"));
            envDests.forEach((d, j) => add(curveModulator(source, amt[j], d)));
        };
        const timeCurve = (source: "key" | "velocity", lo: number, hi: number, scaleAt: (x: number) => number, dests: string[]) => {
            const ref0 = scaleAt(source === "key" ? refKey : refVel);
            const y = new Float64Array(128);
            for (let x = 0; x < 128; x++) y[x] = 1200 * Math.log2(scaleAt(Math.max(lo, Math.min(hi, x))) / ref0);
            for (const d of dests) if (gens[d] !== undefined && gens[d] > -12000) add(curveModulator(source, y, d));
        };
        if (q.keyHi > q.keyLo) {
            curvesOf("key", q.keyLo, q.keyHi, (k) => model.voice(q.header, q.b, k, refVel));
            if (moving) {
                timeCurve("key", q.keyLo, q.keyHi, (k) => model.keyScales(q.b, k)[0], [...early, ...late]);
                if (!q.free) timeCurve("key", q.keyLo, q.keyHi, (k) => model.keyScales(q.b, k)[1], ["releaseModEnv"]);
            }
        }
        if (q.b[0x4a] !== 0x40) curvesOf("velocity", vLo, q.velHi, (x) => model.voice(q.header, q.b, refKey, x));
        if (moving) {
            const vs = (x: number) => model.velocityScales(q.b, x);
            if (q.b[0x4b] !== 0x40) timeCurve("velocity", vLo, q.velHi, (x) => vs(x)[0], early);
            if (q.b[0x4c] !== 0x40) timeCurve("velocity", vLo, q.velHi, (x) => vs(x)[1], [...late, ...(q.free ? [] : ["releaseModEnv"])]);
        }
    }
    const zone: TvfZone = { gens, mods, gainCb, bake, rms: (fast ?? fit).rms, raw: fit.raw, curve: m.c, weights: w, f: fMed, q: qMed, refKey, refVel };
    // the split check: the curves at the zone's edge keys, half way to them and at lower velocities against the
    // engine's curve there (control ticks, no render). Where they miss by more than SPLIT_CENTS over the reference's
    // own error and a projection of its own would do SPLIT_CENTS better, the zone plays better as two
    if (!bake && gens.initialFilterFc !== undefined && !q.noSplit && (q.keyHi > q.keyLo || q.velHi > vLo)) {
        const signed = !moving && tap === "low";
        const errAt = (key: number, velocity: number, g: Record<string, number>) => {
            const c = tickCents(model, maps, model.voice(q.header, q.b, key, velocity), use, rt, signed);
            const r = ruleCents(g, tt, off);
            let sw = 0;
            let e = 0;
            for (let k = 0; k < nT; k++) {
                sw += tw[k];
                e += tw[k] * pow(r[k] - c[k], 2);
            }
            return Math.sqrt(e / Math.max(sw, 1e-12));
        };
        const base = errAt(refKey, refVel, gens);
        const worse = (key: number, velocity: number) => {
            const rule = errAt(key, velocity, tvfGensAt(zone, key, velocity));
            if (rule - base <= SPLIT_CENTS) return false;
            const own = tvfZone(model, maps, { ...q, key, velocity, keyLo: key, keyHi: key, velLo: velocity, velHi: velocity, noSplit: true });
            return !!own && own.gens.initialFilterFc !== undefined && rule - errAt(key, velocity, own.gens) > SPLIT_CENTS;
        };
        const split: TvfSplit = {};
        const keys = [q.keyLo, (q.keyLo + refKey) >> 1, (refKey + q.keyHi + 1) >> 1, q.keyHi];
        if (keys.some((k, i) => k !== refKey && keys.indexOf(k) === i && worse(k, refVel))) split.key = ((q.keyLo + q.keyHi) >> 1) + 1;
        for (const x of [...SPLIT_VELOCITIES, vLo]) {
            if (x < vLo || x >= refVel) continue;
            if (worse(refKey, x)) {
                split.velocity = ((x + refVel) >> 1) + 1;
                break;
            }
        }
        if (split.key !== undefined || split.velocity !== undefined) zone.split = split;
    }
    return zone;
}

/**
 * A zone's generators at a key and velocity, its custom curves applied.
 */
export function tvfGensAt(zone: { gens: Record<string, number>; mods: BankModulator[] }, key: number, velocity: number) {
    const g = { ...zone.gens };
    for (const m of zone.mods) {
        const y = m.points![m.source === "key" ? key : velocity][1];
        g[m.dest] = (g[m.dest] ?? (m.dest.endsWith("ModEnv") || m.dest.endsWith("ModEnv2") ? -12000 : 0)) + ((y - 8192) / 8192) * m.amount;
    }
    return g;
}

/**
 * The cutoff core draws from a zone's generators at times t (s), note off at off: the offset, both modulation
 * envelopes, the ceiling.
 */
function ruleCents(g: Record<string, number>, t: Float64Array, off: number) {
    const e1 = g.modEnvToFilterFc ? modEnv(t, off, modParams(g, "ModEnv")) : undefined;
    const e2 = g.modEnv2ToFilterFc ? modEnv(t, off, modParams(g, "ModEnv2")) : undefined;
    return t.map((_, k) => Math.min(g.initialFilterFc + (e1 ? g.modEnvToFilterFc * e1[k] : 0) + (e2 ? g.modEnv2ToFilterFc * e2[k] : 0),
        g.maxFilterFc ?? OPEN_CENTS, OPEN_CENTS));
}
