// The pitch at note on and per tick, as SC-VA computes it: the static pitch (key, fraction, key curve, coarse,
// random pitch, the wave's root and fine tunes), the envelope's levels by depth and velocity, its random start
// and its rates, the pitch ramp's start and first target, the tick, the key follow, the LFO sum and the
// modulation pitch control.
//
// Pitches are in milli-semitones until the end, where (int)(ms << 9) / 375 + 0x38000 makes the pitch ramp's word
// (1/16384 octave).

#include "voice/control.hpp"

namespace scva {
namespace {

constexpr Va kf_pitch = 0x181a01b20;    // s16 per row and key
constexpr Va depth_slope = 0x1819a2578, depth_base = 0x1819a28d0; // u16
constexpr Va level_curve = 0x1819a2890; // u8
constexpr Va rate_curve = 0x1819a2900;
constexpr Va env_rate_words = 0x1819a7a00;
constexpr Va porta_step = 0x1819a7800;  // u16
constexpr Va key_scale = 0x1819a7900;   // u16 per key
constexpr Va next_stage = 0x1819a3054;
constexpr Va pitch = 0x181a1f0b8;       // the partial's pitch while the note on runs
constexpr Va pitch_rate = 0x181a1f0be, pitch_release_rate = 0x181a1f0c0, pitch_velocity = 0x181a1f0c2;
constexpr Va acc = 0x181a22830, word_in = 0x181a22834, shift = 0x181a22838; // voice_pitch_block_init / keyfollow
constexpr Va sum = 0x181a22820, total = 0x181a22824, shift_t = 0x181a22828;  // voice_pitch_block_update

std::int32_t word_of(std::int32_t ms)
{
    const std::int32_t w = static_cast<std::int32_t>(static_cast<std::uint32_t>(ms) << 9) / 375 + 0x38000;
    return w >= 0x40000 ? 0x3ffff : w < 0 ? 0 : w;
}

std::int32_t clamp_pitch(std::int32_t p)
{
    return p < 0 ? 0 : p > 0x1f018 ? 0x1f018 : p;
}

} // namespace

std::int16_t Control::mod_pitch_control(Va part, std::int8_t amount) const
{
    const std::uint8_t b = m_.u8(part + 0x420);
    std::int16_t s = b < 0x40 ? static_cast<std::int16_t>(-((0x40 - b) * amount)) : static_cast<std::int16_t>((b - 0x40) * amount);
    s = static_cast<std::int16_t>(s + m_.s16(part + 0x3a2));
    if (s < 0) {
        std::int16_t n = static_cast<std::int16_t>(-s);
        if (0xbe8 < -s) {
            n = 0xbe8;
        }
        return static_cast<std::int16_t>(
            -static_cast<std::int16_t>((static_cast<std::uint32_t>(static_cast<std::uint16_t>(n << 3)) * 0xfbf8) >> 16));
    }
    if (0xbe8 < s) {
        s = 0xbe8;
    }
    return static_cast<std::int16_t>((static_cast<std::uint32_t>(static_cast<std::uint16_t>(s << 3)) * 0xfbf8) >> 16);
}

void Control::partial_compute_pitch(Va v)
{
    const Va wd = g::wave, pb = g::partial;
    const std::int32_t native = static_cast<std::int32_t>(m_.u8(wd + 6) * 1000u - m_.u16(wd + 4) + 0x400);
    m_.w32(v + 0x1fc, static_cast<std::uint32_t>(native));
    m_.w32(v + 0x200, static_cast<std::uint32_t>(native - m_.u16(wd + 0xe) + 0x400));
    std::int32_t p = static_cast<std::int32_t>(m_.u8(v + 0x163) * 1000u + m_.u16(v + 0x16a));
    std::int32_t row = -1;
    if (m_.u8(v + 0x169) == 0) {
        row = 2;
    } else if (m_.s8(v + 0x168) != 0) {
        row = static_cast<std::uint16_t>(static_cast<std::int16_t>(m_.s8(v + 0x168)));
    }
    if (row >= 0) {
        const std::uint16_t c = static_cast<std::uint16_t>(
            m_.u16(kf_pitch + (static_cast<Va>(row) * 0x80 + m_.u8(v + 0x163)) * 2) + 0x4000);
        p = p - 0x4000 + c;
        if (p < 0) {
            p = 0;
        }
    }
    p += (m_.u8(pb + 0x11) - 0x40) * 10;
    if (p < 0) {
        p = 0;
    }
    const std::uint32_t random = m_.u8(pb + 0x12);
    if (random != 0) {
        const std::uint16_t r = prng();
        if (static_cast<std::int16_t>(r * 2) < 0) {
            p += static_cast<std::int32_t>(((((static_cast<std::uint16_t>(r * -2) >> 8) * random) & 0xffff) + 0x80) >> 8) * -10;
            if (p < 0) {
                p = 0;
            }
        } else {
            p += static_cast<std::int32_t>((((((r & 0x7fffu) >> 7) * random) & 0xffff) + 0x80) >> 8) * 10;
        }
    }
    std::int32_t glide = 0;
    if ((m_.u8(v + 0x189) & 1) == 0) {
        glide = (m_.s32(v + 0x1f8) - p) + m_.s32(v + 0x8c);
    } else if (m_.s8(v + 0x162) >= 0) {
        glide = static_cast<std::int32_t>(static_cast<std::uint8_t>(m_.s8(v + 0x162))) * 1000 - p;
    }
    m_.w32(pitch, static_cast<std::uint32_t>(p));
    m_.w32(v + 0x8c, static_cast<std::uint32_t>(glide));
    m_.w32(v + 0x1f8, static_cast<std::uint32_t>(p));
    m_.w32(v + 0x218, static_cast<std::uint32_t>(p));
}

bool Control::partial_compute_pitch_env(Va v)
{
    const Va pb = g::partial;
    const std::int8_t l0 = static_cast<std::int8_t>(m_.u8(pb + 0x1b) - 0x40);
    const std::int8_t lr = static_cast<std::int8_t>(m_.u8(pb + 0x1f) - 0x40);
    const std::int8_t l1 = static_cast<std::int8_t>(m_.u8(pb + 0x1c) - 0x40);
    const std::int8_t l2 = static_cast<std::int8_t>(m_.u8(pb + 0x1d) - 0x40);
    const std::int8_t l3 = static_cast<std::int8_t>(m_.u8(pb + 0x1e) - 0x40);
    const std::int32_t base = m_.s32(pitch);
    m_.w32(v + 0x7c, 0);
    if (m_.u16(pb + 0x18) == 0) {
        m_.w32(v + 100, static_cast<std::uint32_t>(base));
        m_.w16(v + 0x7a, 0);
        pitch_env_apply_stage(v);
        m_.w32(v + 0x68, m_.u32(v + 100));
        return false;
    }
    std::uint16_t u2 = static_cast<std::uint16_t>(m_.u8(pb + 0x2b) - 0x40);
    std::uint32_t depth;
    if (u2 == 0) {
        depth = m_.u16(pb + 0x18);
    } else {
        std::uint8_t vel = m_.u8(v + 0x166);
        if (static_cast<std::int16_t>(u2) < 0) {
            u2 = static_cast<std::uint16_t>(-static_cast<std::int16_t>(u2));
            vel = static_cast<std::uint8_t>(-vel & 0x7f);
        }
        depth = ((static_cast<std::uint32_t>(m_.u16(depth_slope + u2 * 2u)) *
                      (static_cast<std::uint32_t>(static_cast<std::int32_t>(static_cast<std::int8_t>(vel))) & 0xffff) +
                  m_.u16(depth_base + u2 * 2u)) *
                     m_.u16(pb + 0x18) +
                 0x8000) >> 16;
    }
    const auto level = [&](std::int8_t l) -> std::int32_t {
        if (l == 0) {
            return base;
        }
        if (l < 0) {
            const std::int32_t r = base - static_cast<std::int32_t>((m_.u8(level_curve + static_cast<Va>(-l)) * depth >> 7) & 0xffff);
            return r < 0 ? 0 : r;
        }
        return static_cast<std::int32_t>((m_.u8(level_curve + static_cast<Va>(l)) * depth >> 7) & 0xffff) + base;
    };
    m_.w32(v + 100, static_cast<std::uint32_t>(level(l0)));
    m_.w32(v + 0x68, static_cast<std::uint32_t>(level(l1)));
    m_.w32(v + 0x80, static_cast<std::uint32_t>(level(lr)));
    m_.w32(v + 0x210, static_cast<std::uint32_t>(level(l2)));
    m_.w32(v + 0x214, static_cast<std::uint32_t>(level(l3)));
    pitch_env_apply_stage(v);
    return true;
}

void Control::pitch_env_apply_stage(Va v)
{
    const std::int8_t random = m_.s8(g::partial + 0x1a);
    if (random == 0) {
        return;
    }
    const std::uint32_t u = static_cast<std::uint32_t>(static_cast<std::int32_t>(random));
    const std::uint16_t r = prng();
    if (static_cast<std::int16_t>(r * 2) >= 0) {
        const std::uint16_t t = static_cast<std::uint16_t>(((r & 0x7fffu) >> 7) * static_cast<std::uint32_t>(static_cast<std::int16_t>(u)));
        m_.w32(v + 100, static_cast<std::uint32_t>(m_.s32(v + 100) + static_cast<std::int32_t>((t + 0x80u) >> 8) * 10));
        return;
    }
    std::int32_t p = m_.s32(v + 100) +
                     static_cast<std::int32_t>(((((static_cast<std::uint16_t>(r * -2) >> 8) * (u & 0xffff)) & 0xffff) + 0x80) >> 8) * -10;
    m_.w32(v + 100, static_cast<std::uint32_t>(p < 0 ? 0 : p));
}

void Control::partial_apply_pitch_env_rates(Va v)
{
    const Va pb = g::partial;
    const auto time_of = [&](std::uint8_t rate_byte, Va key) -> std::uint32_t {
        const std::uint32_t b = rate_byte & 0x7f;
        if (b == 0) {
            return 0;
        }
        const std::uint32_t t = m_.u16(rate_curve + b * 2);
        if (t < 9) {
            return 0;
        }
        return (((static_cast<std::uint32_t>(m_.u16(key)) * t) >> 8 & 0xffff) * m_.u16(pitch_velocity)) >> 8;
    };
    m_.w16(v + 0x60, 0x4000);
    {
        const std::uint32_t b = m_.u8(pb + 0x20) & 0x7f;
        std::uint32_t index = 0, rate = 0xffff;
        if (b == 0 || m_.u16(rate_curve + b * 2) > 8) {
            const std::uint32_t time = b == 0 ? 0 : time_of(static_cast<std::uint8_t>(b), pitch_rate) & 0xffff;
            if (time < 0xb) {
                index = time;
            } else {
                index = 10;
                rate = 0xa0000 / time;
            }
        }
        m_.w16(v + 0x62, rate);
        m_.w16(v + 0x5e, m_.u16(env_rate_words + index * 2));
    }
    m_.w16(v + 0x20a, 0x4000);
    m_.w16(v + 0x204, time_of(m_.u8(pb + 0x21), pitch_rate));
    m_.w16(v + 0x20c, 0x4000);
    m_.w16(v + 0x206, time_of(m_.u8(pb + 0x22), pitch_rate));
    m_.w16(v + 0x20e, 0x4000);
    m_.w16(v + 0x208, time_of(m_.u8(pb + 0x23), pitch_rate));
    m_.w16(v + 0x78, 0x4000);
    {
        const std::uint32_t b = m_.u8(pb + 0x24) & 0x7f;
        std::uint32_t index = 0, rate = 0xffff;
        if (b == 0 || m_.u16(rate_curve + b * 2) >= 9) {
            const std::uint32_t time = b == 0 ? 0 : time_of(static_cast<std::uint8_t>(b), pitch_release_rate) & 0xffff;
            index = time;
            if (time > 10) {
                index = 10;
                rate = 0xa0000 / time;
            }
        }
        m_.w16(v + 0x7a, rate);
        m_.w16(v + 0x76, m_.u16(env_rate_words + index * 2));
    }
}

void Control::lfo_pitch_accumulate(Va v)
{
    const Va part = m_.ptr(v + 0x128);
    const Va lfo1 = m_.ptr(v + 0x170), lfo2 = m_.ptr(v + 0x180);
    const bool zero_ticks = m_.u16(g::tick_count) == 0;
    std::int32_t a = m_.s32(acc);
    if (m_.s8(m_.ptr(v + 0x198)) == 0) {
        a = m_.s16(lfo1 + (zero_ticks ? 8 : 6)) + m_.s16(part + 0x3ba) + a + m_.s16(lfo2 + (zero_ticks ? 0x48 : 0x46));
    } else {
        a = mod_pitch_control(part, m_.s8(m_.ptr(v + 0x198))) + a + m_.s16(lfo2 + (zero_ticks ? 0x48 : 0x46)) +
            m_.s16(lfo1 + (zero_ticks ? 8 : 6));
    }
    m_.w32(acc, static_cast<std::uint32_t>(clamp_pitch(a)));
}

void Control::voice_pitch_keyfollow(Va v)
{
    const std::uint8_t b = m_.u8(m_.ptr(v + 0x128) + 0x3db);
    m_.w8(v + 0x92, b);
    std::int32_t d = b - 0x80;
    m_.w32(shift, static_cast<std::uint32_t>(d));
    if (d == 0) {
        m_.w16(v + 0x90, 0);
        m_.w32(word_in, static_cast<std::uint32_t>(m_.s32(acc) - m_.s32(v + 0x1fc)));
        return;
    }
    const std::uint32_t k = m_.u16(key_scale + static_cast<std::uint16_t>(static_cast<std::int16_t>(m_.s8(v + 0x161))) * 2u);
    std::int16_t s;
    if (static_cast<std::int16_t>(d) < 1) {
        d = -d;
        m_.w32(shift, static_cast<std::uint32_t>(d));
        s = static_cast<std::int16_t>(-static_cast<std::int16_t>((static_cast<std::uint32_t>(d) * k) >> 8));
    } else {
        s = static_cast<std::int16_t>((static_cast<std::uint32_t>(d) * k) >> 8);
    }
    m_.w16(v + 0x90, static_cast<std::uint16_t>(s));
    m_.w32(word_in, static_cast<std::uint32_t>((s - m_.s32(v + 0x1fc)) + m_.s32(acc)));
}

void Control::voice_pitch_block_init(Va v)
{
    const Va part = m_.ptr(v + 0x128);
    const auto accumulate = [&](std::int32_t from) {
        std::int32_t a = from - 0x7e8 + (static_cast<std::int32_t>(m_.u16(part + 0x448) * 1000u) >> 13) + m_.u16(g::system);
        m_.w32(acc, static_cast<std::uint32_t>(clamp_pitch(a)));
        lfo_pitch_accumulate(v);
        std::int32_t glide = m_.s32(v + 0x8c);
        if (glide != 0) {
            const std::uint8_t porta = m_.u8(m_.ptr(v + 400));
            if (porta == 0) {
                m_.w32(v + 0x8c, 0);
            } else {
                const std::int32_t step = static_cast<std::int32_t>(m_.u16(porta_step + porta * 2u) * m_.u16(g::tick_count));
                if (glide < 0) {
                    const std::int32_t g2 = step + glide;
                    glide = g2 < 1 ? g2 : 0;
                } else {
                    glide -= step;
                    if (glide < 0) {
                        glide = 0;
                    }
                }
                m_.w32(acc, static_cast<std::uint32_t>(m_.s32(acc) + glide));
                m_.w32(v + 0x8c, static_cast<std::uint32_t>(glide));
            }
        }
        voice_pitch_keyfollow(v);
    };
    m_.w32(v + 0x84, m_.u32(v + 0x7c));
    m_.w32(acc, m_.u32(v + 100));
    m_.w32(v + 0x6c, m_.u32(acc));
    m_.w16(v + 0x5c, 0);
    m_.w32(v + 0x70, 0);
    m_.w16(v + 0x74, 0x7f00);
    m_.w32(v + 0x88, 0);
    const std::uint16_t saved = m_.u16(g::tick_count);
    accumulate(m_.s32(acc));
    m_.w16(g::tick_count, 1);
    m_.w16(g::tick_saved, saved);
    const std::int32_t start = word_of(m_.s32(word_in)) & ~1;
    std::int32_t target = start;
    std::uint32_t rate_word = 0x4fff;
    if (m_.s16(v + 0x7a) == 0) {
        m_.w32(v + 0x5e, 0x40000fff);
        m_.w32(v + 0xb8, static_cast<std::uint32_t>(start));
    } else {
        m_.w32(v + 0xb8, static_cast<std::uint32_t>(start));
        pitch_env_ramp_segment(v + 0x5c);
        accumulate(m_.s32(v + 0x6c));
        target = word_of(m_.s32(word_in)) & ~1;
        rate_word = m_.u16(v + 0x60) + 0xfffu;
    }
    m_.w32(v + 0xbc, static_cast<std::uint32_t>(target));
    m_.w32(v + 0xc0, rate_word);
    m_.w16(g::tick_count, saved);
}

void Control::voice_pitch_block_update(Va v)
{
    const Va s = g::scratch;
    const Va part = m_.ptr(v + 0x128);
    std::int32_t p;
    const auto released_mix = [&](std::uint32_t value) {
        const std::uint32_t inv = static_cast<std::uint16_t>(~m_.u16(s + 0x7c));
        return static_cast<std::int32_t>(((value & 0xffff) * inv >> 16) + m_.u32(s + 0x78) + (value >> 16) * inv);
    };
    if (m_.u16(s + 0x6e) == 0) {
        p = m_.s32(s + 0x60);
    } else {
        if (m_.u16(s + 0x64) == 0xffff) {
            m_.w16(s + 0x64, 0);
            const std::uint8_t stage = m_.u8(next_stage + m_.u8(s + 0x50));
            m_.w8(s + 0x50, stage);
            pitch_stage(stage, v);
        }
        if (m_.u16(s + 0x7c) == 0xffff) {
            m_.w8(s + 0x68, 4);
        }
        if (m_.u8(s + 0x69) == 0x7f) {
            pitch_env_ramp_segment(s + 0x50);
            if (m_.u16(s + 0x7c) == 0) {
                p = m_.s32(s + 0x60);
            } else {
                m_.w32(s + 0x60, static_cast<std::uint32_t>(released_mix(m_.u32(s + 0x60))));
                p = m_.s32(s + 0x60);
            }
        } else {
            if (m_.u8(s + 0x51) != 0x7f) {
                pitch_env_ramp_segment(s + 0x50);
            }
            pitch_env_ramp_segment(s + 0x68);
            p = m_.s32(s + 0x60);
            if (m_.u16(s + 0x7c) != 0) {
                p = released_mix(m_.u32(s + 0x60));
            }
        }
    }
    p = (static_cast<std::int32_t>(m_.u16(part + 0x448) * 1000u) >> 13) + (p - 0x7e8) + m_.s16(g::system);
    if (p < 0) {
        p = 0;
    }
    const Va lfo1 = m_.ptr(v + 0x170), lfo2 = m_.ptr(v + 0x180);
    const bool zero_ticks = m_.u16(g::tick_count) == 0;
    const std::int32_t lfo = m_.s16(lfo1 + (zero_ticks ? 8 : 6)) + m_.s16(lfo2 + (zero_ticks ? 0x48 : 0x46));
    if (m_.s8(m_.ptr(v + 0x198)) == 0) {
        p = lfo + m_.s16(part + 0x3ba) + p;
    } else {
        p = lfo + mod_pitch_control(part, m_.s8(m_.ptr(v + 0x198))) + p;
    }
    p = clamp_pitch(p);
    std::int32_t glide = m_.s32(s + 0x80);
    if (glide != 0) {
        const std::int32_t step = static_cast<std::int32_t>(m_.u16(porta_step + m_.u8(m_.ptr(v + 400)) * 2u) *
                                                            m_.u16(g::tick_count));
        if (glide < 0) {
            const std::int32_t g2 = step + glide;
            glide = g2 <= 0 ? g2 : 0;
        } else {
            glide -= step;
            if (glide < 0) {
                glide = 0;
            }
        }
        p += glide;
        m_.w32(s + 0x80, static_cast<std::uint32_t>(glide));
    }
    m_.w32(sum, static_cast<std::uint32_t>(p));
    const std::uint8_t b = m_.u8(part + 0x3db);
    std::int32_t t;
    if (m_.u8(s + 0x86) == b) {
        t = m_.s16(s + 0x84) - m_.s32(v + 0x1fc) + p;
    } else {
        m_.w8(s + 0x86, b);
        std::int16_t d = static_cast<std::int16_t>(b - 0x80);
        m_.w16(shift_t, static_cast<std::uint16_t>(d));
        if (d == 0) {
            t = p - m_.s32(v + 0x1fc);
        } else {
            const std::uint32_t k = m_.u16(key_scale + static_cast<std::uint16_t>(static_cast<std::int16_t>(m_.s8(v + 0x161))) * 2u);
            std::int16_t o;
            if (d > 0) {
                o = static_cast<std::int16_t>((static_cast<std::uint32_t>(static_cast<std::uint16_t>(d)) * k) >> 8);
            } else {
                d = static_cast<std::int16_t>(-d);
                m_.w16(shift_t, static_cast<std::uint16_t>(d));
                o = static_cast<std::int16_t>(-static_cast<std::int16_t>((k * static_cast<std::uint16_t>(d)) >> 8));
            }
            m_.w16(s + 0x84, static_cast<std::uint16_t>(o));
            t = o - m_.s32(v + 0x1fc) + p;
        }
    }
    m_.w32(total, static_cast<std::uint32_t>(t));
    m_.w32(s + 0xb0, static_cast<std::uint32_t>(word_of(t) & ~1)); // voice + 0xbc: the pitch ramp's target
    if (m_.u16(s + 0x7c) == 0) {
        m_.w32(s + 0xb4, static_cast<std::uint32_t>(m_.u16(s + 0x52)) + m_.u16(s + 0x54)); // + 0xc0: its word
    } else {
        m_.w32(s + 0xb4, static_cast<std::uint32_t>(m_.u16(s + 0x6a)) + m_.u16(s + 0x6c));
    }
}

} // namespace scva
