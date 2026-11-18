/**
 * The engine's TVF from a partial's bytes: the filter type and tap, the damping, the cutoff with its key follow, the
 * envelope's levels (velocity depth) and times (key follow, velocity), the cutoff sum per control tick through the
 * warp and the ceiling, and the SVF coefficients the ramps hand the filter every 8 samples (no render). Adapted from
 * NativeTS `TvfChain` and `EnvelopeMachine` (BSD 3-Clause, Copyright (c) 2026 Kevin López Brante, see NOTICE.md),
 * checked against SC-VA's own filter.
 */
import type { Directory } from "./directory.js";
import type { Dll } from "./dll.js";
import { fileOffset, readU16 } from "./dll.js";
import { TvaModel } from "./tva.js";

const TYPE_WORDS = fileOffset(0x181987b00);
const KF_CUTOFF = fileOffset(0x181a02a20);
const KF_SCALE_UP = fileOffset(0x1819a2fa8);
const KF_SCALE_DOWN = fileOffset(0x1819a3028);
const RESO_CURVE = fileOffset(0x1819a2b88);
const ENV_LEVEL_CURVE = fileOffset(0x1819a2890);
const KF_TVF_RATE = [fileOffset(0x181a03920), fileOffset(0x181a03620)];
const ENV_RATE_WORDS = fileOffset(0x1819a7a00);
const WARP = fileOffset(0x1819a83d0);
const CEILING = fileOffset(0x1819a7ed0);
const Q_LOWPASS = fileOffset(0x1819a7cd0);
const Q_TYPE6 = fileOffset(0x1819a7fd0);
const VEL_SENS = fileOffset(0x181a01520);
const EXP_TABLE = fileOffset(0x181986420);
const F_CEILING = fileOffset(0x181986860);
const MODE_BITS = fileOffset(0x1819ab678);
const MASK_BITS = fileOffset(0x1819a84d8);
const STEP_MASKS = fileOffset(0x181a03e00);
const INTERP_TABLE = fileOffset(0x181a0f210);
/**
 * The spectrum's frame (samples) and how much of a sample it looks at: the attack and a pass of the loop.
 */
const FRAME = 512;
const SPECTRUM_SPAN = 32768;

/**
 * The SVF's state when a voice starts and a ramp at 0 gives out (1e-5 in float32).
 */
export const IDLE = Math.fround(1e-5);
/**
 * Control ticks are 10 blocks of 32 samples apart.
 */
export const TICK_BLOCKS = 10;
/**
 * The engine's sample rate.
 */
export const ENGINE_RATE = 32000;

/**
 * The SVF output the filter type's word selects: low, band, high or low less high (the symbol names' notch, a peak).
 */
export type Tap = "low" | "band" | "high" | "peak";

const s16 = (x: number) => (x << 16) >> 16;
const u16 = (x: number) => x & 0xffff;

/**
 * What the note on leaves in the voice for its TVF.
 */
export interface TvfVoice {
    type: number;
    /**
     * Undefined for the types without a filter (3 and 7 up: the high tap at a coefficient of 0, the input passes).
     */
    tap?: Tap;
    /**
     * The damping byte (resonance 0x30 with the part's neutral controllers, at least 4).
     */
    damp: number;
    /**
     * The cutoff sum's base: byte 0x2f * 256 plus the cutoff key follow (s16).
     */
    base: number;
    /**
     * The key follow alone (s16, in the cutoff sum's units: 256 per cutoff byte step).
     */
    follow: number;
    /**
     * The envelope's targets of stages 0..3 against the base (s16). Stage 0 starts from 0.
     */
    levels: number[];
    /**
     * The release segment's target against the base.
     */
    releaseLevel: number;
    /**
     * Stage times (ms, the engine's u16) of stages 0..3 and of the release.
     */
    times: number[];
    release: number;
    /**
     * The main segments keep running under the release (tone header 0x0d bit 1), else they hold where the note off
     * found them.
     */
    holdsOn: boolean;
}

interface Segment {
    stage: number;
    modifier: number;
    rateWord: number;
    step: number;
    start: number;
    target: number;
    value: number;
    phase: number;
    carry: number;
}

/**
 * One control tick's result: the envelope value, the cutoff sum, the warped cutoff (the cutoff ramp's target is it
 * times 4 through the exponential table), the damping ramp's target and the cutoff ramp's rate word.
 */
export interface TvfTick {
    env: number;
    sum: number;
    warped: number;
    q: number;
    rateWord: number;
}

/**
 * When the ticks fall against the voice's blocks: the first tick runs after block firstTick (counted from the
 * voice's first rendered block, 0, and -1 when the voice starts on a tick's block), then every TICK_BLOCKS blocks. releaseTick: the index of the first tick that sees
 * the note off (undefined: held).
 */
export interface TvfSchedule {
    firstTick: number;
    releaseTick?: number;
}

/**
 * The SVF coefficients of every 8 samples (4 per block): f after the damping's cap, q, and the cutoff ramp's own f
 * (the value before the cap).
 */
export interface TvfStream {
    f: Float32Array;
    q: Float32Array;
    rampF: Float32Array;
}

interface Ramp {
    flags: number;
    rate: number;
    count: number;
    value: number;
    target: number;
    step: number;
    out: number;
}

export class TvfModel {
    public readonly tva;
    private readonly dll;
    private readonly view;
    private interp?: { fe: Float64Array; he: Float64Array };

    public constructor(dll: Dll, dir: Directory) {
        this.dll = dll;
        this.tva = new TvaModel(dll, dir);
        this.view = new DataView(dll.bytes.buffer, dll.bytes.byteOffset, dll.bytes.byteLength);
    }

    /**
     * The tap of a filter type byte, undefined for the types without a filter.
     */
    public tapOf(type: number): Tap | undefined {
        if (type > 2 && ((type - 4) & 0xff) > 2) return undefined;
        const word = this.dll.u32(TYPE_WORDS + type * 4) & 0xc00;
        return word === 0 ? "low" : word === 0x400 ? "band" : word === 0x800 ? "high" : "peak";
    }

    /**
     * The velocity a voice's TVF sees: the note's velocity through the sensitivity row of byte 0x2e.
     */
    public velocitySens(b: Uint8Array, velocity: number) {
        return this.dll.u8(VEL_SENS + (b[0x2e] & 0xf) * 0x80 + velocity);
    }

    /**
     * The key follow of the envelope's segment times and of its release at a key (env_rate_scale, 0x100 = 1).
     */
    public keyScales(b: Uint8Array, key: number): [number, number] {
        return [
            this.tva.envRateScale((this.dll.u8(KF_TVF_RATE[0] + b[0x46] * 0x80 + key) + 0x80) & 0xff, b[0x48]),
            this.tva.envRateScale((this.dll.u8(KF_TVF_RATE[1] + b[0x47] * 0x80 + key) + 0x80) & 0xff, b[0x49])
        ];
    }

    /**
     * The velocity scale of segments 0-1 and of segments 2-3 with the release (env_level_scale of the sensitivity's
     * velocity, 0x100 = 1).
     */
    public velocityScales(b: Uint8Array, velocity: number): [number, number] {
        const vs = this.velocitySens(b, velocity);
        return [this.tva.envLevelScale(vs, b[0x4b]), this.tva.envLevelScale(vs, b[0x4c])];
    }

    /**
     * The TVF at a key (the MIDI note, a drum's kit pitch) and velocity: partial_compute_filter with the part's
     * controllers neutral (the GS reset). header: the tone's header (its flags byte 0x0d).
     */
    public voice(header: Uint8Array, b: Uint8Array, key: number, velocity: number) {
        const type = b[0x31];
        const tap = this.tapOf(type);
        const damp = Math.max(4, Math.min(0x7f, b[0x30]));
        // the cutoff key follow: a row of 0x32 at the key, scaled by 0x33
        const kf = s16(this.dll.u16(KF_CUTOFF + ((b[0x32] & 0xf) * 0x80 + key) * 2));
        const b33 = b[0x33];
        const mag = u16(Math.abs(kf));
        let negative: boolean;
        let scale: number;
        if (b33 < 0x40) {
            scale = this.dll.u16(KF_SCALE_DOWN + 0x80 - b33 * 2);
            negative = kf >= 0;
        } else {
            scale = this.dll.u16(KF_SCALE_UP + b33 * 2);
            negative = kf < 0;
        }
        const amount = Math.floor((mag * scale) / 512);
        const follow = s16(negative ? -amount : amount);
        // the envelope's depth by velocity (0x4a through the resonance curve)
        const vs = this.velocitySens(b, velocity);
        const u9 = s16(b[0x4a] - 0x40);
        let depth: number;
        let inverted = false;
        if (u9 === 0) {
            depth = 0x7fff;
        } else {
            const s11 = s16(0x7f - ((vs << 24) >> 24));
            depth = u9 < 0
                ? s16(this.dll.s16(RESO_CURVE + -u9 * 2) * s11 - 0x7fff)
                : s16(0x7fff - this.dll.s16(RESO_CURVE + u9 * 2) * s11);
            if (depth < 0) {
                depth = s16(-depth);
                inverted = true;
            }
        }
        const envDepth = readU16(b, 0x38);
        const conv = (level: number) => {
            const d = s16(level - 0x40);
            const a = Math.abs(d);
            if (a === 0) return u16(follow);
            const curve = this.dll.u8(ENV_LEVEL_CURVE + a);
            const inv = inverted ? 1 : 0;
            const sub = d >= 0 ? inv : u16(~inv);
            const p = envDepth * u16(depth);
            const amt = u16(((Math.floor((p * 2) / 65536) & 0xffff) * curve) >> 7);
            if (sub === 0) {
                const r = u16(amt + follow);
                return follow >= 0 && s16(r) < 0 ? 0x7fff : r;
            }
            if (follow >= 0) return u16(follow - amt);
            const r = u16(amt - follow);
            return s16(r) < 0 ? 0x8001 : u16(-s16(r));
        };
        const rel = (level: number) => s16(conv(level) - follow);
        const base = Math.min(b[0x2f] * 0x100 + follow, 0x7fff);
        const [keyRate, keyRelease] = this.keyScales(b, key);
        const [early, late] = this.velocityScales(b, velocity);
        // the part's envelope offsets (CC73 and the like) are neutral, the rate bias is 0
        const timeOf = (rate: number, k: number, v: number) => {
            const t = this.tva.rateCurve(rate & 0x7f);
            if (t < 9) return 0;
            return u16(((((k * t) >>> 8) & 0xffff) * v) >>> 8);
        };
        return {
            type, tap, damp, base: s16(base), follow,
            levels: [rel(b[0x3a]), rel(b[0x3b]), rel(b[0x3c]), rel(b[0x3d])],
            releaseLevel: rel(b[0x3e]),
            times: [timeOf(b[0x3f], keyRate, early), timeOf(b[0x40], keyRate, early), timeOf(b[0x41], keyRate, late),
                timeOf(b[0x42], keyRate, late)],
            release: timeOf(b[0x43], keyRelease, late),
            holdsOn: (header[0x0d] & 2) !== 0
        };
    }

    /**
     * The warp table's entry i (0..128): the warped cutoff at a cutoff sum of i * 256, no ceiling.
     */
    public warpAt(i: number) {
        return this.dll.u16(WARP + i * 2);
    }

    /**
     * The warped cutoff (units / 4 of the filter's exponential domain, 16384 units per octave) for a cutoff sum,
     * under the ceiling of the damping byte.
     */
    public warp(sum: number, damp: number) {
        const c = Math.max(0, Math.min(0x7fff, sum));
        const hi = c >> 8;
        let w = this.dll.u16(WARP + hi * 2);
        if (c & 0xff) w = u16(((u16(this.dll.u16(WARP + hi * 2 + 2) - w) * (c & 0xff)) >> 8) + w);
        return Math.min(w, this.dll.u16(CEILING + damp * 2));
    }

    /**
     * The damping ramp's target for a warped cutoff (q = target / 2^17).
     */
    public qTarget(v: TvfVoice, warped: number) {
        if (v.type === 0 && v.damp === 0x40) return this.dll.u16(Q_LOWPASS + (warped >> 8) * 2) << 2;
        if (v.type === 6) return this.dll.u16(Q_TYPE6 + (warped >> 8) * 2) << 2;
        return v.damp << 11;
    }

    /**
     * exp_ratio: a cutoff ramp word (the warped cutoff times 4) through the exponential table.
     */
    public expRatio(word: number) {
        if (word === 0) return 0;
        const i = (word >> 6) & 0xff;
        const frac = word & 0x3f;
        let v = (Math.imul(this.dll.s32(EXP_TABLE + i * 4), 0x40 - frac) + Math.imul(this.dll.s32(EXP_TABLE + i * 4 + 4), frac)) | 0;
        v = (v + ((v >> 31) & 0x3f)) >> 6;
        return v >> ((15 - ((word >> 14) & 0xf)) & 31);
    }

    /**
     * The coefficient f a warped cutoff settles at (the ramp's level_of), before the damping's cap.
     */
    public coefficient(warped: number) {
        const value = this.expRatio(warped << 2);
        return value === 0 ? IDLE : levelOf(value, 3);
    }

    /**
     * The highest f the damping ramp lets through at a damping target (svf_fceil by the damping's value >> 8).
     */
    public fCeiling(q: number) {
        return this.view.getFloat32(F_CEILING + (q >> 8) * 4, true);
    }

    private cutoff(v: TvfVoice, env: number) {
        const sum = Math.max(0, Math.min(0x7fff, v.base + env));
        const warped = this.warp(sum, v.damp);
        return { sum, warped, q: this.qTarget(v, warped) };
    }

    private rateWordOf(time: number) {
        return this.dll.u16(ENV_RATE_WORDS + (time < 0xb ? time : 10) * 2);
    }

    /**
     * The envelope and the cutoff per control tick: entry 0 the note on's start value, entry 1 the note on's one tick
     * (the ramps' first target), then one per tick. releaseTick counts the ticks after the note on (the first is 0).
     */
    public ticks(v: TvfVoice, count: number, releaseTick?: number) {
        const out = new Array<TvfTick>();
        const t0 = v.times[0];
        const main: Segment = {
            stage: 0, modifier: 0, rateWord: this.rateWordOf(t0), step: t0 >= 0xb ? Math.floor(0xa0000 / t0) : 0xffff,
            start: 0, target: v.levels[0], value: 0, phase: 0, carry: 0
        };
        // a release time of 10 ms gives a step of 0x10000, stored as 0 (the segment never moves)
        const rt = v.release;
        const rel: Segment = {
            stage: 0, modifier: 0x7f, rateWord: this.rateWordOf(rt), step: rt > 9 ? Math.floor(0xa0000 / rt) & 0xffff : 0xffff,
            start: 0, target: v.releaseLevel, value: 0, phase: 0, carry: 0
        };
        const push = (env: number) => {
            const c = this.cutoff(v, env);
            out.push({ env, sum: c.sum, warped: c.warped, q: c.q, rateWord: main.rateWord + 0x4000 });
        };
        if (v.tap === undefined) {
            for (let k = 0; k < count + 2; k++) out.push({ env: 0, sum: 0, warped: 0, q: 0x20000, rateWord: 0x4fff });
            return out;
        }
        push(0);
        this.ramp(main);
        push(main.value);
        const mix = (inv: number) => {
            const env = s16(main.value);
            return env >= 0 ? s16(Math.floor((inv * env) / 65536) + rel.value)
                : s16(rel.value - Math.floor((-env * inv) / 65536));
        };
        for (let k = 0; k < count; k++) {
            if (releaseTick !== undefined && k >= releaseTick) {
                if (!v.holdsOn) main.modifier = 0x7f;
                rel.modifier = 0;
            }
            if (main.phase === 0xffff) {
                main.phase = 0;
                main.stage = Math.min(main.stage + 1, 4);
                if (main.stage === 4) {
                    main.rateWord = 0xcc;
                } else {
                    const t = v.times[main.stage];
                    main.step = t < 0xb ? 0xffff : Math.floor(0xa0000 / t);
                    main.rateWord = this.rateWordOf(t);
                    main.start = main.target;
                    main.target = v.levels[main.stage];
                }
            }
            if (rel.phase === 0xffff) rel.stage = 4;
            let value: number;
            if (rel.modifier === 0x7f) {
                this.ramp(main);
                value = main.value;
                if (rel.phase !== 0) value = mix(u16(~rel.phase));
            } else {
                if (main.modifier !== 0x7f) this.ramp(main);
                this.ramp(rel);
                value = mix(u16(~rel.phase));
            }
            push(value);
        }
        return out;
    }

    /**
     * tvf_env_ramp_segment at a tick count of 1 (only modifier 0 runs: the damper is not used).
     */
    private ramp(g: Segment) {
        if (g.stage === 4) return;
        const ticks = u16(1 + g.carry);
        let phase = ticks * g.step + g.phase;
        g.carry = 0;
        if (phase >= 0x10000) {
            g.carry = Math.floor((phase - 0xffff) / g.step);
            g.phase = 0xffff;
            g.value = g.target;
            return;
        }
        g.phase = phase;
        if (phase === 0xffff) {
            g.value = g.target;
            return;
        }
        const d = s16(g.target) - s16(g.start);
        g.value = d < 0 ? s16(g.start - s16(Math.floor((u16(-d) * phase) / 65536)))
            : s16(g.start + s16(Math.floor((u16(d) * phase) / 65536)));
    }

    /**
     * The coefficients per 8 samples over blocks blocks from the voice's first: the cutoff ramp (linear in the
     * exponential table's domain toward each tick's target), the damping ramp (an approach) and the damping's cap on f.
     */
    public stream(v: TvfVoice, blocks: number, schedule: TvfSchedule) {
        const nTicks = Math.max(0, Math.floor((blocks - 1 - schedule.firstTick) / TICK_BLOCKS) + 2);
        const ticks = this.ticks(v, nTicks, schedule.releaseTick);
        const f = new Float32Array(blocks * 4);
        const q = new Float32Array(blocks * 4);
        const rampF = new Float32Array(blocks * 4);
        const cr: Ramp = { flags: 0, rate: 0, count: 0, value: 0, target: 0, step: 0, out: IDLE };
        const qr: Ramp = { flags: 0, rate: 0, count: 0, value: 0, target: 0, step: 0, out: IDLE };
        const stepOf = (from: number, to: number, rate: number) => {
            const s = Math.imul(to - from, rate) >> 13;
            return s === 0 && from < to ? 1 : s;
        };
        const setCutoff = (start: number, target: number, rateWord: number, reset: boolean) => {
            cr.flags = this.flags(rateWord) & 0xfffe;
            const to = this.expRatio(target);
            if (reset) {
                cr.count = 0;
                cr.value = this.expRatio(start);
            }
            const from = cr.value;
            cr.rate = s16(rateWord & 0xfff);
            cr.target = to;
            cr.step = stepOf(from, to, cr.rate);
            cr.out = from === 0 ? IDLE : levelOf(from, 3);
            if (from !== to) cr.flags |= 1;
        };
        const qWord = 0x100;
        const qMask = this.dll.u32(MASK_BITS + ((qWord >> 12) & 3) * 4) & 0xfffe;
        // ramp::start: the cutoff from the start value toward the note on tick's target, the damping still
        setCutoff(ticks[0].warped << 2, ticks[1].warped << 2, ticks[1].rateWord, true);
        const qs = v.tap === undefined ? 0x20000 : ticks[1].q;
        qr.flags = qMask;
        qr.rate = qWord & 0xfff;
        qr.value = qs;
        qr.target = qs;
        qr.step = qs * 1024;
        qr.out = qs !== 0 ? levelOf(qs, 3) : IDLE;
        let next = 2;
        // the tick after block blk sets the next targets (blk -1: the voice started on a tick's block)
        const tickAfter = (blk: number) => {
            if (blk < schedule.firstTick || (blk - schedule.firstTick) % TICK_BLOCKS !== 0 || next >= ticks.length) return;
            const t = ticks[next++];
            if (v.tap === undefined) return;
            setCutoff(0, t.warped << 2, t.rateWord, false);
            qr.flags = qMask;
            qr.rate = qWord & 0xfff;
            qr.target = t.q;
            if (qr.value !== t.q) qr.flags |= 1;
        };
        tickAfter(-1);
        for (let blk = 0; blk < blocks; blk++) {
            // both ramps look at their moving bit once per block: a ramp that arrives mid block keeps counting
            const cMoving = (cr.flags & 1) !== 0;
            const qMoving = (qr.flags & 1) !== 0;
            for (let i = 0; i < 4; i++) {
                const k = blk * 4 + i;
                if (cMoving) {
                    cr.count++;
                    if ((cr.count & this.mask(cr.flags)) === 0) {
                        const n = (cr.value + cr.step) | 0;
                        cr.value = cr.step < 1 ? Math.max(n, cr.target) : Math.min(n, cr.target);
                        if (cr.value === cr.target) {
                            cr.step = 0;
                            cr.flags &= 0xfffe;
                        }
                        cr.out = cr.value === 0 ? IDLE : levelOf(cr.value, 3);
                    }
                }
                rampF[k] = cr.out;
                let fk = cr.out;
                if (qMoving) {
                    qr.count++;
                    if ((qr.count & this.mask(qr.flags)) === 0) {
                        const gap = s16((((qr.target * 0x400) | 0) - qr.step) >> 13);
                        let st = gap * s16(qr.rate);
                        if (st < 0) {
                            if (-0x400 < st) st = -0x400;
                        } else if (st < 0x400) {
                            st = 0x400;
                        }
                        qr.step = (qr.step + st) | 0;
                        qr.value = qr.step >> 10;
                        if (qr.value === qr.target) qr.flags &= 0xfffe;
                        qr.out = qr.value === 0 ? IDLE : levelOf(qr.step, 13);
                    }
                }
                const top = this.view.getFloat32(F_CEILING + (qr.value >> 8) * 4, true);
                if (top < fk) fk = top;
                f[k] = fk;
                q[k] = qr.out;
            }
            tickAfter(blk);
        }
        return { f, q, rampF };
    }

    /**
     * A sample's power spectrum over its first second as the filter sees it: Hann frames of 512, half overlapped,
     * through the engine's interpolation averaged over its phases (it darkens the top octave before the filter).
     */
    public spectrum(data: Float32Array) {
        const x = data.subarray(0, SPECTRUM_SPAN);
        const n = FRAME;
        const bins = Float64Array.from({ length: n / 2 + 1 }, (_, i) => i / n);
        const power = new Float64Array(n / 2 + 1);
        const hann = Float64Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
        let frames = 0;
        const add = (from: number) => {
            const re = new Float64Array(n);
            const im = new Float64Array(n);
            for (let i = 0; i < n; i++) re[i] = (from + i < x.length ? x[from + i] : 0) * hann[i];
            fft(re, im);
            for (let i = 0; i <= n / 2; i++) power[i] += re[i] * re[i] + im[i] * im[i];
            frames++;
        };
        if (x.length < n) add(0);
        else for (let j = 0; j + n <= x.length; j += n / 2) add(j);
        const h = this.interpResponse(bins);
        for (let i = 0; i < power.length; i++) power[i] = (power[i] / frames) * h[i] * h[i];
        return { bins, power };
    }

    /**
     * The engine's 4 tap interpolation magnitude at frequencies (cycles per sample), |mean over its 128 phases|,
     * interpolated from 511 points.
     */
    public interpResponse(at: Float64Array) {
        const { fe, he } = (this.interp ??= this.phaseAverage());
        return at.map((f) => {
            if (f <= 0) return 1;
            if (f <= fe[0]) return 1 + ((he[0] - 1) * f) / fe[0];
            if (f >= fe[fe.length - 1]) return he[he.length - 1];
            const i = Math.min(fe.length - 2, Math.floor((f / 0.5) * 512) - 1);
            const a = (f - fe[i]) / (fe[i + 1] - fe[i]);
            return he[i] + (he[i + 1] - he[i]) * a;
        });
    }

    private phaseAverage() {
        const rows = Array.from({ length: 128 }, (_, p) => Array.from({ length: 4 }, (_, k) => this.view.getFloat32(INTERP_TABLE + (p * 4 + k) * 4, true)));
        const fe = Float64Array.from({ length: 511 }, (_, i) => (0.5 * (i + 1)) / 512);
        const he = fe.map((f) => {
            const w = 2 * Math.PI * f;
            let re = 0;
            let im = 0;
            for (let p = 0; p < 128; p++) {
                for (let k = 0; k < 4; k++) {
                    const ph = -w * (k - 1 - p / 128);
                    re += rows[p][k] * Math.cos(ph);
                    im += rows[p][k] * Math.sin(ph);
                }
            }
            return Math.hypot(re, im) / 128;
        });
        return { fe, he };
    }

    private flags(rateWord: number) {
        return this.dll.u32(MODE_BITS + ((rateWord >> 14) & 3) * 4) | this.dll.u32(MASK_BITS + ((rateWord >> 12) & 3) * 4);
    }

    private mask(flags: number) {
        return this.dll.s8(STEP_MASKS + ((flags >> 3) & 3));
    }
}

/**
 * A ramp's float output: (short)(value >> shift) * 2^-14.
 */
function levelOf(value: number, shift: number) {
    return s16(value >> shift) / 16384;
}

/**
 * An in place radix 2 FFT (n a power of 2).
 */
export function fft(re: Float64Array, im: Float64Array) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1) j ^= bit;
        j ^= bit;
        if (i < j) {
            const tr = re[i];
            re[i] = re[j];
            re[j] = tr;
            const ti = im[i];
            im[i] = im[j];
            im[j] = ti;
        }
    }
    const tw = twiddles(n);
    for (let len = 2, stage = 0; len <= n; len <<= 1, stage++) {
        const cr = tw[stage].re;
        const ci = tw[stage].im;
        for (let i = 0; i < n; i += len) {
            for (let k = 0; k < len / 2; k++) {
                const wr = cr[k];
                const wi = ci[k];
                const xr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
                const xi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
                re[i + k + len / 2] = re[i + k] - xr;
                im[i + k + len / 2] = im[i + k] - xi;
                re[i + k] += xr;
                im[i + k] += xi;
            }
        }
    }
}

const twiddleTables = new Map<number, { re: Float64Array; im: Float64Array }[]>();

/**
 * fft's factors per stage, cos and sin of the same angles it used to take per butterfly (a wave's spectrum runs a
 * hundred transforms).
 */
function twiddles(n: number) {
    let t = twiddleTables.get(n);
    if (!t) {
        t = new Array<{ re: Float64Array; im: Float64Array }>();
        for (let len = 2; len <= n; len <<= 1) {
            const a = (-2 * Math.PI) / len;
            const re = new Float64Array(len / 2);
            const im = new Float64Array(len / 2);
            for (let k = 0; k < len / 2; k++) {
                re[k] = Math.cos(a * k);
                im[k] = Math.sin(a * k);
            }
            t.push({ re, im });
        }
        twiddleTables.set(n, t);
    }
    return t;
}
