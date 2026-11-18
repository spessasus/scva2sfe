/**
 * The engine's pitch envelope from a partial's bytes: the levels at a velocity, the times at a key and velocity, the
 * pitch the envelope draws per control tick, and its projection onto SFe's modulation envelope 2 (no render).
 * Adapted from NativeTS `PitchChain` and `EnvelopeMachine` (BSD 3-Clause, Copyright (c) 2026 Kevin López Brante,
 * see NOTICE.md), checked against SC-VA's own pitch.
 *
 * Pitches are milli-semitones. The envelope starts at L0 (0x1b), runs to L1 (0x1c) over time 0x20, then to L2, L3
 * and back to the base pitch over 0x21..0x23, and after the note off crossfades from where it stood to its release
 * level (0x1f) over 0x24. Every level is the base pitch plus level_curve[|l - 0x40|] * depth >> 7 (depth 0x18,
 * scaled by velocity through 0x2b).
 */
import type { BankModulator } from "./bank.js";
import { pow } from "./math.js";
import { curveModulator } from "./curves.js";
import type { Directory, WaveDescriptor } from "./directory.js";
import type { Dll } from "./dll.js";
import { fileOffset, readU16 } from "./dll.js";
import type { Generators, ModParams, ModProjection } from "./envfit.js";
import { loudnessWeights, modEnv, modGenerators, modParams, projectModEnv, timecents } from "./envfit.js";
import { PitchModel } from "./pitch.js";
import type { LevelContext } from "./tva.js";
import { NOTE_OFF_LATE, TICK, TvaModel } from "./tva.js";
import { START_BLOCKS } from "./zone-tvf.js";

const KF_PITCH_RATE = [fileOffset(0x181a01f20), fileOffset(0x181a01aa0)];
const DEPTH_SLOPE = fileOffset(0x1819a2578);
const DEPTH_BASE = fileOffset(0x1819a28d0);
const LEVEL_CURVE = fileOffset(0x1819a2890);
const RATE_CURVE = fileOffset(0x1819a2900);
const ENV_RATE_WORDS = fileOffset(0x1819a7a00);
/**
 * pitch_env_ramp_segment clamps a segment's distance here, clamp_pitch the pitch.
 */
const MAX_PITCH = 0x1f018;
/**
 * Segment times under this (ms) take one tick (step 0xffff).
 */
const MIN_SEGMENT = 11;
/**
 * The first control tick's ramp starts here (s from the note on's block): the tick runs after block 10, its targets
 * take hold a block later (the engine's call records fit best with it: p99 1.95 cents against 6.3 at 10 ms).
 */
const FIRST_TICK = TICK + 0.001;

const i8 = (x: number) => ((x & 0xff) ^ 0x80) - 0x80;

export interface PitchEnv {
    /**
     * The partial's pitch at the note (PitchModel.base), what the levels are relative to.
     */
    base: number;
    /**
     * L0 (the start) and the targets of stages 0..3: L1, L2, L3 and the base pitch, absolute.
     */
    levels: number[];
    /**
     * The release level, absolute.
     */
    release: number;
    /**
     * Stage 0..3 times in ms as the engine stores them (under 11: one tick).
     */
    times: number[];
    releaseTime: number;
    /**
     * The main segments keep running under the release (tone header 0x0d bit 1), else they freeze at the note off.
     */
    holdsOn: boolean;
}

/**
 * The envelope per control tick: the pitch the tick hands the pitch ramp (index 0 is the note on's step) and the
 * ramp's time to get there (s).
 */
export interface PitchTicks {
    pitch: Int32Array;
    ramp: Float64Array;
}

interface Segment {
    start: number;
    target: number;
    value: number;
    phase: number;
    carry: number;
    rate: number;
    stage: number;
}

export class PitchEnvModel {
    private readonly dll;
    public readonly dir;
    public readonly tva;
    public readonly pitch;

    public constructor(dll: Dll, dir: Directory) {
        this.dll = dll;
        this.dir = dir;
        this.tva = new TvaModel(dll, dir);
        this.pitch = new PitchModel(dll, dir);
    }

    /**
     * The envelope's depth at a velocity (partial_compute_pitch_env): 0x18 (u16) through the velocity sensitivity
     * 0x2b, uint32 products as the DLL keeps them.
     */
    public depth(b: Uint8Array, velocity: number) {
        const depth = readU16(b, 0x18);
        let u = (b[0x2b] - 0x40) & 0xffff;
        if (u === 0) return depth;
        let vel = velocity & 0xff;
        if (u & 0x8000) {
            u = 0x10000 - u;
            vel = -vel & 0x7f;
        }
        const inner = this.dll.u16(DEPTH_SLOPE + 2 * u) * (i8(vel) & 0xffff) + this.dll.u16(DEPTH_BASE + 2 * u);
        return ((Math.imul(inner, depth) + 0x8000) >>> 0) >>> 16;
    }

    /**
     * A level byte at a depth around base.
     */
    public level(byte: number, base: number, depth: number) {
        const l = i8(byte - 0x40);
        if (l === 0) return base;
        const d = ((this.dll.u8(LEVEL_CURVE + Math.abs(l)) * depth) >>> 7) & 0xffff;
        return l < 0 ? Math.max(base - d, 0) : base + d;
    }

    /**
     * The key follow of the four segment times and of the release at a voice key (env_rate_scale of the
     * g_kf_pitchrate rows 0x27 by 0x29 / 0x2a, 0x100 = 1).
     */
    public keyScales(b: Uint8Array, key: number): [number, number] {
        const index = b[0x27] * 0x80 + (key & 0x7f);
        return [
            this.tva.envRateScale((this.dll.u8(KF_PITCH_RATE[0] + index) + 0x80) & 0xff, b[0x29]),
            this.tva.envRateScale((this.dll.u8(KF_PITCH_RATE[1] + index) + 0x80) & 0xff, b[0x2a])
        ];
    }

    /**
     * The velocity scale of every time, the release's too (env_level_scale of the velocity by 0x2c, 0x100 = 1).
     */
    public velocityScale(b: Uint8Array, velocity: number) {
        return this.tva.envLevelScale(velocity, b[0x2c]);
    }

    /**
     * The envelope at a note (the voice key: a melodic note, a drum's kit pitch) and velocity. Undefined where the
     * partial has no envelope (depth 0). The random start (0x1a) is left out.
     */
    public envelope(header: Uint8Array, b: Uint8Array, note: number, velocity: number) {
        if (readU16(b, 0x18) === 0) return undefined;
        const base = this.pitch.base(header, b, note);
        const depth = this.depth(b, velocity);
        const [kr, krel] = this.keyScales(b, note);
        const vs = this.velocityScale(b, velocity);
        const timeOf = (byte: number, scale: number) => {
            const r = byte & 0x7f;
            if (r === 0) return 0;
            const t = this.dll.u16(RATE_CURVE + 2 * r);
            if (t < 9) return 0;
            return ((((scale * t) >>> 8) & 0xffff) * vs) >>> 8 & 0xffff;
        };
        return {
            base,
            levels: [b[0x1b], b[0x1c], b[0x1d], b[0x1e], 0x40].map((x) => this.level(x, base, depth)),
            release: this.level(b[0x1f], base, depth),
            times: [0x20, 0x21, 0x22, 0x23].map((o) => timeOf(b[o], kr)),
            releaseTime: timeOf(b[0x24], krel),
            holdsOn: (header[0x0d] & 2) !== 0
        };
    }

    /**
     * The ramp time (s) of the rate word a stage of this many ms hands the pitch ramp: env_rate_words[min(ms, 10)],
     * the ramp steps by word / 8192 of the distance per 8 samples.
     */
    private rampOf(ms: number) {
        const word = this.dll.u16(ENV_RATE_WORDS + 2 * Math.min(ms, 10));
        return (8192 / word) * 8 / 32000;
    }

    /**
     * The pitch per control tick for count ticks (voice_pitch_block_init's step, then voice_pitch_block_update),
     * the release from tick offTick on.
     */
    public ticks(e: PitchEnv, count: number, offTick = Infinity) {
        const rateOf = (ms: number) => (ms >= MIN_SEGMENT ? Math.floor(0xa0000 / ms) & 0xffff : 0xffff);
        const main: Segment = {
            start: e.levels[0], target: e.levels[1], value: e.levels[0], phase: 0, carry: 0, rate: rateOf(e.times[0]),
            stage: 0
        };
        const rel: Segment = { start: 0, target: e.release, value: 0, phase: 0, carry: 0, rate: rateOf(e.releaseTime), stage: 0 };
        const pitch = new Int32Array(count);
        const ramp = new Float64Array(count);
        step(main);
        pitch[0] = main.value;
        ramp[0] = this.rampOf(0);
        let mainRamp = this.rampOf(e.times[0]);
        for (let k = 1; k < count; k++) {
            if (main.phase === 0xffff) {
                main.phase = 0;
                main.stage = Math.min(main.stage + 1, 4);
                if (main.stage <= 3) {
                    const ms = e.times[main.stage];
                    main.rate = rateOf(ms);
                    main.start = main.target;
                    main.target = e.levels[main.stage + 1];
                    mainRamp = this.rampOf(ms);
                }
            }
            if (rel.phase === 0xffff) rel.stage = 4;
            if (k < offTick) {
                step(main);
                pitch[k] = main.value;
                ramp[k] = mainRamp;
                continue;
            }
            if (e.holdsOn) step(main);
            step(rel);
            const inv = ~rel.phase & 0xffff;
            pitch[k] = (((main.value & 0xffff) * inv) >>> 16) + rel.value + (main.value >>> 16) * inv;
            ramp[k] = rel.phase === 0 ? mainRamp : this.rampOf(e.releaseTime);
        }
        return { pitch, ramp };
    }

    /**
     * The envelope as the pitch ramp plays it (milli-semitones over the base pitch) at times t (s from the voice's
     * start), the host's note off at off (undefined: never): a line from where the ramp stands to each tick's pitch
     * over the tick's ramp time. step: a pitch change at a time (the wave's second fine tune once it reaches its
     * loop, taken on the next tick), milli-semitones.
     */
    public curve(e: PitchEnv, t: Float64Array, off?: number, step?: { at: number; by: number }, firstTick = FIRST_TICK) {
        const end = t.length ? t[t.length - 1] : 0;
        const count = Math.max(1, Math.floor((end - firstTick) / TICK) + 2);
        const offAt = off === undefined ? Infinity : off + NOTE_OFF_LATE;
        const offTick = off === undefined ? Infinity : Math.max(1, Math.ceil((offAt - firstTick) / TICK - 1e-9) + 1);
        const { pitch, ramp } = this.ticks(e, count, offTick);
        const at = (k: number) => (k === 0 ? 0 : firstTick + (k - 1) * TICK);
        // clamp_pitch: the pitch stops at key 127 (0x1f018) and at 0
        const target = (k: number) => Math.max(0, Math.min(MAX_PITCH, pitch[k])) - e.base + (step && k > 0 && at(k) >= step.at ? step.by : 0);
        const starts = new Float64Array(count);
        starts[0] = e.levels[0] - e.base;
        for (let k = 1; k < count; k++) {
            starts[k] = starts[k - 1] + (target(k - 1) - starts[k - 1]) * Math.min((at(k) - at(k - 1)) / ramp[k - 1], 1);
        }
        const out = new Float64Array(t.length);
        let k = 0;
        for (let i = 0; i < t.length; i++) {
            while (k + 1 < count && at(k + 1) <= t[i]) k++;
            out[i] = starts[k] + (target(k) - starts[k]) * Math.min(Math.max(t[i] - at(k), 0) / ramp[k], 1);
        }
        return out;
    }
}

/**
 * Whether a wave loops forward (a loop or a ping-pong, rom.ts traversal): only those raise the loop event that makes
 * the voice take the second fine tune, a one shot's end fades the voice instead.
 */
export function loops(d: WaveDescriptor) {
    const from = d.loop & ~0x1f;
    return !(d.flags & 4) && d.start - from > Math.max(0, d.end - from);
}

/**
 * When the sampler raises its loop event, s from the note on's block, cents the static pitch before the step
 * (PitchModel.cents, not adopted) and e the envelope on top. The walk starts at the data start's 32-sample block and
 * primes 3 samples ahead (Sampler::init_forward), then fetches one sample per phase overflow of the 16.16 ratio (one
 * ratio per 8 frames) and raises the event when a fetch lands on the loop point. A loop point inside the primed
 * samples waits for the first return to it: a loop's wrap at the end, a ping-pong's way back. The voice renders from
 * block START_BLOCKS and takes the event on the first tick after the event's block, so the time returned is the
 * middle of that block (a tick at its end takes it). Undefined for a wave that does not loop forward or never gets
 * there within a minute.
 */
export function loopTime(model: PitchEnvModel, e: PitchEnv | undefined, d: WaveDescriptor, cents: number, off?: number) {
    if (!loops(d)) return undefined;
    const base = d.loop & ~0x1f;
    const point = d.end - base;
    const length = d.start - base;
    const steps = point > 3 ? point - 3 : d.flags & 1 ? 2 * length - 2 - point : length - 2;
    const chunk = 8 / 32000;
    const block = 32 / 32000;
    const per = 4000;
    let phase = 0;
    let done = 0;
    for (let j0 = 0; j0 < 60 * per; j0 += per) {
        const t = Float64Array.from({ length: per }, (_, i) => START_BLOCKS * block + (j0 + i) * chunk);
        const env = e ? model.curve(e, t, off) : undefined;
        for (let i = 0; i < per; i++) {
            const sum = phase + 8 * Math.floor(65536 * pow(2, (cents + (env ? env[i] / 10 : 0)) / 1200));
            done += Math.floor(sum / 65536);
            phase = sum % 65536;
            if (done >= steps) return (START_BLOCKS + Math.floor((j0 + i) / 4) + 0.5) * block;
        }
    }
    return undefined;
}

/**
 * One tick of pitch_env_ramp_segment: a line from start to target in a 0x10000 phase, ticks left over carried into
 * the next stage, the distance clamped.
 */
function step(g: Segment) {
    if (g.stage === 4) return;
    let phase = (1 + g.carry) * g.rate + g.phase;
    g.carry = 0;
    if (phase >= 0x10000) {
        g.carry = Math.floor((phase - 0xffff) / g.rate);
        phase = 0xffff;
    }
    g.phase = phase;
    if (phase === 0xffff) {
        g.value = g.target;
        return;
    }
    const d = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, g.target - g.start));
    const u = Math.abs(d);
    const move = (u >>> 16) * phase + (((u & 0xffff) * phase) >>> 16);
    g.value = d >= 0 ? g.start + move : g.start - move;
}

/**
 * The pitch ramp's target word (voice_pitch_block_update, word_of with bit 0 cleared) for an absolute pitch
 * against the wave's own pitch (PitchModel.native), both milli-semitones.
 */
export function pitchWord(pitch: number, native: number) {
    const t = Math.max(0, Math.min(MAX_PITCH, pitch)) - native;
    const w = Math.trunc((t * 512) / 375) + 0x38000;
    return (w >= 0x40000 ? 0x3ffff : w < 0 ? 0 : w) & ~1;
}

/**
 * The curve's grid (s): SC-VA's output in steps of two 64-frame calls.
 */
const DT = 128 / 32000;
/**
 * The curve: a 3 s hold and 1.5 s of release, the setup the rules were tuned on. A longer hold for slow envelopes made the
 * projection follow seconds 3..10 at the cost of the first ones (Falling Down: 1 -> 755 cents).
 */
const HOLD = 750;
const RELEASE = 375;
/**
 * The release's second note (0.3 s, the TVA's twin): a decaying voice is silent by the 3 s note off, so the release
 * time is fitted on both notes' releases (Noise&SawHit fell 2200 cents in 50 ms after a short note).
 */
const TWIN_HOLD = 75;
/**
 * The keep rule: an envelope is written
 * when the curve moves at least MIN_CENTS (weighted RMS against the static pitch) and the projection leaves less
 * than KEEP of it, or explains at least EXPLAINED cents and leaves at most RESIDUAL_MAX. The curve is the envelope
 * alone, no LFO on it.
 */
const KEEP = 0.7;
const MIN_CENTS = 3;
const EXPLAINED = 10;
const RESIDUAL_MAX = 40;
/**
 * A fine tune step under this (cents) is left out.
 */
const STEP_MIN = 0.5;
const TIMES = ["attackModEnv2", "holdModEnv2", "decayModEnv2"];
/**
 * The split check's limit (cents of weighted RMS). The curves are exact away from the reference except where the
 * pitch hits key 127 or the playback ratio cap, so only keys whose curve hits one are checked.
 */
const SPLIT_CENTS = 10;

/**
 * Where a zone plays better as two (TvaSplit's shape): the first key or velocity of the upper part.
 */
export interface PitchSplit {
    key?: number;
    velocity?: number;
}

export interface PitchZoneQuery {
    header: Uint8Array;
    b: Uint8Array;
    /**
     * The reference voice key (a melodic note at the zone's centre, a drum's kit pitch) and velocity.
     */
    key: number;
    velocity: number;
    drum: boolean;
    /**
     * The TVA's level context, for the loudness weights.
     */
    levels: LevelContext;
    /**
     * Ignores the note off (a drum key without note off).
     */
    free: boolean;
    /**
     * Where a one shot wave ends the voice (s from the voice's start), undefined for a looped wave.
     */
    end?: number;
    /**
     * The zone's keys and the partial's velocity window: the key and velocity curves hold their edge values outside.
     */
    keyLo: number;
    keyHi: number;
    velLo: number;
    velHi: number;
    /**
     * The zone's scaleTuning (cents a key): a fine tune step's time follows the playback rate.
     */
    scale: number;
    /**
     * Skips the split check (a part already split, or the check's own projection).
     */
    noSplit?: boolean;
}

export interface PitchZone {
    /**
     * Modulation envelope 2 with modEnv2ToPitch (and keyNumToModEnv2Hold for a fine tune step).
     */
    gens: Generators;
    mods: BankModulator[];
    /**
     * Cents the zone's tuning moves by (an envelope whose release goes to its own level: the envelope is held at
     * -tune through the note and the release lands on tune). The zone's tuning itself is the static pitch with the
     * second fine tune where the wave loops (PitchModel.cents, adopted = loops(wave)).
     */
    tune: number;
    /**
     * "envelope": the pitch envelope, "step": the second fine tune's step alone (a voice without an envelope).
     */
    kind: "envelope" | "step";
    /**
     * The step's size in cents for kind "step" (the rules let a filter's fast segment take modulation envelope 2
     * over a step under 5 cents or one over within 50 ms).
     */
    step?: number;
    /**
     * Weighted RMS (cents) of the projection's error and of the curve against the static pitch, at the reference.
     */
    rms: number;
    raw: number;
    split?: PitchSplit;
}

/**
 * Weighted RMS (cents) of offset + amount x modulation envelope against a curve, and of the curve itself against 0.
 */
export function pitchRms(curve: Float64Array, gain: Float64Array, dt: number, holdPoints: number, offset: number,
                         amount: number, p: ModParams | undefined) {
    const w = loudnessWeights(gain);
    const t = Float64Array.from(curve, (_, i) => i * dt);
    const e = p ? modEnv(t, holdPoints * dt, p) : new Float64Array(t.length);
    let se = 0;
    let sr = 0;
    let n2 = 0;
    for (let i = 0; i < t.length; i++) {
        se += pow((offset + amount * e[i] - curve[i]) * w[i], 2);
        sr += pow(curve[i] * w[i], 2);
        n2 += pow(w[i], 2);
    }
    return n2 > 0 ? { rms: Math.sqrt(se / n2), raw: Math.sqrt(sr / n2) } : { rms: 0, raw: 0 };
}

/**
 * The engine's pitch curve of a voice (cents against its steady pitch: the static pitch with the second fine tune
 * where the wave loops) and its TVA gain on the DT grid, from the voice's start. off: the note off (s from the note
 * on), undefined for none. Undefined where the partial plays no voice there.
 */
export function pitchCurve(model: PitchEnvModel, q: PitchZoneQuery, key: number, velocity: number, points: number, off?: number) {
    const z = model.dir.selectWave(q.b, key);
    const s = model.tva.segments(q.b, key, velocity, q.levels);
    if (!z || !s) return undefined;
    const d = model.dir.wave(z.wave);
    const e = model.envelope(q.header, q.b, key, velocity);
    const looped = loops(d);
    const by = model.pitch.native(z.wave) - model.pitch.native(z.wave, true);
    // the voice waits n ticks (its envelopes with it), the host's note off does not
    const n = model.tva.delayTicks(q.b, velocity);
    const late = n ? n * TICK - 0.002 : 0;
    const voff = off === undefined ? undefined : Math.max(DT, off - late);
    const t = Float64Array.from({ length: points }, (_, i) => i * DT);
    // point i is the voice after call 2i + 1 (the grid the rules were tuned on, tva.curve's grid): the
    // pitch ramp's state at (i + 1) DT from the note on's block
    const tp = t.map((x) => x + DT);
    const lt = looped && by !== 0 ? loopTime(model, e, d, model.pitch.cents(q.header, q.b, key, q.drum)!, voff) : undefined;
    const step = lt === undefined ? undefined : { at: lt, by };
    const c = e ? model.curve(e, tp, voff, step) : Float64Array.from(tp, (x) => (step && x >= step.at + FIRST_TICK ? by : 0));
    // the playback ratio stops two octaves up (pitch.ts): an envelope above it is not heard
    const steady = model.pitch.cents(q.header, q.b, key, q.drum, looped)!;
    // the clamp at pitch 0 lies far below any played note and is left to the curves
    let clamped = !!e && Math.max(...e.levels, e.release) > MAX_PITCH;
    const cents = c.map((x) => {
        const y = (x - (looped ? by : 0)) / 10;
        if (y > 2400 - steady) clamped = true;
        return Math.min(y, 2400 - steady);
    });
    const gain = model.tva.curve(s, tp, voff);
    if (q.end !== undefined) for (let i = Math.ceil(q.end / DT); i < points; i++) gain[i] = 0;
    return { cents, gain, env: e, loopTime: lt, holdPoints: voff === undefined ? points : Math.round(voff / DT), clamped };
}

/**
 * A zone's pitch envelope: SFe's modulation envelope 2 projected onto the engine's pitch curve at the zone's
 * reference key and velocity, with the engine's key follow and velocity scaling of the times and the depth as exact
 * custom curves. A voice without an envelope gets the second fine tune's step instead. Undefined
 * where neither moves the pitch.
 */
export function pitchZone(model: PitchEnvModel, q: PitchZoneQuery) {
    const e = model.envelope(q.header, q.b, q.key, q.velocity);
    if (!e) return stepZone(model, q);
    const c = pitchCurve(model, q, q.key, q.velocity, HOLD + RELEASE, q.free ? undefined : HOLD * DT);
    if (!c) return undefined;
    const p0 = projectModEnv(c.cents, c.gain, DT, c.holdPoints);
    if (!p0) return undefined;
    const p = q.free ? p0 : { ...p0, params: { ...p0.params, release: twinRelease(model, q, c, p0) } };
    const { rms, raw } = pitchRms(c.cents, c.gain, DT, c.holdPoints, p.offset, p.amount, p.params);
    const explained = Math.sqrt(Math.max(raw * raw - rms * rms, 0));
    if (!(raw >= MIN_CENTS && (rms < KEEP * raw || (explained >= EXPLAINED && rms <= RESIDUAL_MAX)))) return undefined;
    const gens: Generators = { ...modGenerators(p.params, "ModEnv2"), modEnv2ToPitch: Math.round(p.amount), delayModEnv2: -12000 };
    const tune = p.offset;
    const mods = new Array<BankModulator>();
    const add = (m: BankModulator | undefined) => {
        if (m) mods.push(m);
    };
    const live = (name: string) => (gens[name] ?? -12000) > -12000;
    // key follow: the four segment times scale by one multiplier, the release by another
    if (q.keyHi > q.keyLo) {
        const [kr, krel] = model.keyScales(q.b, q.key);
        const seg = new Float64Array(128);
        const rel = new Float64Array(128);
        for (let k = 0; k < 128; k++) {
            const [a, r] = model.keyScales(q.b, Math.max(q.keyLo, Math.min(q.keyHi, k)));
            seg[k] = 1200 * Math.log2(a / kr);
            rel[k] = 1200 * Math.log2(r / krel);
        }
        for (const name of TIMES) if (live(name)) add(curveModulator("key", seg, name));
        if (live("releaseModEnv2") && !q.free) add(curveModulator("key", rel, "releaseModEnv2"));
    }
    // velocity: every time by one multiplier, the depth (and the release level's tuning offset with it) by 0x2b
    {
        const ref = model.velocityScale(q.b, q.velocity);
        const dref = model.depth(q.b, q.velocity);
        const times = new Float64Array(128);
        const depth = new Float64Array(128);
        const shift = new Float64Array(128);
        for (let v = 0; v < 128; v++) {
            const vv = Math.max(Math.max(1, q.velLo), Math.min(q.velHi, v));
            times[v] = 1200 * Math.log2(model.velocityScale(q.b, vv) / ref);
            const r = dref > 0 ? model.depth(q.b, vv) / dref - 1 : 0;
            depth[v] = gens.modEnv2ToPitch * r;
            shift[v] = tune * r;
        }
        for (const name of TIMES) if (live(name)) add(curveModulator("velocity", times, name));
        if (live("releaseModEnv2") && !q.free) add(curveModulator("velocity", times, "releaseModEnv2"));
        add(curveModulator("velocity", depth, "modEnv2ToPitch"));
        add(curveModulator("velocity", shift, "fineTune"));
    }
    const zone: PitchZone = { gens, mods, tune, kind: "envelope", rms, raw };
    // the split check: at the zone's edge keys and half way to them, where key 127 or the ratio cap flattens the
    // curve, the curves miss what they draw elsewhere. Split where they miss by SPLIT_CENTS more than the reference
    // does and a projection of its own would do SPLIT_CENTS better
    if (!q.noSplit && q.keyHi > q.keyLo) {
        const off = q.free ? undefined : HOLD * DT;
        const worse = (key: number) => {
            const ck = pitchCurve(model, q, key, q.velocity, HOLD + RELEASE, off);
            if (!ck || !ck.clamped) return false;
            const g = pitchGensAt(zone, key, q.velocity);
            const rule = pitchRms(ck.cents, ck.gain, DT, ck.holdPoints, tune + (g.fineTune ?? 0), g.modEnv2ToPitch ?? 0,
                modParams(g, "ModEnv2")).rms;
            if (rule - rms <= SPLIT_CENTS) return false;
            const own = projectModEnv(ck.cents, ck.gain, DT, ck.holdPoints);
            const ownRms = own ? pitchRms(ck.cents, ck.gain, DT, ck.holdPoints, own.offset, own.amount, own.params).rms
                : pitchRms(ck.cents, ck.gain, DT, ck.holdPoints, 0, 0, undefined).raw;
            return rule - ownRms > SPLIT_CENTS;
        };
        const keys = [q.keyLo, (q.keyLo + q.key) >> 1, (q.key + q.keyHi + 1) >> 1, q.keyHi];
        if (keys.some((k, i) => k !== q.key && keys.indexOf(k) === i && worse(k))) zone.split = { key: ((q.keyLo + q.keyHi) >> 1) + 1 };
    }
    return zone;
}

/**
 * The projection's release time refitted on the releases of the long note and of a TWIN_HOLD note together (loudness
 * weighted, each note against its own peak, the two mean squares summed), the rest of the projection kept: a grid of release times, the
 * projection's own where nothing does better.
 */
function twinRelease(model: PitchEnvModel, q: PitchZoneQuery, long: NonNullable<ReturnType<typeof pitchCurve>>, p: ModProjection) {
    const twin = pitchCurve(model, q, q.key, q.velocity, TWIN_HOLD + RELEASE, TWIN_HOLD * DT);
    const parts = new Array<{ t: Float64Array; c: Float64Array; w: Float64Array; off: number }>();
    for (const c of twin ? [long, twin] : [long]) {
        const w = loudnessWeights(c.gain);
        const tv = new Array<number>();
        const cv = new Array<number>();
        const wv = new Array<number>();
        for (let i = c.holdPoints; i < c.cents.length; i++) {
            if (w[i] <= 0) continue;
            tv.push(i * DT);
            cv.push(c.cents[i]);
            wv.push(w[i]);
        }
        if (tv.length) parts.push({ t: Float64Array.from(tv), c: Float64Array.from(cv), w: Float64Array.from(wv), off: c.holdPoints * DT });
    }
    const errOf = (release: number) => {
        let err = 0;
        for (const part of parts) {
            const e = modEnv(part.t, part.off, { ...p.params, release });
            let se = 0;
            let n = 0;
            for (let k = 0; k < part.t.length; k++) {
                se += pow(part.w[k] * (p.offset + p.amount * e[k] - part.c[k]), 2);
                n += pow(part.w[k], 2);
            }
            err += se / n;
        }
        return err;
    };
    let best = p.params.release;
    let bestErr = errOf(best);
    for (let tc = -7200; tc <= 8000; tc += 50) {
        const r = pow(2, tc / 1200);
        const err = errOf(r);
        if (err < bestErr - 1e-9 * Math.max(bestErr, 1)) {
            bestErr = err;
            best = r;
        }
    }
    return best;
}

/**
 * A pitch zone's generators at a key and velocity, its custom curves applied.
 */
export function pitchGensAt(zone: { gens: Generators; mods: BankModulator[] }, key: number, velocity: number) {
    const g: Generators = { ...zone.gens };
    for (const m of zone.mods) {
        const y = m.points![m.source === "key" ? key : velocity][1];
        g[m.dest] = (g[m.dest] ?? (m.dest.endsWith("ModEnv2") ? -12000 : 0)) + ((y - 8192) / 8192) * m.amount;
    }
    return g;
}

/**
 * The second fine tune's step on modulation envelope 2 (a voice without a fitted envelope): the pitch
 * before the loop over the steady one, held until the wave reaches its loop at the reference key, the hold
 * following the playback rate over the keys (keyNumToModEnv2Hold = the zone's scale tuning).
 */
function stepZone(model: PitchEnvModel, q: PitchZoneQuery): PitchZone | undefined {
    const z = model.dir.selectWave(q.b, q.key);
    if (!z) return undefined;
    const d = model.dir.wave(z.wave);
    if (!loops(d) || d.fineTune2 === 1024) return undefined;
    const before = model.pitch.cents(q.header, q.b, q.key, q.drum);
    const after = model.pitch.cents(q.header, q.b, q.key, q.drum, true);
    if (before === undefined || after === undefined || Math.abs(before - after) < STEP_MIN) return undefined;
    const reach = loopTime(model, undefined, d, before);
    if (reach === undefined) return undefined;
    // the step shows on the first tick after the loop event
    const at = Math.max(0, Math.ceil((reach - FIRST_TICK) / TICK)) * TICK + FIRST_TICK;
    const hold = timecents(at) - (60 - q.key) * q.scale;
    const step = before - after;
    return {
        gens: {
            modEnv2ToPitch: Math.round(step), delayModEnv2: -12000, attackModEnv2: -12000,
            holdModEnv2: Math.max(-12000, Math.min(5000, hold)), keyNumToModEnv2Hold: q.scale, decayModEnv2: -12000,
            sustainModEnv2: 1000, releaseModEnv2: Math.max(-12000, Math.min(5000, timecents(at)))
        },
        mods: [],
        tune: 0,
        kind: "step",
        step,
        rms: 0,
        raw: Math.abs(step)
    };
}
