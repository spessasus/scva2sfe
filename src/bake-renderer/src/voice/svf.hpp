#pragma once

// The voice filter: a Chamberlin state variable filter at 32 kHz, after the interpolator and the TVA gains.
// SC-VA 1.1.6 x64 runs it on two paths, four lowpass lanes at once or one lane at a time with any tap, and sets it
// up with the voice's playback. Both paths do the same arithmetic per sample, in float32:
//
//   low  = band * f + low
//   high = in - (band * q + low)
//   band = high * f + band
//
// and write low, high, the new band or low - high. f (the frequency coefficient) and q (the damping) change every
// 8 samples: a block has 4 of each (from the cutoff and damping ramps), they do not ramp inside the 8 samples. The
// state is band and low (per group of 4 voices: band[4], low[4]), set to the idle level when the voice starts.

#include <cstdint>

namespace scva {

/**
 * The output tap, the DLL's 2 bits per voice.
 */
enum class SvfTap : std::uint8_t {
    low = 0,
    high = 1,
    band = 2,
    low_less_high = 3, // the "notch": low minus high, a resonant peak
};

class Svf {
public:
    /**
     * What voice_setup_sample_playback puts into its group's tap word (2 bits per lane, the voice's lane is
     * voice & 3) for the voice's filter type word (0x181a71b60), after clearing the lane's own two bits: below
     * 0x1000 the tap from bits 10-11 (0 low, 0x400 band, 0x800 high, 0xc00 low - high) at the lane's place. At
     * 0x1000 or more the DLL shifts its voice number there in place of a tap, so the lane gets voice & 3 and the
     * higher bits of the voice number land in the taps of the group's later lanes (and above them). Checked
     * against the DLL's setup for every word and voice. partial_compute_filter, the one writer of the word,
     * only stores 0, 0x400, 0x800 and 0xc00, so the second case does not happen in the engine as shipped.
     */
    static std::uint32_t tap_bits_of_word(std::uint16_t word, int voice) noexcept;

    /**
     * The voice's own tap out of tap_bits_of_word.
     */
    static SvfTap tap_of_word(std::uint16_t word, int voice) noexcept
    {
        return static_cast<SvfTap>((tap_bits_of_word(word, voice) >> ((voice & 3) * 2)) & 3);
    }

    /**
     * A voice start: both state values at the idle level (1e-5 in the DLL).
     */
    void reset(float idle) noexcept
    {
        band = idle;
        low = idle;
    }

    /**
     * Filters one 32-sample block. `f` and `q` hold the 4 frequency coefficients and dampings of the block, one
     * per 8 samples. `in` and `out` may be the same buffer.
     */
    void render(const float *in, const float *f, const float *q, float *out) noexcept;

    SvfTap tap = SvfTap::low;
    float band = 0.0f; // the DLL's group struct +0x00 + lane * 4
    float low = 0.0f;  // +0x10 + lane * 4
};

} // namespace scva
