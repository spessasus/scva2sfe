#pragma once

// The wave ROM and its descriptors. Adapted from NativeTS src/rom/wave_rom.cpp and
// include/tabulasonora/wave_descriptor.hpp (BSD 3-Clause, see NOTICE.md). The sampler streams from it.

#include "rom/tables.hpp"

#include <algorithm>
#include <cstdint>
#include <span>

namespace scva {

/**
 * A wave descriptor (stride 0x16). Tabula Sonora's field names: `loop` is the data
 * start, `end` the loop point, `start` the data end, all 20-bit offsets into the wave's 1 MB region.
 */
struct WaveDescriptor {
    static constexpr int stride = 0x16;

    int region = 0;
    int loop = 0;
    int end = 0;
    int start = 0;
    int root_key = 0;
    int fine_tune = 0;
    int fine_tune2 = 1024;
    int flags = 0; // bit 0 ping-pong, bit 1 loop, bit 2 reverse

    static WaveDescriptor parse(const std::uint8_t *r) noexcept
    {
        const auto p20 = [r](int o) { return (r[o] & 15) << 16 | r[o + 1] << 8 | r[o + 2]; };
        WaveDescriptor d;
        d.region = r[0] & 0x7F;
        d.loop = p20(1);
        d.end = p20(7);
        d.start = p20(0x0B);
        d.root_key = r[6];
        d.fine_tune = r[4] | r[5] << 8;
        d.fine_tune2 = r[0x0E] | r[0x0F] << 8;
        d.flags = r[0x0A];
        return d;
    }
};

class WaveRom {
public:
    static constexpr std::int64_t region_size = 0x100000;

    explicit WaveRom(const Tables &tables) : bank_a_(tables.wave_rom_a), bank_b_(tables.wave_rom_b) {}

    /**
     * The bytes of a region: regions 0..15 sit in bank A, 16..23 in bank B, 1 MB each
     * (voice_setup_sample_playback, `(key & 0x7f) * 0x100000 | offset + base`).
     */
    std::span<const std::uint8_t> region(int region) const
    {
        const int bank = (region >> 4) & 1;
        const std::span<const std::uint8_t> b = bank ? bank_b_ : bank_a_;
        const std::int64_t at = (region - 16 * bank) * region_size;
        const std::int64_t n = std::min<std::int64_t>(region_size, static_cast<std::int64_t>(b.size()) - at);
        return n > 0 ? b.subspan(static_cast<std::size_t>(at), static_cast<std::size_t>(n))
                     : std::span<const std::uint8_t>{};
    }

private:
    std::span<const std::uint8_t> bank_a_, bank_b_;
};

} // namespace scva
