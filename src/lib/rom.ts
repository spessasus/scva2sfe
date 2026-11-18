/**
 * The wave ROM inside SCCore.dll: block floating point DPCM, decoded to the traversal the engine plays (forward
 * loop, ping-pong round trip, reverse walk, one shot). Adapted from Tabula Sonora / NativeTS (BSD 3-Clause, Copyright
 * (c) 2026 Kevin López Brante, see NOTICE.md), checked against the engine's own sampler.
 */
import type { Dll } from "./dll.js";
import type { WaveDescriptor } from "./directory.js";

const WAVE_BANKS = [0x92700, 0x1092730];
const REGION_SIZE = 0x100000;
const OUTPUT_SCALE = 2 ** -27;

export type SampleMode = "loop" | "pingpong" | "reverse" | "oneshot";

export interface DecodedWave {
    data: Float32Array;
    loopStart: number;
    /**
     * Exclusive, like SF2.
     */
    loopEnd: number;
    mode: SampleMode;
}

const regionBase = (region: number) => {
    const bank = (region >> 4) & 1;
    return WAVE_BANKS[bank] + (region - 16 * bank) * REGION_SIZE;
};

/**
 * Waves with the same extent and traversal decode to the same sample (bit 1 of the flags plays no part).
 */
export const sampleKey = (d: WaveDescriptor) => `${d.region}:${d.loop}:${d.start}:${d.end}:${d.flags & 5}`;

/**
 * The scale (shift) of delta n from a 32-sample block's packed scale byte: the low nibble for its first 16 samples.
 */
const scaleOf = (packed: number, pos: number) => ((pos >> 4) & 1 ? packed >> 4 : packed & 15);

/**
 * The forward decode from the 32-sample block below the data start: predictors (int32, count + 1) and the steps.
 */
function forward(dll: Dll, d: WaveDescriptor) {
    const start = d.loop & ~0x1f;
    const count = d.start - start;
    if (count <= 0) return undefined;
    const base = regionBase(d.region);
    const first = start & ~0x1f;
    const n = start - first + count + 1;
    const steps = new Float64Array(n);
    const pred = new Int32Array(n);
    let acc = 0;
    for (let p = 0; p < n; p++) {
        const delta = dll.s8(base + first + p);
        const step = delta * 2 ** (scaleOf(dll.u8(base + (first >> 5) + (p >> 5)), p) + 10);
        steps[p] = step;
        // the engine's accumulator is 32 bits wide
        acc = (acc + step) | 0;
        pred[p] = acc;
    }
    const phase = start - first;
    return { pred: pred.subarray(phase), steps: steps.subarray(phase) };
}

/**
 * A reverse wave as the engine plays it: the read position walks from the data end down to the data start, the
 * predictor starts at 0 at the top and keeps adding the deltas on the way down.
 */
function reverseWalk(dll: Dll, d: WaveDescriptor) {
    const lo = d.loop;
    const top = d.start;
    if (top < lo || lo < 1) return undefined;
    const first = (lo - 1) & ~0x1f;
    const base = regionBase(d.region);
    const n = top - lo + 1;
    const out = new Int32Array(n);
    let acc = 0;
    for (let i = 0; i < n; i++) {
        const p = top - first - i;
        // the init primes four samples and steps back up by one: with the data end at 3 mod 32 the first fetch
        // crosses the half block again, and from there every delta takes the scale byte of the block below
        const block = (p >> 5) - (top % 32 === 3 && p <= top - first - 4 ? 1 : 0);
        const step = dll.s8(base + first + p) * 2 ** (scaleOf(dll.u8(base + (first >> 5) + block), p) + 10);
        acc = (acc + step) | 0;
        out[i] = acc;
    }
    return out;
}

const toFloat = (x: ArrayLike<number>) => Float32Array.from(x, (v) => Math.fround(v * OUTPUT_SCALE));

/**
 * A wave's traversal as a bank sample, undefined for an empty wave.
 */
export function decodeWave(dll: Dll, d: WaveDescriptor): DecodedWave | undefined {
    const w = traversal(dll, d);
    if (w && (w.mode === "oneshot" || w.mode === "reverse")) {
        // the sampler stops at the last whole 32-sample block when only one or two samples are left past it and
        // plays its idle level there (63 waves, the engine's decode)
        const rest = w.data.length % 32;
        if (rest > 0 && rest <= 2) w.data.fill(Math.fround(1e-5), w.data.length - rest);
    }
    return w;
}

function traversal(dll: Dll, d: WaveDescriptor): DecodedWave | undefined {
    const f = forward(dll, d);
    if (!f) return undefined;
    const start = d.loop & ~0x1f;
    const de = d.start - start;
    const ls = Math.max(0, d.end - start);
    if (d.flags & 4) {
        const walk = reverseWalk(dll, d);
        if (walk) return { data: toFloat(walk), loopStart: 0, loopEnd: 0, mode: "reverse" };
        return { data: toFloat(f.pred.subarray(0, de + 1)).reverse(), loopStart: 0, loopEnd: 0, mode: "reverse" };
    }
    if (d.flags & 1 && de > ls) {
        // the predictor keeps adding on the way down, the turnaround index is applied twice
        const idx = new Array<number>();
        for (let k = de; k >= ls; k--) idx.push(k);
        for (let k = ls; k <= de; k++) idx.push(k);
        const out = new Float32Array(de + 1 + idx.length);
        out.set(toFloat(f.pred.subarray(0, de + 1)));
        let acc = f.pred[de];
        for (let i = 0; i < idx.length; i++) {
            acc = (acc + f.steps[idx[i]]) | 0;
            out[de + 1 + i] = Math.fround(acc * OUTPUT_SCALE);
        }
        return { data: out, loopStart: de + 1, loopEnd: de + 1 + idx.length, mode: "pingpong" };
    }
    if (de > ls) return { data: toFloat(f.pred.subarray(0, de + 1)), loopStart: ls, loopEnd: de + 1, mode: "loop" };
    return { data: toFloat(f.pred.subarray(0, de)), loopStart: 0, loopEnd: 0, mode: "oneshot" };
}
