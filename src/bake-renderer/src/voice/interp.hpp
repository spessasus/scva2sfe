#pragma once

// The interpolator: the 4-tap FIR with 128 phases every sample format of SC-VA shares, and the two gain ramps of
// the TVA it multiplies into the sample. The phase's top 7 bits pick a row of 4 coefficients, they multiply the
// last four samples (oldest first), the products are summed in pairs and the pairs summed, then the result is
// multiplied by gain4 * gain16 (multiplied before).
//
// So a sample is ((c0 t0 + c1 t1) + (c2 t2 + c3 t3)) * (gain4 * gain16) in float32, in that order, as SC-VA
// computes it. A build must not contract the products into fused multiply adds (the build files see to it).

#include "voice/sampler.hpp"

#include <algorithm>
#include <array>
#include <cstdint>
#include <span>

namespace scva {

class Interpolator {
public:
    static constexpr int phases = 128;

    /**
     * `table` is the DLL's coefficient table: 128 rows of 4 float32, the row picked by the phase's top 7 bits.
     */
    explicit Interpolator(std::span<const std::uint8_t> table);

    /**
     * One sample from the sampler's last four samples (oldest first) and its 16-bit phase.
     */
    float sample(const float *taps, std::uint16_t phase) const noexcept
    {
        const float *c = coef_.data() + static_cast<std::size_t>(phase >> 9) * 4;
        const float p0 = c[0] * taps[0], p1 = c[1] * taps[1], p2 = c[2] * taps[2], p3 = c[3] * taps[3];
        return (p0 + p1) + (p2 + p3);
    }

    /**
     * One 32-sample block of a voice before its filter, as a block renderer writes it: the sampler steps with
     * the block's 4 playback ratios and every sample is the interpolation times gain4[i / 8] * gain16[i / 2]
     * (the TVA's two ramps, 4 and 16 values per block). A sampler that is not running gives the idle level in
     * every slot, without the gains. Returns whether the sampler ran.
     */
    bool render(Sampler &sampler, const std::int32_t *ratios, const float *gain16, const float *gain4,
                float *out) const
    {
        const bool ran = sampler.render(ratios, [&](int i, const float *taps, std::uint16_t phase) {
            const float gain = gain4[i >> 3] * gain16[i >> 1];
            out[i] = sample(taps, phase) * gain;
        });
        if (!ran) {
            std::fill(out, out + 32, sampler.idle());
        }
        return ran;
    }

private:
    std::array<float, phases * 4> coef_{};
};

} // namespace scva
