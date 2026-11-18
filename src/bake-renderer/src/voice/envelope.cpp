// The envelope machine shared by the TVA, TVF and pitch envelopes, as SC-VA steps them, with its integer widths
// and signs: the rate and level scalers, the three segment steppers (TVA, TVF, pitch) and the stage loaders the
// stage tables point at (tva_stages, tvf_stages, pitch_stages below, the next stage by next_stage).
//
// A segment (TVA and TVF, 0x12 bytes): +0 the stage, +1 a rate modifier (0x7f: not running), +2 the ramp's rate
// word for the stage, +4 the shape (0 the curve, 0x4000 a line), +6 the step per tick into a 0x10000 phase, +8
// where it starts, +0xa where it goes, +0xc where it is, +0xe the phase, +0x10 ticks left over from the stage
// before. The pitch segment holds 32-bit levels (+8 start, +0xc target, +0x10 value, +0x14 phase, +0x16 the
// carry).

#include "voice/control.hpp"

#include <stdexcept>

namespace scva {
namespace {

constexpr Va rate_out = 0x1819a3060;    // the rate multipliers, u16, 0x100 = 1
constexpr Va scale_curve = 0x1819a28e8; // u8
constexpr Va env_shape = 0x1819a7a90;   // the segment curve, 258 x u16
constexpr Va tva_rate_words = 0x1819a7a30; // the amp ramp's rate word per short stage (512 / n)
constexpr Va env_rate_words = 0x1819a7a00; // the same for the TVF and pitch envelopes
// the stage tables (function pointers per stage) and the functions they hold
constexpr Va tva_stages = 0x1819a2408, tvf_stages = 0x1819a2430, pitch_stages = 0x1819a17c8;
constexpr Va dispatch_noop = 0x1800052d0;
constexpr Va tva_loads[3] = {0x1800838e0, 0x180083960, 0x1800839e0}, tva_hold = 0x180083a60;
constexpr Va tvf_loads[3] = {0x1800846f0, 0x180084770, 0x1800847f0}, tvf_hold = 0x180084870;
constexpr Va pitch_loads[3] = {0x180083870, 0x180083800, 0x180083790};

// which loader (1..3), hold (4) or no-op (0) a stage table entry is, -1 for anything else
int stage_function(const Mem &m, Va table, int stage, const Va *loads, Va hold)
{
    const Va fn = m.code_pointer(table + static_cast<Va>(stage) * 8);
    if (fn == dispatch_noop) {
        return 0;
    }
    for (int i = 0; i < 3; ++i) {
        if (fn == loads[i]) {
            return i + 1;
        }
    }
    if (hold && fn == hold) {
        return 4;
    }
    return -1;
}

// the rate a modifier byte scales a segment's step by: ~rol16(c * 2, 8) * rate >> 16
std::uint32_t modified_rate(std::uint32_t rate, std::uint8_t modifier)
{
    if (modifier == 0) {
        return rate;
    }
    const std::uint16_t x = static_cast<std::uint16_t>(static_cast<std::int16_t>(static_cast<std::int8_t>(modifier)) * 2);
    const std::uint16_t r = static_cast<std::uint16_t>(~static_cast<std::uint16_t>((x << 8) | (x >> 8)));
    return (static_cast<std::uint32_t>(r) * rate) >> 16;
}

} // namespace

std::uint16_t Control::env_rate_scale(std::uint16_t base, std::int16_t modifier) const
{
    // the callers pass (table byte + 0x80) & 0xff
    std::uint16_t u = static_cast<std::uint16_t>(modifier - 0x40);
    if (u == 0) {
        return 0x100;
    }
    std::uint16_t b = base;
    if (static_cast<std::int16_t>(u) < 0) {
        b = static_cast<std::uint8_t>(-static_cast<std::int8_t>(static_cast<std::uint8_t>(b)));
        u = static_cast<std::uint16_t>(-static_cast<std::int16_t>(u));
        if (b == 0) {
            b = 0xff;
        }
    }
    b = static_cast<std::uint16_t>(b - 0x80);
    if (b == 0) {
        return 0x100;
    }
    const std::uint32_t s = m_.u8(scale_curve + u);
    std::uint16_t index;
    if (static_cast<std::int16_t>(b) < 0) {
        const std::uint32_t r = static_cast<std::uint32_t>(static_cast<std::int32_t>(static_cast<std::int16_t>(b)) *
                                                           static_cast<std::int32_t>(s) * -2) >> 8;
        index = static_cast<std::uint16_t>(0x80 - r);
    } else {
        index = static_cast<std::uint16_t>(0x80 + ((static_cast<std::uint32_t>(b) * s * 2) >> 8));
    }
    return m_.u16(rate_out + static_cast<Va>(index) * 2);
}

std::uint16_t Control::env_level_scale(std::uint8_t level, std::uint8_t modifier) const
{
    const std::int16_t l = static_cast<std::int16_t>(0x40 - level);
    if (l == 0) {
        return 0x100;
    }
    const std::int16_t mod = static_cast<std::int16_t>(modifier - 0x40);
    if (mod == 0) {
        return 0x100;
    }
    const auto curve = [&](int i) { return static_cast<std::int32_t>(m_.u8(scale_curve + static_cast<std::int16_t>(i))); };
    std::int16_t d;
    bool down; // the index counts down from 0x80
    if (l < 0) {
        if (mod >= 0) {
            d = static_cast<std::int16_t>(-(curve(mod * 2) * l));
            down = true;
        } else {
            d = static_cast<std::int16_t>(-(curve(-mod * 2) * l));
            down = false;
        }
    } else if (mod < 0) {
        d = static_cast<std::int16_t>(curve(-mod * 2) * l);
        down = true;
    } else {
        d = static_cast<std::int16_t>(curve(mod * 2) * l);
        down = false;
    }
    const std::int16_t shifted = static_cast<std::int16_t>(static_cast<std::int16_t>(d << 2) >> 8);
    const std::int16_t index = static_cast<std::int16_t>(down ? 0x80 - shifted : shifted + 0x80);
    return m_.u16(rate_out + static_cast<Va>(static_cast<std::int64_t>(index) * 2));
}

void Control::env_ramp_segment(Va seg)
{
    if (m_.u8(seg) == 4) {
        return;
    }
    const std::uint32_t base_rate = m_.u16(seg + 6);
    const std::uint32_t rate = modified_rate(base_rate, m_.u8(seg + 1));
    const std::uint32_t ticks = static_cast<std::uint16_t>(m_.u16(g::tick_count) + m_.u16(seg + 0x10));
    std::uint32_t phase = ticks * rate + m_.u16(seg + 0xe);
    m_.w16(seg + 0x10, 0);
    if (phase >= 0x10000) {
        m_.w16(seg + 0x10, (phase - 0xffff) / base_rate);
        phase = 0xffff;
    }
    m_.w16(seg + 0xe, phase);
    const std::uint16_t start = m_.u16(seg + 8), target = m_.u16(seg + 0xa);
    if (phase == 0xffff) {
        m_.w16(seg + 0xc, target);
        return;
    }
    const std::uint16_t shape = m_.u16(seg + 4);
    if (shape != 0) {
        if (shape != 0x4000) {
            m_.w16(seg + 0xc, 0);
            return;
        }
        const std::int32_t d = static_cast<std::int32_t>(target) - static_cast<std::int32_t>(start);
        if (d < 0) {
            const std::uint32_t n = static_cast<std::uint16_t>(-d);
            m_.w16(seg + 0xc, start - ((n * phase) >> 16));
        } else {
            m_.w16(seg + 0xc, start + ((static_cast<std::uint32_t>(d) * phase) >> 16));
        }
        return;
    }
    const std::uint32_t i = static_cast<std::uint8_t>(~(phase >> 8));
    const std::uint32_t frac = static_cast<std::uint8_t>(~phase);
    const std::uint16_t c0 = m_.u16(env_shape + i * 2), c1 = m_.u16(env_shape + i * 2 + 2);
    const std::uint16_t v = static_cast<std::uint16_t>(
        ((static_cast<std::uint32_t>(static_cast<std::uint16_t>(c1 - c0)) * frac) >> 8) + c0);
    const std::int32_t d = static_cast<std::int32_t>(target) - static_cast<std::int32_t>(start);
    if (d < 0) {
        const std::uint32_t n = static_cast<std::uint16_t>(-d);
        m_.w16(seg + 0xc, ((n * v) >> 16) + target);
    } else {
        m_.w16(seg + 0xc, ((static_cast<std::uint32_t>(static_cast<std::uint16_t>(~v)) * static_cast<std::uint32_t>(d)) >> 16) +
                              start);
    }
}

void Control::tvf_env_ramp_segment(Va seg)
{
    if (m_.u8(seg) == 4) {
        return;
    }
    const std::uint32_t base_rate = m_.u16(seg + 6);
    const std::uint32_t rate = modified_rate(base_rate, m_.u8(seg + 1));
    const std::uint32_t ticks = static_cast<std::uint16_t>(m_.u16(g::tick_count) + m_.u16(seg + 0x10));
    const std::uint32_t phase = ticks * rate + m_.u16(seg + 0xe);
    m_.w16(seg + 0x10, 0);
    if (phase >= 0x10000) {
        m_.w16(seg + 0x10, (phase - 0xffff) / base_rate);
        m_.w16(seg + 0xe, 0xffff);
        m_.w16(seg + 0xc, m_.u16(seg + 0xa));
        return;
    }
    m_.w16(seg + 0xe, phase);
    if (phase == 0xffff) {
        m_.w16(seg + 0xc, m_.u16(seg + 0xa));
        return;
    }
    std::int16_t out = 0;
    if (m_.u16(seg + 4) == 0x4000) {
        const std::int16_t start = m_.s16(seg + 8);
        const std::int32_t d = static_cast<std::int32_t>(m_.s16(seg + 0xa)) - start;
        if (d < 0) {
            const std::uint32_t n = static_cast<std::uint16_t>(-d);
            out = static_cast<std::int16_t>(start - static_cast<std::int16_t>((n * phase) >> 16));
        } else {
            out = static_cast<std::int16_t>(
                start + static_cast<std::int16_t>((static_cast<std::uint32_t>(static_cast<std::uint16_t>(d)) * phase) >> 16));
        }
    }
    m_.w16(seg + 0xc, static_cast<std::uint16_t>(out));
}

void Control::pitch_env_ramp_segment(Va seg)
{
    if (m_.u8(seg) == 4) {
        return;
    }
    const std::uint32_t base_rate = m_.u16(seg + 6);
    const std::uint32_t rate = modified_rate(base_rate, m_.u8(seg + 1));
    const std::uint32_t ticks = static_cast<std::uint16_t>(m_.u16(g::tick_count) + m_.u16(seg + 0x16));
    std::uint32_t phase = ticks * rate + m_.u16(seg + 0x14);
    m_.w16(seg + 0x16, 0);
    if (phase >= 0x10000) {
        m_.w16(seg + 0x16, (phase - 0xffff) / base_rate);
        phase = 0xffff;
    }
    m_.w16(seg + 0x14, phase);
    if (phase == 0xffff) {
        m_.w32(seg + 0x10, m_.u32(seg + 0xc));
        return;
    }
    const std::int32_t start = m_.s32(seg + 8);
    std::int32_t d = static_cast<std::int32_t>(static_cast<std::uint32_t>(m_.s32(seg + 0xc)) -
                                               static_cast<std::uint32_t>(start));
    if (d > 0x1f018) {
        d = 0x1f018;
    } else if (d < -0x1f018) {
        d = -0x1f018;
    }
    std::uint32_t out;
    if (d >= 0) {
        const std::uint32_t u = static_cast<std::uint32_t>(d);
        out = static_cast<std::uint32_t>(start) + (u >> 16) * phase + (((u & 0xffff) * phase) >> 16);
    } else {
        const std::uint32_t u = static_cast<std::uint32_t>(-d);
        out = static_cast<std::uint32_t>(start) - (((u & 0xffff) * phase) >> 16) - (u >> 16) * phase;
    }
    m_.w32(seg + 0x10, out);
}

// the stage loaders: the next stage's step, shape, ramp rate word and levels, from what the note on stored in
// the voice (stage 1..3 times at +0x1c6 / +0x1c8 / +0x1ca, shapes +0x1cc.., targets +0x1d2.. for the TVA)
void Control::tva_stage(int entry, Va v)
{
    const int stage = stage_function(m_, tva_stages, entry, tva_loads, tva_hold);
    if (stage < 0) {
        throw std::logic_error("an unknown TVA stage function");
    }
    if (stage == 0) {
        return; // dispatch_noop
    }
    if (stage == 4) {
        m_.w16(v + 0xe, 0x33); // tva_env_stage4_hold: into the voice, which the scratch copy then overwrites
        return;
    }
    const Va s = g::scratch;
    const std::uint32_t time = m_.u16(v + 0x1c6 + (stage - 1) * 2);
    std::uint32_t index = time;
    if (time < 0xb) {
        m_.w16(s + 6, 0xffff);
    } else {
        m_.w16(s + 6, 0xa0000 / time);
        index = 10;
    }
    m_.w16(s + 4, m_.u16(v + 0x1cc + (stage - 1) * 2));
    m_.w16(s + 2, m_.u16(tva_rate_words + index * 2));
    m_.w16(s + 8, m_.u16(s + 0xa));
    m_.w16(s + 0xa, m_.u16(v + 0x1d2 + (stage - 1) * 2));
}

void Control::tvf_stage(int entry, Va v)
{
    const Va s = g::scratch + 0x28; // the TVF segment, voice + 0x34
    const int stage = stage_function(m_, tvf_stages, entry, tvf_loads, tvf_hold);
    if (stage < 0) {
        throw std::logic_error("an unknown TVF stage function");
    }
    if (stage == 0) {
        return;
    }
    if (stage == 4) {
        m_.w16(s + 2, 0xcc); // tvf_env_stage4_hold
        return;
    }
    const std::uint32_t time = m_.u16(v + 0x1d8 + (stage - 1) * 2);
    std::uint32_t index = time;
    if (time < 0xb) {
        m_.w16(s + 6, 0xffff);
    } else {
        m_.w16(s + 6, 0xa0000 / time);
        index = 10;
    }
    m_.w16(s + 4, m_.u16(v + 0x1de + (stage - 1) * 2));
    m_.w16(s + 2, m_.u16(env_rate_words + index * 2));
    m_.w16(s + 8, m_.u16(s + 0xa));
    m_.w16(s + 0xa, m_.u16(v + 0x1e4 + (stage - 1) * 2));
}

void Control::pitch_stage(int entry, Va v)
{
    const Va s = g::scratch + 0x50; // the pitch segment, voice + 0x5c
    const int stage = stage_function(m_, pitch_stages, entry, pitch_loads, 0);
    if (stage < 0) {
        throw std::logic_error("an unknown pitch stage function");
    }
    if (stage == 0) {
        return;
    }
    const std::uint32_t time = m_.u16(v + 0x204 + (stage - 1) * 2);
    std::uint32_t index = time;
    if (time < 0xb) {
        m_.w16(s + 6, 0xffff);
    } else {
        m_.w16(s + 6, 0xa0000 / time);
        index = 10;
    }
    m_.w16(s + 4, m_.u16(v + 0x20a + (stage - 1) * 2));
    m_.w16(s + 2, m_.u16(env_rate_words + index * 2));
    m_.w32(s + 8, m_.u32(s + 0xc));
    m_.w32(s + 0xc, m_.u32(v + 0x210 + (stage - 1) * 4));
}

} // namespace scva
