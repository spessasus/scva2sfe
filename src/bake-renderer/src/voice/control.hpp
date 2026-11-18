#pragma once

// The voice control layer of SCCore.dll 1.1.6: what a note on writes into a voice (the partial's parameters and
// the TVA, TVF and pitch setup), the control tick that steps the three envelopes and hands their values to the
// per-sample ramps (ramp.*). It runs on the DLL's own memory layout (Mem): the voice struct (0x220 bytes), the
// part struct (0x488), the scratch copy the tick works in, and the DLL's tables in .rdata. The functions are split by stage over envelope.cpp, tva.cpp, tvf.cpp,
// pitch.cpp and control.cpp.
//
// Not here: the LFOs (which write the output slots a voice reads at voice + 0x170 and + 0x180) and the controller
// matrix (which writes the part's modulation sums at part + 0x3a2 .. + 0x3ce). The output slots stay 0 and so do
// the sums (src/render.cpp says why).

#include "voice/mem.hpp"

#include <cstdint>

namespace scva {

/**
 * The DLL's globals the ported functions share (VA in .data / .bss).
 */
namespace g {
inline constexpr Va scratch = 0x181a226d0;      // g_voice_scratch: voice + 0xc .. + 0x104 while a tick runs
inline constexpr Va tick_count = 0x181a2283c;   // the control ticks since the last update (1 normally)
inline constexpr Va tick_saved = 0x181a2282c;
inline constexpr Va tick_pending = 0x181a2281c; // timer ticks the next update takes
inline constexpr Va partial = 0x181a1e7b0;      // the partial's 0x6e bytes and the wave descriptor's 0x16 after
inline constexpr Va wave = 0x181a1e81e;
inline constexpr Va system = 0x181a1e6f8;       // master tune (s16), +2 master volume, +5 key shift, +6 pan
inline constexpr Va send_base = 0x181a6f640;    // the voice's send bus base while it starts
} // namespace g

class Control {
public:
    explicit Control(Mem &m) : m_(m) {}

    // note on (control.cpp): what part_start_voices does for one voice after the allocation
    void partial_load_params(Va v);
    void partial_pitch_env_init(Va v);
    void voice_start(Va v);

    // the control tick for one voice (control.cpp): voices_control_update's voice loop body
    void control_update(Va v);
    void voice_block_process(Va v);
    void voice_release_or_kill(Va v);
    void voice_fadeout_tick(Va v);
    void voice_env_retrigger(Va v);

    // envelopes (envelope.cpp)
    std::uint16_t env_rate_scale(std::uint16_t base, std::int16_t modifier) const;
    std::uint16_t env_level_scale(std::uint8_t level, std::uint8_t modifier) const;
    void env_ramp_segment(Va seg);
    void tvf_env_ramp_segment(Va seg);
    void pitch_env_ramp_segment(Va seg);
    void tva_stage(int stage, Va v);
    void tvf_stage(int stage, Va v);
    void pitch_stage(int stage, Va v);

    // TVA (tva.cpp)
    void tva_compute_base_level(Va v);
    void tva_compute_env_levels(Va v);
    void tva_compute_env_rates(Va v);
    std::uint32_t voice_volume_apply(Va v);
    void tvf_env_prep(Va v); // the DLL's name: it sets the volume ramp and the pan, not the TVF
    void voice_pan_slew(Va v);
    void voice_send_slew(Va v);

    // TVF (tvf.cpp)
    void partial_compute_filter(Va v);
    std::uint32_t tvf_env_level_conv(Va v, std::uint8_t level);
    void tvf_compute_env_rates(Va v);
    std::uint32_t tvf_cutoff_compute(Va v);
    void tvf_env_cutoff_update(Va v);
    void tvf_cutoff_add_lfo(Va v, Va out);
    void tvf_filter_stage(int which, Va v, Va out); // the four per-type tables at 0x1819a2458 .. 0x1819a2500

    // pitch (pitch.cpp)
    void partial_compute_pitch(Va v);
    bool partial_compute_pitch_env(Va v);
    void pitch_env_apply_stage(Va v);
    void partial_apply_pitch_env_rates(Va v);
    void voice_pitch_block_init(Va v);
    void voice_pitch_block_update(Va v);
    void voice_pitch_keyfollow(Va v);
    void lfo_pitch_accumulate(Va v);
    std::int16_t mod_pitch_control(Va part, std::int8_t amount) const;

    /**
     * The random generator's next value (an LFSR in two u16 registers).
     */
    std::uint16_t prng();

    Mem &mem() noexcept { return m_; }

private:
    Mem &m_;
    Va local_ = 0; // voice_block_process's stack copy of the release segment
};

} // namespace scva
