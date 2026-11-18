#pragma once

// The per-sample control ramps of a voice: the five ramp structs the control tick sets targets in and every
// 32-sample block steps, as SC-VA steps them, and the target setters. The structs live at the DLL's addresses
// in Mem (stride 0x18 per voice): +0 flags (bit 0 moving, bits 1-2 the mode, bits 3-4 how many counts per step),
// +2 the rate, +4 the count, +8 the current value, +0xc the target, +0x10 the step (linear) or the accumulator
// (exponential), +0x14 what the ramp gives out (a float, or the playback ratio for the pitch ramp).

#include "voice/mem.hpp"

#include <cstdint>

namespace scva::ramp {

inline constexpr Va pitch = 0x181a1cbf0;  // g_voice_ramp_pitch: the pitch word, out the playback ratio (16.16)
inline constexpr Va amp = 0x181a10140;    // g_voice_ramp_amp: the TVA envelope, out gain16 (one per 2 samples)
inline constexpr Va gain4 = 0x181a10d40;  // the volume ramp, out gain4 (one per 8 samples)
inline constexpr Va cutoff = 0x181a10740; // the SVF frequency coefficient (one per 8 samples)
inline constexpr Va q = 0x181a0fb40;      // the SVF damping (one per 8 samples), caps f

inline constexpr Va stride = 0x18;

inline constexpr Va exp_table = 0x181986420;  // g_ramp_exp_tbl, 257 x i32
inline constexpr Va step_masks = 0x181a03e00; // counts per step: 0, 7, 0x1f, 0x7f (flags bits 3-4)
inline constexpr Va f_ceiling = 0x181986860;  // the highest f per damping, float, by q current >> 8
inline constexpr Va mode_bits = 0x1819ab678;  // rate word bits 14-15 -> flags mode bits (2, 0, 4, 4)
inline constexpr Va mask_bits = 0x1819a84d8;  // rate word bits 12-13 -> flags bits 3-4 (0, 8, 16, 24)
inline constexpr Va int16_unit = 0x181a04178; // 2^-14
inline constexpr Va idle_level = 0x181a04160; // 1e-5

/**
 * A pitch word (1/16384 octave above 2^-14) as a 16.16 playback ratio through the exponential table, 0 for 0.
 */
std::int32_t exp_ratio(const Mem &m, std::int32_t word);

/**
 * One block of each ramp (render_block's order: pitch, then amp and gain4 for an active voice, the renderer,
 * then cutoff and q). ratios[4], gain16[16], gain4[4], f[4] and q[4] as render_block hands them on. q caps f
 * in place (voice_ctrl_ramp_d), so f is final after q_block.
 */
void pitch_block(Mem &m, int voice, std::int32_t *ratios);
void amp_block(Mem &m, int voice, float *gain16);
void gain4_block(Mem &m, int voice, float *gain4);
void cutoff_block(Mem &m, int voice, float *f);
void q_block(Mem &m, int voice, float *q, float *f);

/**
 * The target setters: voice_set_ramp_target_0 (pitch), _1 (amp), _2 (cutoff), voice_ramp_target_amp,
 * voice_ramp_target_pitch, voice_ramp_target_aux and voice_ramp_targets_writeback, which read the per voice
 * target arrays (0x181a70c60 .. 0x181a72460) the control code writes.
 */
void set_target_pitch(Mem &m, int voice, std::uint16_t flags, std::uint32_t start, std::uint32_t target,
                      std::int16_t rate, bool reset);
void set_target_amp(Mem &m, int voice, std::uint16_t flags, std::int32_t start, std::int32_t target,
                    std::int16_t rate, bool reset);
void set_target_cutoff(Mem &m, int voice, std::uint16_t flags, std::uint32_t start, std::uint32_t target,
                       std::int16_t rate, bool reset);
void target_amp(Mem &m, int voice);
void target_pitch(Mem &m, int voice);
void target_aux(Mem &m, int voice);
void targets_writeback(Mem &m, int voice);

/**
 * The ramp part of voice_setup_sample_playback: every ramp starts at the voice's start values (the arrays
 * voice_start fills), with its count at 0.
 */
void start(Mem &m, int voice);

/**
 * voice_compute_mod_rates: the four send levels from the packed send words (0x181a73560 ..).
 */
void compute_sends(Mem &m, int voice);

/**
 * The flags a rate word selects (mode bits | count bits).
 */
std::uint16_t flags_of_rate(const Mem &m, std::uint32_t rate_word);

} // namespace scva::ramp
