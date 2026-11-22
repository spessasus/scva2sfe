/**
 * The SFe writer as a library: the bank model and its audio in, the bank file out (spessasynth_core's writeSFe). No
 * file system: the CLI (or a web page) reads and writes the files.
 */
import {
    BasicInstrument,
    BasicPreset,
    BasicSample,
    BasicSoundBank,
    CustomCurve,
    GeneratorTypes,
    Modulator,
    ModulatorControllerSources,
    ModulatorCurveTypes,
    ModulatorSource,
    SampleTypes,
    SoundBankLoader
} from "spessasynth_core";
import type { BasicZone, GeneratorType, ModulatorCurveType, ModulatorSourceIndex } from "spessasynth_core";
import type { Bank, BankModulator, BankSource } from "./bank.js";
import { DEPTH_RANGE_SCALE } from "./lfo.js";
import { pruneFallbacks } from "./prune.js";

/**
 * The size cap of one bank file in bytes (decimal 300 MB, the user's limit since 2026-11-22: exact controller curves
 * and the CC75 fits took the full banks past the old 205 MB). The bake plan's budget was set for 200 MB.
 * The hosts check every file they write against it.
 */
export const BANK_CAP = 300_000_000;

/**
 * Encodes one sample's mono float audio to an Ogg Vorbis stream (the CLI passes ffmpeg's libvorbis).
 */
export type VorbisEncoder = (data: Float32Array, sampleRate: number) => Promise<Uint8Array>;

export interface WriteOptions {
    log?: (line: string) => void;
    /**
     * The bank's creation date (default a fixed one, so that two conversions write the same bytes).
     */
    creationDate?: Date;
}

/**
 * Builds the core sound bank from the bank model. audio: the float32 files the samples point into (samples.f32
 * unless a sample names its own file).
 */
export function buildSoundBank(bank: Bank, audio: Record<string, Float32Array>, options: WriteOptions = {}) {
    const log = options.log ?? (() => undefined);
    const audioFile = (name: string) => {
        const a = audio[name];
        if (!a) throw new Error(`no audio for ${name}`);
        return a;
    };
    const soundBank = new BasicSoundBank("sfe");
    // The default modulators as SC-VA answers them (measured): the mod wheel gives 47 cents of LFO1
    // vibrato at 127 (core: 50), channel pressure does nothing by default (core: 50 cents of vibrato). The wheel plays
    // on the modulation LFO: in the engine it skips LFO1's delay and fade, which the zones give core's vibrato LFO, so
    // the zones set the modulation LFO to LFO1's rate (or move the wheel back where LFO2 needs it)
    const isWheel = (m: Modulator) =>
        m.primarySource.isCC && m.primarySource.index === 1 && m.destination === GeneratorTypes.vibLfoToPitch;
    const wheel = soundBank.defaultModulators.find(isWheel);
    if (!wheel) throw new Error("core's default modulators have no mod wheel vibrato");
    // the wheel follows the Modulation Depth Range (RPN 5, GS MOD LFO1 PITCH DEPTH): full at 16 semitones, so the
    // default 50 cents reads as 1/32 and the amounts are 32 times the cents at that default
    if (wheel.secondarySource.isCC || wheel.secondarySource.index !== ModulatorControllerSources.modulationDepthRange) {
        throw new Error("core's mod wheel default has no Modulation Depth Range amount source");
    }
    soundBank.defaultModulators = soundBank.defaultModulators.filter(
        (m) =>
            !isWheel(m) &&
            !(
                !m.primarySource.isCC &&
                m.primarySource.index === ModulatorControllerSources.channelPressure &&
                m.destination === GeneratorTypes.vibLfoToPitch
            )
    );
    soundBank.defaultModulators = [
        ...soundBank.defaultModulators,
        new Modulator(
            ModulatorSource.copyFrom(wheel.primarySource),
            ModulatorSource.copyFrom(wheel.secondarySource),
            GeneratorTypes.modLfoToPitch,
            (bank.wheel_cents ?? 47) * DEPTH_RANGE_SCALE,
            0
        )
    ];
    // CC71 keeps core's default (SFe 7.3): filterQOffset above 64, which moves the Q and not the level, like the SVF

    // Velocity -> attenuation is a custom curve per zone (the measured level per velocity), which does not replace the
    // default by identity, so the default goes and the zones without a measured curve carry it themselves.
    // The envelope time defaults on CC72 / CC73 / CC75 have a CC switch secondary source since core 4.4.10, so the
    // zones' own envelope controller modulators no longer replace them either: they go too
    const isVelocityLevel = (m: Modulator) =>
        !m.primarySource.isCC &&
        m.primarySource.index === ModulatorControllerSources.noteOnVelocity &&
        m.destination === GeneratorTypes.initialAttenuation;
    const envelopeTimes = new Set<GeneratorType>([
        GeneratorTypes.attackVolEnv,
        GeneratorTypes.holdVolEnv,
        GeneratorTypes.decayVolEnv,
        GeneratorTypes.releaseVolEnv
    ]);
    const isEnvelopeCC = (m: Modulator) =>
        m.primarySource.isCC && [72, 73, 75].includes(m.primarySource.index) && envelopeTimes.has(m.destination);
    soundBank.defaultModulators = soundBank.defaultModulators.filter((m) => !isVelocityLevel(m) && !isEnvelopeCC(m));
    // the bank's copies of core's envelope time curves served only those defaults
    for (const curve of [...soundBank.customCurves]) {
        if (curve.useCount === 0) soundBank.deleteCustomCurve(curve);
    }
    soundBank.soundBankInfo.name = bank.name;
    soundBank.soundBankInfo.engineer = "scva2sfe";
    soundBank.soundBankInfo.creationDate = options.creationDate ?? new Date(Date.UTC(2026, 0, 1));

    /**
     * The engine's interpolation lowpass on a sample (a zero phase FIR). Inside the loop the
     * taps wrap around it, so the loop stays seamless in its steady state. Elsewhere they read the sample's neighbours,
     * with silence before the start and the loop after the end. An alternating loop reflects on its two turn points
     * instead: a symmetric FIR of the triangle played back is the triangle of the filtered data.
     */
    function interpolationFilter(
        x: Float32Array,
        taps: number[],
        loopStart: number,
        loopEnd: number,
        alternate = false
    ) {
        const half = (taps.length - 1) / 2;
        const length = loopEnd - loopStart;
        const looped = length > 0;
        // the alternating loop's round trip, each turn point once
        const period = 2 * (length - 1);
        const wrap = alternate
            ? (j: number) => {
                  const m = (((j - loopStart) % period) + period) % period;
                  return loopStart + (m > length - 1 ? period - m : m);
              }
            : (j: number) => loopStart + ((((j - loopStart) % length) + length) % length);
        const y = new Float32Array(x.length);
        for (let i = 0; i < x.length; i++) {
            const inLoop = looped && i >= loopStart && i < loopEnd;
            let acc = 0;
            for (let k = -half; k <= half; k++) {
                let j = i + k;
                if (inLoop && (j < loopStart || j >= loopEnd)) j = wrap(j);
                else if (j >= x.length) {
                    if (!looped) continue;
                    j = wrap(j);
                } else if (j < 0) continue;
                acc += taps[k + half] * x[j];
            }
            y[i] = acc;
        }
        return y;
    }

    const samples = bank.samples.map((s) => {
        // leading silence for core's first block fade in to run over (the zones skip what they do not need)
        const pad = s.pad ?? 0;
        // The tuning is all in the zones (several waves with different roots share one sample)
        const sample = new BasicSample(
            s.name,
            bank.sample_rate,
            60,
            0,
            SampleTypes.monoSample,
            s.loop_start + pad,
            s.loop_end + pad
        );
        const raw = audioFile(s.file ?? "samples.f32").slice(s.offset, s.offset + s.length);
        // a loop from data index 0 turns on the sample of padding before it, filtered from the data alone
        const alternate = s.mode === "alternate";
        const loopStart = Math.max(0, s.loop_start);
        const smooth =
            bank.sample_fir && !s.baked
                ? interpolationFilter(raw, bank.sample_fir, loopStart, s.loop_end, alternate)
                : raw;
        const filtered = s.fir ? interpolationFilter(smooth, s.fir, loopStart, s.loop_end, alternate) : smooth;
        const gain = s.gain ?? bank.sample_gain;
        const data = new Float32Array(pad + filtered.length);
        for (let i = 0; i < filtered.length; i++) data[pad + i] = filtered[i] * gain;
        sample.setAudioData(data, bank.sample_rate);
        return sample;
    });

    /**
     * Sets a generator without the spec range validation.
     */
    // Generators core renamed (SFe 4.0 after sfe-rework-3: 66 / 67 follow the SF2 "LfoToVolume" naming): the bank uses
    // the new names, a core with the old ones still builds
    const RENAMED: Record<string, string> = {
        modLfoToAmplitude: "modLfoAmplitudeDepth",
        vibLfoToAmplitude: "vibLfoAmplitudeDepth"
    };
    const generatorType = (name: string) =>
        (GeneratorTypes as Record<string, GeneratorType>)[name] ??
        (GeneratorTypes as Record<string, GeneratorType>)[RENAMED[name] ?? ""];

    function gen(zone: BasicZone, name: string, value: number) {
        const type = generatorType(name);
        if (type === undefined) throw new Error(`unknown generator ${name}`);
        zone.setGenerator(type, Math.round(value), false);
    }

    // the SFe custom curves, one per distinct point list
    const customCurves = new Map<string, CustomCurve>();

    /**
     * A modulator source from bank.json: velocity, the key number, a MIDI controller or none (a constant, core reads
     * the missing controller as 1).
     */
    function modulatorSource(m: BankSource) {
        const curves: Record<Exclude<BankSource["curve"], "custom">, ModulatorCurveType> = {
            linear: ModulatorCurveTypes.linear,
            concave: ModulatorCurveTypes.concave,
            convex: ModulatorCurveTypes.convex,
            switch: ModulatorCurveTypes.switch
        };
        const source = new ModulatorSource();
        if (m.source === "cc") {
            if (m.cc === undefined) throw new Error("cc modulator without a controller number");
            source.index = m.cc as ModulatorSourceIndex;
            source.isCC = true;
        } else {
            source.index =
                m.source === "none"
                    ? ModulatorControllerSources.noController
                    : m.source === "key"
                      ? ModulatorControllerSources.noteOnKeyNum
                      : m.source === "depthRange"
                        ? ModulatorControllerSources.modulationDepthRange
                        : ModulatorControllerSources.noteOnVelocity;
            source.isCC = false;
        }
        if (m.curve === "custom") {
            // one shared curve per distinct point list
            if (!m.points) throw new Error("custom curve without points");
            const key = JSON.stringify(m.points);
            let curve = customCurves.get(key);
            if (!curve) {
                curve = new CustomCurve(
                    m.points.map(([x, y]) => ({ x, y })),
                    `c${customCurves.size}`
                );
                customCurves.set(key, curve);
            }
            source.curve = curve;
        } else {
            source.curveType = curves[m.curve];
        }
        source.isBipolar = m.bipolar;
        source.isNegative = m.negative;
        return source;
    }

    /**
     * A zone modulator from bank.json, with an optional secondary source (none when missing).
     */
    function modulator(m: BankModulator) {
        const destination = generatorType(m.dest);
        if (destination === undefined) throw new Error(`unknown modulator destination ${m.dest}`);
        const secondary = m.secondary ? modulatorSource(m.secondary) : new ModulatorSource();
        return new Modulator(modulatorSource(m), secondary, destination, m.amount, 0);
    }

    const used = new Set<BasicSample>();
    const instruments = bank.instruments.map((i) => {
        const instrument = new BasicInstrument();
        instrument.name = i.name;
        for (const z of i.zones) {
            const sample = samples[z.sample];
            used.add(sample);
            const zone = instrument.createZone(sample);
            zone.keyRange = { min: z.key_lo, max: z.key_hi };
            zone.velRange = { min: z.vel_lo, max: z.vel_hi };
            for (const [name, value] of Object.entries(z.gens)) gen(zone, name, value);
            for (const m of z.mods ?? []) zone.addModulators(modulator(bank.modulators[m]));
        }
        // the zones of one instrument mostly share their controller modulators, they go to the global zone once
        instrument.globalize();
        return instrument;
    });

    const usedSamples = samples.filter((s) => used.has(s));
    for (let i = 0; i < usedSamples.length; i += 1000) soundBank.addSamples(...usedSamples.slice(i, i + 1000));
    for (let i = 0; i < instruments.length; i += 1000) soundBank.addInstruments(...instruments.slice(i, i + 1000));
    // in chunks: a spread of tens of thousands of arguments overflows the stack
    const curveList = [...customCurves.values()];
    for (let i = 0; i < curveList.length; i += 1000) soundBank.addCustomCurves(...curveList.slice(i, i + 1000));
    log(`${customCurves.size} custom curves`);
    const fallbacks = new Set<BasicPreset>();
    for (const p of bank.presets) {
        const preset = new BasicPreset(soundBank);
        if (p.fallback) fallbacks.add(preset);
        preset.name = p.name;
        preset.program = p.program;
        preset.bankMSB = p.bank_msb;
        preset.bankLSB = p.bank_lsb;
        preset.isGMGSDrum = p.drum;
        for (const z of p.zones) {
            const zone = preset.createZone(instruments[z.instrument]);
            if (z.key_lo !== undefined && z.key_hi !== undefined) {
                zone.keyRange = { min: z.key_lo, max: z.key_hi };
            }
        }
        soundBank.addPresets(preset);
    }
    // fallback presets that core's own fallback already answers with the same tone
    const maps = [1, 2, 3, 4].map((lsb) => (p: BasicPreset) => p.bankLSB === lsb);
    const pruned = pruneFallbacks(soundBank, fallbacks, maps);

    log(`${used.size} samples, ${instruments.length} instruments, ${soundBank.presets.length} presets (${pruned} duplicates dropped)`);
    return { soundBank, pruned };
}

/**
 * Builds the core sound bank from the bank model and writes it as SFe (32-bit RIFF sizes).
 */
export function writeBank(bank: Bank, audio: Record<string, Float32Array>, options: WriteOptions = {}) {
    const { soundBank } = buildSoundBank(bank, audio, options);
    return soundBank.writeSFe({ rf64: false });
}

/**
 * The Vorbis copy of a written bank: samples of a quarter second or longer compressed (the short ones are mostly
 * single cycle loops, where the codec would smear the loop and save almost nothing), parallel batches.
 */
export async function writeVorbisBank(data: ArrayBuffer, encode: VorbisEncoder, batch = 8, options: WriteOptions = {}) {
    const soundBank = SoundBankLoader.fromArrayBuffer(data.slice(0));
    const minSeconds = 0.25;
    const long = soundBank.samples.filter((s) => s.getAudioData().length >= minSeconds * s.sampleRate);
    for (let i = 0; i < long.length; i += batch) {
        const part = long.slice(i, i + batch);
        const encoded = await Promise.all(part.map((s) => encode(s.getAudioData(), s.sampleRate)));
        part.forEach((s, j) => s.setCompressedData(encoded[j]));
    }
    // The writer keeps one byte offset for all samples and starts a PCM sample at offset / 2: after an Ogg stream of
    // odd length a PCM sample would read one byte shifted, so every PCM sample goes first (syxg2sfe found this)
    soundBank.samples.sort((a, b) => Number(a.isCompressed) - Number(b.isCompressed));
    (options.log ?? (() => undefined))(`${long.length} of ${soundBank.samples.length} samples compressed`);
    return soundBank.writeSFe({ rf64: false });
}

export const MAP_BANKS = [
    { lsb: 1, name: "55" },
    { lsb: 2, name: "88" },
    { lsb: 3, name: "88pro" },
    { lsb: 4, name: "8820" }
];

/**
 * One bank per map cut out of the full bank: that map's tones and kits moved to bank LSB 0
 * (the other maps and the full bank's LSB 0 copies dropped), the GM2 kits kept, unused instruments and samples
 * removed.
 */
export function extractMap(data: ArrayBuffer, map: { lsb: number; name: string }, options: WriteOptions = {}) {
    const bank = SoundBankLoader.fromArrayBuffer(data.slice(0));
    for (const preset of [...bank.presets]) {
        if (preset.isGMGSDrum && preset.bankMSB === 120) continue;
        if (preset.bankLSB === map.lsb) preset.bankLSB = 0;
        else bank.deletePreset(preset);
    }
    // with one map left, core's fallback answers most variation banks with the same tone by itself
    const pruned = pruneFallbacks(bank);
    bank.removeUnusedElements();
    bank.soundBankInfo.name = `${bank.soundBankInfo.name} (${map.name})`;
    bank.flush();
    (options.log ?? (() => undefined))(`scva-${map.name}: ${bank.samples.length} samples, ${bank.instruments.length} instruments, ${bank.presets.length} presets (${pruned} duplicates dropped)`);
    return bank.writeSFe({ rf64: false });
}
