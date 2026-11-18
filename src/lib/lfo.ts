/**
 * The partial's two LFOs from its bytes and the tone header, adapted from NativeTS `LfoEngine::configure` (BSD
 * 3-Clause, see NOTICE.md), and their SFe generators: core's vibrato LFO plays LFO1, its modulation LFO plays LFO2.
 * The part's vibrato controllers (CC76..78) become exact custom curves of the engine's answer, the mod wheel goes on
 * the LFO that carries its depth.
 */
import type { BankModulator } from "./bank.js";
import { ccCurve } from "./curves.js";
import type { Dll } from "./dll.js";
import { fileOffset, readS16, readU16 } from "./dll.js";
import type { Generators } from "./envfit.js";
import { timecents } from "./envfit.js";
import { INSTANT } from "./zone-tva.js";

/**
 * The mod wheel's amounts per cent: SFe's Modulation Depth Range source is full at 16 semitones, so its default of
 * 50 cents reads as 1/32.
 */
export const DEPTH_RANGE_SCALE = 32;

const LFO_RATE = fileOffset(0x1819a2790);
const LFO_CENTS = fileOffset(0x1819a2690);
const LFO_DELAY = fileOffset(0x1819a2590);
const LFO_WAVE_MAP = fileOffset(0x181987ae0);
/**
 * The tick caps the increment at 16 Hz (NativeTS `LfoRunner::tick`).
 */
const MAX_INCREMENT = 0x28f6;
/**
 * The mod wheel's LFO1 pitch depth byte after the GS reset (GS MOD LFO1 PITCH DEPTH, 10).
 */
const GS_WHEEL_DEPTH = 10;

export interface Lfo {
    waveform: number;
    phase: number;
    increment: number;
    delayRate: number;
    fadeRate: number;
    /**
     * Tenths of a cent.
     */
    pitch: number;
    tvf: number;
    tva: number;
}

/**
 * The mod wheel's vibrato depth at CC1 127 in cents: the controller matrix's LFO1 pitch product for the GS default
 * depth (part/matrix.cpp apply_linear, then recalc's clamp 0xfc0, shift 1 and factor 0xbe7a), in tenths of a cent.
 */
export function wheelCents() {
    const product = (GS_WHEEL_DEPTH * 127) >> 2;
    const t = (Math.min(product, 0xfc0) << 1) & 0xffff;
    return Math.round(((t * 0xbe7a) >>> 16) / 10);
}

export class LfoModel {
    private readonly dll;

    public constructor(dll: Dll) {
        this.dll = dll;
    }

    private table(base: number, i: number) {
        return this.dll.u16(base + 2 * i);
    }

    /**
     * LFO1 (tone header: waveform 0x0e, rate 0x10, delay 0x12, fade 0x14, depths from the partial: pitch 0x15 through
     * the cents table, TVF 0x34 / 2, TVA 0x56) and LFO2 (the partial's own 0x06..0x0c, depths 0x16, 0x36 / 2, 0x58).
     * rate, depth and delay are the part's vibrato controllers (64 neutral).
     */
    public lfos(header: Uint8Array, b: Uint8Array, rate = 64, depth = 64, delay = 64): [Lfo, Lfo] {
        const clamp = (x: number) => Math.max(0, Math.min(0x7f, x));
        const wave = (x: number) => this.dll.u8(LFO_WAVE_MAP + (x & 0x1f));
        const pidx = b[0x15] > 127 ? b[0x15] - 256 : b[0x15];
        const cents = this.table(LFO_CENTS, clamp((pidx < 0 ? pidx & 0x7f : pidx) + (depth - 64) * 2));
        const lfo1: Lfo = {
            waveform: wave(header[0x0e]),
            phase: (header[0x0e] & 0xc0) << 8,
            increment: Math.min(this.table(LFO_RATE, clamp(readU16(header, 0x10) + rate - 64)), MAX_INCREMENT),
            delayRate: this.table(LFO_DELAY, clamp(readS16(header, 0x12) + (delay - 64) * 2)),
            fadeRate: readU16(header, 0x14),
            pitch: pidx < 0 ? -cents : cents,
            tvf: Math.trunc(readS16(b, 0x34) / 2),
            tva: readS16(b, 0x56)
        };
        const d2 = readS16(b, 0x0a);
        const lfo2: Lfo = {
            waveform: wave(b[0x06]),
            phase: (b[0x06] & 0xc0) << 8,
            increment: Math.min(readU16(b, 0x08), MAX_INCREMENT),
            delayRate: d2 > 0 ? d2 : 0xffff,
            fadeRate: readU16(b, 0x0c),
            pitch: readS16(b, 0x16),
            tvf: Math.trunc(readS16(b, 0x36) / 2),
            tva: readS16(b, 0x58)
        };
        return [lfo1, lfo2];
    }

    /**
     * The engine's LFO1 answer to CC76 (rate, cents), CC77 (depth, cents) and CC78 (delay, timecents) against 64.
     */
    public vibratoCurves(header: Uint8Array, b: Uint8Array) {
        const hzCents = (inc: number) => 1200 * Math.log2(Math.max((inc * 100) / 65536, 0.01) / 8.176);
        const delayTc = (r: number) => 1200 * Math.log2(r < 0xffff ? Math.ceil(0xffff / r) * 0.01 : 0.01);
        const base = this.lfos(header, b)[0];
        const rate = new Float64Array(128);
        const depth = new Float64Array(128);
        const delay = new Float64Array(128);
        for (let v = 0; v < 128; v++) {
            rate[v] = hzCents(this.lfos(header, b, v)[0].increment) - hzCents(base.increment);
            depth[v] = (this.lfos(header, b, 64, v)[0].pitch - base.pitch) / 10;
            delay[v] = delayTc(this.lfos(header, b, 64, 64, v)[0].delayRate) - delayTc(base.delayRate);
        }
        return { rate, depth, delay };
    }

    /**
     * The LFO generators and the controller modulators of a zone. centsPerUnit: cents one unit of the TVF's 15 bit
     * cutoff sum moves the zone's filter by (undefined without a filter), wheel: the mod wheel's depth in cents.
     */
    public generators(header: Uint8Array, b: Uint8Array, centsPerUnit: number | undefined, wheel: number) {
        const out: Generators = {};
        const mods = new Array<BankModulator>();
        const names = [
            ["freqVibLFO", "delayVibLFO", "fadeVibLFO", "vibLfoWaveform", "vibLfoStartPhase", "vibLfoToPitch", "vibLfoToFilterFc", "vibLfoToAmplitude"],
            ["freqModLFO", "delayModLFO", "fadeModLFO", "modLfoWaveform", "modLfoStartPhase", "modLfoToPitch", "modLfoToFilterFc", "modLfoToAmplitude"]
        ];
        const lfos = this.lfos(header, b);
        let wheelLfo: { wave: number; phase: number } | undefined;
        lfos.forEach((lfo, n) => {
            const [rate, delay, fade, wave, phase, toPitch, toFilter, toAmplitude] = names[n];
            if (!lfo.increment) return;
            const hz = (lfo.increment * 100) / 65536;
            const saw = lfo.waveform === 5;
            // engine shapes 0 sine, 4 square, 5 sawtooth, 6 triangle map to core's 2, 3, 1 and 0. The rest have no
            // core shape and play as a triangle: 1 to 3 (sample and hold, random walk), 7 (the offset triangle) and
            // the wave bank's 8 and up
            const shape = ({ 0: 2, 4: 3, 5: 1 } as Record<number, number>)[lfo.waveform] ?? 0;
            // core starts every LFO at zero and rising, the engine's sawtooth starts at -1 (half a turn on)
            const offset = saw ? 0.5 : 0;
            if (n === 0) {
                // the mod wheel drives LFO1 at its own rate from the first tick (no delay, no fade)
                wheelLfo = { wave: shape, phase: Math.round((((lfo.phase / 65536 + offset) % 1) * 360)) % 360 };
                out[rate] = Math.round(1200 * Math.log2(hz / 8.176));
                out[phase] = wheelLfo.phase;
                out[wave] = shape;
            }
            if (!lfo.delayRate || !lfo.fadeRate) return;
            const pitch = lfo.pitch / 10;
            const filt = centsPerUnit !== undefined && lfo.tvf ? lfo.tvf * centsPerUnit : 0;
            const r = Math.min(Math.abs(lfo.tva) / 32768, 0.95);
            const volume = lfo.tva ? 100 * Math.log10((1 + r) / (1 - r)) : 0;
            // LFO1 gets its timing even without a depth: the vibrato depth controller can give it one
            if (n !== 0 && Math.abs(pitch) < 0.5 && Math.abs(filt) < 2 && volume < 0.5) return;
            const delayS = lfo.delayRate < 0xffff ? Math.ceil(0xffff / lfo.delayRate) * 0.01 : 0.01;
            const fadeS = lfo.fadeRate < 0xffff ? (0xffff / lfo.fadeRate) * 0.01 : 0;
            // the engine's phase runs through the delay, core's starts when the delay ends
            const turns = lfo.phase / 65536 + hz * delayS + offset;
            out[rate] = Math.round(1200 * Math.log2(hz / 8.176));
            out[delay] = timecents(delayS);
            out[fade] = fadeS > 0 ? timecents(fadeS) : INSTANT;
            out[wave] = shape;
            out[phase] = Math.round((turns % 1) * 360) % 360;
            if (Math.abs(pitch) >= 0.5) out[toPitch] = Math.round(pitch);
            if (Math.abs(filt) >= 2) out[toFilter] = Math.round(filt);
            // the engine scales the gain by 1 + wave * depth / 32768, core's amplitude depth by 1 + wave * A / 1000
            if (volume >= 0.5) out[toAmplitude] = Math.max(-1000, Math.min(1000, Math.round(lfo.tva / 32.768)));
        });
        // the part's vibrato controllers move LFO1 (rate, depth and delay, latched at note on), exact per value
        const [lfo1] = lfos;
        const runs = lfo1.increment && lfo1.delayRate && lfo1.fadeRate;
        const c = this.vibratoCurves(header, b);
        const add = (m: BankModulator | undefined) => {
            if (m) mods.push(m);
        };
        if (lfo1.increment) add(ccCurve(76, c.rate, "freqVibLFO"));
        if (runs) {
            add(ccCurve(77, c.depth, "vibLfoToPitch"));
            add(ccCurve(78, c.delay, "delayVibLFO"));
        }
        // The mod wheel (the bank's default: CC1 to the modulation LFO's pitch) skips LFO1's delay and fade, core's
        // vibrato LFO cannot, so it plays on the modulation LFO at LFO1's rate where LFO2 leaves that free. A zone
        // with LFO2 keeps it on the vibrato LFO, one without LFO1 gets none
        const lfo2Used = ["modLfoToPitch", "modLfoToFilterFc", "modLfoToAmplitude"].some((k) => k in out);
        // the same amount source as the bank's default, so these supersede it
        const wheelMod = (dest: string, amount: number): BankModulator => ({
            source: "cc", cc: 1, curve: "linear", negative: false, bipolar: false, dest, amount: amount * DEPTH_RANGE_SCALE,
            secondary: { source: "depthRange", curve: "linear", negative: false, bipolar: false }
        });
        if (wheelLfo && !lfo2Used) {
            out.freqModLFO = out.freqVibLFO;
            out.modLfoWaveform = wheelLfo.wave;
            out.modLfoStartPhase = wheelLfo.phase;
            add(ccCurve(76, c.rate, "freqModLFO"));
        } else {
            mods.push(wheelMod("modLfoToPitch", 0));
            if (wheelLfo) mods.push(wheelMod("vibLfoToPitch", wheel));
        }
        return { gens: out, mods };
    }
}
