#include "rom/tables.hpp"

#include <stdexcept>

namespace scva {
namespace {

// name, file offset, size, heap copy pointer (0: read in place)
constexpr TableDef defs[] = {
    // the curves, key follow and LFO tables (NativeTS manifest, read in place in .rdata, interp_coef in .data)
    {"curve_amp_hi_2ba0", 0x19A1BA0, 512, 0},
    {"curve_amp_lo_2da0", 0x19A1DA0, 512, 0},
    {"curve_filtenvdepth_2f00", 0x19A1F00, 352, 0},
    {"curve_filttype_987b00", 0x1986B00, 64, 0},
    {"curve_level_2a00", 0x19A1A00, 256, 0},
    {"curve_pitchbias_2890", 0x19A1890, 128, 0},
    {"curve_pitchdepthvs_28d0", 0x19A18D0, 128, 0},
    {"curve_pitchenv_2578", 0x19A1578, 856, 0},
    {"curve_rateout_3060", 0x19A2060, 1024, 0},
    {"curve_reso_2b88", 0x19A1B88, 128, 0},
    {"curve_scale_28e8", 0x19A18E8, 256, 0},
    {"curve_segrate_2900", 0x19A1900, 256, 0},
    {"curve_vel_2b00", 0x19A1B00, 256, 0},
    {"curve_velsens_01520", 0x1A00520, 2048, 0},
    {"curve_velxfade_01020", 0x1A00020, 2048, 0},
    {"env_shape_7a90", 0x19A6A90, 516, 0},
    {"env_startphase_7a30", 0x19A6A30, 256, 0},
    {"interp_coef_a0f210", 0x1A0DE10, 2048, 0},
    {"kf_pitch_01b20", 0x1A00B20, 2048, 0},
    {"kf_pitchrate0_01f20", 0x1A00F20, 16384, 0},
    {"kf_pitchrate1_01aa0", 0x1A00AA0, 16384, 0},
    {"kf_tvalevel2_01fa0", 0x1A00FA0, 16384, 0},
    {"kf_tvalevel_026a0", 0x1A016A0, 16384, 0},
    {"kf_tvarate0_023a0", 0x1A013A0, 16384, 0},
    {"kf_tvarate1_020a0", 0x1A010A0, 16384, 0},
    {"kf_tvfenv_02a20", 0x1A01A20, 4096, 0},
    {"kf_tvfrate_03920", 0x1A02920, 16384, 0},
    {"lfo_cents_2690", 0x19A1690, 256, 0},
    {"lfo_delay_a2590", 0x19A1590, 256, 0},
    {"lfo_rate_2790", 0x19A1790, 256, 0},
    {"lfo_wave_1740", 0x19A0740, 256, 0},
    {"lfo_wavebank_a17f0", 0x19A07F0, 6192, 0},
    {"lfo_wavemap_87ae0", 0x1986AE0, 32, 0},
    {"pan_a2fa1", 0x19A1FA1, 128, 0},
    {"porta_step_7800", 0x19A6800, 256, 0},
    {"ramp_divider_a03e00", 0x1A02E00, 4, 0},
    {"ramp_exp_986420", 0x1985420, 1028, 0},
    {"ramp_flagword_a84d8", 0x19A74D8, 16, 0},
    {"svf_fceil_986860", 0x1985860, 4096, 0},
    {"tvf_ceil_a7ed0", 0x19A6ED0, 256, 0},
    {"tvf_q_lp_a7cd0", 0x19A6CD0, 512, 0},
    {"tvf_q_t6_a7fd0", 0x19A6FD0, 512, 0},
    {"tvf_warp_a83d0", 0x19A73D0, 258, 0},
    // two float constants of the voice renderers (.rdata): predictor to sample, and the level of an idle slot
    {"sample_scale_a04144", 0x1A03144, 4, 0},
    {"idle_level_a04160", 0x1A03160, 4, 0},
    // the patch directory (program to tone)
    {"lut1_2e30", 0x19F1E30, 128, 0},
    {"lut2_28b0", 0x19F18B0, 16384, 0},
    {"lut3_32b0", 0x19F22B0, 65536, 0},
    {"tone_indirect_bank64_a8bf0", 0x19A7BF0, 1408, 0},
    {"tone_indirect_bank65_a9800", 0x19A8800, 1408, 0},
    // drum kit selection (map -> row, row and program -> kit slot, slot -> kit), NativeTS DrumKitTable
    {"drum_bank_row", 0x19FFBB0, 128, 0},
    {"drum_prog_map", 0x19F1EB0, 6 * 0x80, 0},
    {"drum_kit_index", 0x19F21B0, 512, 0},
    // the pitch key follow slopes (VA 0x1800935c0, read by the key zone choice): k / 20 * 65536, 21 x u16.
    // Read as far as |byte 0x13 - 0x40| can reach (64), the bytes past entry 20 are other data
    {"kf_slope_935c0", 0x925C0, 130, 0},
    // TG_initialize's 8 blobs, copied to the heap at init (sizes from their size functions)
    {"blob0_1896630", 0x1896630, 0x58, 0x181A18EF8},
    {"tone_a", 0x18F1810, 0x93B00, 0x181A18F00},
    {"multisample_a", 0x18C9570, 0x28294, 0x181A18F08},
    {"wavedesc_a", 0x1896B40, 0x16E04, 0x181A18F10},
    {"drum_kits", 0x18AD950, 0x1BC20, 0x181A18F18},
    {"layered_1896690", 0x1896690, 0x4B0, 0x181A18F20},
    {"wave_rom_bank_A", 0x92700, 0x1000004, 0x181A18EF0},
    {"wave_rom_bank_B", 0x1092730, 0x800004, 0x181A11A68},
};

} // namespace

Tables::Tables(const Rom &rom) : rom_(&rom)
{
    for (const TableDef &d : defs) {
        tables_.push_back({&d, d.pointer_va ? 0 : rom.file_to_va(d.file_offset), rom.bytes(d.file_offset, d.size)});
    }
    tone = raw("tone_a");
    multisample = raw("multisample_a");
    wavedesc = raw("wavedesc_a");
    layered = raw("layered_1896690");
    drum_kits = raw("drum_kits");
    lut1 = raw("lut1_2e30");
    lut2 = raw("lut2_28b0");
    lut3 = raw("lut3_32b0");
    indirect64 = raw("tone_indirect_bank64_a8bf0");
    indirect65 = raw("tone_indirect_bank65_a9800");
    drum_bank_row = raw("drum_bank_row");
    drum_prog_map = raw("drum_prog_map");
    drum_kit_index = raw("drum_kit_index");
    kf_slope = raw("kf_slope_935c0");
    vel_xfade = raw("curve_velxfade_01020");
    wave_rom_a = raw("wave_rom_bank_A");
    wave_rom_b = raw("wave_rom_bank_B");
}

std::uint8_t Tables::file_byte(std::span<const std::uint8_t> table, std::size_t at) const
{
    const std::int64_t offset = table.data() - rom_->bytes(0, 0).data();
    return rom_->bytes(offset + static_cast<std::int64_t>(at), 1)[0];
}

std::span<const std::uint8_t> Tables::raw(std::string_view name) const
{
    for (const Table &t : tables_) {
        if (name == t.def->name) {
            return t.bytes;
        }
    }
    throw std::out_of_range("no table " + std::string(name));
}

} // namespace scva
