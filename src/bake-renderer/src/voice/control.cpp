// The note on and the control tick of a voice, as SC-VA runs them: the partial's parameters at the note on, the
// pitch envelope's start, the voice start, the voice part of the control update, the per block step, the release
// or kill, the fade out tick, the envelope retrigger and the random generator.

#include "voice/control.hpp"

#include "voice/ramp.hpp"
#include "voice/sampler.hpp"

namespace scva {
namespace {

constexpr Va next_stage = 0x1819a3054;       // u8: 1, 2, 3, 4, 4, 4
constexpr Va rate_curve = 0x1819a2900;       // u16
constexpr Va kf_pitchrate0 = 0x181a01f20, kf_pitchrate1 = 0x181a01aa0; // u8 per row and key
constexpr Va kf_tvarate0 = 0x181a023a0, kf_tvarate1 = 0x181a020a0;
constexpr Va kf_pan = 0x181a01fa0;           // s8
constexpr Va pitch_rate = 0x181a1f0be, pitch_release_rate = 0x181a1f0c0, pitch_velocity = 0x181a1f0c2;
constexpr Va key_rate = 0x181a1f5b4, key_release = 0x181a1f5b6, vel_early = 0x181a1f5b0, vel_late = 0x181a1f5b2;
constexpr Va tva_rate_words = 0x1819a7a30;
constexpr Va rng1 = 0x181a6f630, rng2 = 0x181a6f634;
constexpr Va gain16_first = 0x181a1d730;     // float per voice: the block's first gain16, 0 while idle
constexpr Va half_unit = 0x181a041b0, low_limit = 0x181a041e0, to_int16 = 0x181a041c4; // voice_fadeout_tick

// the per voice arrays the ramps read their targets from
constexpr Va q_target = 0x181a70c60, pitch_target = 0x181a70d60, cutoff_target = 0x181a70e60;
constexpr Va gain4_target = 0x181a70f60, amp_target = 0x181a71060, q_rate = 0x181a71160, pitch_rate_w = 0x181a71260;
constexpr Va cutoff_rate = 0x181a71360, gain4_rate = 0x181a71460, amp_rate = 0x181a71560, pitch_start = 0x181a71660;
constexpr Va cutoff_start = 0x181a71760, gain4_start = 0x181a71860, amp_start = 0x181a71960;
constexpr Va filter_word = 0x181a71b60, q_start4 = 0x181a71c60;
constexpr Va unknown_71e60 = 0x181a71e60, unknown_72260 = 0x181a72260, unknown_72360 = 0x181a72360;
constexpr Va unknown_72460 = 0x181a72460, unknown_70b60 = 0x181a70b60, unknown_70760 = 0x181a70760;
constexpr Va unknown_70960 = 0x181a70960;
constexpr Va send_word[4] = {0x181a73560, 0x181a735e0, 0x181a73660, 0x181a736e0};
constexpr Va wave_reg_flags = 0x181a6fb60, wave_reg_a = 0x181a6fc60, wave_reg_b = 0x181a6fd60, wave_reg_c = 0x181a6fe60;
constexpr Va kill_flags = 0x181a74518, killed_voice = 0x181a1dd40;

int slot_of(const Mem &m, Va v)
{
    return m.u8(v) & 0x3f;
}

// the tail of every kill: the amp ramp falls fast to 0, the pitch ramp's target 0 stops the voice
void kill(Control &c, Va v)
{
    Mem &m = c.mem();
    const int slot = slot_of(m, v);
    m.w16(v + 0x94, 0);
    m.w32(amp_rate + slot * 4, 0xfff);
    m.w32(amp_target + slot * 4, 0);
    m.w32(unknown_72260 + slot * 4, 0);
    m.w32(unknown_71e60 + slot * 4, 0);
    ramp::target_amp(m, slot);
    m.w32(pitch_rate_w + slot * 4, 0x4fff);
    m.w32(pitch_target + slot * 4, 0);
    ramp::target_pitch(m, slot);
    m.w32(kill_flags, m.u32(kill_flags) | 0x4000);
    m.wptr(killed_voice, v);
}

} // namespace

std::uint16_t Control::prng()
{
    const std::uint16_t r1 = m_.u16(rng1);
    std::uint16_t a = static_cast<std::uint16_t>(r1 >> 1);
    if (r1 & 0x20) {
        if (!(r1 & 0x8000)) {
            a = static_cast<std::uint16_t>(a + 0x8000);
        }
    } else if (r1 & 0x8000) {
        a = static_cast<std::uint16_t>(a + 0x8000);
    }
    m_.w16(rng1, a);
    std::uint16_t r2 = m_.u16(rng2);
    const bool one = (r2 & 4) ? !(r2 & 0x2000) : (r2 & 0x200) != 0;
    r2 = static_cast<std::uint16_t>(r2 * 2 + (one ? 1 : 0));
    m_.w16(rng2, r2);
    return static_cast<std::uint16_t>(r2 ^ a);
}

void Control::partial_load_params(Va v)
{
    // the partial's bytes and the wave descriptor into the work copy the setup reads (0x181a1e7b0)
    std::uint8_t partial[0x6e], wave[0x16];
    m_.read(m_.ptr(v + 0x148), partial, sizeof partial);
    m_.read(m_.ptr(v + 0x138), wave, sizeof wave);
    m_.write(g::partial, partial, sizeof partial);
    m_.write(g::wave, wave, sizeof wave);
    // wavedesc_decode into the voice's registers (+0x1a0 a, +0x1a4 b, +0x1a8 c, +0x1ac flags, +0x1b0 the loop bit)
    const WaveRegisters reg = WaveRegisters::decode(wave);
    m_.w32(v + 0x1a0, reg.a);
    m_.w32(v + 0x1a4, reg.b);
    m_.w32(v + 0x1a8, reg.c);
    m_.w32(v + 0x1ac, reg.flags);
    m_.w8(v + 0x1b0, (wave[10] >> 1) & 1);
    if (m_.u8(v + 1) != 0) {
        return;
    }
    partial_compute_pitch(v);
    const Va pb = g::partial;
    if (partial_compute_pitch_env(v)) {
        m_.w16(v + 0x60, 0x4000);
        const Va index = static_cast<Va>(static_cast<std::uint16_t>(static_cast<std::int16_t>(m_.s8(v + 0x161)))) +
                         static_cast<Va>(m_.u8(pb + 0x27)) * 0x80;
        m_.w16(pitch_rate, env_rate_scale(static_cast<std::uint8_t>(m_.u8(kf_pitchrate0 + index) + 0x80), m_.u8(pb + 0x29)));
        m_.w16(pitch_release_rate,
               env_rate_scale(static_cast<std::uint8_t>(m_.u8(kf_pitchrate1 + index) + 0x80), m_.u8(pb + 0x2a)));
        m_.w16(pitch_velocity, env_level_scale(m_.u8(v + 0x166), m_.u8(pb + 0x2c)));
        partial_apply_pitch_env_rates(v);
    }
    voice_pitch_block_init(v);
    if (m_.u8(v + 1) != 0) {
        return;
    }
    if ((m_.u8(v + 0x189) & 2) == 0) {
        m_.w8(v + 0xd, 0);
        m_.w32(v + 0xd0, m_.u16(v + 0x38) + 0xfffu);
        m_.w8(v + 0x21, 0x7f);
        m_.w8(v + 0x35, 0);
        m_.w8(v + 0x49, 0x7f);
        m_.w8(v + 0x5d, 0);
        m_.w8(v + 0x75, 0x7f);
        m_.w32(v + 0xa8, 0);
        m_.w32(v + 0xb0, 0x4040);
        m_.w32(v + 200, 0);
        return;
    }
    // byte 0: the voice delay (bit 7: counted from the note on, 0xff: start at the note off)
    const Va part = m_.ptr(v + 0x128);
    std::uint8_t b = m_.u8(pb);
    std::uint32_t step = 0xffff, rest = 0;
    bool delayed = true;
    bool whole = false;
    if (static_cast<std::int8_t>(b) < 0) {
        b &= 0x7f;
        m_.w8(v + 5, 1);
        if (b == 0x7f) {
            step = 0;
            rest = 0x7f;
            whole = true;
        }
    } else {
        m_.w8(v + 5, 0);
    }
    if (!whole) {
        std::int16_t s = static_cast<std::int16_t>(m_.u8(part + 0x45b) + m_.u8(part + 0x44b) +
                                                   static_cast<std::int8_t>(b) - 0x80);
        const std::uint8_t c = s >= 0x80 ? 0x7f : s < 0 ? 0 : static_cast<std::uint8_t>(s);
        const std::uint32_t scale = env_level_scale(m_.u8(v + 0x166), m_.u8(pb + 1));
        const std::uint32_t ticks = ((scale * m_.u16(rate_curve + c * 2u) >> 8) & 0xffff) / 10;
        step = 0xffff;
        if (static_cast<std::uint16_t>(ticks) == 0) {
            delayed = false;
        } else {
            step = 0xffff / ticks;
            rest = 0xffff % ticks;
        }
    }
    m_.w16(v + 0xfa, delayed ? 0 : 0xffff);
    m_.w16(v + 0xfc, step);
    (void)rest;
    if (m_.u8(v + 1) != 0) {
        return;
    }
    tva_compute_base_level(v);
    tva_compute_env_levels(v);
    const Va key = static_cast<Va>(static_cast<std::int64_t>(m_.s8(v + 0x161)));
    m_.w16(key_rate, env_rate_scale(static_cast<std::uint8_t>(m_.u8(kf_tvarate0 + m_.u8(pb + 0x65) * 0x80u + key) + 0x80),
                                    m_.u8(pb + 0x67)));
    m_.w16(key_release,
           env_rate_scale(static_cast<std::uint8_t>(m_.u8(kf_tvarate1 + m_.u8(pb + 0x66) * 0x80u + key) + 0x80),
                          m_.u8(pb + 0x68)));
    m_.w16(vel_early, env_level_scale(m_.u8(v + 0x164), m_.u8(pb + 0x69)));
    m_.w16(vel_late, env_level_scale(m_.u8(v + 0x164), m_.u8(pb + 0x6a)));
    tva_compute_env_rates(v);
    const std::int16_t pan = static_cast<std::int16_t>(m_.s8(kf_pan + m_.u8(pb + 0x6b) * 0x80u + key) + m_.u8(pb + 0xf));
    m_.w16(v + 0x1b8, static_cast<std::uint16_t>(pan));
    if (pan < 1) {
        m_.w16(v + 0x1b8, 1);
    } else if (static_cast<std::uint16_t>(pan) > 0x7f) {
        m_.w16(v + 0x1b8, 0x7f);
    }
    // one tick of the TVA envelope from its start, at a tick count of 1
    const std::uint16_t saved = m_.u16(g::tick_count);
    m_.w8(v + 0xc, 0);
    m_.w16(g::tick_saved, saved);
    m_.w32(v + 0x1a, 0);
    m_.w8(v + 0xd, 0);
    m_.w16(v + 0x20, 0x7f00);
    m_.w32(v + 0x2e, 0);
    m_.w16(g::tick_count, 1);
    env_ramp_segment(v + 0xc);
    m_.w16(v + 0x2c, m_.u16(v + 0x28));
    std::uint32_t start = static_cast<std::uint32_t>(m_.u16(v + 0x18)) * 4;
    m_.w16(g::tick_count, saved);
    const std::uint32_t word = m_.u16(v + 0xe) + 0x4000u;
    m_.w32(v + 0xac, start);
    m_.w32(v + 0xb0, word);
    if (((word - 0xfff) & 0xffffbfffu) != 0) {
        start = static_cast<std::uint32_t>(m_.u16(v + 0x14)) << 2;
    }
    m_.w32(v + 0xa8, start);
    if (m_.u8(v + 1) == 0) {
        tvf_env_prep(v);
        if (m_.u8(v + 1) == 0) {
            partial_compute_filter(v);
        }
    }
}

void Control::partial_pitch_env_init(Va v)
{
    // despite the name: the voice's send words and its send bus base (voice + 6)
    const Va part = m_.ptr(v + 0x128), kit = m_.ptr(v + 0x158);
    std::int16_t s5, s6;
    if (m_.u8(v + 7) == 0) {
        if (m_.u8(part + 0x452) == 0) {
            m_.w8(v + 6, m_.u8(part + 0x450) == 0 ? 0x3a : 0x33);
            std::uint8_t b4;
            if (kit == 0) {
                b4 = m_.u8(part + 0x13);
                if (static_cast<std::int8_t>(b4) > 0x1f) {
                    b4 = static_cast<std::uint8_t>((m_.u8(part + 0x45c) != 2 ? 1 : 0) - 2);
                }
            } else {
                b4 = static_cast<std::uint8_t>(
                    ~(m_.u8(kit + 0x480 + static_cast<Va>(static_cast<std::int64_t>(m_.s8(v + 0x160)))) >> 3) | 0xfe);
            }
            const std::uint8_t reverb = m_.u8(part + 0x3e3);
            std::uint16_t r = reverb;
            const Va key = kit != 0 ? kit + static_cast<Va>(static_cast<std::int64_t>(m_.s8(v + 0x160))) : 0;
            if (b4 == 0xfe) {
                std::uint8_t d = m_.u8(part + 0x44a);
                if (kit != 0) {
                    r = static_cast<std::uint16_t>(static_cast<std::uint16_t>(m_.u8(key + 0x300) * reverb * 2 + 0xff) >> 8);
                    d = static_cast<std::uint8_t>(static_cast<std::uint16_t>(m_.u8(key + 0x400) * d * 2 + 0xff) >> 8);
                }
                s6 = static_cast<std::int16_t>(d * 0x200 + 0x30);
            } else if (b4 == 0xff) {
                std::uint8_t d = m_.u8(part + 0x3e2);
                if (kit != 0) {
                    r = static_cast<std::uint16_t>(static_cast<std::uint16_t>(m_.u8(key + 0x300) * reverb * 2 + 0xff) >> 8);
                    d = static_cast<std::uint8_t>(static_cast<std::uint16_t>(m_.u8(key + 0x380) * d * 2 + 0xff) >> 8);
                }
                s6 = static_cast<std::int16_t>(d * 0x200 + 0x3d);
            } else {
                s6 = static_cast<std::int16_t>(b4 - 0x1f0);
            }
            s5 = static_cast<std::int16_t>(r * 0x200 + 0x3c);
        } else {
            s5 = 0xf;
            m_.w8(v + 6, 0x3e);
            s6 = 0xf;
        }
    } else {
        s5 = 0xf;
        m_.w8(v + 6, 0x31);
        s6 = 0xf;
    }
    m_.w16(v + 0xf0, static_cast<std::uint16_t>(s5));
    m_.w16(v + 0xf2, static_cast<std::uint16_t>(s6));
}

void Control::voice_start(Va v)
{
    const std::uint16_t base = m_.u16(g::send_base);
    const int slot = slot_of(m_, v);
    m_.w8(v + 3, 0);
    m_.w8(v + 4, 0);
    m_.w8(v + 0x16c, 1);
    m_.w16(send_word[0] + slot * 2, static_cast<std::uint16_t>(m_.s16(v + 0xf4) + base));
    m_.w16(send_word[1] + slot * 2, static_cast<std::uint16_t>(m_.s16(v + 0xf6) + base + 1));
    m_.w16(send_word[2] + slot * 2, m_.u16(v + 0xf0));
    m_.w16(send_word[3] + slot * 2, m_.u16(v + 0xf2));
    m_.w32(filter_word + slot * 4, m_.u32(v + 0x1ec));
    m_.w32(wave_reg_b + slot * 4, m_.u32(v + 0x1a4));
    m_.w32(wave_reg_c + slot * 4, m_.u32(v + 0x1a8));
    m_.w32(q_target + slot * 4, m_.u32(v + 0xdc));
    m_.w32(q_start4 + slot * 4, m_.u32(v + 0xdc) << 2);
    m_.w32(q_rate + slot * 4, m_.u32(v + 0xe0));
    m_.w32(cutoff_target + slot * 4, m_.u32(v + 0xcc));
    m_.w32(cutoff_rate + slot * 4, m_.u32(v + 0xd0));
    m_.w32(cutoff_start + slot * 4, m_.u32(v + 200));
    m_.w32(gain4_target + slot * 4, m_.u32(v + 0x9c));
    m_.w32(gain4_rate + slot * 4, m_.u32(v + 0xa0));
    m_.w32(gain4_start + slot * 4, m_.u32(v + 0x98));
    std::uint32_t amp = 0;
    if (m_.s16(v + 0xfa) == 0) {
        // a delayed voice: silent and still (the pitch target 0 keeps it from rendering) until the delay is over
        m_.w32(pitch_target + slot * 4, 0);
        m_.w32(pitch_rate_w + slot * 4, 0x4fff);
        m_.w32(pitch_start + slot * 4, 0);
        m_.w32(amp_rate + slot * 4, 0x4fff);
        m_.w32(amp_start + slot * 4, 0);
        m_.w32(unknown_72260 + slot * 4, 0);
        m_.w32(unknown_71e60 + slot * 4, 0);
    } else {
        m_.w32(pitch_target + slot * 4, m_.u32(v + 0xbc));
        m_.w32(pitch_rate_w + slot * 4, m_.u32(v + 0xc0));
        m_.w32(pitch_start + slot * 4, m_.u32(v + 0xb8));
        m_.w32(amp_rate + slot * 4, m_.u32(v + 0xb0));
        m_.w32(amp_start + slot * 4, m_.u32(v + 0xa8));
        m_.w32(unknown_72260 + slot * 4, m_.u32(v + 0xb4));
        m_.w32(unknown_71e60 + slot * 4, m_.u32(v + 0xb4) << 4);
        amp = m_.u32(v + 0xac);
    }
    m_.w32(amp_target + slot * 4, amp);
    m_.w32(unknown_72360 + slot * 4, 0);
    m_.w32(unknown_72460 + slot * 4, 0);
    m_.w32(unknown_70b60 + slot * 4, 0x18);
    m_.w32(unknown_70760 + slot * 4, 0);
    m_.w32(unknown_70960 + slot * 4, 0);
    m_.w32(wave_reg_flags + slot * 4, m_.u32(v + 0x1ac));
    m_.w32(wave_reg_a + slot * 4, m_.u32(v + 0x1a0));
    if (m_.s16(v + 0xfa) != 0) {
        m_.w16(v + 0x94, m_.u32(v + 0xac) >> 10);
    }
    // voice_setup_sample_playback: the ramps (the sampler and the SVF state are the engine's own objects)
    ramp::start(m_, slot);
}

void Control::control_update(Va v)
{
    m_.w8(v + 2, 0);
    const std::uint8_t state = m_.u8(v + 0x16c);
    if (state == 0) {
        return;
    }
    if (state != 1) {
        voice_fadeout_tick(v);
        return;
    }
    if (m_.u8(v + 4) != 0) {
        // the sampler reported its loop point (or a one-shot's end) since the last tick
        m_.w8(v + 4, 0);
        if (m_.u8(v + 0x1b0) != 0) {
            const int slot = slot_of(m_, v);
            m_.w32(v + 0xac, 0);
            m_.w32(v + 0xb0, 0x4080);
            m_.w32(amp_rate + slot * 4, 0x4080);
            m_.w32(amp_target + slot * 4, m_.u32(v + 0xac));
            ramp::target_amp(m_, slot);
            m_.w32(pitch_rate_w + slot * 4, 0x4019);
            m_.w32(pitch_target + slot * 4, 0);
            ramp::target_pitch(m_, slot);
            m_.w8(v + 0x16c, 2);
            return;
        }
        // from here on the pitch is the wave's second fine tune
        m_.w32(v + 0x1fc, m_.u32(v + 0x200));
    }
    voice_block_process(v);
}

void Control::voice_release_or_kill(Va v)
{
    const Va part = m_.ptr(v + 0x128);
    if (m_.u8(v + 0x16d) != 0 && m_.u8(part + 0x462) == 0) {
        bool retrigger = false;
        if (m_.u16(v + 0xfc) == 0) {
            m_.w16(v + 0xfa, 0xffff);
            const Va group = m_.ptr(v + 0x120);
            retrigger = m_.ptr(group) != m_.ptr(group + 8);
        }
        if (retrigger) {
            tvf_env_prep(v);
            voice_env_retrigger(v);
        } else {
            kill(*this, v);
        }
        return;
    }
    const std::uint32_t sum = static_cast<std::uint32_t>(m_.u16(v + 0xfa)) + m_.u16(v + 0xfc);
    if (sum > 0xfffe) {
        m_.w16(v + 0xfa, 0xffff);
        voice_env_retrigger(v);
        return;
    }
    m_.w16(v + 0xfa, sum);
}

void Control::voice_fadeout_tick(Va v)
{
    if (m_.u8(v + 0x16c) != 2) {
        return;
    }
    const int slot = slot_of(m_, v);
    const float g = m_.f32(gain16_first + slot * 4);
    std::int16_t s;
    if (g < m_.f32(half_unit)) {
        s = m_.f32(low_limit) < g ? static_cast<std::int16_t>(static_cast<std::int32_t>(g * m_.f32(to_int16)))
                                  : static_cast<std::int16_t>(-0x8000);
    } else {
        s = 0x7fff;
    }
    const std::uint32_t u = s > 0 ? static_cast<std::uint32_t>(s) * 8 : 0;
    const std::uint16_t w = static_cast<std::uint16_t>(u >> 2);
    if (w == 0) {
        kill(*this, v);
    } else {
        m_.w16(v + 0x94, w >> 8);
    }
}

void Control::voice_env_retrigger(Va v)
{
    const int slot = slot_of(m_, v);
    m_.w32(pitch_start + slot * 4, m_.u32(v + 0xb8));
    m_.w32(pitch_rate_w + slot * 4, m_.u32(v + 0xc0));
    m_.w32(pitch_target + slot * 4, m_.u32(v + 0xbc));
    m_.w32(amp_start + slot * 4, m_.u32(v + 0xa8));
    m_.w32(amp_rate + slot * 4, m_.u32(v + 0xb0));
    m_.w32(amp_target + slot * 4, m_.u32(v + 0xac));
    m_.w16(v + 0x94, m_.u32(v + 0xac) >> 10);
    const std::uint32_t pr = m_.u32(pitch_rate_w + slot * 4), ar = m_.u32(amp_rate + slot * 4);
    ramp::set_target_pitch(m_, slot, ramp::flags_of_rate(m_, pr), m_.u32(pitch_start + slot * 4),
                           m_.u32(pitch_target + slot * 4), static_cast<std::int16_t>(pr & 0xfff), true);
    ramp::set_target_amp(m_, slot, ramp::flags_of_rate(m_, ar), m_.s32(amp_start + slot * 4),
                         m_.s32(amp_target + slot * 4), static_cast<std::int16_t>(ar & 0xfff), true);
}

void Control::voice_block_process(Va v)
{
    const Va s = g::scratch;
    if (m_.u8(v + 2) != 0) {
        m_.w8(v + 2, 0);
        voice_fadeout_tick(v);
        return;
    }
    if (m_.s16(v + 0xfa) != -1) {
        voice_release_or_kill(v);
        return;
    }
    m_.w16(v + 0x94, m_.u32(v + 0xac) >> 10);
    if (m_.u32(v + 0xac) == 0 &&
        (m_.s16(v + 0x2e) != 0 || (m_.u8(v + 0x188) == 0 && m_.s16(v + 0x14) != 0) || m_.u8(v + 0xc) == 4)) {
        kill(*this, v);
        return;
    }
    // the tick works on a copy of voice + 0xc .. + 0x104 at 0x181a226d0
    std::uint8_t copy[0xf8];
    m_.read(v + 0xc, copy, sizeof copy);
    m_.write(s, copy, sizeof copy);
    if (m_.u8(v + 0x16d) == 1) {
        // released: the main segments stop and the release segments run, unless the damper holds
        const Va lfo2 = m_.ptr(v + 0x180), lfo1 = m_.ptr(v + 0x178);
        if (m_.s16(lfo2 + 0x3a) == 0) {
            m_.w16(lfo2 + 0x74, 0xffff);
        }
        if (m_.s16(lfo1 + 0x3a) == 0) {
            m_.w16(lfo1 + 0x74, 0xffff);
        }
        bool go = true;
        std::int8_t damper = 0;
        if (m_.u8(v + 5) != 0) {
            if (m_.u16(s + 0xf0) == 0) {
                go = false;
                if (m_.u8(s) == 4) {
                    m_.w8(s + 0x15, 0);
                    m_.w8(s + 1, 0x7f);
                    m_.w8(s + 0x3d, 0);
                    m_.w8(s + 0x29, 0x7f);
                    m_.w8(s + 0x69, 0);
                    m_.w8(s + 0x51, 0x7f);
                }
            }
        } else {
            damper = m_.s8(m_.ptr(v + 0x128) + 0x462);
        }
        if (go) {
            bool release = true;
            if (m_.u8(v + 8) == 0) {
                if (damper >= 0x40) {
                    release = false;
                } else {
                    m_.w8(s + 1, 0x7f);
                    m_.w8(s + 0x29, 0x7f);
                    m_.w8(s + 0x51, 0x7f);
                }
            }
            if (release) {
                m_.w8(s + 0x69, static_cast<std::uint8_t>(damper));
                m_.w8(s + 0x3d, static_cast<std::uint8_t>(damper));
                m_.w8(s + 0x15, static_cast<std::uint8_t>(damper));
            }
        }
    }
    if (m_.u16(s + 0xe) == 0xffff) {
        // the TVA segment ended last tick: the next stage
        m_.w16(s + 0xe, 0);
        const std::uint8_t stage = m_.u8(next_stage + m_.u8(s));
        m_.w8(s, stage);
        tva_stage(stage, v);
    }
    std::uint32_t level, word;
    if (m_.u8(s + 0x15) == 0x7f) {
        env_ramp_segment(s);
        if (m_.u16(s + 0x22) != 0) {
            m_.w16(s + 0xc, (static_cast<std::uint32_t>(m_.u16(s + 0xc)) * m_.u16(s + 0x20)) >> 16);
        }
        level = m_.u16(s + 0xc);
        word = m_.u16(s + 2);
    } else {
        if (m_.u8(s + 1) != 0x7f) {
            env_ramp_segment(s);
        }
        const std::uint8_t over = m_.u8(m_.ptr(v + 0x128) + 0x46e);
        if (static_cast<std::int8_t>(over) < 0) {
            // the part's release time replaces the partial's: a copy of the release segment with its own step
            if (local_ == 0) {
                local_ = m_.alloc(0x14); // the DLL's stack copy
            }
            const Va local = local_;
            std::uint8_t seg[0x14];
            m_.read(s + 0x14, seg, sizeof seg);
            m_.write(local, seg, sizeof seg);
            const std::uint16_t time =
                static_cast<std::uint16_t>(m_.u16(rate_curve + (over & 0x7fu) * 2) + m_.u16(s + 0x26));
            m_.w16(local + 0x12, time);
            std::uint16_t rw;
            if (time < 0x14) {
                m_.w16(local + 6, 0xffff);
                rw = m_.u16(tva_rate_words + time * 2u);
            } else {
                m_.w16(local + 6, 0xa0000 / time);
                rw = 0x1a;
            }
            m_.w16(local + 2, rw);
            env_ramp_segment(local);
            m_.w16(s + 0x22, m_.u16(local + 0xe));
            level = (static_cast<std::uint32_t>(m_.u16(s + 0xc)) * m_.u16(local + 0xc)) >> 16;
            word = m_.u16(local + 2);
        } else {
            env_ramp_segment(s + 0x14);
            level = (static_cast<std::uint32_t>(m_.u16(s + 0xc)) * m_.u16(s + 0x20)) >> 16;
            word = m_.u16(s + 0x16);
        }
    }
    m_.w32(s + 0xa0, level << 2);    // voice + 0xac: the amp ramp's target
    m_.w32(s + 0xa4, word + 0x4000); // voice + 0xb0: its rate word, a line
    if (m_.u8(v + 2) == 0) {
        tvf_env_cutoff_update(v);
        if (m_.u8(v + 2) == 0) {
            voice_pitch_block_update(v);
            if (m_.u8(v + 2) == 0) {
                const std::uint32_t vol = voice_volume_apply(v) & 0xffff;
                m_.w32(s + 0x90, vol << 2); // voice + 0x9c: the volume ramp's target
                m_.w32(s + 0x94, 0xcc);     // voice + 0xa0: its rate
                voice_pan_slew(v);
                voice_send_slew(v);
                if (m_.u8(v + 2) == 0) {
                    m_.read(s, copy, sizeof copy);
                    m_.write(v + 0xc, copy, sizeof copy);
                    if (m_.u32(v + 0xac) == 0) {
                        m_.w32(v + 0xb0, 0x4080);
                    }
                    const std::uint8_t base = m_.u8(v + 6);
                    m_.w16(g::send_base, base);
                    const int slot = slot_of(m_, v);
                    m_.w16(send_word[0] + slot * 2, static_cast<std::uint16_t>(m_.s16(v + 0xf4) + base));
                    m_.w16(send_word[1] + slot * 2, static_cast<std::uint16_t>(m_.s16(v + 0xf6) + base + 1));
                    m_.w16(send_word[2] + slot * 2, m_.u16(v + 0xf0));
                    m_.w16(send_word[3] + slot * 2, m_.u16(v + 0xf2));
                    m_.w32(pitch_rate_w + slot * 4, m_.u32(v + 0xc0));
                    m_.w32(pitch_target + slot * 4, m_.u32(v + 0xbc));
                    m_.w32(cutoff_rate + slot * 4, m_.u32(v + 0xd0));
                    m_.w32(cutoff_target + slot * 4, m_.u32(v + 0xcc));
                    m_.w32(q_rate + slot * 4, m_.u32(v + 0xe0));
                    m_.w32(q_target + slot * 4, m_.u32(v + 0xdc));
                    m_.w32(gain4_rate + slot * 4, m_.u32(v + 0xa0));
                    m_.w32(gain4_target + slot * 4, m_.u32(v + 0x9c));
                    m_.w32(amp_rate + slot * 4, m_.u32(v + 0xb0));
                    m_.w32(amp_target + slot * 4, m_.u32(v + 0xac));
                    ramp::targets_writeback(m_, slot);
                    return;
                }
            }
        }
    }
    m_.w8(v + 2, 0);
    voice_fadeout_tick(v);
}

} // namespace scva
