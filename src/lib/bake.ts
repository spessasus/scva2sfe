/**
 * The bake step: the zones a decision list names play the engine's own render of the partial. The render comes from
 * the WASM bake renderer with the LFOs held at 0 (the zone keeps them live). The sample carries the envelopes, the
 * pitch envelope and the filter (tap "out"), or the voice before its filter where the zone keeps a live filter
 * ("pre"). A slow attack stays on the volume envelope, a voice still moving where the render loops hands its decay to
 * the volume envelope.
 */
import type { BakeRenderer, BakeVoice } from "../bake-renderer/index.js";
import { pow } from "./math.js";
import type { BakeEntry } from "../rules/bake-plan.js";
import type { Generators } from "./envfit.js";
import { timecents } from "./envfit.js";
import { fft } from "./tvf.js";
import { INSTANT } from "./zone-tva.js";

const SR = 32000;
const CALL = 64;
/**
 * The longest stretch a bake renders before its loop (s), the render runs BAKE_AFTER past it. A voice whose pitch or
 * cutoff still moves at the cap renders on to BAKE_MAX, and is not baked where it still moves then.
 */
const BAKE_CAP = 1.5;
const BAKE_AFTER = 2.0;
const BAKE_MAX = 4.0;
const RELEASE = 0.05;
/**
 * An attack that takes longer than ATTACK_SLOW (s) to come within ATTACK_NEAR dB of the TVA's peak plays on the
 * zone's volume envelope instead of in the sample.
 */
const ATTACK_SLOW = 0.02;
const ATTACK_NEAR = 0.5;
const SETTLE_DB = 0.1;
const SILENT = 90;
const SETTLE_CENTS = 0.5;
const SETTLE_F = 0.005;
const SWEEP_CENTS = 1.0;
const SWEEP_F = 0.01;
const LOOP_MIN = 512;
const LOOP_WINDOW = 4096;
const LOOP_FADE = 256;
const LOOP_LONG = 32000;
const LONG_FADE = 3200;
const LOOP_ERROR = 0.02;
const SAMPLE_HEADROOM = 0.97;

const VOL = ["delayVolEnv", "attackVolEnv", "holdVolEnv", "decayVolEnv", "sustainVolEnv", "decay2VolEnv", "sustain2VolEnv",
    "keyNumToVolEnvHold", "keyNumToVolEnvDecay", "delayVoice"];
const ENV2 = ["delayModEnv2", "attackModEnv2", "holdModEnv2", "decayModEnv2", "sustainModEnv2", "releaseModEnv2",
    "keyNumToModEnv2Hold", "keyNumToModEnv2Decay", "modEnv2ToPitch"];
const FILTER = ["initialFilterFc", "initialFilterQ", "filterQOffset", "maxFilterFc", "filterType", "modEnvToFilterFc",
    "modEnv2ToFilterFc", "delayModEnv", "attackModEnv", "holdModEnv", "decayModEnv", "sustainModEnv", "releaseModEnv",
    "keyNumToModEnvHold", "keyNumToModEnvDecay", "vibLfoToFilterFc", "modLfoToFilterFc"];
/**
 * What a bake takes out of the zone: after the filter everything the sample carries, before it the volume
 * envelope and the pitch envelope's depth.
 */
export const DROP_OUT: ReadonlySet<string> = new Set([...VOL, ...ENV2, ...FILTER]);
export const DROP_PRE: ReadonlySet<string> = new Set([...VOL, "modEnv2ToPitch"]);

export interface BakeQuery {
    map: number;
    msb: number;
    lsb: number;
    program: number;
    drum: boolean;
    key: number;
    tone: number;
}

export interface BakeJob {
    query: BakeQuery;
    slot: number;
    velocity: number;
    tap: "out" | "pre";
}

export interface BakeRender {
    data: Float32Array;
    loop?: [number, number];
    gain4: number;
    send: [number, number];
    /**
     * Where the TVA's attack is divided out of the data and the zone's volume envelope plays it (s).
     */
    attack?: number;
    /**
     * Decay, sustain (cB), decay 2, sustain 2 past the first for the volume envelope after a loop that starts
     * before the voice settled.
     */
    tail?: [number, number, number, number];
    loopError: number;
    /**
     * The first SHAPE_SECONDS of the voice per call: TVA gain (dB under its peak there), cutoff (log2 of the SVF
     * coefficient) and pitch (cents over the wave), for the tooling that builds the decision list (its velocity floors).
     */
    shape?: [Float64Array, Float64Array, Float64Array];
}

const median = (x: ArrayLike<number>) => {
    const s = Float64Array.from(x).sort();
    if (!s.length) return 0;
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * The call (from the note on) from which the voice's TVA gain (gain), pitch and cutoff (cutoff) stay where they end
 * the hold, the gain also where it has gone silent for good.
 */
function settleTime(v: BakeVoice, holdCalls: number, gain: boolean, cutoff: boolean, centsTol: number, fTol: number) {
    const c = v.calls;
    const idx = new Array<number>();
    for (let i = 0; i < c.count; i++) if (c.call[i] < holdCalls) idx.push(i);
    if (!idx.length) return 0;
    const g = idx.map((i) => c.tvaAmp[i]);
    const ok = idx.map(() => true);
    if (gain) {
        const top = 20 * Math.log10(Math.max(Math.max(...g), 1e-12));
        const db = g.map((x) => 20 * Math.log10(Math.max(x, 1e-12)));
        const end = db[db.length - 1];
        db.forEach((d, j) => (ok[j] = ok[j] && (Math.abs(d - end) <= SETTLE_DB || (d < top - SILENT && end < top - SILENT))));
    }
    const ratio = idx.map((i) => c.ratio[i]);
    const lastLive = [...ratio].reverse().find((r) => r > 0);
    if (lastLive !== undefined) {
        ratio.forEach((r, j) => {
            if (r > 0) ok[j] = ok[j] && Math.abs(1200 * Math.log2(Math.max(r, 1) / Math.max(lastLive, 1))) <= centsTol;
        });
    }
    const f = idx.map((i) => c.svfF[i]);
    if (cutoff && f[f.length - 1] > 0) f.forEach((x, j) => (ok[j] = ok[j] && Math.abs(x / f[f.length - 1] - 1) <= fTol));
    let last = -1;
    ok.forEach((x, j) => {
        if (!x) last = j;
    });
    if (last < 0) return c.call[idx[0]];
    return c.call[idx[Math.min(last + 1, idx.length - 1)]];
}

/**
 * A loop of whole periods in y from start: the length N (LOOP_MIN..longest) where y[t + N] is closest to y[t] over
 * LOOP_WINDOW samples (the smallest within twice the best), and its relative error.
 */
function findLoop(y: Float64Array, start: number, longest: number): [number | undefined, number] {
    const w = y.subarray(start, start + LOOP_WINDOW);
    const tail = y.subarray(start, start + LOOP_WINDOW + longest);
    if (tail.length < LOOP_WINDOW + LOOP_MIN || !w.some((x) => x !== 0)) return [undefined, 1];
    const n = 1 << Math.ceil(Math.log2(tail.length + LOOP_WINDOW));
    const ar = new Float64Array(n);
    const ai = new Float64Array(n);
    const br = new Float64Array(n);
    const bi = new Float64Array(n);
    ar.set(w);
    br.set(tail);
    fft(ar, ai);
    fft(br, bi);
    // conj(A) * B, then the inverse by the conjugate trick
    for (let k = 0; k < n; k++) {
        const re = ar[k] * br[k] + ai[k] * bi[k];
        const im = ar[k] * bi[k] - ai[k] * br[k];
        ar[k] = re;
        ai[k] = -im;
    }
    fft(ar, ai);
    const m = tail.length - LOOP_WINDOW + 1;
    const sq = new Float64Array(tail.length + 1);
    for (let i = 0; i < tail.length; i++) sq[i + 1] = sq[i] + tail[i] * tail[i];
    let e0 = 0;
    for (const x of w) e0 += x * x;
    const d = new Float64Array(m);
    let best = Infinity;
    for (let t = 0; t < m; t++) {
        const corr = ar[t] / n;
        const energy = sq[t + LOOP_WINDOW] - sq[t];
        d[t] = t < LOOP_MIN ? Infinity : (e0 + energy - 2 * corr) / Math.max(e0 + energy, 1e-30);
        best = Math.min(best, d[t]);
    }
    const lim = Math.max(2 * best, 1e-7);
    for (let t = 0; t < m; t++) if (d[t] <= lim) return [t, d[t]];
    return [undefined, 1];
}

/**
 * The decay after a bake's loop point as SFe's decay and second decay: (seconds per 96 dB, sustain cB, seconds per
 * 96 dB, second sustain cB past the first), from a two piece line in dB through the engine's curve.
 */
function twoSegments(t: Float64Array, db: Float64Array): [number, number, number, number] {
    let best: [number, number, number, number] | undefined;
    const n = t.length;
    for (let k = 4; k < n - 4; k += Math.max(1, Math.floor(n / 40))) {
        const s1 = db[k] / Math.max(t[k], 1e-6);
        const s2 = (db[n - 1] - db[k]) / Math.max(t[n - 1] - t[k], 1e-6);
        let e = 0;
        for (let i = 0; i < n; i++) {
            const m = t[i] <= t[k] ? s1 * t[i] : db[k] + s2 * (t[i] - t[k]);
            e += pow(m - db[i], 2);
        }
        const err = Math.sqrt(e / n);
        if (!best || err < best[0]) best = [err, s1, s2, db[k]];
    }
    if (!best) {
        const s1 = db[n - 1] / Math.max(t[n - 1], 1e-6);
        best = [0, s1, s1, db[n - 1]];
    }
    const [, s1, s2, knee] = best;
    const flat = Math.abs(db[n - 1] - db[Math.max(0, n - Math.floor(n / 5) - 1)]) < 0.2;
    const per96 = (s: number) => 96 / Math.max(Math.abs(s), 1e-3);
    const sus1 = Math.max(0, Math.min(960, -10 * knee));
    const sus2 = flat ? Math.max(0, Math.min(960, -10 * db[n - 1])) : 960;
    return [per96(s1), sus1, per96(s2), sus2 - sus1];
}

const SHAPE_SECONDS = 1.0;

function shapeOf(v: BakeVoice): [Float64Array, Float64Array, Float64Array] {
    const c = v.calls;
    const last = Math.floor((SHAPE_SECONDS * SR) / CALL);
    let n = 0;
    while (n < c.count && c.call[n] < last) n++;
    let top = 0;
    for (let i = 0; i < n; i++) top = Math.max(top, c.tvaAmp[i]);
    top = Math.max(top, 1e-6);
    return [
        Float64Array.from({ length: n }, (_, i) => 20 * Math.log10(Math.max(c.tvaAmp[i], 1e-6) / top)),
        Float64Array.from({ length: n }, (_, i) => Math.log2(Math.max(c.svfF[i], 1e-6))),
        Float64Array.from({ length: n }, (_, i) => 1200 * Math.log2(Math.max(c.ratio[i], 1) / 65536))
    ];
}

/**
 * A partial's voice rendered for a bake (render_bake), undefined where the partial does not sound, or where its pitch
 * or (tap "out") cutoff still moves, or its attack still rises, at BAKE_MAX.
 */
export function renderBake(renderer: BakeRenderer, job: BakeJob) {
    const { query: q, slot, velocity, tap } = job;
    let v: BakeVoice | undefined;
    let hold = 0;
    let holdCalls = 0;
    let sweep = 0;
    let tPeak = 0;
    let cap = BAKE_CAP;
    let found = false;
    for (cap of [BAKE_CAP, BAKE_MAX]) {
        hold = cap + BAKE_AFTER;
        const holdFrames = Math.round(hold * SR);
        const frames = Math.ceil(Math.round((hold + RELEASE) * SR) / CALL) * CALL;
        const res = renderer.render({ map: q.map, msb: q.msb, lsb: q.lsb, program: q.program, drum: q.drum, key: q.key, velocity, tone: q.tone, holdFrames, frames });
        v = res.voices.find((x) => x.partial === slot && x.calls.count > 0);
        if (!v) return undefined;
        holdCalls = Math.floor(holdFrames / CALL);
        sweep = settleTime(v, holdCalls, false, tap === "out", SWEEP_CENTS, SWEEP_F) * CALL;
        const c = v.calls;
        let top = 0;
        for (let i = 0; i < c.count; i++) if (c.call[i] < holdCalls) top = Math.max(top, c.tvaAmp[i]);
        const near = top * pow(10, -ATTACK_NEAR / 20);
        for (let i = 0; i < c.count; i++) {
            if (c.call[i] < holdCalls && c.tvaAmp[i] >= near) {
                tPeak = c.call[i] * CALL;
                break;
            }
        }
        if (sweep <= cap * SR && tPeak <= cap * SR) {
            found = true;
            break;
        }
    }
    if (!found || !v) return undefined;
    const holdFrames = Math.round(hold * SR);
    const y = tap === "out" ? v.out : v.pre;
    const br = v.blocks;
    const g4 = br.count ? median(Array.from({ length: br.count }, (_, i) => br.gain4[i * 4])) : 0;
    let left = 0;
    let right = 0;
    if (v.sends.count && v.sends.bus[0] === 51 && v.sends.bus[1] === 52) {
        left = median(Array.from({ length: v.sends.count }, (_, i) => v!.sends.level[i * 4]));
        right = median(Array.from({ length: v.sends.count }, (_, i) => v!.sends.level[i * 4 + 1]));
    }
    if (!y || g4 <= 0) return undefined;
    // the voice's gain per output sample: the TVA ramp times the part level stage
    const g = new Float64Array(y.length);
    for (let r = 0; r < br.count; r++) {
        const b = br.block[r];
        if (b * 32 < 0 || b * 32 >= y.length) continue;
        for (let i = 0; i < 32 && b * 32 + i < y.length; i++) g[b * 32 + i] = br.gain16[r * 16 + (i >> 1)] * br.gain4[r * 4 + (i >> 3)];
    }
    const settle = settleTime(v, holdCalls, true, tap === "out", SETTLE_CENTS, SETTLE_F) * CALL;
    const data = Float64Array.from(y, (x) => x / g4);
    let peak = 0;
    for (let i = 0; i < Math.min(holdFrames, data.length); i++) peak = Math.max(peak, Math.abs(data[i]));
    if (peak <= 0) return undefined;
    const out: BakeRender = { data: new Float32Array(0), gain4: g4, send: [left, right], loopError: 0, shape: shapeOf(v) };
    // a slow attack goes to the zone's volume envelope: the data before the TVA's peak with its gain divided out
    if (tPeak > ATTACK_SLOW * SR && g[tPeak] > 0) {
        const gp = g[tPeak];
        for (let i = 0; i < tPeak; i++) data[i] *= g[i] > 0 ? gp / Math.max(g[i], gp * 1e-3) : 0;
        out.attack = tPeak / SR;
    }
    const floor = peak * pow(10, -SILENT / 20);
    let lastLoud = -1;
    for (let i = 0; i < data.length; i++) if (Math.abs(data[i]) > floor) lastLoud = i;
    const c = v.calls;
    let tvaTop = 0;
    let tvaLast = 0;
    for (let i = 0; i < c.count; i++) {
        if (c.call[i] < holdCalls) {
            tvaTop = Math.max(tvaTop, c.tvaAmp[i]);
            tvaLast = c.tvaAmp[i];
        }
    }
    let silentEnd = true;
    for (let i = holdFrames - 64; i < holdFrames; i++) if (y[i]) silentEnd = false;
    const gone = silentEnd || 20 * Math.log10(Math.max(tvaLast, 1e-12) / Math.max(tvaTop, 1e-12)) < -SILENT;
    if (gone && settle <= cap * SR) {
        out.data = Float32Array.from(data.subarray(0, lastLoud + 1));
        return out;
    }
    // the loop starts where the voice has settled, at the latest at the cap, and not before the sampler has entered
    // the wave's own loop
    let entry = 0;
    for (let r = 0; r < br.count; r++) {
        if (br.event[r]) {
            entry = br.block[r] * 32 + LOOP_FADE;
            break;
        }
    }
    const start = Math.max(Math.min(settle, Math.trunc(cap * SR)), entry, sweep, out.attack !== undefined ? tPeak : 0);
    const longest = holdFrames - start - LOOP_WINDOW;
    const region = data.slice();
    if (settle > start) {
        // still moving at the cap: the loop plays the voice with its gain divided out, at the gain of the loop's
        // start, and the volume envelope takes the decay on from there
        for (let i = 0; i < region.length; i++) if (g[i] > 0) region[i] = data[i] * g4 / g[i] * (g[start] / g4);
        const tc = new Array<number>();
        const gt = new Array<number>();
        for (let i = 0; i < c.count; i++) {
            if (c.call[i] * CALL >= start && c.call[i] < holdCalls) {
                tc.push(c.call[i]);
                gt.push(c.tvaAmp[i]);
            }
        }
        if (gt.length > 8 && gt[0] > 0) {
            const t = Float64Array.from(tc, (x) => ((x - tc[0]) * CALL) / SR);
            const db = Float64Array.from(gt, (x) => 20 * Math.log10(Math.max(x, 1e-12) / gt[0]));
            out.tail = twoSegments(t, db);
        }
    }
    let [N, err] = findLoop(region, start, Math.max(longest, LOOP_MIN));
    if (N === undefined) {
        out.data = Float32Array.from(data.subarray(0, lastLoud + 1));
        out.tail = undefined;
        return out;
    }
    let fade = Math.min(LOOP_FADE, N >> 2, start);
    if (err > LOOP_ERROR) {
        N = Math.max(N, Math.min(LOOP_LONG, longest + LOOP_WINDOW));
        fade = Math.min(LONG_FADE, N >> 2, start);
    }
    const end = start + N;
    const body = new Float64Array(end);
    body.set(data.subarray(0, start));
    body.set(region.subarray(start, end), start);
    // crossfade into the loop's end from the samples before its start (equal power where the two do not correlate)
    if (fade > 1) {
        for (let i = 0; i < fade; i++) {
            const w = i / fade;
            const [a, b] = err > LOOP_ERROR ? [Math.cos((w * Math.PI) / 2), Math.sin((w * Math.PI) / 2)] : [1 - w, w];
            body[end - fade + i] = body[end - fade + i] * a + body[start - fade + i] * b;
        }
    }
    out.data = Float32Array.from(body);
    out.loop = [start, end];
    out.loopError = err;
    return out;
}

/**
 * The query that plays a plan entry: a melodic tone directly on map 4, a kit through the first map and program that
 * select it (GM2 kits through the GM2 map).
 */
export function bakeQuery(e: BakeEntry, kitPage: Map<number, [number, number]>) {
    if (e.kind === "melodic") return { map: 4, msb: 0, lsb: 0, program: 0, drum: false, key: e.key, tone: e.tone };
    const [page, program] = kitPage.get(e.kit)!;
    return page === 120
        ? { map: 0x7a, msb: 0, lsb: 0, program, drum: true, key: e.note, tone: -1 }
        : { map: page, msb: 0, lsb: page, program, drum: true, key: e.note, tone: -1 };
}

/**
 * A baked zone's generators: the zone's own without what the sample carries (a slow attack stays), the tail after
 * the loop on the volume envelope, the render's key as the root.
 */
export function bakedGenerators(gens: Generators, r: BakeRender, tap: "out" | "pre", renderKey: number, tune: number) {
    const drop = tap === "out" ? DROP_OUT : DROP_PRE;
    const keep = r.attack !== undefined ? new Set(["delayVolEnv", "attackVolEnv"]) : new Set<string>();
    const g: Generators = {};
    for (const [n, x] of Object.entries(gens)) if (!drop.has(n) || keep.has(n)) g[n] = x;
    if (!keep.size) {
        g.attackVolEnv = INSTANT;
        g.delayVolEnv = INSTANT;
    }
    g.sampleModes = r.loop ? 1 : 0;
    const scale = gens.scaleTuning ?? 100;
    if (r.tail && r.loop) {
        const [d1, s1, d2, s2] = r.tail;
        // the hold runs to the loop's start, which the sample reaches sooner or later by its playback rate: the key
        // follow on the hold (timecents a key, against key 60) is the pitch key follow
        let attack = 0;
        for (const n of keep) attack += pow(2, (g[n] ?? -12000) / 1200);
        let hold = timecents(Math.max(r.loop[0] / SR - attack, 0.001));
        // core clamps the stored hold before it adds the key's excursion: a render key far from 60 holds flat
        if (scale && -12000 <= hold - Math.round(scale) * (60 - renderKey) && hold - Math.round(scale) * (60 - renderKey) <= 5000) {
            g.keyNumToVolEnvHold = Math.round(scale);
            hold -= Math.round(scale) * (60 - renderKey);
        }
        Object.assign(g, {
            holdVolEnv: Math.max(-12000, Math.min(5000, hold)), decayVolEnv: Math.min(8000, timecents(d1)), sustainVolEnv: Math.round(s1),
            decay2VolEnv: Math.min(8000, timecents(d2)), sustain2VolEnv: Math.round(s2)
        });
    }
    const coarse = Math.round(tune / 100);
    Object.assign(g, { overridingRootKey: renderKey, coarseTune: coarse, fineTune: Math.round(tune - coarse * 100) });
    return g;
}

/**
 * The bake sample's gain where its peak would clip.
 */
export function bakeGain(data: Float32Array) {
    let top = 0;
    for (const x of data) top = Math.max(top, Math.abs(x));
    return top > 1e-6 ? SAMPLE_HEADROOM / top : undefined;
}
