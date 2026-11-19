# scva2sfe

The ultimate GS soundfont generator,
brought to you by a million tokens and gallons of water wasted


This essentially converts `SCCore.dll` into a soundfont, as accurately as it can.
It uses SFe because SF2 isn't enough for it to play accurately.

Essentially the sound canvas version of [syxg2sfe](https://github.com/spessasus/syxg2sfe).

Currently, you can use SFe with:
- [SpessaSynth](https://spessasus.github.io/SpessaSynth)
- [SpessaFont](https://spessasus.github.io/SpessaFont) - This one can convert to SF2, but it will break many things, including the filter.

Note that you need your own copy of SOUND Canvas VA. This repository does not ship it.

This is vibecoded.
The text below is written by AI too.
The SFe format, DMOD and the library that writes the banks are by me,
the rest is AI slop `¯\_(ツ)_/¯`

## Requirements

- Node.js **26** and npm, on Windows, Linux or macOS. Node.js 26 is the version the converter is tested with
  (`engines` in `package.json`). The converter is TypeScript, the small engine renderer it uses for some voices is
  WebAssembly built from `src/bake-renderer`.
- spessasynth_core **4.4.11** or newer, the first release with SFe 4. `npm ci` installs it.
- To build it: git and [Emscripten](https://emscripten.org) **6.0.13** (the emsdk) for the WebAssembly.
- ffmpeg with libvorbis, only for the Ogg Vorbis bank (`--vorbis`).
- `SCCore.dll` from SOUND Canvas VA **1.1.6, x64**. Other versions are refused by their hash:

| File         | Version                    | sha256                                                             |
|--------------|----------------------------|--------------------------------------------------------------------|
| `SCCore.dll` | SOUND Canvas VA 1.1.6, x64 | `117e6aa147a96fbde5e10d2caf16c89965acc1e44235fd245992216cc620bdb1` |

The banks are SFe 4 files and need spessasynth_core 4.4.11 or newer to play right. They use its custom modulator
curves, its extra generators and its alternating loops (see [Why SFe and not SF2](#why-sfe-and-not-sf2)). An older
player ignores what it does not know, so pitch envelopes, second decays, filter types, LFO shapes, the drum sends and
the controller responses play wrong there.

## Building from source

The bake renderer's WebAssembly (`build/bake-renderer/sbr.wasm`) is built from `src/bake-renderer` with Emscripten
6.0.13, the version its bit checks ran on (the build scripts refuse another unless `SCVA_EMSDK_ANY=1`). It is not in
the repository:

```sh
git clone https://github.com/emscripten-core/emsdk && cd emsdk
./emsdk install 6.0.13 && ./emsdk activate 6.0.13      # emsdk.bat on Windows
cd ..
```

Then, with `em++` on `PATH` or `SCVA_EMSDK` set to the emsdk folder:

```sh
git clone https://github.com/spessasus/scva2sfe && cd scva2sfe
npm ci                    # spessasynth_core 4.4.11 and the build tools
npm run build:wasm        # tools/build-bake-renderer.sh, or tools\build-bake-renderer.cmd on Windows
npm run build:dist        # the compiled converter in dist/, with sbr.wasm next to it
```

`npm run build` type checks everything, the library (`src/lib`, `src/rules`) also against browser APIs alone, so it
stays free of Node APIs. `.github/workflows/pr-checks.yml` runs the same build in GitHub Actions.

## Usage

```sh
node bin/scva2sfe.mjs "/path/to/SOUND Canvas VA/SCCore.dll" --out out --maps --vorbis
```

Options:

- `--out <dir>`: where the banks go (default `out`).
- `--maps`: also one bank per map, cut out of the full bank.
- `--full-maps`: also the full bank with each other map on bank LSB 0 (`scva-v7-88-full.sf4`, `scva-v7-88pro-full.sf4`,
  `scva-v7-8820-full.sf4`), from the same conversion.
- `--vorbis`: also a bank with the longer samples as Ogg Vorbis (needs ffmpeg).
- `--jobs <n>`: worker threads (default: one per core, at most 16 and at most one per GB of memory, since each
  worker holds its own copy of the DLL and the engine renderer's memory).
- `--cache-dir <dir>`: where the solve cache goes (default: your user cache folder, `%LOCALAPPDATA%\scva2sfe\cache`,
  `~/Library/Caches/scva2sfe` or `~/.cache/scva2sfe`).
- `--no-cache`: neither read nor write the solve cache.

Any other option is refused with the usage text.

The drum key name lists `SCVSC.drk` and `GM2.drk` from the SOUND Canvas VA install are optional. When they sit next
to `SCCore.dll`, the drum keys get SOUND Canvas VA's names ("Closed Hi-Hat 2"). Without them a key is named after its
tone in the DLL ("Close HiHat2").

This writes `scva-v7.sf4` (exact 16-bit samples, every map on its bank LSB and SC-55 on LSB 0), with `--vorbis` also
`scva-v7-vorbis.sf4`, with `--maps` one bank per map: `scva-v7-55.sf4`, `scva-v7-88.sf4`, `scva-v7-88pro.sf4` and
`scva-v7-8820.sf4`, each with its map on bank LSB 0 and the GM2 kits, and with `--full-maps` the three full banks with
SC-88, SC-88Pro or SC-8820 on LSB 0. Two conversions of the same DLL write the same bytes. Every bank stays under
205,000,000 bytes: a file over that cap is still written, but the run reports it and exits with an error.

The first conversion takes about 4 to 7 minutes on 16 threads, longer on fewer cores: most of it fits every zone's
envelopes and filter to the engine's curves. The results go into the solve cache on your machine (about 35 MB, keyed
on the DLL's hash, the converter's build and the Node.js JavaScript engine's version), so a later conversion takes
about 30 s for the main bank and about 80 s for all nine files, and writes the same bytes. The cache only ever holds
what your own DLL gave, and a new converter build replaces it. The cache is optional: if it cannot be written, the
conversion says so and goes on without it.

## In the browser

`web/` is the same converter as a static page ("Sound Canvas VA to SFe converter"): pick `SCCore.dll` and the
optional `.drk` files, choose the banks and download them. Everything runs in the browser, the files are never
uploaded. The zones run on Web Workers (one per thread, at most 16, about 350 MB each, fewer can be set on the page),
the solve cache sits in the browser's IndexedDB (the page can clear it), and a conversion writes the same bytes
whatever the number of workers and whether the cache was used. In Firefox on 16 threads the first conversion takes
about 5 minutes and a cached one about 25 s for the main bank and about 60 s for all eight. Firefox then holds about
7 GB during the zones and up to about 10 GB once all eight banks are written, since every finished bank stays in
memory until the page is closed. The fits take their numbers from the JavaScript engine's Math functions, so the bytes can only
match the command line's on the same engine as Node.js (V8, in Chrome and Edge). Firefox rounds `Math.sin`, `Math.cos`,
`Math.log10` and `Math.hypot` differently in the last bit, so its banks differ slightly from the command line's. The
Ogg Vorbis bank is not offered there: browsers have no Vorbis encoder that writes the same bank.

```sh
npm run build:wasm
npm run build:web         # the site in build/web
npm run serve:web         # http://localhost:8080 (workers need http, not file://)
```

`.github/workflows/pages.yml` builds the site from source and deploys it to GitHub Pages.

## How it works

The conversion reads the voice data from the DLL and translates it with fixed rules: the envelopes, filters and pitch
envelopes are fitted to the engine's own curves, computed from the DLL's bytes. A listed set of voices that SFe cannot
express (a moving highpass, a pitch envelope with several turns) is rendered by the engine renderer and played from
that render.

## The bank

| Sound | Bank MSB | Bank LSB | Program |
| --- | --- | --- | --- |
| Tones of the SC-55, SC-88, SC-88Pro and SC-8820 maps | GS variation | 1, 2, 3, 4 | GS program |
| Tones of the SC-55 map (a `-full` bank: its own map) | GS variation | 0 | GS program |
| Drum kits of each map | 0 | 1 to 4, and 0 for the SC-55 map (a `-full` bank: its own map) | kit program |
| GM2 drum kits | 120 | 0 | kit program |

A missing variation plays its map's capital tone, as in SOUND Canvas VA. Where the module answers with another tone,
the bank has its own preset for it, so the bank plays what the module plays. The SC-55 kits cut a retriggered drum
key: that is the hardware's default, SOUND Canvas VA itself does not cut.

What the bank carries from the engine: the samples with their exact loops, the key and velocity zones, tuning, the
volume, pitch and filter envelopes with their key and velocity follow, the filter (cutoff and resonance, the highpass,
bandpass and peaking types), both LFOs, the velocity curves, pan, the drum kits' levels, pitches, pans, exclusive
groups and reverb, chorus and delay sends, and the response to the mod wheel, the vibrato controllers (CC76 to CC78),
the filter controllers (CC74, CC71) and the envelope controllers (CC72, CC73, CC75). The levels follow the engine's
own level chain.

Known limits: the LFO shapes SFe has no shape for play as triangles. Those are the random shapes (sample and hold,
random walk: about 480 partials with a depth, mostly on LFO2), the wave bank shapes (8 and up, about 50 partials) and
the offset triangle (shape 7, two partials, neither with a depth). Sine, square, sawtooth and triangle play as
themselves. Random tones play one fixed draw, a kit key with random pan plays centred, and the two SC-8820 per key
voices TeeBee and Jazz Scat are left out.

### Why SFe and not SF2

Plain SF2 cannot hold this bank:

- **Bank numbers.** An SF2 preset has one bank number. GS addresses tones by bank MSB (the variation) and bank LSB
  (the map: SC-55, SC-88, SC-88Pro, SC-8820), and the bank uses 54 MSB values on 5 LSB values, plus the GM2 kits on
  MSB 120. SFe's bank field carries MSB, LSB and the drum flag, so every GS bank maps 1:1.
- **Size limits.** SF2 counts zones, generators and modulators with 16-bit indexes (65,536 each). The main bank has
  89,311 zones, 1,457,124 generators and 649,637 modulators. SFe extends the indexes.
- **Default modulators.** SF2's default modulators are fixed. SOUND Canvas VA differs (the mod wheel's vibrato depth,
  resonance, the velocity to level response, the envelope controllers), so the bank brings its own list.
- **Modulator curves.** SF2 has four curve shapes. The engine's responses follow its own tables: CC74 and CC71 on the
  cutoff through its warp and ceiling, the vibrato controllers CC76 to CC78, velocity on level, cutoff and envelope
  times, and the key follow of every envelope. The bank draws them as 35,150 custom curves, every one of them used.
- **Generators SF2 lacks.** A SOUND Canvas partial does more than the SF2 synthesis model, and SFe adds generators
  for it (counts are instrument zones of the main bank):
  - a second modulation envelope, so the pitch envelope gets its own (33,698 zones),
  - a second decay segment, SC envelopes decay to one level, then to another at their own rate (59,766 zones),
  - LFO fade-in, start phase and the sine, square and sawtooth shapes (sine vibrato in 58,537 zones),
  - a cutoff ceiling and a resonance offset, the engine's filter does not open past its ceiling (41,047 zones),
  - filter types beyond lowpass: highpass (1,801 zones), bandpass (963) and peaking (244),
  - ignoring note-off, which drum keys without a release do (6,788 zones),
  - a delayed voice start (563 zones) and a gain that can boost (1,538 zones).
- **Alternating loops.** SC ping-pong waves loop forward and back. SFe plays them as alternating loops (4,481 zones),
  SF2 would need every such wave doubled in the sample data.
- **Drum sends.** A drum key carries its kit's own reverb, chorus and delay depths as per-key send modulators
  (16,444 of them). The delay send is an SFe 4 generator, SF2 has none.

### What SFe still can not express

- The engine's filter is a state variable filter, SFe's is a biquad. A generic map turns one into the other, and a
  partial whose filter moves in a way the map can not follow (a moving highpass, a ringing click) is played from a
  render of the engine instead: 689 rendered key spans, about 104 MB of the bank.
- Pitch envelopes with several turns and the LFO shapes SFe has no shape for (the random ones, the wave bank shapes)
  are covered the same way or play as triangles, see the known limits above.
- Random tones play one fixed draw.

## Special thanks

- [Tabula Sonora](https://github.com/TabulaSonora/spec) - for the SOUND Canvas VA specification the voice decoding
  builds on (BSD 3-Clause, see [NOTICE.md](NOTICE.md))
- [NativeTS](https://github.com/TabulaSonora/NativeTS) - for the C++ engine parts of the converter and the engine
  renderer are adapted from (BSD 3-Clause, see [NOTICE.md](NOTICE.md) and [LICENSE.NativeTS](LICENSE.NativeTS))
- [88emu](https://theusualsuspects.io) by The Usual Suspects - for the Sound Canvas hardware emulator, used as a
  sanity check
- [Ghidra](https://github.com/NationalSecurityAgency/ghidra) - for the binary analysis tools
- [Emscripten](https://emscripten.org) - for the WebAssembly toolchain the engine renderer is built with
- [Wine](https://www.winehq.org) - for running SOUND Canvas VA on Linux, to compare the banks with it
- [FFmpeg](https://ffmpeg.org) - for the Ogg Vorbis encoding

## License

The converter is licensed under the Apache License 2.0, see [LICENSE](LICENSE).

## Legal notice

This project is not affiliated with, endorsed by or connected to Roland Corporation. Roland, SOUND Canvas and
GS are trademarks of Roland Corporation, used here only to describe what the converter works with.

This repository contains no Roland software, samples, wave ROM data or tone parameters, and it distributes no
sound banks and no samples. Everything the converter produces is extracted from the `SCCore.dll` you supply.

Only use it with a copy of SOUND Canvas VA that you obtained legally, and within the terms of the license that
came with it. The banks it writes contain Roland's samples and tone data from your copy: they are for your own
use, do not share or redistribute them.
