// The TVA at note on and per tick, as SC-VA computes it, with its integer signs and widths: the base level (level
// byte, zone level, tone level, level key follow), the four segment levels through the amplitude curves, the
// segment times (rate curve, key follow and velocity, CC73 / 75 / 72), the volume ramp's target (CC7, CC11, the
// kit key level, the LFO tremolo slots), the volume ramp and the pan at note on, the pan and send slews.

#include "voice/control.hpp"

namespace scva {
namespace {

constexpr Va level_curve = 0x1819a2a00;   // u16 per level byte
constexpr Va amp_hi = 0x1819a2ba0, amp_lo = 0x1819a2da0; // the amplitude curve, u16 x u16 >> 16
constexpr Va vel_curve = 0x1819a2b00;     // u8
constexpr Va scale_curve = 0x1819a28e8;   // u8
constexpr Va kf_tva_level = 0x181a026a0;  // s8 per row and key
constexpr Va rate_curve = 0x1819a2900;    // u16 ticks per rate byte
constexpr Va tva_rate_words = 0x1819a7a30;
constexpr Va pan_curve = 0x1819a2fa0, pan_curve_end = 0x1819a3020; // u8
constexpr Va base_level = 0x181a1f5a8;    // g_tva_base_level
constexpr Va rate_bias = 0x181a1f5ac;     // the part's attack / decay / release offset of the segment being set
constexpr Va vel_early = 0x181a1f5b0, vel_late = 0x181a1f5b2, key_rate = 0x181a1f5b4, key_release = 0x181a1f5b6;

std::uint16_t amp_of(const Mem &m, std::uint32_t level)
{
    return static_cast<std::uint16_t>((static_cast<std::uint32_t>(m.u16(amp_hi + ((level & 0xffff) >> 8) * 2)) *
                                       m.u16(amp_lo + (level & 0xff) * 2)) >> 16);
}

} // namespace

void Control::tva_compute_base_level(Va v)
{
    const Va pb = g::partial;
    const std::int8_t kf = m_.s8(kf_tva_level + static_cast<Va>(m_.u8(pb + 0x54)) * 0x80 +
                                 static_cast<Va>(static_cast<std::int64_t>(m_.s8(v + 0x161))));
    std::uint16_t u6 = static_cast<std::uint16_t>(static_cast<std::int16_t>(kf));
    std::uint16_t u5 = static_cast<std::uint16_t>(m_.u8(pb + 0x55) - 0x40);
    const std::uint16_t own = static_cast<std::uint16_t>(~m_.u16(level_curve + m_.u8(pb + 0x53) * 2));
    std::uint32_t level = own;
    const std::uint8_t mode = m_.u8(v + 0x141);
    if (mode == 1) {
        level += m_.u8(v + 0x142);
        if (level > 0xffff) {
            level = 0xffff;
        }
    } else if (mode == 2) {
        level -= m_.u8(v + 0x142);
        if (level == 0) {
            level = 1;
        }
    } else if (own == 0) {
        level = 1;
    }
    std::uint32_t scale;
    bool add;
    if (static_cast<std::int16_t>(u5) < 0) {
        u5 = static_cast<std::uint16_t>(-static_cast<std::int16_t>(u5));
        scale = m_.u8(scale_curve + u5);
        if (kf < 0) {
            u6 = static_cast<std::uint16_t>(-static_cast<std::int16_t>(u6));
            add = true;
        } else {
            add = false;
        }
    } else {
        scale = m_.u8(scale_curve + u5);
        if (static_cast<std::int16_t>(u6) >= 0) {
            add = true;
        } else {
            u6 = static_cast<std::uint16_t>(-static_cast<std::int16_t>(u6));
            add = false;
        }
    }
    const std::uint32_t index = (static_cast<std::uint32_t>(static_cast<std::int32_t>(u6 * scale * 2) >> 8)) & 0xffff;
    const std::uint32_t term = static_cast<std::uint32_t>(m_.u8(vel_curve + index)) << 8;
    if (add) {
        level += term;
        if (level > 0xffff) {
            level = 0xffff;
        }
    } else {
        level -= term;
        if (static_cast<std::int32_t>(level) < 0) {
            level = 1;
        }
    }
    std::int32_t l = static_cast<std::int32_t>(level);
    l -= m_.u16(level_curve + static_cast<Va>(static_cast<std::uint16_t>(static_cast<std::int16_t>(m_.s8(v + 0x164)))) * 2);
    if (l < 1) {
        l = 1;
    }
    l -= m_.u16(level_curve + static_cast<Va>(m_.u8(v + 0x140)) * 2);
    if (l < 1) {
        l = 1;
    }
    l -= m_.u16(level_curve + static_cast<Va>(static_cast<std::int64_t>(m_.s8(v + 0x167)) * 2));
    if (l < 1) {
        l = 1;
    }
    m_.w32(base_level, static_cast<std::uint32_t>(l));
}

void Control::tva_compute_env_levels(Va v)
{
    const Va pb = g::partial;
    const std::int32_t base = m_.s32(base_level);
    const auto level = [&](int k) {
        return static_cast<std::uint32_t>(base - static_cast<std::int32_t>(m_.u16(level_curve + m_.u8(pb + 0x5a + k) * 2)));
    };
    m_.w8(v + 0x188, 0);
    m_.w16(v + 0x14, 0);
    std::uint32_t u = level(0);
    m_.w16(v + 0x16, static_cast<std::int32_t>(u) < 1 ? 0 : amp_of(m_, u));
    m_.w32(v + 0x28, 0xffff);
    std::int16_t s5 = 0, s6 = 0;
    u = level(1);
    if (static_cast<std::int32_t>(u) < 1) {
        m_.w16(v + 0x1d2, 0);
    } else {
        s5 = static_cast<std::int16_t>(amp_of(m_, u));
        m_.w16(v + 0x1d2, static_cast<std::uint16_t>(s5));
        if (m_.s16(v + 0x16) == 0) {
            m_.w8(v + 0x188, 1);
        }
    }
    u = level(2);
    if (static_cast<std::int32_t>(u) < 1) {
        m_.w16(v + 0x1d4, 0);
    } else {
        s6 = static_cast<std::int16_t>(amp_of(m_, u));
        m_.w16(v + 0x1d4, static_cast<std::uint16_t>(s6));
        if (s5 == 0) {
            m_.w8(v + 0x188, 1);
        }
    }
    u = level(3);
    if (static_cast<std::int32_t>(u) < 1) {
        m_.w16(v + 0x1d6, 0);
        return;
    }
    m_.w16(v + 0x1d6, amp_of(m_, u));
    if (s6 == 0) {
        m_.w8(v + 0x188, 1);
    }
}

void Control::tva_compute_env_rates(Va v)
{
    const Va pb = g::partial;
    const Va part = m_.ptr(v + 0x128);
    const auto bias_of = [&](Va a, Va b) {
        m_.w16(rate_bias, static_cast<std::uint32_t>((m_.u8(part + a) + m_.u8(part + b)) * 2 - 0x100));
    };
    // the segment time: the rate curve at (rate byte & 0x7f) + the part's offset, times the key follow and the
    // velocity scale (both 0x100 = 1); 0 under 9 ticks or below the curve
    const auto time_of = [&](std::uint8_t rate_byte, Va key, Va vel, bool clip_key) -> std::uint32_t {
        std::int16_t i = static_cast<std::int16_t>((rate_byte & 0x7f) + m_.s16(rate_bias));
        if (i < 0) {
            return 0;
        }
        if (i > 0x7f) {
            i = 0x7f;
        }
        const std::uint32_t t = m_.u16(rate_curve + static_cast<Va>(i) * 2);
        if (t < 9) {
            return 0;
        }
        std::uint32_t k = (static_cast<std::uint32_t>(m_.u16(key)) * t) >> 8;
        if (clip_key && k > 0xffff) {
            k = 0xffff;
        }
        return static_cast<std::uint16_t>((static_cast<std::uint32_t>(m_.u16(vel)) * (k & 0xffff)) >> 8);
    };
    const auto shape_of = [&](std::uint8_t rate_byte) {
        return static_cast<std::uint32_t>(rate_byte & 0x80 ? 0x4000 : 0);
    };

    bias_of(0x457, 0x3e8); // the attack: segments 0 and 1
    std::uint8_t b = m_.u8(pb + 0x5e);
    m_.w16(v + 0x10, shape_of(b));
    // segment 0 goes straight into the running segment at voice + 0xc
    {
        std::int16_t i = static_cast<std::int16_t>((b & 0x7f) + m_.s16(rate_bias));
        std::uint32_t time = 0, word_index = 0, rate = 0xffff;
        bool below = false;
        if (i >= 0) {
            if (i > 0x7f) {
                i = 0x7f;
            }
            const std::uint32_t t = m_.u16(rate_curve + static_cast<Va>(i) * 2);
            if (t < 9) {
                below = true;
            } else {
                std::uint32_t k = (static_cast<std::uint32_t>(m_.u16(key_rate)) * t) >> 8;
                if (k > 0xffff) {
                    k = 0xffff;
                }
                time = static_cast<std::uint16_t>((static_cast<std::uint32_t>(m_.u16(vel_early)) * (k & 0xffff)) >> 8);
            }
        }
        if (!below) {
            if (time < 0xb) {
                word_index = time;
            } else {
                word_index = 10;
                rate = 0xa0000 / time;
            }
        }
        m_.w16(v + 0x12, rate);
        m_.w16(v + 0xe, m_.u16(tva_rate_words + word_index * 2));
    }
    b = m_.u8(pb + 0x5f);
    m_.w16(v + 0x1cc, shape_of(b));
    m_.w16(v + 0x1c6, time_of(b, key_rate, vel_early, true));

    bias_of(0x458, 0x3e9); // the decay: segments 2 and 3
    b = m_.u8(pb + 0x60);
    m_.w16(v + 0x1ce, shape_of(b));
    m_.w16(v + 0x1c8, time_of(b, key_rate, vel_late, true));
    b = m_.u8(pb + 0x61);
    m_.w16(v + 0x1d0, shape_of(b));
    m_.w16(v + 0x1ca, time_of(b, key_rate, vel_late, true));

    bias_of(0x459, 0x3ea); // the release
    b = m_.u8(pb + 0x62);
    m_.w16(v + 0x24, shape_of(b));
    std::uint32_t time = 0;
    {
        std::int16_t i = static_cast<std::int16_t>((b & 0x7f) + m_.s16(rate_bias));
        if (i >= 0) {
            if (i > 0x7f) {
                i = 0x7f;
            }
            const std::uint32_t t = m_.u16(rate_curve + static_cast<Va>(i) * 2);
            if (t > 8) {
                std::uint32_t k = static_cast<std::uint32_t>(m_.u16(key_release)) * t;
                std::uint32_t k16 = k >> 8 > 0xffff ? 0xffff : static_cast<std::uint16_t>(k >> 8);
                time = (k16 * m_.u16(vel_late)) >> 8;
            }
        }
    }
    m_.w16(v + 0x32, time);
    std::uint32_t word_index = time & 0xffff, rate = 0xffff;
    if ((time & 0xffff) > 10) {
        word_index = 10;
        rate = 0xa0000 / (time & 0xffff);
    }
    m_.w16(v + 0x26, rate);
    m_.w16(v + 0x22, m_.u16(tva_rate_words + word_index * 2));
}

std::uint32_t Control::voice_volume_apply(Va v)
{
    const Va part = m_.ptr(v + 0x128);
    if (m_.u8(part + 0x44f) == 0) {
        return 0;
    }
    const std::uint32_t u = ((static_cast<std::uint32_t>(m_.s8(part + 0x464) * m_.u8(part + 0x3dc)) & 0xffff) *
                             m_.u8(g::system + 2) >> 6) & 0xffff;
    const Va kit = m_.ptr(v + 0x158);
    std::uint32_t prod;
    if (kit == 0) {
        prod = u * 0x10410;
    } else {
        const std::uint32_t k = m_.u8(kit + 0x100 + static_cast<Va>(static_cast<std::int64_t>(m_.s8(v + 0x160))));
        prod = ((k * u >> 7) & 0xffff) * 0x1061c;
    }
    const std::uint32_t level = (prod >> 16) & 0xffff;
    if (level == 0) {
        return 0;
    }
    const std::uint32_t squared = (level * level) >> 16;
    const std::int8_t c = m_.s8(m_.ptr(v + 0x198));
    std::int32_t s5;
    if (c == 0) {
        s5 = m_.s16(part + 0x3be);
    } else {
        const std::uint8_t b = m_.u8(part + 0x422);
        std::int16_t s = b < 0x40 ? static_cast<std::int16_t>(-((static_cast<std::int32_t>(0x40 - b) * c) >> 1))
                                  : static_cast<std::int16_t>((static_cast<std::int32_t>(b - 0x40) * c) >> 1);
        s = static_cast<std::int16_t>(s + m_.s16(part + 0x3a6));
        if (s < 0) {
            std::int16_t n = static_cast<std::int16_t>(-s);
            if (4000 < -s) {
                n = 4000;
            }
            s = static_cast<std::int16_t>(
                -static_cast<std::int16_t>((static_cast<std::uint32_t>(static_cast<std::uint16_t>(n << 4)) * 0x820d) >> 16));
        } else {
            if (4000 < s) {
                s = 4000;
            }
            s = static_cast<std::int16_t>((static_cast<std::uint32_t>(static_cast<std::uint16_t>(s << 4)) * 0x820d) >> 16);
        }
        s5 = s;
    }
    std::int32_t sum = m_.s16(m_.ptr(v + 0x180) + 0x40) + m_.s16(m_.ptr(v + 0x170)) + s5;
    if (sum > 0x7f00) {
        sum = 0x7f00;
    } else if (sum < -0x7f00) {
        sum = -0x7f00;
    }
    const std::int32_t x = static_cast<std::int32_t>(squared) * sum;
    const std::uint32_t g = static_cast<std::uint16_t>(x / 0x7f00 + static_cast<std::int32_t>(squared));
    const std::uint32_t scaled = g * 0x208;
    return scaled > 0xffffff ? 0xffff : (scaled >> 8) & 0xffff;
}

void Control::tvf_env_prep(Va v)
{
    const std::uint32_t vol = voice_volume_apply(v) & 0xffff;
    m_.w32(v + 0xa0, 0xcc);
    m_.w32(v + 0x98, vol * 4);
    m_.w32(v + 0x9c, vol * 4);
    m_.w32(v + 0xb4, ((m_.u32(v + 0xa8) >> 2 & 0xffff) * vol) >> 16);
    const Va part = m_.ptr(v + 0x128), kit = m_.ptr(v + 0x158);
    const std::uint8_t mode = m_.u8(part + 0x451);
    m_.w8(v + 7, mode);
    if (mode == 2) {
        m_.w32(v + 0xf4, 0x9600);
        m_.w16(v + 0xf8, 0xffff);
        return;
    }
    if (mode == 3) {
        m_.w32(v + 0xf4, 0x96000000);
        m_.w16(v + 0xf8, 0xffff);
        return;
    }
    const std::uint8_t pan = m_.u8(part + 0x3dd);
    const auto random = [&] {
        if (m_.s16(v + 0xf8) == -1) {
            return;
        }
        // the random pan: the first voice of the note's chain draws, every voice of it takes the pan
        Va first = v;
        for (Va p = m_.ptr(v + 0x110); p != 0; p = m_.ptr(p + 0x110)) {
            first = p;
        }
        const std::uint16_t r = prng();
        const std::uint32_t left = m_.u8(pan_curve_end - (r >> 9)), right = m_.u8(pan_curve + (r >> 9));
        for (Va p = first; p != 0; p = m_.ptr(p + 0x108)) {
            m_.w16(p + 0xf8, 0xffff);
            m_.w16(p + 0xf4, left << 9);
            m_.w16(p + 0xf6, right << 9);
        }
    };
    if (pan == 0) {
        random();
        return;
    }
    std::uint16_t p = pan;
    if (kit != 0) {
        const std::uint8_t kp = m_.u8(kit + 0x280 + static_cast<Va>(static_cast<std::int64_t>(m_.s8(v + 0x160))));
        if (kp == 0) {
            random();
            return;
        }
        const std::int16_t q = static_cast<std::int16_t>(pan + (kp - 0x40));
        p = q >= 0x80 ? 0x7f : q < 0 ? 0 : static_cast<std::uint16_t>(q);
    }
    const std::uint8_t master = m_.u8(g::system + 6);
    const std::int16_t shift = master == 0 ? static_cast<std::int16_t>(m_.s16(v + 0x1b8) - 0x40)
                                           : static_cast<std::int16_t>(master + m_.s16(v + 0x1b8) - 0x80);
    const std::int16_t q = static_cast<std::int16_t>(p + shift);
    const std::uint16_t r = q >= 0x80 ? 0x7f : q < 0 ? 0 : static_cast<std::uint16_t>(q);
    m_.w16(v + 0xf8, r);
    m_.w16(v + 0xf6, static_cast<std::uint32_t>(m_.u8(pan_curve + r)) << 9);
    m_.w16(v + 0xf4, static_cast<std::uint32_t>(m_.u8(pan_curve_end - r)) << 9);
}

void Control::voice_pan_slew(Va v)
{
    const Va s = g::scratch;
    const Va pos = s + 0xec; // voice + 0xf8, the pan position the slew moves
    if (m_.u16(pos) == 0xffff) {
        return;
    }
    const Va part = m_.ptr(v + 0x128), kit = m_.ptr(v + 0x158);
    std::uint16_t p = m_.u8(part + 0x3dd);
    if (kit != 0) {
        const std::int16_t q = static_cast<std::int16_t>(
            p + (m_.u8(kit + 0x280 + static_cast<Va>(static_cast<std::int64_t>(m_.s8(v + 0x160)))) - 0x40));
        p = q >= 0x80 ? 0x7f : q < 0 ? 0 : static_cast<std::uint16_t>(q);
    }
    const std::uint8_t master = m_.u8(g::system + 6);
    const std::int16_t shift = master == 0 ? static_cast<std::int16_t>(m_.s16(v + 0x1b8) - 0x40)
                                           : static_cast<std::int16_t>(master + m_.s16(v + 0x1b8) - 0x80);
    std::int16_t q = static_cast<std::int16_t>(p + shift);
    const std::uint16_t want = q >= 0x80 ? 0x7f : q < 0 ? 0 : static_cast<std::uint16_t>(q);
    const std::uint16_t at = m_.u16(pos);
    if (want == at) {
        return;
    }
    const std::int16_t d = static_cast<std::int16_t>(want - at);
    std::uint16_t next;
    if (d >= 2) {
        next = static_cast<std::uint16_t>(at + 2);
    } else if (d >= 1) {
        next = static_cast<std::uint16_t>(at + 1);
    } else if (d >= -1) {
        next = static_cast<std::uint16_t>(at - 1);
    } else {
        next = static_cast<std::uint16_t>(at - 2);
    }
    m_.w16(pos, next);
    m_.w16(s + 0xe8, static_cast<std::uint32_t>(m_.u8(pan_curve_end - next)) << 9); // voice + 0xf4
    m_.w16(s + 0xea, static_cast<std::uint32_t>(m_.u8(pan_curve + next)) << 9);     // voice + 0xf6
}

void Control::voice_send_slew(Va v)
{
    const Va s = g::scratch;
    const Va words = s + 0xe4; // voice + 0xf0 (u16 send 2) and + 0xf2 (u16 send 3)
    std::uint32_t w = m_.u32(words);
    std::int16_t hi = static_cast<std::int16_t>(w >> 16);
    const Va part = m_.ptr(v + 0x128), kit = m_.ptr(v + 0x158);
    std::uint32_t bus = (w >> 16) & 0x3f;
    if (bus == 0xf) {
        return;
    }
    const std::uint8_t reverb = m_.u8(part + 0x3e3);
    std::uint32_t lo_level = reverb;
    std::uint32_t hi_level = 0;
    bool hi_slews = false;
    const Va key = kit != 0 ? kit + static_cast<Va>(static_cast<std::int64_t>(m_.s8(v + 0x160))) : 0;
    if (bus == 0x30 || bus == 0x3d) {
        const std::uint8_t depth = m_.u8(part + (bus == 0x30 ? 0x44a : 0x3e2));
        hi_level = depth;
        if (kit != 0) {
            const std::uint8_t kd = m_.u8(key + (bus == 0x30 ? 0x400 : 0x380));
            lo_level = static_cast<std::uint16_t>(m_.u8(key + 0x300) * reverb * 2 + 0xff) >> 8;
            hi_level = static_cast<std::uint16_t>(kd * depth * 2 + 0xff) >> 8;
        }
        hi_slews = true;
    } else if (kit != 0) {
        lo_level = static_cast<std::uint16_t>(m_.u8(key + 0x300) * reverb * 2 + 0xff) >> 8;
    }
    const auto step = [](std::int32_t d, std::int16_t at) {
        if (d >= 2) {
            return static_cast<std::int16_t>(at + 0x200);
        }
        if (d >= 1) {
            return static_cast<std::int16_t>(at + 0x100);
        }
        if (d >= -1) {
            return static_cast<std::int16_t>(at - 0x100);
        }
        return static_cast<std::int16_t>(at - 0x200);
    };
    if (hi_slews) {
        const std::int32_t d = static_cast<std::int32_t>(hi_level * 0x200) - static_cast<std::int32_t>((w >> 16) & 0xffc0);
        if (d != 0) {
            hi = step(d, hi);
            w = (static_cast<std::uint32_t>(static_cast<std::uint16_t>(hi)) << 16) | (w & 0xffff);
        }
    }
    const std::int32_t d = static_cast<std::int32_t>(lo_level * 0x200) - static_cast<std::int32_t>(w & 0xffc0);
    if (d != 0) {
        w = (w & 0xffff0000) | static_cast<std::uint16_t>(step(d, static_cast<std::int16_t>(w)));
    }
    m_.w32(words, w);
}

} // namespace scva
