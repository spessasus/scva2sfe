// The TVF at note on and per tick, as SC-VA computes it: the filter setup (type, cutoff key follow, the
// envelope's levels and velocity depth, the first cutoff and damping), the envelope's level conversion and rates,
// the cutoff, the tick (envelope, cutoff sum, damping) and the LFO's cutoff share, with the per filter type steps
// of filter_tables below (damping byte, cutoff sum, the cutoff warp, the damping value).
//
// The cutoff work struct (at_note_on and at_tick below): +0 the cutoff (u16, its high byte also
// indexes the warp and the damping tables), +8 the damping value (u32), +0xc 0: read the voice's own envelope
// and damping byte (voice + 0xec / + 0xee), else the tick's scratch copy.

#include "voice/control.hpp"

#include <stdexcept>

namespace scva {
namespace {

constexpr Va type_words = 0x181987b00;   // u32 per filter type: the SVF tap word
constexpr Va kf_cutoff = 0x181a02a20;    // u16 per row and key
constexpr Va kf_scale_up = 0x1819a2fa8, kf_scale_down = 0x1819a3028; // u16
constexpr Va reso_curve = 0x1819a2b88;   // s16
constexpr Va level_curve = 0x1819a2890;  // g_tvf_env_level_curve, u8
constexpr Va kf_tvfrate = 0x181a03920, kf_tvfrate2 = 0x181a03620;
constexpr Va rate_curve = 0x1819a2900;
constexpr Va env_rate_words = 0x1819a7a00;
constexpr Va warp = 0x1819a83d0;         // u16, 129 entries
constexpr Va ceiling = 0x1819a7ed0;      // u16 per damping byte
constexpr Va q_lowpass = 0x1819a7cd0, q_type6 = 0x1819a7fd0; // u16
constexpr Va depth = 0x181a1f5c0, depth_inverted = 0x181a1f5c2, env_depth = 0x181a1f5c4, rate_bias = 0x181a1f5c6;
constexpr Va key_rate = 0x181a1f5b8, vel_early = 0x181a1f5ba, vel_late = 0x181a1f5bc, key_release = 0x181a1f5be;
constexpr Va at_note_on = 0x181a22840, at_tick = 0x181a22850;
constexpr Va dispatch_noop = 0x1800052d0;
constexpr Va damping_byte_fn = 0x1800845c0, cutoff_fn = 0x180084200, cutoff5_fn = 0x180084270;
constexpr Va warp_fn = 0x180084470, warp5_fn = 0x1800844f0;
constexpr Va q0_fn = 0x180084620, q_fn = 0x180084660, q5_fn = 0x1800846a0, q6_fn = 0x180084680;

// the four per filter type function tables (damping byte, cutoff sum, warp, damping value), 7 types each
constexpr Va filter_tables[4] = {0x1819a2500, 0x1819a24c8, 0x1819a2490, 0x1819a2458};

} // namespace

void Control::tvf_filter_stage(int which, Va v, Va out)
{
    const std::uint8_t type = m_.u8(v + 0x1f5);
    if (type > 6) {
        throw std::logic_error("filter type past the tables");
    }
    const Va fn = m_.code_pointer(filter_tables[which] + type * 8u);
    const bool own = m_.u8(out + 0xc) == 0;
    const Va env = own ? v + 0xec : g::scratch + 0xe0;
    const Va damp = own ? v + 0xee : g::scratch + 0xe2;
    const Va part = m_.ptr(v + 0x128);
    switch (fn) {
    case dispatch_noop:
        return;
    case damping_byte_fn: {
        const std::int16_t s = static_cast<std::int16_t>(((0x80 - m_.u8(part + 0x456)) - m_.u8(part + 999)) * 2 +
                                                         m_.u8(v + 500));
        m_.w8(damp, s > 0x7f ? 0x7f : s < 0 ? 0 : s);
        return;
    }
    case cutoff_fn: {
        const std::int32_t c = ((m_.u8(part + 0x3e6) - 0x80) + m_.u8(part + 0x455)) * 0x100 + m_.s16(v + 0x1f0) +
                               m_.s16(env);
        m_.w16(out, c > 0x7fff ? 0x7fff : c < 0 ? 0 : static_cast<std::uint32_t>(c));
        return;
    }
    case warp_fn: {
        const std::uint16_t old = m_.u16(out);
        const std::uint32_t hi = old >> 8;
        std::uint16_t w = m_.u16(warp + hi * 2);
        if ((old & 0xff) != 0) {
            w = static_cast<std::uint16_t>(
                ((static_cast<std::uint32_t>(static_cast<std::uint16_t>(m_.u16(warp + hi * 2 + 2) - w)) * (old & 0xff)) >> 8) + w);
        }
        const std::uint16_t top = m_.u16(ceiling + m_.u8(damp) * 2u);
        m_.w16(out, top < w ? top : w);
        return;
    }
    case q0_fn:
        if (m_.u8(damp) == 0x40) {
            m_.w32(out + 8, static_cast<std::uint32_t>(m_.u16(q_lowpass + m_.u8(out + 1) * 2u)) << 2);
        } else {
            m_.w32(out + 8, static_cast<std::uint32_t>(m_.u8(damp)) << 11);
        }
        return;
    case q_fn:
        m_.w32(out + 8, static_cast<std::uint32_t>(m_.u8(damp)) << 11);
        return;
    case q6_fn:
        m_.w32(out + 8, static_cast<std::uint32_t>(m_.u16(q_type6 + m_.u8(out + 1) * 2u)) << 2);
        return;
    default:
        // type 5 (cutoff5_fn, warp5_fn, q5_fn): no partial of the tone table has it
        throw std::logic_error("filter type 5 is not ported (no partial uses it)");
    }
}

std::uint32_t Control::tvf_env_level_conv(Va v, std::uint8_t level)
{
    const std::uint16_t kf = m_.u16(v + 0x3c);
    const std::int16_t d = static_cast<std::int16_t>(level - 0x40);
    const std::uint16_t a = static_cast<std::uint16_t>(d < 0 ? -d : d);
    if (a == 0) {
        return kf;
    }
    const std::uint32_t curve = m_.u8(level_curve + a);
    const std::uint16_t inv = static_cast<std::uint16_t>(static_cast<std::int16_t>(m_.s8(depth_inverted)));
    const std::uint16_t sub = d >= 0 ? inv : static_cast<std::uint16_t>(~inv);
    const std::uint32_t p = static_cast<std::uint32_t>(m_.u16(env_depth)) * m_.u16(depth);
    const std::uint16_t amount = static_cast<std::uint16_t>(((((p * 2) >> 16) & 0xffff) * curve) >> 7);
    if (sub == 0) {
        const std::uint16_t r = static_cast<std::uint16_t>(amount + kf);
        if (static_cast<std::int16_t>(kf) >= 0 && static_cast<std::int16_t>(r) < 0) {
            return 0x7fff;
        }
        return r;
    }
    if (static_cast<std::int16_t>(kf) >= 0) {
        return static_cast<std::uint16_t>(kf - amount);
    }
    const std::uint16_t r = static_cast<std::uint16_t>(amount - kf);
    if (static_cast<std::int16_t>(r) < 0) {
        return 0x8001;
    }
    return static_cast<std::uint16_t>(-static_cast<std::int16_t>(r));
}

void Control::tvf_compute_env_rates(Va v)
{
    const Va pb = g::partial;
    const Va part = m_.ptr(v + 0x128);
    const auto bias = [&](Va a, Va b) {
        m_.w16(rate_bias, static_cast<std::uint32_t>((m_.u8(part + a) + m_.u8(part + b)) * 2 - 0x100));
    };
    const auto time_of = [&](std::uint8_t rate_byte, Va key, Va vel) -> std::uint16_t {
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
        return static_cast<std::uint16_t>((((static_cast<std::uint32_t>(m_.u16(key)) * t) >> 8 & 0xffff) *
                                           m_.u16(vel)) >> 8);
    };
    if ((m_.u8(pb + 0xe) & 0x10) == 0) {
        m_.w16(rate_bias, 0);
    } else {
        bias(0x457, 1000); // the attack, when the tone lets CC73 move its TVF envelope
    }
    m_.w16(v + 0x38, 0x4000);
    std::uint16_t time = time_of(m_.u8(pb + 0x3f), key_rate, vel_early);
    std::uint32_t index = time, rate = 0xffff;
    if (time >= 0xb) {
        index = 10;
        rate = 0xa0000 / time;
    }
    m_.w16(v + 0x3a, rate);
    m_.w16(v + 0x36, m_.u16(env_rate_words + index * 2));
    m_.w16(v + 0x1de, 0x4000);
    m_.w16(v + 0x1d8, time_of(m_.u8(pb + 0x40), key_rate, vel_early));
    bias(0x458, 0x3e9); // the decay
    m_.w16(v + 0x1e0, 0x4000);
    m_.w16(v + 0x1da, time_of(m_.u8(pb + 0x41), key_rate, vel_late));
    m_.w16(v + 0x1e2, 0x4000);
    m_.w16(v + 0x1dc, time_of(m_.u8(pb + 0x42), key_rate, vel_late));
    bias(0x459, 0x3ea); // the release
    m_.w16(v + 0x4c, 0x4000);
    time = time_of(m_.u8(pb + 0x43), key_release, vel_late);
    index = time;
    rate = 0xffff;
    if (time > 9) {
        index = 10;
        rate = 0xa0000 / time; // 10 gives 0x10000, stored as 0
    }
    m_.w16(v + 0x4e, rate);
    m_.w16(v + 0x4a, m_.u16(env_rate_words + index * 2));
}

std::uint32_t Control::tvf_cutoff_compute(Va v)
{
    const Va out = at_note_on;
    tvf_filter_stage(0, v, out);
    const Va damp = m_.u8(out + 0xc) != 0 ? g::scratch + 0xe2 : v + 0xee;
    if (m_.u8(damp) < 4) {
        m_.w8(damp, 4);
    }
    tvf_filter_stage(1, v, out);
    tvf_cutoff_add_lfo(v, out);
    tvf_filter_stage(2, v, out);
    tvf_filter_stage(3, v, out);
    return static_cast<std::uint32_t>(m_.u16(out)) << 2;
}

void Control::tvf_cutoff_add_lfo(Va v, Va out)
{
    const Va part = m_.ptr(v + 0x128);
    const std::int8_t c = m_.s8(m_.ptr(v + 0x198));
    std::int32_t sum;
    if (c == 0) {
        sum = m_.s16(m_.ptr(v + 0x180) + 0x42) + m_.s16(m_.ptr(v + 0x170) + 2) + m_.s16(part + 0x3bc) + m_.u16(out);
    } else {
        const std::uint8_t b = m_.u8(part + 0x421);
        std::int16_t s = b < 0x40 ? static_cast<std::int16_t>(-((static_cast<std::int32_t>(0x40 - b) * c) >> 1))
                                  : static_cast<std::int16_t>((static_cast<std::int32_t>(b - 0x40) * c) >> 1);
        s = static_cast<std::int16_t>(s + m_.s16(part + 0x3a4));
        if (s < 0) {
            std::int16_t n = static_cast<std::int16_t>(-s);
            if (4000 < -s) {
                n = 4000;
            }
            s = static_cast<std::int16_t>(
                -static_cast<std::int16_t>((static_cast<std::uint32_t>(static_cast<std::uint16_t>(n << 3)) * 0xc49c) >> 16));
        } else {
            if (4000 < s) {
                s = 4000;
            }
            s = static_cast<std::int16_t>((static_cast<std::uint32_t>(static_cast<std::uint16_t>(s << 3)) * 0xc49c) >> 16);
        }
        sum = s + m_.u16(out) + m_.s16(m_.ptr(v + 0x180) + 0x42) + m_.s16(m_.ptr(v + 0x170) + 2);
    }
    m_.w16(out, sum > 0x7fff ? 0x7fff : sum < 0 ? 0 : static_cast<std::uint32_t>(sum));
}

void Control::partial_compute_filter(Va v)
{
    const Va pb = g::partial;
    const std::uint8_t type = m_.u8(pb + 0x31);
    m_.w8(v + 0x1f5, type);
    if (type > 2 && static_cast<std::uint8_t>(type - 4) > 2) {
        // types 3 and 7 and up: the high tap on fixed coefficients, no envelope
        m_.w8(v + 499, 0xff);
        m_.st<std::uint64_t>(v + 200, 0);
        m_.w32(v + 0xd0, 0x4fff);
        m_.w32(v + 0xdc, 0x20000);
        m_.w32(v + 0xe0, 0x100);
        m_.w32(v + 0x1ec, 0x800);
        return;
    }
    m_.w8(v + 499, 0);
    m_.w32(v + 0x1ec, m_.u32(type_words + type * 4u));
    m_.w8(v + 500, m_.u8(pb + 0x30));
    m_.w8(v + 0x1f2, m_.u8(pb + 0x2f));
    // the cutoff key follow
    const std::uint16_t kf = m_.u16(kf_cutoff + ((m_.u8(pb + 0x32) & 0xfu) * 0x80 +
                                                 static_cast<std::uint16_t>(static_cast<std::int16_t>(m_.s8(v + 0x161)))) * 2);
    const std::uint8_t b33 = m_.u8(pb + 0x33);
    const std::uint32_t mag = static_cast<std::uint16_t>(static_cast<std::int16_t>(kf) < 0 ? -static_cast<std::int16_t>(kf) : kf);
    bool negative;
    std::uint32_t scale;
    if (b33 < 0x40) {
        scale = m_.u16(kf_scale_down + 0x80 - b33 * 2u);
        negative = static_cast<std::int16_t>(kf) >= 0;
    } else {
        scale = m_.u16(kf_scale_up + b33 * 2u);
        negative = static_cast<std::int16_t>(kf) < 0;
    }
    const std::int16_t follow = static_cast<std::int16_t>(negative ? -static_cast<std::int16_t>((mag * scale) >> 9)
                                                                   : static_cast<std::int16_t>((mag * scale) >> 9));
    m_.w16(v + 0x3c, static_cast<std::uint16_t>(follow));
    // the envelope's depth by velocity
    const std::uint16_t u9 = static_cast<std::uint16_t>(m_.u8(pb + 0x4a) - 0x40);
    std::int16_t dep;
    bool inverted = false;
    if (u9 == 0) {
        dep = 0x7fff;
    } else {
        const std::int16_t s11 = static_cast<std::int16_t>(0x7f - m_.s8(v + 0x165));
        if (static_cast<std::int16_t>(u9) < 0) {
            dep = static_cast<std::int16_t>(m_.s16(reso_curve + static_cast<std::uint16_t>(-static_cast<std::int16_t>(u9)) * 2u) * s11 - 0x7fff);
        } else {
            dep = static_cast<std::int16_t>(0x7fff - m_.s16(reso_curve + u9 * 2u) * s11);
        }
        if (dep < 0) {
            dep = static_cast<std::int16_t>(-dep);
            inverted = true;
        }
    }
    m_.w16(depth, static_cast<std::uint16_t>(dep));
    m_.w8(depth_inverted, inverted ? 1 : 0);
    m_.w16(env_depth, m_.u16(pb + 0x38));
    m_.w16(v + 0x3e, tvf_env_level_conv(v, m_.u8(pb + 0x3a)));
    m_.w16(v + 0x50, 0);
    m_.w16(v + 0x52, tvf_env_level_conv(v, m_.u8(pb + 0x3e)));
    m_.w16(v + 0x1e4, tvf_env_level_conv(v, m_.u8(pb + 0x3b)));
    m_.w16(v + 0x1e6, tvf_env_level_conv(v, m_.u8(pb + 0x3c)));
    m_.w16(v + 0x1e8, tvf_env_level_conv(v, m_.u8(pb + 0x3d)));
    const std::int32_t base = m_.u8(v + 0x1f2) * 0x100 + m_.s16(v + 0x3c);
    m_.w16(v + 0x1f0, base > 0x7fff ? 0x7fff : static_cast<std::uint32_t>(base));
    const std::int16_t f = m_.s16(v + 0x3c);
    for (Va o : {Va(0x3e), Va(0x52), Va(0x1e4), Va(0x1e6), Va(0x1e8)}) {
        m_.w16(v + o, static_cast<std::uint16_t>(m_.s16(v + o) - f));
    }
    m_.w16(v + 0x3c, 0);
    const Va part = m_.ptr(v + 0x128);
    const std::int16_t reso = static_cast<std::int16_t>(((0x80 - m_.u8(part + 0x456)) - m_.u8(part + 999)) * 2 +
                                                        m_.u8(v + 500));
    m_.w8(v + 0xee, reso >= 0x80 ? 0x7f : reso < 0 ? 0 : reso);
    const Va key = static_cast<std::uint16_t>(static_cast<std::int16_t>(m_.s8(v + 0x161)));
    m_.w16(key_rate, env_rate_scale(static_cast<std::uint8_t>(m_.u8(kf_tvfrate + m_.u8(pb + 0x46) * 0x80u + key) + 0x80),
                                    m_.u8(pb + 0x48)));
    m_.w16(key_release,
           env_rate_scale(static_cast<std::uint8_t>(m_.u8(kf_tvfrate2 + m_.u8(pb + 0x47) * 0x80u + key) + 0x80),
                          m_.u8(pb + 0x49)));
    m_.w16(vel_early, env_level_scale(m_.u8(v + 0x165), m_.u8(pb + 0x4b)));
    m_.w16(vel_late, env_level_scale(m_.u8(v + 0x165), m_.u8(pb + 0x4c)));
    tvf_compute_env_rates(v);
    m_.w8(at_note_on + 0xc, 0);
    m_.w16(v + 0xec, m_.u16(v + 0x3c));
    m_.w16(v + 0x34, 0);
    m_.w32(v + 0x42, 0);
    m_.w16(v + 0x48, 0x7f00);
    m_.w32(v + 0x56, 0);
    m_.w32(v + 200, tvf_cutoff_compute(v));
    // one tick of the envelope from its start: the cutoff ramp glides from the first value to this one
    const std::uint16_t saved = m_.u16(g::tick_count);
    m_.w16(g::tick_count, 1);
    m_.w16(g::tick_saved, saved);
    tvf_env_ramp_segment(v + 0x34);
    m_.w16(v + 0x54, m_.u16(v + 0x50));
    m_.w16(g::tick_count, saved);
    m_.w16(v + 0xec, m_.u16(v + 0x40));
    m_.w32(v + 0xcc, tvf_cutoff_compute(v));
    m_.w32(v + 0xd0, static_cast<std::uint32_t>(m_.u16(v + 0x38)) + m_.u16(v + 0x36));
    m_.w32(v + 0xdc, m_.u32(at_note_on + 8));
    m_.w32(v + 0xe0, 0x100);
}

void Control::tvf_env_cutoff_update(Va v)
{
    const Va s = g::scratch;
    const Va out = at_tick;
    m_.w8(out + 0xc, 1);
    if (m_.u8(v + 499) != 0) {
        return;
    }
    if (m_.u16(s + 0x36) == 0xffff) {
        // the envelope's segment ended last tick: the next stage
        m_.w16(s + 0x36, 0);
        const std::uint8_t stage = m_.u8(0x1819a3054 + m_.u8(s + 0x28));
        m_.w8(s + 0x28, stage);
        tvf_stage(stage, v);
    }
    if (m_.u16(s + 0x4a) == 0xffff) {
        m_.w8(s + 0x3c, 4);
    }
    std::int16_t value;
    const auto mix = [&](std::uint16_t inv) {
        const std::int16_t env = m_.s16(s + 0x34);
        if (env >= 0) {
            return static_cast<std::int16_t>(((static_cast<std::uint32_t>(inv) * static_cast<std::uint16_t>(env)) >> 16) +
                                             m_.u16(s + 0x48));
        }
        return static_cast<std::int16_t>(
            m_.u16(s + 0x48) -
            ((static_cast<std::uint32_t>(static_cast<std::uint16_t>(-env)) * inv) >> 16));
    };
    if (m_.u8(s + 0x3d) == 0x7f) {
        tvf_env_ramp_segment(s + 0x28);
        value = m_.s16(s + 0x34);
        if (m_.u16(s + 0x4a) != 0) {
            value = mix(static_cast<std::uint16_t>(~m_.u16(s + 0x4a)));
        }
    } else {
        if (m_.u8(s + 0x29) != 0x7f) {
            tvf_env_ramp_segment(s + 0x28);
        }
        tvf_env_ramp_segment(s + 0x3c);
        value = mix(static_cast<std::uint16_t>(~m_.u16(s + 0x4a)));
    }
    m_.w16(s + 0xe0, static_cast<std::uint16_t>(value)); // voice + 0xec: the envelope's value
    tvf_filter_stage(0, v, out);
    const Va damp = s + 0xe2;
    if (m_.u8(damp) < 4) {
        m_.w8(damp, 4);
    }
    tvf_filter_stage(1, v, out);
    tvf_cutoff_add_lfo(v, out);
    tvf_filter_stage(2, v, out);
    tvf_filter_stage(3, v, out);
    m_.w32(s + 0xd4, 0x100);                 // voice + 0xe0: the damping ramp's rate
    m_.w32(s + 0xd0, m_.u32(out + 8));       // voice + 0xdc: its target
    m_.w32(s + 0xc4, static_cast<std::uint32_t>(m_.u16(s + 0x2a)) + m_.u16(s + 0x2c)); // + 0xd0: the cutoff ramp's word
    m_.w32(s + 0xc0, static_cast<std::uint32_t>(m_.u16(out)) << 2);                   // + 0xcc: its target
}

} // namespace scva
