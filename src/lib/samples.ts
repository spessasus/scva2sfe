/**
 * The bank's sample table: one sample per distinct wave traversal (rom.ts decodes the stream the engine's sampler
 * plays), the engine's interpolation as a FIR the writer bakes into every sample, the per sample gain where the
 * bank's would clip, the SVF copies of baked static filters and the alternating loop of the ping-pong waves.
 */
import type { BankSample } from "./bank.js";
import { pow } from "./math.js";
import type { Directory } from "./directory.js";
import type { Dll } from "./dll.js";
import { fileOffset } from "./dll.js";
import type { SvfTap } from "./filter-map.js";
import { svfResponse } from "./filter-map.js";
import type { DecodedWave } from "./rom.js";
import { decodeWave, sampleKey } from "./rom.js";

/**
 * g_interp_coef_table: 128 phase rows of 4 float32 taps.
 */
const INTERP_TABLE = fileOffset(0x181a0f210);
const TAPS = 15;
export const SAMPLE_GAIN = 1.5;
const SAMPLE_HEADROOM = 0.97;

/**
 * |mean over phases| of a 4 tap interpolator's response at f (cycles per sample), rows[p] the taps of phase p / n.
 */
function phaseAverage(rows: number[][], f: Float64Array) {
    const n = rows.length;
    return f.map((x) => {
        const w = 2 * Math.PI * x;
        let re = 0;
        let im = 0;
        for (let p = 0; p < n; p++) {
            for (let k = 0; k < 4; k++) {
                const a = -w * (k - 1 - p / n);
                re += rows[p][k] * Math.cos(a);
                im += rows[p][k] * Math.sin(a);
            }
        }
        return Math.hypot(re, im) / n;
    });
}

/**
 * Solves the normal equations of a weighted least squares problem (a small dense system).
 */
function leastSquares(a: Float64Array[], y: Float64Array, w: Float64Array) {
    const m = a[0].length;
    const ata = Array.from({ length: m }, () => new Float64Array(m + 1));
    for (let i = 0; i < a.length; i++) {
        const ww = w[i] * w[i];
        for (let r = 0; r < m; r++) {
            for (let c = 0; c < m; c++) ata[r][c] += a[i][r] * a[i][c] * ww;
            ata[r][m] += a[i][r] * y[i] * ww;
        }
    }
    for (let c = 0; c < m; c++) {
        let p = c;
        for (let r = c + 1; r < m; r++) if (Math.abs(ata[r][c]) > Math.abs(ata[p][c])) p = r;
        [ata[c], ata[p]] = [ata[p], ata[c]];
        for (let r = 0; r < m; r++) {
            if (r === c) continue;
            const k = ata[r][c] / ata[c][c];
            for (let j = c; j <= m; j++) ata[r][j] -= k * ata[c][j];
        }
    }
    return Float64Array.from({ length: m }, (_, r) => ata[r][m] / ata[r][r]);
}

/**
 * The FIR (15 taps, symmetric) that takes core's Hermite to the engine's interpolation, fitted below 0.47 of the
 * sample rate to the ratio of the two phase averages. From the DLL's table at conversion time.
 */
export function interpolationFir(dll: Dll) {
    const view = new DataView(dll.bytes.buffer, dll.bytes.byteOffset, dll.bytes.byteLength);
    const rows = Array.from({ length: 128 }, (_, p) => [0, 1, 2, 3].map((k) => view.getFloat32(INTERP_TABLE + (p * 4 + k) * 4, true)));
    const hermite = Array.from({ length: 128 }, (_, p) => {
        const t = p / 128;
        return [(-(pow(t, 3)) + 2 * pow(t, 2) - t) / 2, (3 * pow(t, 3) - 5 * pow(t, 2) + 2) / 2, (-3 * pow(t, 3) + 4 * pow(t, 2) + t) / 2, (pow(t, 3) - pow(t, 2)) / 2];
    });
    const f = Float64Array.from({ length: 511 }, (_, i) => ((i + 1) * 0.5) / 512);
    const engine = phaseAverage(rows, f);
    const core = phaseAverage(hermite, f);
    const half = TAPS >> 1;
    const a = Array.from(f, (x) => Float64Array.from({ length: half + 1 }, (_, k) => (k === 0 ? 1 : 2 * Math.cos(2 * Math.PI * k * x))));
    const target = engine.map((e, i) => e / core[i]);
    const c = leastSquares(a, target, f.map((x) => (x < 0.47 ? 1 : 0.1)));
    return [...Array.from(c.subarray(1)).reverse(), ...c];
}

/**
 * A zero phase FIR (odd length) over a signal, the edges read as silence (numpy's convolve 'same').
 */
export function convolveSame(x: Float32Array, taps: ArrayLike<number>) {
    const half = (taps.length - 1) >> 1;
    const y = new Float64Array(x.length);
    for (let i = 0; i < x.length; i++) {
        let acc = 0;
        const k0 = Math.max(-half, -i);
        const k1 = Math.min(half, x.length - 1 - i);
        for (let k = k0; k <= k1; k++) acc += taps[half - k] * x[i + k];
        y[i] = acc;
    }
    return y;
}

/**
 * The gain that puts a sample's peak (after the interpolation FIR and an optional filter FIR) at the headroom, or
 * undefined for a silent one.
 */
export function ownGain(x: Float32Array, interp: ArrayLike<number>, fir?: ArrayLike<number>) {
    if (!x.length) return undefined;
    let y = convolveSame(x, interp);
    if (fir) y = convolveSame(Float32Array.from(y), fir);
    let top = 0;
    for (const v of y) top = Math.max(top, Math.abs(v));
    return top > 1e-6 ? SAMPLE_HEADROOM / top : undefined;
}

/**
 * The modified Bessel function I0 (Kaiser windows).
 */
function besselI0(x: number) {
    let sum = 1;
    let term = 1;
    for (let k = 1; k < 64; k++) {
        term *= pow(x / (2 * k), 2);
        sum += term;
        if (term < 1e-17 * sum) break;
    }
    return sum;
}

/**
 * A zero phase FIR that gives a sample the engine's SVF tap at coefficient f and damping q played back at ratio:
 * the response on a 16384 point grid of the output's frequencies, its impulse response cut to 511
 * taps (2047 for a sharp resonance or a low cutoff) under a Kaiser window (beta 8).
 */
export function svfFir(f: number, q: number, tap: SvfTap, ratio: number) {
    const taps = q < 0.25 || f / ratio < 0.06 ? 2047 : 511;
    const n = 16384;
    const hz = Float64Array.from({ length: n / 2 + 1 }, (_, i) => Math.min(Math.max((i / n) * 32000 * ratio, 1), 16000 - 1));
    const h = svfResponse(f, q, hz, tap);
    const half = taps >> 1;
    const fir = new Array<number>(taps);
    const i0 = besselI0(8);
    for (let j = 0; j < taps; j++) {
        const k = j - half;
        // irfft of a real, even spectrum
        let acc = h[0] + h[n / 2] * (k % 2 === 0 ? 1 : -1);
        for (let i = 1; i < n / 2; i++) acc += 2 * h[i] * Math.cos((2 * Math.PI * i * k) / n);
        const r = (2 * j) / (taps - 1) - 1;
        const w = besselI0(8 * Math.sqrt(Math.max(0, 1 - r * r))) / i0;
        fir[j] = Math.round((acc / n) * w * 1e7) / 1e7;
    }
    return fir;
}

/**
 * Every wave's sample: decoded once per traversal, the audio concatenated in wave order.
 */
export class SampleTable {
    public readonly samples = new Array<BankSample>();
    /**
     * Wave number -> sample index (undefined: the wave has no data).
     */
    public readonly ofWave = new Map<number, number | undefined>();
    private readonly decoded = new Array<DecodedWave>();
    private readonly byKey = new Map<string, number | undefined>();
    private readonly dll;
    private readonly dir;
    private length = 0;

    public constructor(dll: Dll, dir: Directory) {
        this.dll = dll;
        this.dir = dir;
    }

    /**
     * The sample of a wave, decoded on first use.
     */
    public of(wave: number) {
        if (this.ofWave.has(wave)) return this.ofWave.get(wave);
        const d = this.dir.wave(wave);
        const key = sampleKey(d);
        let k = this.byKey.get(key);
        if (!this.byKey.has(key)) {
            const w = decodeWave(this.dll, d);
            if (w && w.data.length) {
                k = this.samples.length;
                this.decoded.push(w);
                let peak = 0;
                for (const v of w.data) peak = Math.max(peak, Math.abs(v));
                this.samples.push({ name: `w${wave}`, offset: this.length, length: w.data.length, loop_start: w.loopStart, loop_end: w.loopEnd, mode: w.mode, peak } as BankSample);
                this.length += w.data.length;
            }
            this.byKey.set(key, k);
        }
        this.ofWave.set(wave, k);
        return k;
    }

    public data(k: number) {
        return this.decoded[k].data;
    }

    /**
     * The decoded audio at an audio offset (a copy of a sample shares its source's).
     */
    public dataAt(offset: number) {
        const k = this.samples.findIndex((s) => s.offset === offset);
        return this.decoded[k].data;
    }

    /**
     * The decoded audio of every sample, in table order (the bank's samples.f32).
     */
    public audio() {
        const out = new Float32Array(this.length);
        this.decoded.forEach((w, k) => out.set(w.data, this.samples[k].offset));
        return out;
    }
}
