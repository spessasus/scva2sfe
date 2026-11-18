/**
 * The bank model between the rules and the writer (bank.json's schema), so two converted banks can be compared zone
 * by zone.
 */

export interface BankSample {
    name: string;
    offset: number;
    length: number;
    loop_start: number;
    loop_end: number;
    // "alternate" plays the loop as SFe's alternating loop (sampleModes 4), turning on loop_start and loop_end - 1
    mode?: string;
    // its own gain where the bank's would clip it
    gain?: number;
    // leading silence in samples, for core's onset fade
    pad?: number;
    // a highpass, bandpass or notch the engine holds still on this copy, as a zero phase FIR
    fir?: number[];
    // the audio's file in the data folder when it is not samples.f32 (the engine's bakes)
    file?: string;
    // an engine render: its interpolation is in the audio already, the writer does not filter it
    baked?: boolean;
}

export interface BankSource {
    // "depthRange": SFe's Modulation Depth Range (RPN 5 and the GS MOD LFO1 PITCH DEPTH)
    source: "velocity" | "key" | "cc" | "none" | "depthRange";
    cc?: number;
    curve: "linear" | "concave" | "convex" | "switch" | "custom";
    // an SFe custom curve's [x, y] points (curve "custom")
    points?: [number, number][];
    negative: boolean;
    bipolar: boolean;
}

export interface BankModulator extends BankSource {
    dest: string;
    amount: number;
    secondary?: BankSource;
}

export interface BankZone {
    sample: number;
    key_lo: number;
    key_hi: number;
    vel_lo: number;
    vel_hi: number;
    gens: Record<string, number>;
    // indices into Bank.modulators
    mods?: number[];
}

export interface BankPresetZone {
    instrument: number;
    key_lo?: number;
    key_hi?: number;
}

export interface Bank {
    name: string;
    sample_rate: number;
    sample_gain: number;
    sample_fir?: number[];
    // the mod wheel's vibrato depth at CC1 127 in cents (the direct translator takes it from the engine)
    wheel_cents?: number;
    samples: BankSample[];
    // every distinct zone modulator once
    modulators: BankModulator[];
    instruments: { name: string; zones: BankZone[] }[];
    presets: {
        name: string;
        bank_msb: number;
        bank_lsb: number;
        program: number;
        drum: boolean;
        // an explicit preset for a variation SC-VA answers with another tone
        fallback?: boolean;
        zones: BankPresetZone[];
    }[];
}
