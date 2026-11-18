# Notice

scva2sfe is licensed under the Apache License 2.0 (`LICENSE`). Parts of it are adapted from two projects of Tabula
Sonora, both under the BSD 3-Clause License, Copyright (c) 2026 Kevin López Brante (the license text is in
`LICENSE.NativeTS`, it is the same for both):

- Tabula Sonora, the SOUND Canvas VA specification (https://github.com/TabulaSonora/spec, commit ac212f7): the
  table offsets and names, the record layouts, the wave format and its descriptor fields.
- NativeTS, the C++ engine of the Tabula Sonora project (https://github.com/TabulaSonora/NativeTS, commit 0219297).

## The converter (`src/lib`)

| here | adapted from |
|---|---|
| `src/lib/dll.ts` | the table offsets and record layouts of Tabula Sonora and NativeTS (`assets/manifest.json`) |
| `src/lib/directory.ts` | NativeTS `src/patches/patch_directory.cpp`, `src/patches/drum_kit_table.cpp` and Tabula Sonora's directory description |
| `src/lib/rom.ts` | the wave ROM decoding of Tabula Sonora and NativeTS `src/rom/wave_rom.cpp` |
| `src/lib/pitch.ts` | NativeTS `PitchChain` (the static pitch) |
| `src/lib/pitch-env.ts` | NativeTS `PitchChain` (the pitch envelope) and `EnvelopeMachine` |
| `src/lib/tva.ts` | NativeTS `TvaChain` and `EnvelopeMachine` |
| `src/lib/tvf.ts` | NativeTS `TvfChain` and `EnvelopeMachine` |
| `src/lib/lfo.ts` | NativeTS `LfoEngine::configure` and `LfoRunner::tick` |
| `src/lib/controllers.ts` | NativeTS `EnvelopeMachine::segment_milliseconds` (a segment's length) |

These were checked against SOUND Canvas VA's own output and changed where it plays otherwise. The SFe side (the fits,
the generators, the modulators, the writer) is scva2sfe's own.

## The bake renderer (`src/bake-renderer`)

The bake renderer is written for scva2sfe: what one voice of a bake needs, with its own C API (`include/sbr.h`) and
loader (`index.ts`). Parts of it are adapted from NativeTS:

| here | adapted from NativeTS |
|---|---|
| `src/rom/rom.*` | `src/rom/rom_image.cpp` (reading SCCore.dll as a data file, one build only) |
| `src/rom/tables.*` | `assets/manifest.json` (the table offsets and names), `src/rom/table_set.cpp` |
| `src/rom/wave_rom.hpp` | `src/rom/wave_rom.cpp`, `include/tabulasonora/wave_descriptor.hpp` |
| `src/patch/directory.*` | `src/patches/patch_directory.cpp`, `src/patches/drum_kit_table.cpp`, the velocity window of `src/dsp/tva_chain.cpp` |

The key follow and the zone select in `src/patch/directory.cpp` follow Tabula Sonora and NativeTS, corrected where
SOUND Canvas VA picks another zone. The sampler (`src/voice/sampler.*`) is not taken from NativeTS: NativeTS decodes a
wave into a buffer and resamples it, the renderer streams the DPCM state as SOUND Canvas VA does. What it shares with
NativeTS and Tabula Sonora is the knowledge of the wave format (block floating point deltas, the scale nibbles, the
descriptor fields). The interpolator (`src/voice/interp.*`) and the state variable filter (`src/voice/svf.*`) are not
taken from NativeTS either: NativeTS's versions compute the same recurrences in another order and in double
precision, the renderer keeps SOUND Canvas VA's float32 operations one by one. NativeTS's effects, MIDI file front
end, sample rate converter and SoundFont exporter are not used.

## Roland's data

None of Roland's data is part of this repository. The converter and the renderer read every table from the user's
own `SCCore.dll` (SOUND Canvas VA 1.1.6 x64) at run time. The offsets in the source say where those tables are, they
hold none of their bytes.

## The bake renderer's float semantics

A bake has to come out bit-identical to SOUND Canvas VA's render, so the build (`src/bake-renderer/build.rsp`) keeps
float32 arithmetic in the order the source gives: no `-ffast-math`, no contraction (`-ffp-contract=off`, and
WebAssembly has no scalar fused multiply add anyway), no SIMD. WebAssembly keeps denormals, as SOUND Canvas VA does
(it runs with the default MXCSR). Float to integer conversions use the checked form (`-mno-nontrapping-fptoint`),
which gives x86's 0x80000000 for a signed conversion out of range (and NaN) where the saturating form would clamp.
