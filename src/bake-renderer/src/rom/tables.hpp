#pragma once

// The engine's offset map: every table it reads from SCCore.dll, by file offset and size, and where the DLL
// itself reads it at run time (in place, or the heap copy TG_initialize makes). Offsets of the cached tables
// are NativeTS's assets/manifest.json (BSD 3-Clause, see NOTICE.md), names kept. The blob sizes are the ones
// TG_initialize copies.

#include "rom/rom.hpp"

#include <cstdint>
#include <span>
#include <string>
#include <string_view>
#include <vector>

namespace scva {

struct TableDef {
    const char *name;
    std::int64_t file_offset;
    std::int64_t size;
    /** The variable holding the DLL's heap copy (TG_initialize's blob table at 0x181a0fa10), 0 when in place. */
    std::int64_t pointer_va;
};

struct Table {
    const TableDef *def;
    std::int64_t va; // in place: where the DLL reads it, 0 for a heap copy
    std::span<const std::uint8_t> bytes;
};

class Tables {
public:
    explicit Tables(const Rom &rom);

    const std::vector<Table> &all() const noexcept { return tables_; }

    /**
     * The bytes of a table by name. Throws std::out_of_range for a name the map does not have.
     */
    std::span<const std::uint8_t> raw(std::string_view name) const;

    // the tables patch resolution reads, bound once
    std::span<const std::uint8_t> tone, multisample, wavedesc, layered, drum_kits;
    std::span<const std::uint8_t> lut1, lut2, lut3, indirect64, indirect65;
    std::span<const std::uint8_t> drum_bank_row, drum_prog_map, drum_kit_index;
    std::span<const std::uint8_t> kf_slope, vel_xfade;
    std::span<const std::uint8_t> wave_rom_a, wave_rom_b;

    /**
     * The file byte `at` bytes into a table, where the DLL reads past the table's end (a reversed velocity
     * window indexing into the next row of g_vel_xfade, say).
     */
    std::uint8_t file_byte(std::span<const std::uint8_t> table, std::size_t at) const;

    std::uint8_t vel_xfade_tail(std::size_t at) const { return file_byte(vel_xfade, at); }

private:
    const Rom *rom_;
    std::vector<Table> tables_;
};

} // namespace scva
