/**
 * The engine's TVA from a partial's bytes: the four segment levels and times at a key and velocity, the release, and
 * the gain curve they draw (no render). Adapted from NativeTS `TvaChain` and `EnvelopeMachine` (BSD 3-Clause,
 * Copyright (c) 2026 Kevin López Brante, see NOTICE.md), checked against SC-VA's own TVA.
 */
import type { Directory } from "./directory.js";
import type { Dll } from "./dll.js";
import { fileOffset } from "./dll.js";

const RATE_OUT = fileOffset(0x1819a3060);
const SCALE_CURVE = fileOffset(0x1819a28e8);
const ENV_SHAPE = fileOffset(0x1819a7a90);
const RATE_CURVE = fileOffset(0x1819a2900);
const LEVEL_CURVE = fileOffset(0x1819a2a00);
const AMP_CURVE_HI = fileOffset(0x1819a2ba0);
const AMP_CURVE_LO = fileOffset(0x1819a2da0);
const KF_TVA_RATE = [fileOffset(0x181a023a0), fileOffset(0x181a020a0)];
const KF_TVA_LEVEL = fileOffset(0x181a026a0);
const VEL_CURVE = fileOffset(0x1819a2b00);

const i8 = (x: number) => ((x & 0xff) ^ 0x80) - 0x80;

/**
 * The control tick the segments advance on (seconds). A segment's time is a whole number of ticks.
 */
export const TICK = 0.01;
/**
 * Segment times under this (ms) skip the segment: the gain jumps through the amp ramp.
 */
const MIN_SEGMENT = 11;
/**
 * The MIDI queue dispatches a note off two 64-frame calls late (render.cpp's +2 latency), the release starts on the
 * first tick after that.
 */
export const NOTE_OFF_LATE = 128 / 32000;

export type Shape = "line" | "curve";

/**
 * What the voice's level chain takes besides the partial: the zone's level byte (multisample), the tone's level
 * (header byte 0x0c).
 */
export interface LevelContext {
    zoneLevel: number;
    toneLevel: number;
    /**
     * The main segments keep running under the release (tone header 0x0d bit 1), else they freeze at the note off.
     */
    holdsOn?: boolean;
}

/**
 * The part's envelope controllers as rate index offsets (TvaModel.segments).
 */
export interface EnvelopeBias {
    early?: number;
    late?: number;
    release?: number;
}

export interface TvaSegments {
    /**
     * The four segment targets as 16 bit levels over 65535 (the engine's amp_of of base level minus segment level).
     */
    amps: number[];
    /**
     * Segment times in ms (0: the segment is skipped).
     */
    times: number[];
    shapes: Shape[];
    release: number;
    releaseShape: Shape;
    /**
     * The main segments keep running under the release (tone header 0x0d bit 1).
     */
    holdsOn: boolean;
}

export class TvaModel {
    private readonly dll;
    private readonly dir;

    public constructor(dll: Dll, dir: Directory) {
        this.dll = dll;
        this.dir = dir;
    }

    public ampOf(level: number) {
        const l = Math.max(0, Math.min(0xffff, Math.trunc(level)));
        const hi = this.dll.u16(AMP_CURVE_HI + 2 * (l >> 8));
        const lo = this.dll.u16(AMP_CURVE_LO + 2 * (l & 0xff));
        return ((hi * lo) >>> 16) / 65535;
    }

    public levelCurve(i: number) {
        return this.dll.u16(LEVEL_CURVE + 2 * i);
    }

    public rateCurve(i: number) {
        return this.dll.u16(RATE_CURVE + 2 * i);
    }

    /**
     * env_rate_scale: a key follow byte against its modifier, 0x100 = 1.
     */
    public envRateScale(base: number, modifier: number) {
        let u = (modifier - 0x40) & 0xffff;
        if (u === 0) return 0x100;
        let b = base & 0xffff;
        if (u & 0x8000) {
            const sb = ((b & 0xff) ^ 0x80) - 0x80;
            b = -sb & 0xff;
            u = -(u - 0x10000) & 0xffff;
            if (b === 0) b = 0xff;
        }
        b = (b - 0x80) & 0xffff;
        if (b === 0) return 0x100;
        const s = this.dll.u8(SCALE_CURVE + u);
        let index: number;
        if (b & 0x8000) {
            const r = ((b - 0x10000) * s * -2) >>> 8;
            index = (0x80 - r) & 0xffff;
        } else {
            index = (0x80 + ((b * s * 2) >>> 8)) & 0xffff;
        }
        return index < 0x200 ? this.dll.u16(RATE_OUT + 2 * index) : 0x100;
    }

    /**
     * env_level_scale: a level byte against its velocity modifier, 0x100 = 1.
     */
    public envLevelScale(level: number, modifier: number) {
        const l = 0x40 - level;
        if (l === 0) return 0x100;
        const mod = modifier - 0x40;
        if (mod === 0) return 0x100;
        const curve = (i: number) => this.dll.u8(SCALE_CURVE + i);
        let d: number;
        let down: boolean;
        if (l < 0) {
            d = -(curve(Math.abs(mod) * 2) * l);
            down = mod >= 0;
        } else {
            d = curve(Math.abs(mod) * 2) * l;
            down = mod < 0;
        }
        d = ((d + 0x8000) & 0xffff) - 0x8000;
        const x = ((d * 4 + 0x8000) & 0xffff) - 0x8000;
        const shifted = x >> 8;
        const index = down ? 0x80 - shifted : shifted + 0x80;
        return this.dll.u16(RATE_OUT + 2 * index);
    }

    /**
     * tva_compute_base_level: the partial's level (0x53) with its level key follow (row 0x54, depth 0x55), less the
     * level curve of the velocity's level byte, the zone level and the tone level, each step clamped at 1.
     */
    public baseLevel(b: Uint8Array, key: number, lb: number, levels: LevelContext) {
        const kf = i8(this.dll.u8(KF_TVA_LEVEL + b[0x54] * 0x80 + key));
        const depth = b[0x55] - 0x40;
        const own = 0xffff - this.levelCurve(b[0x53]);
        let level = own === 0 ? 1 : own;
        const scale = this.dll.u8(SCALE_CURVE + Math.abs(depth));
        const term = this.dll.u8(VEL_CURVE + (((Math.abs(kf) * scale * 2) >> 8) & 0xffff)) << 8;
        // a negative depth turns the key follow's sign around
        if ((depth < 0) === (kf < 0)) {
            level = Math.min(level + term, 0xffff);
        } else {
            level -= term;
            if (level < 0) level = 1;
        }
        level = Math.max(level - this.dll.u16(LEVEL_CURVE + 2 * (lb & 0xffff)), 1);
        level = Math.max(level - this.levelCurve(levels.zoneLevel), 1);
        // the tone level is read signed (bytes over 0x7f index below the curve, as the DLL does)
        return Math.max(level - this.dll.u16(LEVEL_CURVE + 2 * i8(levels.toneLevel)), 1);
    }

    /**
     * voice_volume_apply after the GS reset (CC7 100, CC11 127, master volume 127, no tremolo): the part level stage
     * the voice is multiplied by, a drum key's level byte for kit voices.
     */
    public partGain(kitLevel?: number) {
        const u = (((127 * 100) & 0xffff) * 127 >> 6) & 0xffff;
        const prod = kitLevel === undefined ? u * 0x10410 : (((kitLevel * u) >> 7) & 0xffff) * 0x1061c;
        const level = Math.floor(prod / 65536) & 0xffff;
        const squared = (level * level) >>> 16;
        const scaled = squared * 0x208;
        // the volume ramp's target is the word << 2, its output (short)(acc >> 13) / 2^14
        return (scaled > 0xffffff ? 0xffff : (scaled >> 8) & 0xffff) / 32768;
    }

    /**
     * The key follow of the segment times and of the release at a key (env_rate_scale, 0x100 = 1).
     */
    public keyScales(b: Uint8Array, key: number): [number, number] {
        return [
            this.envRateScale((this.dll.u8(KF_TVA_RATE[0] + b[0x65] * 0x80 + key) + 0x80) & 0xff, b[0x67]),
            this.envRateScale((this.dll.u8(KF_TVA_RATE[1] + b[0x66] * 0x80 + key) + 0x80) & 0xff, b[0x68])
        ];
    }

    /**
     * The velocity scale of segments 0-1 and of segments 2-3 with the release (env_level_scale of the level byte,
     * 0x100 = 1), undefined outside the velocity window.
     */
    public velocityScales(b: Uint8Array, velocity: number): [number, number] | undefined {
        const lb = this.dir.levelByte(b, velocity);
        return lb === undefined ? undefined : [this.envLevelScale(lb, b[0x69]), this.envLevelScale(lb, b[0x6a])];
    }

    /**
     * The voice delay of byte 0 = 1..0x7e (bit 7 only says where it counts from) in control ticks: the rate curve at
     * the byte (the part's two offsets are 0x40 each after the GS reset), scaled by the note's velocity against byte
     * 1, in whole ticks. The voice adds 0xffff / ticks per tick and starts on the tick that passes 0xfffe. 0: no delay.
     */
    public delayTicks(b: Uint8Array, velocity: number) {
        const d = b[0] & 0x7f;
        if (b[0] === 0xff || d === 0) return 0;
        const ticks = Math.floor((((this.envLevelScale(velocity, b[1]) * this.rateCurve(d)) >>> 8) & 0xffff) / 10);
        if (ticks === 0) return 0;
        const step = Math.floor(0xffff / ticks);
        return Math.floor(0xfffe / step) + 1;
    }

    /**
     * The TVA at a key (the MIDI note, a drum's kit pitch) and velocity, undefined outside the velocity window. bias:
     * the part's envelope controllers as rate index offsets ((value - 64) * 2: CC73 on segments 0-1, CC75 on 2-3, CC72
     * on the release), an index under 0 makes the segment instant.
     */
    public segments(b: Uint8Array, key: number, velocity: number, levels: LevelContext, bias: EnvelopeBias = {}): TvaSegments | undefined {
        const lb = this.dir.levelByte(b, velocity);
        if (lb === undefined) return undefined;
        const base = this.baseLevel(b, key, lb, levels);
        const amps = new Array<number>();
        for (let k = 0; k < 4; k++) {
            const u = base - this.levelCurve(b[0x5a + k]);
            amps.push(u >= 1 ? this.ampOf(u) : 0);
        }
        const [kr, krel] = this.keyScales(b, key);
        const early = this.envLevelScale(lb, b[0x69]);
        const late = this.envLevelScale(lb, b[0x6a]);
        const rateAt = (rate: number, offset = 0) => {
            const i = (rate & 0x7f) + offset;
            return i < 0 ? 0 : this.rateCurve(Math.min(i, 0x7f));
        };
        const timeOf = (rate: number, vr: number, offset?: number) => {
            const t = rateAt(rate, offset);
            if (t < 9) return 0;
            const k = Math.min((kr * t) >>> 8, 0xffff);
            return ((vr * k) >>> 8) & 0xffff;
        };
        const times = [timeOf(b[0x5e], early, bias.early), timeOf(b[0x5f], early, bias.early), timeOf(b[0x60], late, bias.late),
            timeOf(b[0x61], late, bias.late)];
        const shapes = [0, 1, 2, 3].map((k): Shape => (b[0x5e + k] & 0x80 ? "line" : "curve"));
        const t = rateAt(b[0x62], bias.release);
        const release = t > 8 ? (Math.min((krel * t) >>> 8, 0xffff) * late) >>> 8 : 0;
        return { amps, times, shapes, release, releaseShape: b[0x62] & 0x80 ? "line" : "curve", holdsOn: levels.holdsOn === true };
    }

    /**
     * What is left of a segment's distance at phase u (0..1): a line, or the engine's segment curve (env_shape).
     */
    public fall(shape: Shape, u: number) {
        if (u >= 1) return 0;
        if (shape === "line") return Math.max(0, 1 - u);
        const p = Math.max(0, Math.min(0xffff, Math.trunc(u * 65536)));
        const i = 255 - (p >> 8);
        const frac = 255 - (p & 0xff);
        const c0 = this.dll.u16(ENV_SHAPE + 2 * i);
        const c1 = this.dll.u16(ENV_SHAPE + 2 * i + 2);
        return ((((c1 - c0) & 0xffff) * frac) >>> 8) / 65536 + c0 / 65536;
    }

    /**
     * One segment step (env_ramp_segment): the segment's value after ticks more ticks.
     */
    private step(g: Segment, ticks: number) {
        if (g.done) return;
        let phase = (ticks + g.left) * g.rate + g.phase;
        g.left = 0;
        if (phase >= 0x10000) {
            g.left = Math.floor((phase - 0xffff) / g.rate);
            phase = 0xffff;
        }
        g.phase = phase;
        if (phase === 0xffff) {
            g.value = g.target;
            return;
        }
        const d = g.target - g.start;
        if (g.shape === "line") {
            g.value = d < 0 ? g.start - ((-d * phase) >>> 16) : g.start + ((d * phase) >>> 16);
            return;
        }
        const i = ~(phase >> 8) & 0xff;
        const frac = ~phase & 0xff;
        const c0 = this.dll.u16(ENV_SHAPE + 2 * i);
        const c1 = this.dll.u16(ENV_SHAPE + 2 * i + 2);
        const v = (((((c1 - c0) & 0xffff) * frac) >>> 8) + c0) & 0xffff;
        g.value = d < 0 ? ((-d * v) >>> 16) + g.target : (((~v & 0xffff) * d) >>> 16) + g.start;
    }

    /**
     * The TVA's gain at times t (seconds from the voice's start), the host's note off at off (undefined: never). The
     * segments step once per control tick as the engine's integer code does (a skipped segment still takes its
     * tick), and the amp ramp runs a line to each tick's level over the stage's ramp time.
     */
    public curve(s: TvaSegments, t: Float64Array, off?: number, firstTick = TICK) {
        const levels = s.amps.map((a) => Math.round(a * 65535));
        const rateOf = (ms: number) => (ms >= MIN_SEGMENT ? Math.floor(0xa0000 / ms) & 0xffff : 0xffff);
        // the amp ramp's time per stage: the rate word 512 / n ms for n < 11, 10 ms (one tick) for the rest
        const rampOf = (ms: number) => (ms >= MIN_SEGMENT ? TICK : Math.max(ms, 0.125) / 1000);
        const seg = (stage: number, from: number): Segment => ({
            start: from, target: levels[stage], value: from, phase: 0, left: 0, rate: rateOf(s.times[stage]),
            shape: s.shapes[stage], done: false
        });
        const end = t.length ? t[t.length - 1] + TICK : 0;
        const offAt = off === undefined ? Infinity : off + NOTE_OFF_LATE;
        // (tick time, level, ramp time) per tick
        const knots = new Array<[number, number, number]>();
        let stage = 0;
        let g = seg(0, 0);
        this.step(g, 1);
        knots.push([0, g.value, rampOf(s.times[0])]);
        let rel: Segment | undefined;
        let held = 0;
        for (let k = 1; firstTick + (k - 1) * TICK <= end; k++) {
            const tk = firstTick + (k - 1) * TICK;
            if (rel === undefined && tk >= offAt) {
                held = g.value;
                rel = { start: 0xffff, target: 0, value: 0xffff, phase: 0, left: 0, rate: rateOf(s.release),
                    shape: s.releaseShape, done: false };
            }
            if (rel && !s.holdsOn) {
                this.step(rel, 1);
                knots.push([tk, (held * rel.value) / 65536, rampOf(s.release)]);
                continue;
            }
            if (g.phase === 0xffff && !g.done) {
                if (stage < 3) {
                    const left = g.left;
                    stage++;
                    g = seg(stage, g.target);
                    g.left = left;
                } else {
                    g.done = true;
                }
            }
            this.step(g, 1);
            if (rel) {
                // the main segment keeps moving, the release scales it
                this.step(rel, 1);
                knots.push([tk, Math.floor((g.value * rel.value) / 65536), rampOf(s.release)]);
                continue;
            }
            knots.push([tk, g.value, rampOf(s.times[stage])]);
        }
        const out = new Float64Array(t.length);
        // the ramp's start at each tick: where the previous line had got to (an instant first segment jumps)
        const starts = new Float64Array(knots.length);
        starts[0] = s.times[0] === 0 ? knots[0][1] : 0;
        for (let k = 1; k < knots.length; k++) {
            const [tp, lp, rp] = knots[k - 1];
            starts[k] = starts[k - 1] + (lp - starts[k - 1]) * Math.min((knots[k][0] - tp) / rp, 1);
        }
        let k = 0;
        for (let i = 0; i < t.length; i++) {
            while (k + 1 < knots.length && knots[k + 1][0] <= t[i]) k++;
            const [tk, level, ramp] = knots[k];
            // the amp ramp's target is the level << 2, its output (short)(value >> 3) / 2^14
            out[i] = (starts[k] + (level - starts[k]) * Math.min(Math.max(t[i] - tk, 0) / ramp, 1)) / 32768;
        }
        return out;
    }
}

interface Segment {
    start: number;
    target: number;
    value: number;
    phase: number;
    left: number;
    rate: number;
    shape: Shape;
    done: boolean;
}
