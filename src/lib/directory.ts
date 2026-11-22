/**
 * The patch directory of SCCore.dll: tone maps, tones and their partials, multisamples, wave descriptors and drum
 * kits, with the engine's own key follow and zone choice. Adapted from Tabula Sonora and NativeTS (BSD 3-Clause,
 * Copyright (c) 2026 Kevin López Brante, see NOTICE.md).
 */
import type { Dll } from "./dll.js";
import { fileOffset, readS16, readU16 } from "./dll.js";

export const MAP_SC55 = 1;
export const MAP_SC88 = 2;
export const MAP_SC88PRO = 3;
export const MAP_SC8820 = 4;
export const MAP_NAMES: Record<number, string> = { 1: "sc55", 2: "sc88", 3: "sc88pro", 4: "sc8820" };
/**
 * Drum map rows per tone map, row 5 holds the GM2 kits.
 */
export const DRUM_ROWS: Record<number, number> = { 1: 3, 2: 2, 3: 1, 4: 0 };
export const GM2_DRUM_ROW = 5;

const TONES = 0x18f1810;
const TONE_COUNT = 2363;
const MULTISAMPLES = 0x18c9570;
const WAVEDESC = 0x1896b40;
const WAVE_COUNT = 4259;
const LAYERED = 0x1896690;
const LUT1 = 0x19f1e30;
const LUT2 = 0x19f18b0;
const LUT3 = 0x19f22b0;
const INDIRECT64 = 0x19a7bf0;
const INDIRECT65 = 0x19a8800;
const DRUM_PROG_MAP = 0x19f1eb0;
const DRUM_KIT_INDEX = 0x19f21b0;
const DRUM_KITS = 0x18ad950;
/**
 * The second tone table (tone numbers 0x4000 up): records of four partials, the table's header right after them
 * holds the partial count.
 */
const WIDE_TONES = fileOffset(0x181a00c30);
const WIDE_TONE_INFO = fileOffset(0x181a01000);
const VEL_XFADE = 0x1a00020;
const KF_SLOPE = fileOffset(0x1800935c0);

export const TONE_STRIDE = 0x100;
export const TONE_HEADER = 0x24;
export const PARTIAL_STRIDE = 0x6e;
const MULTISAMPLE_STRIDE = 0x8c;
const WAVEDESC_STRIDE = 0x16;
const ALTERNATE_STRIDE = 0x18;
const KIT_STRIDE = 0x50c;
const WIDE_TONE_STRIDE = 0x1e8;
const WIDE_TONE_COUNT = (WIDE_TONE_INFO - WIDE_TONES) / WIDE_TONE_STRIDE;
/**
 * A wide tone's partials start after its header and a 96 bit partial mask (bit 31 of each word down is partial 0 up).
 */
const WIDE_TONE_PARTIALS = 0x30;
const UNASSIGNED = 0xffff;
const WIDE_TONE_SPACE = 0x4000;
const ALTERNATE_SPACE = 0x6000;
const INDIRECT_ONLY = 0x8000;

const clamp7 = (x: number) => Math.max(0, Math.min(127, x));
const i8 = (x: number) => ((x & 0xff) ^ 0x80) - 0x80;
const latin1 = (b: Uint8Array) => Array.from(b, (c) => String.fromCharCode(c)).join("").replace(/[ \0]+$/, "");

export interface WaveDescriptor {
    region: number;
    /**
     * The data start (Tabula Sonora's `loop`).
     */
    loop: number;
    /**
     * The loop point (`end`).
     */
    end: number;
    /**
     * The data end (`start`).
     */
    start: number;
    rootKey: number;
    fineTune: number;
    fineTune2: number;
    flags: number;
}

export interface Zone {
    wave: number;
    level: number;
    zone: number;
    key: number;
}

export interface KitKey {
    tone: number;
    level: number;
    pitch: number;
    group: number;
    pan: number;
    reverb: number;
    chorus: number;
    delay: number;
    noteOff: boolean;
    noteOn: boolean;
    sounding: boolean;
}

export class Directory {
    private readonly dll;

    public constructor(dll: Dll) {
        this.dll = dll;
    }

    public get toneCount() {
        return TONE_COUNT;
    }

    public get waveCount() {
        return WAVE_COUNT;
    }

    public toneRecord(n: number) {
        if (n >= WIDE_TONE_SPACE) return this.dll.slice(WIDE_TONES + (n - WIDE_TONE_SPACE) * WIDE_TONE_STRIDE, WIDE_TONE_STRIDE);
        return this.dll.slice(TONES + n * TONE_STRIDE, TONE_STRIDE);
    }

    /**
     * The partial slots of a tone: 2, or the second table's count for tone numbers 0x4000 up.
     */
    public partialCount(n: number) {
        return n >= WIDE_TONE_SPACE ? this.dll.u16(WIDE_TONE_INFO + 2) : 2;
    }

    public toneName(n: number) {
        return latin1(this.toneRecord(n).subarray(0, 12));
    }

    public toneHeader(n: number) {
        return this.toneRecord(n).subarray(0, TONE_HEADER);
    }

    /**
     * A partial's 0x6e bytes, undefined for an empty slot.
     */
    public partial(n: number, slot: number) {
        const r = this.toneRecord(n);
        let start = TONE_HEADER;
        if (n >= WIDE_TONE_SPACE) {
            // the wide tones switch partials by their mask (little endian words, tone_lookup), the melodic header's
            // 0x16 byte is 0 there
            const byte = TONE_HEADER + 4 * (slot >> 5) + 3 - ((slot & 31) >> 3);
            if ((r[byte] & (0x80 >> (slot & 7))) === 0) return undefined;
            start = WIDE_TONE_PARTIALS;
        }
        const b = r.subarray(start + slot * PARTIAL_STRIDE, start + (slot + 1) * PARTIAL_STRIDE);
        return readU16(b, 2) === 0xffff ? undefined : b;
    }

    public multisample(m: number) {
        return this.dll.slice(MULTISAMPLES + m * MULTISAMPLE_STRIDE, MULTISAMPLE_STRIDE);
    }

    public wave(w: number) {
        const r = this.dll.slice(WAVEDESC + w * WAVEDESC_STRIDE, WAVEDESC_STRIDE);
        const p20 = (o: number) => ((r[o] & 15) << 16) | (r[o + 1] << 8) | r[o + 2];
        return {
            region: r[0] & 0x7f,
            loop: p20(1),
            end: p20(7),
            start: p20(0x0b),
            rootKey: r[6],
            fineTune: readU16(r, 4),
            fineTune2: readU16(r, 0x0e),
            flags: r[0x0a]
        };
    }

    /**
     * The key a partial plays as (multisample_key_zone, the path the DLL takes: pivot 60): [key, fraction / 1000].
     */
    public keyFollow(b: Uint8Array, note: number): [number, number] {
        const pivot = 60;
        const kf = b[0x13];
        if (kf === 0x4a) return [note, 0];
        if (kf === 0x40) return pivot <= note ? [pivot, 0] : [pivot - 1, 1000];
        const d = kf - 0x40;
        const dist = note - pivot;
        // the engine's sign test: a negative distance always counts as negative
        const neg = dist < 0 || d < 0;
        const slope = this.dll.u16(KF_SLOPE + 2 * Math.abs(d));
        const u = (slope * 2 * Math.abs(dist)) >>> 0;
        const hi = u >>> 16;
        const lo = u & 0xffff;
        let k: number;
        let frac: number;
        if (lo < 65000) {
            frac = Math.floor((lo * 999) / 65000);
            if (neg) {
                k = -hi - 1;
                frac = 1000 - frac;
            } else {
                k = hi;
            }
        } else {
            k = neg ? -hi - 1 : hi + 1;
            frac = 0;
        }
        k += pivot;
        return k < 0 ? [0, frac] : [Math.min(k, 127), frac];
    }

    /**
     * The wave a partial plays for a key (multisample_select_wave, the DLL's path: a key above the last bound or an
     * empty zone is silent), undefined where the partial starts no voice.
     */
    public selectWave(b: Uint8Array, note: number) {
        const r = this.multisample(readU16(b, 2));
        let key = this.keyFollow(b, note)[0];
        key = clamp7(key + b[0x10] - 0x40);
        key = clamp7(key + 0x40 - b[0x04]);
        if (r[0x2b] < key) return undefined;
        let z = 0;
        while (r[0x0c + z] < key) z++;
        const wave = readS16(r, 0x2c + z * 2);
        return wave >= 0 ? { wave, level: r[0x6c + z], zone: z, key } : undefined;
    }

    /**
     * The partial's level byte at a velocity through its crossfade window, undefined outside the window.
     */
    public levelByte(b: Uint8Array, velocity: number) {
        const low = b[0x4f];
        const high = b[0x51];
        const wl = Math.min(low, high);
        const wh = Math.max(low, high);
        if (velocity < wl || velocity > wh) return undefined;
        let position: number;
        if (wh === wl) {
            position = 0x7f;
        } else {
            const off = velocity - wl;
            const scaled = Math.floor((((off * 0x100) | (off >> 8)) & 0xffff) / (wh - wl));
            position = scaled > 0xff ? 0x7f : scaled >> 1;
        }
        const span = i8(b[0x52] - b[0x50]);
        const index = low <= high ? position : (wl - position) & 0xff;
        // a reversed window can index past its row (the next rows of the table, as the DLL reads them)
        const curve = this.dll.u8(VEL_XFADE + (b[0x4e] & 15) * 0x80 + index);
        const delta = i8((((curve * Math.abs(span)) + 0x7f) * 2) >> 8);
        const level = i8(b[0x50] + (span >= 0 ? delta : -delta));
        return level === 0 ? 1 : level;
    }

    private lut3Raw(program: number, map: number, bank: number) {
        const l1 = this.dll.u8(LUT1 + map);
        if (l1 === 0xff) return undefined;
        const l2 = this.dll.u8(LUT2 + l1 * 0x80 + bank);
        if (l2 === 0xff) return undefined;
        return this.dll.u16(LUT3 + 2 * (l2 * 0x80 + program));
    }

    private lut3Resolved(program: number, map: number, bank: number): number | undefined {
        if (bank === 0x40 || bank === 0x41) {
            const t = bank === 0x40 ? INDIRECT64 : INDIRECT65;
            const b2 = this.dll.u8(t + 0x80 + program);
            if (b2 === 0x40 || b2 === 0x41) return undefined;
            return this.lut3Resolved(this.dll.u8(t + 0x100 + program), this.dll.u8(t + program), b2);
        }
        let raw = this.lut3Raw(program, map, bank);
        if (bank && (raw === undefined || raw === UNASSIGNED)) raw = this.lut3Raw(program, map, 0);
        return raw;
    }

    private dereference(map: number, bank: number, program: number) {
        const raw = this.lut3Raw(program, map, bank);
        if (raw === undefined || raw === UNASSIGNED) return -1;
        const n = raw & 0x7fff;
        return n < 0x4000 ? n : -1;
    }

    /**
     * The tone a program change plays (poly mode), or -1. resolved: with the capital tone fallback and the
     * redirect banks. Alternate articulation entries give their primary reference.
     */
    public programTone(program: number, map: number, bank: number, resolved = true) {
        const raw = resolved ? this.lut3Resolved(program, map, bank) : this.lut3Raw(program, map, bank);
        if (raw === undefined || raw === UNASSIGNED || raw >= INDIRECT_ONLY) return -1;
        // 0x4000..0x5fff point into the second tone table (TeeBee and Jazz Scat of SC-8820, four partials each)
        if (raw >= WIDE_TONE_SPACE + WIDE_TONE_COUNT && raw < ALTERNATE_SPACE) return -1;
        if (raw < ALTERNATE_SPACE) return raw;
        const r = this.dll.slice(LAYERED + (raw - ALTERNATE_SPACE) * ALTERNATE_STRIDE, ALTERNATE_STRIDE);
        return this.dereference(r[0x10], r[0x11], r[0x12]);
    }

    public kitForProgram(program: number, row: number) {
        const slot = this.dll.u8(DRUM_PROG_MAP + row * 0x80 + program);
        return slot === 0xff ? undefined : this.dll.u16(DRUM_KIT_INDEX + 2 * slot);
    }

    public kit(k: number) {
        const r = this.dll.slice(DRUM_KITS + k * KIT_STRIDE, KIT_STRIDE);
        const keys = new Array<KitKey>();
        for (let note = 0; note < 128; note++) {
            const tone = readU16(r, 2 * note);
            const flags = r[0x480 + note];
            keys.push({
                tone,
                level: r[0x100 + note],
                pitch: r[0x180 + note],
                group: r[0x200 + note],
                pan: r[0x280 + note],
                reverb: r[0x300 + note],
                chorus: r[0x380 + note],
                delay: r[0x400 + note],
                noteOff: (flags & 1) !== 0,
                noteOn: (flags & 0x10) !== 0,
                sounding: (flags & 0x10) !== 0 && tone !== 0xffff
            });
        }
        return { number: k, name: latin1(r.subarray(0x500, 0x50c)), keys };
    }
}
