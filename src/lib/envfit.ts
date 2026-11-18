/**
 * SFe's volume envelope (spessasynth_core's volume_envelope.ts: a linear gain attack, hold, two decays straight in dB,
 * the release at 96 dB per release time) and its projection onto a curve the engine's TVA draws (tva.ts). The engine
 * curve comes from the partial's bytes, so the projection is a transform of the bytes: a least squares solve that
 * puts SFe's segments where the engine's curve runs.
 */
import { pow } from "./math.js";

export const SILENCE_DB = 96;
const RELEASE_END_DB = 90;
export const FLOOR_DB = 72;
const MIN_TIME = 0.001;
const MIN_RELEASE = pow(2, -7200 / 1200);
const BLOCK = 128 / 32000;
const MAX_HOLD = pow(2, 5000 / 1200);
const MAX_TIME = pow(2, 8000 / 1200);
const KNEES = [0.8];

export const timecents = (seconds: number) => (seconds <= MIN_TIME ? -12000 : Math.round(1200 * Math.log2(seconds)));

export interface VolumeParams {
    attack: number;
    hold: number;
    decay: number;
    s1: number;
    decay2: number;
    s2: number;
    release: number;
}

export type Generators = Record<string, number>;

/**
 * volumeDb's held part at time tt (a plain function: tsx names every closure it creates, which costs more than the
 * envelope in the solver's loop).
 */
function volumeHeld(tt: number, attack: number, aEnd: number, hEnd: number, dEnd: number, d2End: number, s1: number, s2: number) {
    if (tt < aEnd && attack > BLOCK) {
        const lin = Math.min(Math.max((tt + BLOCK) / attack, 1e-6), 1);
        return Math.min(-20 * Math.log10(lin), SILENCE_DB);
    }
    if (tt < hEnd) return 0;
    if (tt < dEnd) return ((tt - hEnd) / (dEnd - hEnd)) * s1;
    if (tt < d2End) return s1 + ((tt - dEnd) / (d2End - dEnd)) * (s2 - s1);
    return s2;
}

/**
 * Core's volume envelope in dB below the peak at times t, note off at off unless free (ignoreNoteOff).
 */
export function volumeDb(t: Float64Array, off: number, p: VolumeParams, free: boolean) {
    const s1 = Math.min(Math.max(p.s1, 0), SILENCE_DB);
    const s2 = Math.min(Math.max(p.s2, 0), SILENCE_DB);
    const aEnd = p.attack;
    const hEnd = aEnd + p.hold;
    const dEnd = hEnd + (p.decay * s1) / SILENCE_DB;
    const d2End = dEnd + (p.decay2 * Math.abs(s2 - s1)) / SILENCE_DB;
    const out = new Float64Array(t.length);
    const start = free ? 0 : volumeHeld(off, p.attack, aEnd, hEnd, dEnd, d2End, s1, s2);
    const rate = SILENCE_DB / Math.max(p.release, MIN_RELEASE);
    for (let i = 0; i < t.length; i++) {
        if (free || t[i] < off) {
            out[i] = volumeHeld(t[i], p.attack, aEnd, hEnd, dEnd, d2End, s1, s2);
        } else {
            const r = start + (t[i] - off) * rate;
            out[i] = r >= RELEASE_END_DB ? 200 : r;
        }
    }
    return out;
}

/**
 * projectVolume's residuals of one part into r from o on: volumeDb's value at each point (the same arithmetic) plus
 * the level, clipped at the floor, against db, times the weight. Returns the next free index.
 */
function volumeResiduals(r: Float64Array, o: number, t: Float64Array, off: number, p: VolumeParams, free: boolean, lvl: number,
                         db: Float64Array, w: Float64Array) {
    const s1 = Math.min(Math.max(p.s1, 0), SILENCE_DB);
    const s2 = Math.min(Math.max(p.s2, 0), SILENCE_DB);
    const aEnd = p.attack;
    const hEnd = aEnd + p.hold;
    const dEnd = hEnd + (p.decay * s1) / SILENCE_DB;
    const d2End = dEnd + (p.decay2 * Math.abs(s2 - s1)) / SILENCE_DB;
    const start = free ? 0 : volumeHeld(off, p.attack, aEnd, hEnd, dEnd, d2End, s1, s2);
    const rate = SILENCE_DB / Math.max(p.release, MIN_RELEASE);
    for (let i = 0; i < t.length; i++) {
        let m: number;
        if (free || t[i] < off) {
            m = volumeHeld(t[i], p.attack, aEnd, hEnd, dEnd, d2End, s1, s2);
        } else {
            const rr = start + (t[i] - off) * rate;
            m = rr >= RELEASE_END_DB ? 200 : rr;
        }
        r[o++] = (Math.min(m + lvl, FLOOR_DB) - db[i]) * w[i];
    }
    return o;
}

/**
 * The generators of a parameter set.
 */
export function volumeGenerators(p: VolumeParams, free: boolean) {
    let s1 = Math.min(Math.max(p.s1, 0), SILENCE_DB);
    let s2 = Math.min(Math.max(p.s2, 0), SILENCE_DB);
    // a level at the clip only says the curve went below it: the engine goes on to nothing, so does the bank (a
    // looped voice that ignores the note off would never end in core)
    if (s2 >= FLOOR_DB - 2) {
        s2 = SILENCE_DB;
        if (s1 >= FLOOR_DB - 2) s1 = SILENCE_DB;
    }
    const gens: Generators = {
        attackVolEnv: timecents(p.attack),
        holdVolEnv: timecents(p.hold),
        decayVolEnv: timecents(p.decay),
        sustainVolEnv: Math.round(s1 * 10),
        decay2VolEnv: timecents(p.decay2),
        sustain2VolEnv: Math.round(s2 * 10) - Math.round(s1 * 10),
        releaseVolEnv: Math.max(-7200, timecents(p.release))
    };
    if (free) {
        gens.ignoreNoteOff = 1;
        // a forced release (all notes off, exclusive class) still uses it: fall at the envelope's last slope
        gens.releaseVolEnv = s2 > s1 ? gens.decay2VolEnv : gens.decayVolEnv;
    }
    return gens;
}

/**
 * The parameters back from generators (for scoring a generator set).
 */
export function volumeParams(gens: Generators) {
    const sec = (k: string) => ((gens[k] ?? -12000) <= -12000 ? 0 : pow(2, gens[k] / 1200));
    const s1 = Math.min(gens.sustainVolEnv ?? 0, 960) / 10;
    return {
        attack: sec("attackVolEnv"),
        hold: sec("holdVolEnv"),
        decay: sec("decayVolEnv"),
        s1,
        decay2: sec("decay2VolEnv"),
        s2: Math.min(Math.max(s1 + (gens.sustain2VolEnv ?? 0) / 10, 0), SILENCE_DB),
        release: Math.max(sec("releaseVolEnv"), MIN_RELEASE)
    };
}

const toDb = (g: Float64Array, peak: number) => g.map((x) => Math.min(-20 * Math.log10(Math.max(x, 1e-12) / peak), FLOOR_DB));

/**
 * A curve to project: gain every dt seconds from the voice's start, note off after holdPoints points.
 */
export interface Curve {
    gain: Float64Array;
    dt: number;
    holdPoints: number;
}

/**
 * The curve held on past the long curve's note off (no note off at all), scored from point from on, every 16th point
 * at weight: it pins segment times longer than the long curve's hold without bending the part every note plays.
 */
export interface Tail {
    gain: Float64Array;
    from: number;
    weight: number;
}

interface Part {
    t: Float64Array;
    off: number;
    db: Float64Array;
    w: Float64Array;
}

/**
 * Bounded Levenberg-Marquardt on a residual function, finite difference Jacobian, a step that takes less than ftol of
 * the cost ends it. Returns the parameters and the cost (half the sum of squares).
 */
export function solve(resid: (x: Float64Array) => Float64Array, x0: Float64Array, lo: Float64Array, hi: Float64Array,
               scale: Float64Array, maxEval: number, ftol = 1e-12) {
    // plain loops throughout: tsx names every closure it creates, and this loop runs millions of times a conversion
    const n = x0.length;
    let x = clipTo(x0, lo, hi);
    let r = resid(x);
    let c = halfSquares(r);
    let lambda = 1e-3;
    let evals = 1;
    const A = new Array<Float64Array>(n);
    for (let a = 0; a < n; a++) A[a] = new Float64Array(n + 1);
    const jac = new Array<Float64Array>(n);
    const jtj = new Array<Float64Array>(n);
    for (let a = 0; a < n; a++) jtj[a] = new Float64Array(n);
    const jtr = new Float64Array(n);
    const d = new Float64Array(n);
    const fixed = new Array<boolean>(n);
    while (evals < maxEval) {
        const m = r.length;
        for (let j = 0; j < n; j++) {
            const h = 1e-3 * Math.max(Math.abs(x[j]), 1) * Math.sign(x[j] || 1);
            const xh = Float64Array.from(x);
            xh[j] += h;
            if (xh[j] >= hi[j]) xh[j] = x[j] - h;
            const rh = resid(xh);
            const col = new Float64Array(m);
            const step = xh[j] - x[j];
            for (let i = 0; i < m; i++) col[i] = (rh[i] - r[i]) / step;
            jac[j] = col;
        }
        // each sum over i in order, four of them per pass with their own accumulators (the products' order and the
        // sums' order stay as one plain dot product each)
        for (let a = 0; a < n; a++) {
            const ca = jac[a];
            // the columns this row pairs with: jac[0..a], then the residual (jtr)
            const count = a + 2;
            for (let b0 = 0; b0 < count; b0 += 4) {
                const k = Math.min(4, count - b0);
                const c0 = b0 <= a ? jac[b0] : r;
                const c1 = k > 1 ? (b0 + 1 <= a ? jac[b0 + 1] : r) : c0;
                const c2 = k > 2 ? (b0 + 2 <= a ? jac[b0 + 2] : r) : c0;
                const c3 = k > 3 ? (b0 + 3 <= a ? jac[b0 + 3] : r) : c0;
                let s0 = 0;
                let s1 = 0;
                let s2 = 0;
                let s3 = 0;
                for (let i = 0; i < m; i++) {
                    const v = ca[i];
                    s0 += v * c0[i];
                    s1 += v * c1[i];
                    s2 += v * c2[i];
                    s3 += v * c3[i];
                }
                const out = [s0, s1, s2, s3];
                for (let q = 0; q < k; q++) {
                    const b = b0 + q;
                    if (b <= a) jtj[a][b] = out[q];
                    else jtr[a] = out[q];
                }
            }
        }
        for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) jtj[a][b] = jtj[b][a];
        // a parameter on its bound that the step would push past stays there (an active set): left in, its
        // clipped step blocks every other one
        // flat directions (a level past the clip) get a damping floor, else their step is unbounded
        let top = 0;
        for (let a = 0; a < n; a++) top = Math.max(top, jtj[a][a]);
        const floor = Math.max(top * 1e-4, 1e-12);
        fixed.fill(false);
        let improved = false;
        for (let tries = 0; tries < 10 && evals < maxEval; tries++) {
            for (let pass = 0; pass < 3; pass++) {
                for (let a = 0; a < n; a++) {
                    const row = A[a];
                    for (let b = 0; b < n; b++) {
                        const v = jtj[a][b];
                        row[b] = fixed[a] || fixed[b] ? (a === b ? 1 : 0) : a === b ? v + lambda * Math.max(v, floor) : v;
                    }
                    row[n] = fixed[a] ? 0 : -jtr[a];
                }
                gaussInPlace(A, n, d);
                let more = false;
                for (let a = 0; a < n; a++) {
                    if (!fixed[a] && ((x[a] <= lo[a] + 1e-6 && d[a] < 0) || (x[a] >= hi[a] - 1e-6 && d[a] > 0))) {
                        fixed[a] = true;
                        more = true;
                    }
                }
                if (!more) break;
            }
            const xs = new Float64Array(n);
            for (let i = 0; i < n; i++) xs[i] = x[i] + d[i];
            const xn = clipTo(xs, lo, hi);
            const rn = resid(xn);
            evals++;
            const cn = halfSquares(rn);
            if (cn < c) {
                const gain = c - cn;
                x = xn;
                r = rn;
                c = cn;
                lambda = Math.max(lambda / 3, 1e-12);
                improved = gain > ftol * Math.max(c, 1e-12);
                break;
            }
            lambda *= 4;
        }
        if (!improved) break;
    }
    return { x, cost: c };
}

function clipTo(x: Float64Array, lo: Float64Array, hi: Float64Array) {
    const out = new Float64Array(x.length);
    for (let i = 0; i < x.length; i++) out[i] = Math.min(Math.max(x[i], lo[i] + 1e-9), hi[i] - 1e-9);
    return out;
}

function halfSquares(v: Float64Array) {
    let s = 0;
    for (let i = 0; i < v.length; i++) s = s + v[i] * v[i];
    return s / 2;
}

/**
 * Gaussian elimination with partial pivoting on the augmented rows M (n by n + 1, overwritten), the solution into x.
 */
function gaussInPlace(M: Float64Array[], n: number, x: Float64Array) {
    for (let col = 0; col < n; col++) {
        let piv = col;
        for (let i = col + 1; i < n; i++) if (Math.abs(M[i][col]) > Math.abs(M[piv][col])) piv = i;
        const tmp = M[col];
        M[col] = M[piv];
        M[piv] = tmp;
        const p = M[col][col] || 1e-300;
        for (let i = col + 1; i < n; i++) {
            const f = M[i][col] / p;
            if (f !== 0) for (let j = col; j <= n; j++) M[i][j] -= f * M[col][j];
        }
    }
    for (let i = n - 1; i >= 0; i--) {
        let s = M[i][n];
        for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j];
        x[i] = s / (M[i][i] || 1e-300);
    }
}

/**
 * A starting point from the curve's shape: attack to the peak, one decay to where the
 * hold ends, the release from the -40 dB time.
 */
function heuristic(c: Curve, holdPoints: number) {
    const g = c.gain.map((x) => Math.max(x, 1e-7));
    let p = 0;
    for (let i = 1; i < holdPoints; i++) if (g[i] > g[p]) p = i;
    const db = g.map((x) => 20 * Math.log10(x / g[p]));
    const out: VolumeParams = { attack: p * c.dt, hold: 0, decay: MIN_TIME, s1: 0, decay2: MIN_TIME, s2: 0, release: 0.005 };
    const end = db[holdPoints - 1];
    if (end <= -1) {
        const from = Math.max(p, holdPoints - Math.trunc(0.3 / c.dt));
        const slope = (db[holdPoints - 1] - db[from]) / Math.max(c.dt * (holdPoints - 1 - from), c.dt);
        if (slope > -3) {
            let reach = p;
            while (reach < holdPoints && db[reach] > end + 0.5) reach++;
            out.s1 = Math.min(-end, SILENCE_DB);
            out.decay = (Math.max((reach - p) * c.dt, c.dt) * SILENCE_DB) / -end;
        } else {
            out.s1 = SILENCE_DB;
            out.decay = SILENCE_DB / (-end / Math.max((holdPoints - 1 - p) * c.dt, c.dt));
        }
    }
    out.s2 = out.s1;
    const rel = db.subarray(holdPoints);
    if (rel.length >= 3 && g[holdPoints] > 2e-7) {
        let below = -1;
        for (let i = 0; i < rel.length; i++) {
            if (rel[i] <= rel[0] - 40) {
                below = i;
                break;
            }
        }
        out.release = below >= 0 ? (Math.max(below * c.dt, c.dt) * SILENCE_DB) / 40
            : (rel.length * c.dt * SILENCE_DB) / Math.max(rel[0] - rel[rel.length - 1], 1);
    }
    return out;
}

/**
 * Results by their inputs' exact bits, for the projections: a zone's split check, the parts it cuts and the kit keys
 * that play the same drum ask for the same projection again, and a solve costs milliseconds. A hit compares the whole
 * key bit for bit, so a result only comes back for the same inputs. Full, it starts over (the repeats sit close
 * together, within one job).
 */
export class Memo<T> {
    private readonly limit;
    private readonly map = new Map<number, { key: Uint32Array; value: T }[]>();
    private size = 0;

    public constructor(limit: number) {
        this.limit = limit;
    }

    public clear() {
        this.map.clear();
        this.size = 0;
    }

    public get(parts: (number | ArrayLike<number> | undefined)[], compute: () => T) {
        let n = 0;
        for (const p of parts) n += p === undefined ? 1 : typeof p === "number" ? 1 : p.length + 1;
        const f = new Float64Array(n);
        let o = 0;
        for (const p of parts) {
            if (p === undefined) {
                f[o++] = NaN;
            } else if (typeof p === "number") {
                f[o++] = p;
            } else {
                // the length first, so two arrays never read as one
                f[o++] = p.length;
                for (let i = 0; i < p.length; i++) f[o++] = p[i];
            }
        }
        const key = new Uint32Array(f.buffer);
        let h = 0x811c9dc5;
        for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key[i], 0x01000193);
        const list = this.map.get(h);
        if (list) {
            for (const e of list) {
                if (e.key.length !== key.length) continue;
                let same = true;
                for (let i = 0; i < key.length && same; i++) same = e.key[i] === key[i];
                if (same) return e.value;
            }
        }
        const value = compute();
        if (this.size >= this.limit) {
            this.map.clear();
            this.size = 0;
        }
        const l = this.map.get(h);
        if (l) l.push({ key, value });
        else this.map.set(h, [{ key, value }]);
        this.size++;
        return value;
    }
}

/**
 * Warm starts (volume and pitch): each projection's last solution in the current job is tried first on the next one (a zone's neighbour,
 * its split parts and checks look alike), next to the fixed starts. A job starts with no warm start and empty
 * projection memos (resetWarm), so its result depends on the job alone, whichever worker runs it after whatever.
 */
const warm = new Map<string, Float64Array>();
const memos = new Array<Memo<unknown>>();

export function resetWarm() {
    warm.clear();
    for (const m of memos) m.clear();
}

/**
 * A projection memo, emptied with the warm starts.
 */
export function projectionMemo<T>() {
    const m = new Memo<{ value: T; x?: Float64Array }>(1000);
    memos.push(m as Memo<unknown>);
    return m;
}

/**
 * The starts with the kind's warm start first, the best solve kept and remembered.
 */
export function bestOf(kind: string | undefined, starts: Float64Array[], one: (x0: Float64Array) => { x: Float64Array; cost: number }) {
    const w = kind === undefined ? undefined : warm.get(kind);
    const list = w && w.length === starts[0].length ? [w, ...starts] : starts;
    let best: { x: Float64Array; cost: number } | undefined;
    for (const x0 of list) {
        const r = one(x0);
        if (!best || r.cost < best.cost) best = r;
    }
    if (kind !== undefined) warm.set(kind, best!.x);
    return best!;
}

/**
 * A projection through its memo: within a job the same inputs give the first answer again, and a hit leaves the warm
 * start where that solve left it.
 */
export function warmMemo<T>(memo: Memo<{ value: T; x?: Float64Array }>, kind: string | undefined, parts: (number | ArrayLike<number> | undefined)[], compute: () => T) {
    const r = memo.get(parts, () => {
        const value = compute();
        return { value, x: kind === undefined ? undefined : warm.get(kind) };
    });
    if (kind !== undefined && r.x) warm.set(kind, r.x);
    return r.value;
}

const volumes = projectionMemo<ReturnType<typeof projectVolumeOnce>>();
const modEnvs = projectionMemo<ReturnType<typeof projectModEnvOnce>>();

/**
 * Projects SFe's volume envelope onto an engine curve (with an early note off twin for the release, unless free).
 * Returns the gain at the envelope's 0 dB and the generators. The result is shared between equal calls: callers copy before they change it.
 */
export function projectVolume(long: Curve, short: Curve | undefined, free: boolean, tail?: Tail) {
    return warmMemo(volumes, "volume", [long.gain, long.dt, long.holdPoints, short?.gain, short?.dt, short?.holdPoints, free ? 1 : 0, tail?.gain,
        tail?.from, tail?.weight], () => projectVolumeOnce(long, short, free, tail));
}

function projectVolumeOnce(long: Curve, short: Curve | undefined, free: boolean, tail?: Tail) {
    const g = long.gain;
    let peak = 0;
    for (const x of g) peak = Math.max(peak, x);
    if (tail) for (let i = tail.from; i < tail.gain.length; i++) peak = Math.max(peak, tail.gain[i]);
    if (peak <= 0) return undefined;
    const dt = long.dt;
    const off = long.holdPoints * dt;
    const all = toDb(g, peak);
    const parts = new Array<Part>();
    {
        const t = new Array<number>();
        const db = new Array<number>();
        const w = new Array<number>();
        for (let i = 0; i < g.length; i++) {
            const tt = i * dt;
            const near = Math.abs(tt - off) < 0.3;
            // past 4.5 s (a long hold) sparser, so the part every check hears keeps its weight
            if (tt < 1 || near || i % (tt < 4.5 ? 4 : 16) === 0) {
                t.push(tt);
                db.push(all[i]);
                w.push((tt < 0.25 ? 2 : 1) * (tt >= 1 && !near ? 2 : 1));
            }
        }
        parts.push({ t: Float64Array.from(t), off, db: Float64Array.from(db), w: Float64Array.from(w) });
    }
    if (short && !free) {
        const soff = short.holdPoints * dt;
        const sdb = toDb(short.gain, peak);
        const t = new Array<number>();
        const db = new Array<number>();
        for (let i = 0; i < sdb.length; i++) {
            const tt = i * dt;
            if (tt >= soff - 0.1 && tt < soff + 1) {
                t.push(tt);
                db.push(sdb[i]);
            }
        }
        parts.push({ t: Float64Array.from(t), off: soff, db: Float64Array.from(db), w: new Float64Array(t.length).fill(2) });
    }
    if (tail) {
        const tdb = toDb(tail.gain, peak);
        const t = new Array<number>();
        const db = new Array<number>();
        for (let i = tail.from; i < tdb.length; i += 16) {
            t.push(i * dt);
            db.push(tdb[i]);
        }
        parts.push({ t: Float64Array.from(t), off: Infinity, db: Float64Array.from(db), w: new Float64Array(t.length).fill(tail.weight) });
    }
    // past the hold the held curve goes on at the slope of the hold's last half second
    let beyond: { t: Float64Array; db: Float64Array } | undefined;
    if (!free && !tail) {
        const from = Math.max(0, long.holdPoints - Math.trunc(0.5 / dt));
        const last = all.subarray(from, long.holdPoints);
        if (last.length > 2 && last[last.length - 1] < FLOOR_DB - 1) {
            const slope = Math.max(0, (last[last.length - 1] - last[0]) / ((last.length - 1) * dt));
            const after = [0.25, 0.5, 1, 2, 4];
            beyond = {
                t: Float64Array.from(after, (x) => off + x),
                db: Float64Array.from(after, (x) => Math.min(last[last.length - 1] + slope * x, FLOOR_DB))
            };
        }
    }
    const params = (x: Float64Array): [VolumeParams, number] => [{
        attack: Math.exp(x[0]), hold: Math.exp(x[1]), decay: Math.exp(x[2]), s1: x[3], decay2: Math.exp(x[4]), s2: x[5],
        release: Math.exp(x[6])
    }, x[7]];
    const size = parts.reduce((s, p) => s + p.t.length, 0) + (beyond ? beyond.t.length : 0);
    const four = beyond ? new Float64Array(beyond.t.length).fill(4) : undefined;
    const resid = (x: Float64Array) => {
        const [p, lvl] = params(x);
        const r = new Float64Array(size);
        let o = 0;
        for (const part of parts) o = volumeResiduals(r, o, part.t, part.off, p, free, lvl, part.db, part.w);
        if (beyond) volumeResiduals(r, o, beyond.t, 0, p, true, lvl, beyond.db, four!);
        return r;
    };
    const L = Math.log;
    const lo = Float64Array.from([L(MIN_TIME), L(MIN_TIME), L(MIN_TIME), 0, L(MIN_TIME), 0, L(MIN_RELEASE), -6]);
    const hi = Float64Array.from([L(MAX_TIME), L(MAX_HOLD), L(MAX_TIME), SILENCE_DB, L(MAX_TIME), SILENCE_DB, L(MAX_TIME), 6]);
    const scale = Float64Array.from([1, 1, 1, 10, 1, 10, 1, 1]);
    const h = heuristic(long, free ? g.length : long.holdPoints);
    if (short && !free) h.release = heuristic(short, short.holdPoints).release;
    const toX = (p: VolumeParams) => Float64Array.from([L(Math.max(p.attack, MIN_TIME)), L(Math.max(p.hold, MIN_TIME)),
        L(Math.max(p.decay, MIN_TIME)), p.s1, L(Math.max(p.decay2, MIN_TIME)), p.s2, L(Math.max(p.release, MIN_RELEASE)), 0]);
    const endHold = Math.min(all[long.holdPoints - 1], 95);
    const starts = [toX(h)];
    for (const [s1, d, s2, d2] of [[endHold / 2, 0.5, endHold, 6], [10, 0.3, SILENCE_DB, 10], [endHold, 1, SILENCE_DB, 20],
        [3, 0.05, endHold, 3]]) {
        starts.push(toX({ ...h, hold: MIN_TIME * 2, decay: d, s1, decay2: d2, s2 }));
    }
    // knee starts: a fall that steepens toward its end (a line in amplitude to nothing) is a slow decay to the
    // curve's level at the knee, then a fast one to silence
    {
        const n = free ? g.length : long.holdPoints;
        let p0 = 0;
        for (let i = 1; i < n; i++) if (all[i] < all[p0]) p0 = i;
        let i1 = p0;
        while (i1 < n && all[i1] - all[p0] < 1) i1++;
        let iEnd = i1;
        while (iEnd < n && all[iEnd] < FLOOR_DB - 1) iEnd++;
        if (iEnd < n && iEnd - i1 >= 4) {
            for (const f of KNEES) {
                const k = i1 + Math.round(f * (iEnd - i1));
                const s1 = Math.min(Math.max(all[k] - all[p0], 1), SILENCE_DB - 1);
                starts.push(toX({ ...h, attack: Math.max(p0 * dt, MIN_TIME), hold: Math.max((i1 - p0) * dt, MIN_TIME),
                    decay: ((k - i1) * dt * SILENCE_DB) / s1, s1, decay2: Math.max(((iEnd - k) * dt * SILENCE_DB) / (SILENCE_DB - s1), MIN_TIME),
                    s2: SILENCE_DB }));
            }
        }
    }
    // every fixed start stays and the warm start comes on top (an ftol of 1e-8 stopped R Jz Snare2 on a 12 s decay,
    // 10 dB off in the DLL checks: the solve keeps its 1e-12)
    const best = bestOf("volume", starts, (x0) => solve(resid, x0, lo, hi, scale, 200));
    const [p, lvl] = params(best.x);
    return { top: peak * pow(10, -lvl / 20), gens: volumeGenerators(p, free) };
}

/**
 * RMS error in dB (clipped at FLOOR_DB) of generators against a curve, peak = the gain at the envelope's 0 dB.
 */
export function volumeRms(c: Curve, gens: Generators, peak: number, free: boolean) {
    const t = Float64Array.from(c.gain, (_, i) => i * c.dt);
    const model = volumeDb(t, c.holdPoints * c.dt, volumeParams(gens), free);
    const meas = toDb(c.gain, peak);
    let s = 0;
    for (let i = 0; i < t.length; i++) s += pow(Math.min(model[i], FLOOR_DB) - meas[i], 2);
    return Math.sqrt(s / t.length);
}

/**
 * SFe's modulation envelope (modEnv or modEnv2) as core draws it: the attack on core's convex curve,
 * hold, a linear decay to the sustain fraction, the release linear from where it stands over release x that level.
 * Times in seconds, sustain 0..1.
 */
export interface ModParams {
    attack: number;
    hold: number;
    decay: number;
    sustain: number;
    release: number;
}

/**
 * modEnv's held part at time tt (a plain function, as volumeHeld).
 */
function modHeld(tt: number, attack: number, hEnd: number, dLen: number, dEnd: number, sustain: number) {
    if (tt < attack && attack > 0) {
        return Math.min(Math.max(1 + (400 / 960) * Math.log10(Math.min(Math.max(tt / attack, 1e-9), 1)), 0), 1);
    }
    if (tt < hEnd) return 1;
    if (dLen > 0 && tt < dEnd) return 1 + (sustain - 1) * Math.min(Math.max((tt - hEnd) / dLen, 0), 1);
    return sustain;
}

/**
 * The modulation envelope (0..1) at times t, note off at off (Infinity: never).
 */
export function modEnv(t: Float64Array, off: number, p: ModParams) {
    const hEnd = p.attack + p.hold;
    const dLen = p.decay * (1 - p.sustain);
    const dEnd = hEnd + dLen;
    const lvl = off === Infinity ? 0 : modHeld(off, p.attack, hEnd, dLen, dEnd, p.sustain);
    const rd = Math.max(p.release, MIN_TIME) * lvl;
    const out = new Float64Array(t.length);
    for (let i = 0; i < t.length; i++) {
        if (t[i] < off) out[i] = modHeld(t[i], p.attack, hEnd, dLen, dEnd, p.sustain);
        else out[i] = rd > 0 ? Math.min(Math.max(1 - (t[i] - off) / rd, 0), 1) * lvl : 0;
    }
    return out;
}

/**
 * The generators of a modulation envelope, suffix "ModEnv" or "ModEnv2".
 */
export function modGenerators(p: ModParams, suffix: string) {
    return {
        ["attack" + suffix]: timecents(p.attack),
        ["hold" + suffix]: timecents(p.hold),
        ["decay" + suffix]: timecents(p.decay),
        ["sustain" + suffix]: Math.round((1 - p.sustain) * 1000),
        ["release" + suffix]: timecents(p.release)
    };
}

/**
 * The parameters back from generators (for scoring a generator set).
 */
export function modParams(gens: Generators, suffix: string) {
    const sec = (k: string) => ((gens[k + suffix] ?? -12000) <= -12000 ? 0 : pow(2, gens[k + suffix] / 1200));
    return {
        attack: sec("attack"),
        hold: sec("hold"),
        decay: sec("decay"),
        sustain: 1 - Math.min(Math.max(gens["sustain" + suffix] ?? 0, 0), 1000) / 1000,
        release: sec("release")
    };
}

/**
 * A modulation envelope projected onto a curve (cents): curve ~ offset + amount * env.
 */
export interface ModProjection {
    offset: number;
    amount: number;
    params: ModParams;
    /**
     * Weighted RMS of the projection's error and of the curve around its weighted mean (cents).
     */
    rms: number;
    raw: number;
}

/**
 * The loudness weight of each point: full down to 20 dB below the peak, nothing from 60 dB.
 */
export function loudnessWeights(gain: Float64Array) {
    let peak = 0;
    for (const x of gain) peak = Math.max(peak, x);
    return gain.map((x) => Math.min(Math.max((20 * Math.log10(Math.max(x, 1e-12) / Math.max(peak, 1e-12)) + 60) / 40, 0), 1));
}

/**
 * Projects SFe's modulation envelope onto an engine curve (cents every dt seconds, note off after holdPoints
 * points), each point weighed by the voice's loudness (gain), with a soft L1 loss. With releaseOffset the envelope may also be held at 1 and fall to 0 at the release, the way
 * an engine envelope with its own release level is drawn (offset + amount lands on the held part). Points past
 * 1 s away from the note off count every 4th at double weight. Undefined when fewer than 10 points sound.
 */
export function projectModEnv(curve: Float64Array, gain: Float64Array, dt: number, holdPoints: number,
                              releaseOffset = true, offsetRange: [number, number] = [-20000, 30000]): ModProjection | undefined {
    return warmMemo(modEnvs, "modEnv", [curve, gain, dt, holdPoints, releaseOffset ? 1 : 0, offsetRange[0], offsetRange[1]],
        () => projectModEnvOnce(curve, gain, dt, holdPoints, releaseOffset, offsetRange));
}

function projectModEnvOnce(curve: Float64Array, gain: Float64Array, dt: number, holdPoints: number, releaseOffset: boolean,
                           offsetRange: [number, number]): ModProjection | undefined {
    const w = loudnessWeights(gain);
    const off = holdPoints * dt;
    const tv = new Array<number>();
    const cv = new Array<number>();
    const wv = new Array<number>();
    for (let i = 0; i < curve.length; i++) {
        if (w[i] <= 0) continue;
        const tt = i * dt;
        const near = tt < 1 || Math.abs(tt - off) < 0.3;
        if (!near && i % 4 !== 0) continue;
        tv.push(tt);
        cv.push(curve[i]);
        wv.push(w[i] * (near ? 1 : 2));
    }
    if (tv.length < 10) return undefined;
    const t = Float64Array.from(tv);
    const c = Float64Array.from(cv);
    const wt = Float64Array.from(wv);
    const sw = wt.reduce((s, x) => s + x, 0);
    const mean = c.reduce((s, x, i) => s + x * wt[i], 0) / sw;
    const held = new Array<number>();
    for (let i = 0; i < t.length; i++) if (t[i] < off) held.push(i);
    const median = (a: number[]) => {
        const s = [...a].sort((x, y) => x - y);
        return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
    };
    const late = held.length ? held.slice(-Math.max(1, held.length >> 3)).map((i) => c[i]) : [c[c.length - 1]];
    const base0 = median(late);
    let iPeak = 0;
    for (const i of held) if (Math.abs(c[i] - base0) * wt[i] > Math.abs(c[iPeak] - base0) * wt[iPeak]) iPeak = i;
    const amount0 = c[iPeak] - base0 || 1;
    const after = new Array<number>();
    for (let i = 0; i < t.length; i++) if (t[i] >= off) after.push(c[i]);
    const r0 = after.length ? median(after.slice(0, Math.max(1, after.length >> 2))) - base0 : 0;
    const params = (x: Float64Array): ModParams => ({
        attack: Math.exp(x[2]), hold: Math.exp(x[3]), decay: Math.exp(x[4]), sustain: x[5], release: Math.exp(x[6])
    });
    // soft L1 (scipy's loss='soft_l1', f_scale 5) as a residual whose square is the loss
    const F = 5;
    const resid = (x: Float64Array) => {
        const e = modEnv(t, off, params(x));
        const r = new Float64Array(t.length);
        for (let i = 0; i < t.length; i++) {
            const z = ((x[0] + x[1] * e[i] - c[i]) * wt[i]) / F;
            r[i] = Math.sign(z) * F * Math.sqrt(2 * (Math.sqrt(1 + z * z) - 1));
        }
        return r;
    };
    const L = Math.log;
    const lo = Float64Array.from([offsetRange[0], -12000, L(MIN_TIME), L(MIN_TIME), L(MIN_TIME), 0, L(MIN_TIME)]);
    const hi = Float64Array.from([offsetRange[1], 12000, L(MAX_TIME), L(MAX_HOLD), L(MAX_TIME), 1, L(MAX_TIME)]);
    const scale = Math.max(Math.abs(amount0), Math.abs(r0), 1);
    const xs = Float64Array.from([scale, scale, 1, 1, 1, 0.2, 1]);
    const tPeak = Math.max(t[iPeak], MIN_TIME * 2);
    const starts = [[base0, amount0, MIN_TIME * 1.5, 0.2, 0], [base0, amount0, tPeak, 0.5, 0],
        [base0, amount0, MIN_TIME * 1.5, 2, 0], [base0, amount0, tPeak, 0.05, 0]];
    if (releaseOffset && Math.abs(r0) > 5) starts.push([base0 + r0, -r0, MIN_TIME * 1.5, 1, 1]);
    // a rise from the first point to the held level (scipy's trust region found these where this solver stuck:
    // Tuba's 180 cent scoop 11 -> 3 cents)
    {
        const c0 = c[0];
        let rise = 0;
        while (rise < t.length - 1 && t[rise] < off && Math.abs(c[rise] - base0) > 0.1 * Math.abs(c0 - base0)) rise++;
        const tRise = Math.max(t[rise], MIN_TIME * 2);
        if (Math.abs(c0 - base0) > 1) {
            starts.push([c0, base0 - c0, tRise, 0.2, 1]);
            if (releaseOffset && Math.abs(r0) > 5) starts.push([c0, base0 - c0, tRise, 1, 1]);
        }
    }
    // every fixed start and the warm start on top
    const best = bestOf("modEnv", starts.map(([o0, a0, at0, d0, s0]) => Float64Array.from([o0, a0, L(at0), L(MIN_TIME * 1.5), L(d0), s0, L(0.05)])),
        (x0) => solve(resid, x0, lo, hi, xs, 400));
    const x = best.x;
    const e = modEnv(t, off, params(x));
    let se = 0;
    let sr = 0;
    let n2 = 0;
    for (let i = 0; i < t.length; i++) {
        se += pow((x[0] + x[1] * e[i] - c[i]) * wt[i], 2);
        sr += pow((c[i] - mean) * wt[i], 2);
        n2 += pow(wt[i], 2);
    }
    return { offset: x[0], amount: x[1], params: params(x), rms: Math.sqrt(se / n2), raw: Math.sqrt(sr / n2) };
}
