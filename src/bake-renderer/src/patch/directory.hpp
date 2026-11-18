#pragma once

// Patch resolution: program, bank and map to a tone, drum kits and keys to tones, and a played note to the
// multisample zone and wave of each partial. The directory chain and the drum tables are adapted from NativeTS
// src/patches (patch_directory.cpp, drum_kit_table.cpp, BSD 3-Clause, see NOTICE.md). The key follow and the zone
// select take the path SC-VA takes for the ROM's tones, checked against its sampler: the pivot is key 60 and an
// empty zone is silent (SC-VA borrows no neighbouring zone there). The velocity window level is NativeTS
// TvaChain::partial_level.

#include "rom/tables.hpp"
#include "scva/engine.h"

#include <cstdint>
#include <optional>
#include <string>

namespace scva {

class Directory {
public:
    static constexpr int tone_stride = 0x100;
    static constexpr int tone_header = 0x24;
    static constexpr int partial_stride = 0x6E;
    static constexpr int multisample_stride = 0x8C;
    static constexpr int alternate_stride = 0x18;
    static constexpr int kit_stride = 0x50C;
    static constexpr int unassigned = 0xFFFF;
    static constexpr int drum_space = 0x4000;
    static constexpr int alternate_space = 0x6000;
    static constexpr int indirect_only = 0x8000;

    explicit Directory(const Tables &tables);

    int tone_count() const noexcept { return tone_count_; }
    int kit_count() const noexcept { return kit_count_; }
    int wave_count() const noexcept { return wave_count_; }

    const std::uint8_t *tone(int n) const noexcept;
    /** A partial's 0x6e block by slot, nullptr when the slot is empty (multisample 0xffff). */
    const std::uint8_t *partial(int tone, int slot) const noexcept;
    const std::uint8_t *multisample(int m) const noexcept;
    const std::uint8_t *wave(int w) const noexcept;
    const std::uint8_t *kit(int k) const noexcept;

    /** The three-level lookup as stored, nothing when a level has no entry. */
    std::optional<int> lut3_raw(int program, int map, int bank) const;
    /** With the capital tone fallback and the 0x40 / 0x41 redirect banks, as SC-VA resolves a program. */
    std::optional<int> lut3_resolved(int program, int map, int bank) const;
    /** The tone a program plays in poly mode, -1 for none. An alternate articulation entry gives its primary. */
    int program_tone(int program, int map, int bank, bool raw, int *word = nullptr) const;
    /** The kit a drum program selects on a map, -1 for none. */
    int kit_for_program(int program, int map) const;

    /** The key a partial plays as after its pitch key follow (byte 0x13): key and fraction in 1/1000 key. */
    std::pair<int, int> key_follow(const std::uint8_t *b, int note) const;

    struct Zone {
        int wave, level, zone, key;
    };
    /** The wave a partial plays for a note: wave -1 where it is silent (an empty zone, a key above the last
     * bound), nothing when the partial has no multisample. */
    std::optional<Zone> select_wave(const std::uint8_t *b, int note) const;

    /** The partial's level byte at a velocity, nothing outside its window. */
    std::optional<int> level_byte(const std::uint8_t *b, int velocity) const;

    /** The whole query. Returns false for a query out of range. */
    bool resolve(const scva_patch_query &q, scva_patch &out) const;

private:
    const Tables *t_;
    int tone_count_ = 0;
    int multisample_count_ = 0;
    int wave_count_ = 0;
    int kit_count_ = 0;
    int alternate_count_ = 0;
};

} // namespace scva
