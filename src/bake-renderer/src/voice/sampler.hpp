#pragma once

// The sampler: the engine's DPCM stream out of the wave ROM, with its forward loop, the ping-pong walk, the
// reverse walk and the 16.16 playback position, as SC-VA 1.1.6 x64 plays them: the descriptor's registers, the
// playback setup, the forward and reverse stream starts, the loop wraps both ways and the sample fetch of every
// sample format. The state is the DLL's 0x50 byte DPCM state field for field, so it compares directly with the
// DLL's memory.

#include "rom/tables.hpp"

#include <cstdint>
#include <span>

namespace scva {

/**
 * The four per voice wave registers the engine fills from a descriptor record.
 */
struct WaveRegisters {
    std::uint32_t flags = 0; // bits 0..6 the region, bit 11 reverse, bit 12 ping-pong, bit 15 always
    std::uint32_t a = 0;     // forward: the data start. Reverse: the data end
    std::uint32_t b = 0;     // forward: the loop point. Reverse: where the walk wraps
    std::uint32_t c = 0;     // forward: the data end. Reverse: the stop (it also picks the block base)

    static WaveRegisters decode(const std::uint8_t *record) noexcept;
};

/**
 * Sampler state flags (DPCM state +0x48).
 */
enum SamplerFlag : std::uint8_t {
    sampler_running = 0x01,
    sampler_mode_mask = 0x06,  // 0 one-shot, 2 loop, 4 ping-pong
    sampler_loop = 0x02,
    sampler_ping_pong = 0x04,
    sampler_turned = 0x08,     // ping-pong: walking against the start direction
    sampler_loop_event = 0x10, // the read position reached the loop point (cleared after the block)
    sampler_reverse = 0x20,
};

class Sampler {
public:
    /**
     * `scale` is the factor from the 32-bit predictor to a sample and `idle` the level of a sample slot nothing
     * was written to, both read from the DLL.
     */
    Sampler(const Tables &tables, float scale, float idle) noexcept;

    /**
     * voice_setup_sample_playback: points the state at the wave and primes the last four samples.
     */
    void start(const WaveRegisters &reg) noexcept;

    /**
     * Renders one 32-sample block. `ratios` are the 4 playback ratios (16.16) of the block, one per 8 samples.
     * For every sample `emit(index, taps, phase)` gets the last four fetched samples (oldest first) and the
     * 16-bit fraction, as the interpolator reads them, before the position moves on. A sampler that is not
     * running calls nothing and returns false (the DLL fills the block with the idle level).
     */
    template <typename Emit> bool render(const std::int32_t *ratios, Emit &&emit)
    {
        if (!(flags & sampler_running)) {
            return false;
        }
        int index = 0;
        for (int i = 0; i < 4; ++i) {
            const std::int32_t ratio = ratios[i];
            for (int j = 0; j < 8; ++j, ++index) {
                emit(index, static_cast<const float *>(hist), phase);
                const std::int32_t sum = static_cast<std::int32_t>(phase) + ratio;
                phase = static_cast<std::uint16_t>(sum);
                for (std::int32_t n = sum >> 16; n > 0; --n) {
                    step();
                }
            }
        }
        return true;
    }

    /**
     * What voice_report_finished does after a block: takes the loop event (bit 4 of the flags) and clears it.
     * The pitch stage steps to the wave's second fine tune on it.
     */
    bool take_loop_event() noexcept
    {
        const bool hit = flags & sampler_loop_event;
        flags &= static_cast<std::uint8_t>(~sampler_loop_event);
        return hit;
    }

    /**
     * Whether a fetch of the current block raised the engine's event mask (bit 2). The one-shot end raises it
     * without setting the flag bit. Cleared by clear_event().
     */
    bool event() const noexcept { return event_; }
    void clear_event() noexcept { event_ = false; }

    bool running() const noexcept { return flags & sampler_running; }
    float idle() const noexcept { return idle_; }

    // the DPCM state, at the DLL's offsets
    float hist[4]{};              // +0x00 the last four samples, oldest first
    std::uint8_t window[16]{};    // +0x10 the 16 delta bytes around the position
    std::int32_t position = 0;    // +0x28 index of the last fetched sample, from the block base
    std::int32_t loop_point = 0;  // +0x2c
    std::int32_t length = 0;      // +0x30
    std::int32_t predictor = 0;   // +0x40
    std::int16_t scale_index = 0; // +0x44 the scale byte after the one in use
    std::uint16_t phase = 0;      // +0x46
    std::uint8_t flags = 0;       // +0x48
    std::uint8_t nibble = 0;      // +0x49 the scale in use
    std::uint8_t scale_byte = 0;  // +0x4a

private:
    void step() noexcept;
    void fetch_forward() noexcept;
    void fetch_backward() noexcept;
    void wrap_to_loop() noexcept;
    void init_forward(std::int32_t start) noexcept;
    void init_backward(std::int32_t start) noexcept;
    void add(std::int32_t index) noexcept;
    void push() noexcept;
    void load_window(std::int64_t at) noexcept;
    std::uint8_t scale_at(std::int64_t index) const noexcept;

    std::span<const std::uint8_t> bank_a_, bank_b_;
    float scale_, idle_;
    std::span<const std::uint8_t> bank_; // the bank the wave is in
    std::int64_t deltas_ = 0;            // +0x20 as an offset into the bank
    std::int64_t scales_ = 0;            // +0x38 as an offset into the bank
    bool event_ = false;
};

} // namespace scva
