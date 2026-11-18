/**
 * The engine's static playback pitch of a partial at a note (no envelope, LFO or bend). Adapted from NativeTS
 * `PitchChain` (BSD 3-Clause, Copyright (c) 2026 Kevin López Brante, see NOTICE.md).
 */
import type { Directory } from "./directory.js";
import type { Dll } from "./dll.js";
import { fileOffset } from "./dll.js";

const KF_PITCH = fileOffset(0x181a01b20);
const EXP_TABLE = fileOffset(0x181986420);
/**
 * The ratio stops two octaves up (no voice SC-VA plays passes 3.9993, Alias plays at the cap).
 */
const MAX_RATIO = 4;

export class PitchModel {
    private readonly dll;
    private readonly dir;

    public constructor(dll: Dll, dir: Directory) {
        this.dll = dll;
        this.dir = dir;
    }

    /**
     * The playback ratio's cents against the sample's own rate: key * 1000 + fraction + the key curve (row header
     * 0x17, drum keys too) + coarse * 10 milli-semitones against the wave's root * 1000 + 1024 - fine, less fine 2 -
     * 1024 once the wave has reached its loop (adopted), through the exponential table. Undefined where the note
     * starts no voice.
     */
    public cents(header: Uint8Array, b: Uint8Array, note: number, _drum: boolean, adopted = false) {
        const z = this.dir.selectWave(b, note);
        if (!z) return undefined;
        const milli = this.base(header, b, note) - this.native(z.wave, adopted);
        // Python's round: half to even
        const x = (milli * 16384) / 12000;
        let r = Math.round(x);
        if (Math.abs(x % 1) === 0.5 && r % 2 !== 0) r -= 1;
        const word = r + 14 * 16384;
        const o = word >> 14;
        const f = word & 0x3fff;
        const i = f >> 6;
        const w = f & 63;
        const t = (j: number) => this.dll.s32(EXP_TABLE + 4 * j);
        const ratio = ((t(i) + Math.floor(((t(i + 1) - t(i)) * w) / 64)) * 2 ** (o - 14)) / t(0);
        return 1200 * Math.log2(Math.min(ratio, MAX_RATIO));
    }

    /**
     * The partial's pitch at a note in milli-semitones before the wave's root comes off (partial_compute_pitch
     * without the random pitch): key * 1000 + fraction + the key curve + the fine byte 0x11 in cents. The pitch
     * envelope's levels sit around it.
     */
    public base(header: Uint8Array, b: Uint8Array, note: number) {
        const [k0, frac] = this.dir.keyFollow(b, note);
        const key = Math.max(0, Math.min(127, k0 + b[0x10] - 0x40));
        const row = header[0x17];
        // the key curve holds for drum keys too: the row is the tone's while the part's byte 0x10 is set, which
        // the GS reset does
        const curve = row > 0 && row < 4 ? this.dll.s16(KF_PITCH + 2 * (row * 0x80 + key)) : 0;
        return key * 1000 + frac + curve + (b[0x11] - 0x40) * 10;
    }

    /**
     * The wave's own pitch in milli-semitones (root * 1000 + 1024 - fine), with the second fine tune once the
     * sampler has reached the loop (adopted).
     */
    public native(wave: number, adopted = false) {
        const d = this.dir.wave(wave);
        return d.rootKey * 1000 + 1024 - d.fineTune - (adopted ? d.fineTune2 - 1024 : 0);
    }
}
