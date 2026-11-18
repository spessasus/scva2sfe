#include "voice/ramp.hpp"

namespace scva::ramp {
namespace {

// the per voice target arrays the control code fills (u32 per voice)
constexpr Va q_target = 0x181a70c60, pitch_target = 0x181a70d60, cutoff_target = 0x181a70e60;
constexpr Va gain4_target = 0x181a70f60, amp_target = 0x181a71060;
constexpr Va q_rate = 0x181a71160, pitch_rate = 0x181a71260, cutoff_rate = 0x181a71360, gain4_rate = 0x181a71460;
constexpr Va amp_rate = 0x181a71560, pitch_start = 0x181a71660, cutoff_start = 0x181a71760;
constexpr Va gain4_start = 0x181a71860, amp_start = 0x181a71960, q_start4 = 0x181a71c60;
// the packed send words (u16 per voice, level << 6 | bus) and what voice_compute_mod_rates makes of them
constexpr Va send_word[4] = {0x181a73560, 0x181a735e0, 0x181a73660, 0x181a736e0};
constexpr Va send_level[4] = {0x181a1d930, 0x181a1da30, 0x181a1db30, 0x181a1dc30};
constexpr Va send_bus[4] = {0x181a6e4b0, 0x181a6e5b0, 0x181a6e6b0, 0x181a6e7b0};
constexpr Va send_unit = 0x181a04188;

std::int32_t wrap_mul(std::int32_t a, std::int32_t b)
{
    return static_cast<std::int32_t>(static_cast<std::uint32_t>(a) * static_cast<std::uint32_t>(b));
}

// the step of a linear ramp toward its target: ((target - current) * rate) >> 13, at least 1 upward
std::int32_t linear_step(std::int32_t current, std::int32_t target, std::int32_t rate)
{
    std::int32_t step = wrap_mul(static_cast<std::int32_t>(static_cast<std::uint32_t>(target) -
                                                           static_cast<std::uint32_t>(current)),
                                 rate) >> 13;
    if (step == 0 && current < target) {
        step = 1;
    }
    return step;
}

float level_of(const Mem &m, std::int32_t value, int shift)
{
    // (float)(short)(value >> shift) * 2^-14, the idle level at 0
    return static_cast<float>(static_cast<std::int16_t>(value >> shift)) * m.f32(int16_unit);
}

int mask_of(const Mem &m, std::uint16_t flags)
{
    return m.s8(step_masks + ((flags >> 3) & 3));
}

// one count of a linear ramp (mode 0): returns whether the value moved this count
bool linear_count(Mem &m, Va r)
{
    const std::uint32_t count = m.u32(r + 4) + 1;
    m.w32(r + 4, count);
    if ((count & static_cast<std::uint32_t>(mask_of(m, m.u16(r)))) != 0) {
        return false;
    }
    const std::int32_t target = m.s32(r + 0xc), step = m.s32(r + 0x10);
    const std::int32_t next = static_cast<std::int32_t>(static_cast<std::uint32_t>(m.s32(r + 8)) +
                                                        static_cast<std::uint32_t>(step));
    const std::int32_t value = step < 1 ? (next < target ? target : next) : (target < next ? target : next);
    m.w32(r + 8, static_cast<std::uint32_t>(value));
    if (value == target && (m.u16(r) & 1)) {
        m.w32(r + 0x10, 0);
        m.w16(r, m.u16(r) & 0xfffe);
    }
    return true;
}

// one count of an exponential approach (mode 2): the accumulator moves by the rate times the remaining
// distance, at least 0x400. Returns whether it moved
bool approach_count(Mem &m, Va r, std::uint16_t mask_flags)
{
    const std::uint32_t count = m.u32(r + 4) + 1;
    m.w32(r + 4, count);
    if ((count & static_cast<std::uint32_t>(mask_of(m, mask_flags))) != 0) {
        return false;
    }
    const std::int32_t target = m.s32(r + 0xc), acc = m.s32(r + 0x10);
    const std::int32_t gap = static_cast<std::int16_t>(
        static_cast<std::int32_t>(static_cast<std::uint32_t>(target) * 0x400u - static_cast<std::uint32_t>(acc)) >>
        13);
    std::int32_t step = gap * static_cast<std::int32_t>(m.s16(r + 2));
    if (step < 0) {
        if (-0x400 < step) {
            step = -0x400;
        }
    } else if (step < 0x400) {
        step = 0x400;
    }
    const std::int32_t next = static_cast<std::int32_t>(static_cast<std::uint32_t>(acc) +
                                                        static_cast<std::uint32_t>(step));
    m.w32(r + 0x10, static_cast<std::uint32_t>(next));
    m.w32(r + 8, static_cast<std::uint32_t>(next >> 10));
    if ((next >> 10) == target && (m.u16(r) & 1)) {
        m.w16(r, m.u16(r) & 0xfffe);
    }
    return true;
}

float approach_out(const Mem &m, Va r)
{
    const std::int32_t acc = m.s32(r + 0x10);
    return (acc >> 10) == 0 ? 1e-05f : level_of(m, acc, 13);
}

} // namespace

std::int32_t exp_ratio(const Mem &m, std::int32_t word)
{
    if (word == 0) {
        return 0;
    }
    const std::uint32_t i = static_cast<std::uint32_t>(word >> 6) & 0xff;
    const std::int32_t frac = word & 0x3f;
    std::int32_t v = wrap_mul(m.s32(exp_table + i * 4), 0x40 - frac) + wrap_mul(m.s32(exp_table + i * 4 + 4), frac);
    // a signed division by 64 rounding toward zero, then the octave
    v = (v + ((v >> 31) & 0x3f)) >> 6;
    return v >> ((15 - ((word >> 14) & 0xf)) & 31);
}

std::uint16_t flags_of_rate(const Mem &m, std::uint32_t rate_word)
{
    return static_cast<std::uint16_t>(m.u32(mode_bits + ((rate_word >> 14) & 3) * 4) |
                                      m.u32(mask_bits + ((rate_word >> 12) & 3) * 4));
}

void pitch_block(Mem &m, int voice, std::int32_t *ratios)
{
    const Va r = pitch + static_cast<Va>(voice) * stride;
    if (!(m.u16(r) & 1)) {
        for (int i = 0; i < 4; ++i) {
            ratios[i] = m.s32(r + 0x14);
        }
        return;
    }
    for (int i = 0; i < 4; ++i) {
        std::int32_t out = m.s32(r + 0x14);
        if (linear_count(m, r)) {
            out = exp_ratio(m, m.s32(r + 8));
        }
        m.w32(r + 0x14, static_cast<std::uint32_t>(out));
        ratios[i] = out;
    }
}

void amp_block(Mem &m, int voice, float *gain16)
{
    const Va r = amp + static_cast<Va>(voice) * stride;
    const std::uint16_t flags = m.u16(r);
    if (!(flags & 1)) {
        for (int i = 0; i < 16; ++i) {
            gain16[i] = m.f32(r + 0x14);
        }
        return;
    }
    const int mode = flags & 6;
    if (mode == 6) {
        return; // no branch for it in voice_ctrl_ramp_a: the block keeps what the buffer held
    }
    for (int i = 0; i < 16; ++i) {
        float out = m.f32(r + 0x14);
        if (mode == 0) {
            if (linear_count(m, r)) {
                const std::int32_t value = m.s32(r + 8);
                out = value == 0 ? 1e-05f : level_of(m, value, 3);
            }
        } else if (mode == 2) {
            if (approach_count(m, r, flags)) {
                out = approach_out(m, r);
            }
        } else {
            // mode 4: a fall that speeds up, +0xc the speed, +0x10 where it stops speeding up
            const std::uint32_t count = m.u32(r + 4) + 1;
            m.w32(r + 4, count);
            if ((count & static_cast<std::uint32_t>(mask_of(m, flags))) == 0) {
                const std::int32_t current = m.s32(r + 8), rate = m.s16(r + 2);
                std::int32_t value;
                if (m.s32(r + 0x10) < current) {
                    const std::int32_t speed = m.s32(r + 0xc) - rate;
                    m.w32(r + 0xc, static_cast<std::uint32_t>(speed));
                    value = speed + current;
                    m.w32(r + 8, static_cast<std::uint32_t>(value));
                } else {
                    const std::int32_t speed = rate + m.s32(r + 0xc);
                    m.w32(r + 0xc, static_cast<std::uint32_t>(speed));
                    value = speed < 1 ? current + speed : 0;
                    m.w32(r + 8, static_cast<std::uint32_t>(value));
                    if (value == 0 && (m.u16(r) & 1)) {
                        m.w16(r, m.u16(r) & 0xfffe);
                    }
                }
                out = value == 0 ? 1e-05f : level_of(m, value, 3);
            }
        }
        m.wf(r + 0x14, out);
        gain16[i] = out;
    }
}

void gain4_block(Mem &m, int voice, float *out4)
{
    // voice_ctrl_ramp_b runs its approach whatever the flags say
    const Va r = ramp::gain4 + static_cast<Va>(voice) * stride;
    const std::uint16_t flags = m.u16(r);
    for (int i = 0; i < 4; ++i) {
        float out = m.f32(r + 0x14);
        if (approach_count(m, r, flags)) {
            out = approach_out(m, r);
        }
        m.wf(r + 0x14, out);
        out4[i] = out;
    }
}

void cutoff_block(Mem &m, int voice, float *f)
{
    const Va r = cutoff + static_cast<Va>(voice) * stride;
    if (!(m.u16(r) & 1)) {
        for (int i = 0; i < 4; ++i) {
            f[i] = m.f32(r + 0x14);
        }
        return;
    }
    for (int i = 0; i < 4; ++i) {
        float out = m.f32(r + 0x14);
        if (linear_count(m, r)) {
            const std::int32_t value = m.s32(r + 8);
            out = value == 0 ? 1e-05f : level_of(m, value, 3);
        }
        m.wf(r + 0x14, out);
        f[i] = out;
    }
}

void q_block(Mem &m, int voice, float *qs, float *f)
{
    const Va r = ramp::q + static_cast<Va>(voice) * stride;
    const std::uint16_t flags = m.u16(r);
    const auto cap = [&](int i) {
        const float ceiling = m.f32(f_ceiling + static_cast<Va>(static_cast<std::int64_t>(m.s32(r + 8) >> 8) * 4));
        if (ceiling < f[i]) {
            f[i] = ceiling;
        }
    };
    if (!(flags & 1)) {
        for (int i = 0; i < 4; ++i) {
            qs[i] = m.f32(r + 0x14);
            cap(i);
        }
        return;
    }
    for (int i = 0; i < 4; ++i) {
        float out = m.f32(r + 0x14);
        if (approach_count(m, r, flags)) {
            out = approach_out(m, r);
        }
        m.wf(r + 0x14, out);
        cap(i);
        qs[i] = out;
    }
}

void set_target_pitch(Mem &m, int voice, std::uint16_t flags, std::uint32_t start, std::uint32_t target,
                      std::int16_t rate, bool reset)
{
    const Va r = pitch + static_cast<Va>(voice) * stride;
    m.w16(r + 2, static_cast<std::uint16_t>(rate));
    m.w16(r, flags & 0xfffe);
    m.w32(r + 0xc, target);
    if (!reset) {
        start = m.u32(r + 8);
    } else {
        m.w32(r + 8, start);
        m.w32(r + 4, 0);
    }
    m.w32(r + 0x10, static_cast<std::uint32_t>(
                        linear_step(static_cast<std::int32_t>(start), static_cast<std::int32_t>(target), rate)));
    m.w32(r + 0x14, static_cast<std::uint32_t>(exp_ratio(m, static_cast<std::int32_t>(start))));
    if (start != target) {
        m.w16(r, (flags & 0xfffe) | 1);
    }
}

void set_target_amp(Mem &m, int voice, std::uint16_t flags, std::int32_t start, std::int32_t target,
                    std::int16_t rate, bool reset)
{
    const Va r = amp + static_cast<Va>(voice) * stride;
    m.w16(r, flags & 0xfffe);
    m.w32(r + 0xc, static_cast<std::uint32_t>(target));
    bool still;
    if (!reset) {
        m.w16(r + 2, static_cast<std::uint16_t>(rate));
        if ((flags & 6) == 0) {
            m.w32(r + 0x10, static_cast<std::uint32_t>(linear_step(m.s32(r + 8), target, rate)));
        }
        still = m.s32(r + 8) == target;
    } else {
        m.w16(r + 2, static_cast<std::uint16_t>(rate));
        m.w32(r + 4, 0);
        m.w32(r + 8, static_cast<std::uint32_t>(start));
        if ((flags & 6) == 0) {
            m.w32(r + 0x10, static_cast<std::uint32_t>(linear_step(start, target, rate)));
        } else if ((flags & 6) == 2) {
            m.w32(r + 0x10, static_cast<std::uint32_t>(start) << 10);
        } else if ((flags & 6) == 4) {
            m.w32(r + 0xc, 0);
            m.w32(r + 0x10, static_cast<std::uint32_t>(start / 2));
            target = 0;
        }
        if (start == 0) {
            still = target == 0;
            m.wf(r + 0x14, m.f32(idle_level));
        } else {
            still = start == target;
            m.wf(r + 0x14, level_of(m, start, 3));
        }
    }
    if (!still) {
        m.w16(r, (flags & 0xfffe) | 1);
    }
}

void set_target_cutoff(Mem &m, int voice, std::uint16_t flags, std::uint32_t start, std::uint32_t target,
                       std::int16_t rate, bool reset)
{
    const Va r = cutoff + static_cast<Va>(voice) * stride;
    m.w16(r, flags & 0xfffe);
    const std::int32_t to = exp_ratio(m, static_cast<std::int32_t>(target));
    std::int32_t from;
    float out;
    bool still;
    if (!reset) {
        m.w16(r + 2, static_cast<std::uint16_t>(rate));
        from = m.s32(r + 8);
        m.w32(r + 0xc, static_cast<std::uint32_t>(to));
        m.w32(r + 0x10, static_cast<std::uint32_t>(wrap_mul(to - from, rate) >> 13 == 0 && from < to
                                                       ? 1
                                                       : wrap_mul(to - from, rate) >> 13));
        out = from != 0 ? level_of(m, from, 3) : m.f32(idle_level);
        still = from == to;
    } else {
        m.w32(r + 4, 0);
        from = exp_ratio(m, static_cast<std::int32_t>(start));
        m.w32(r + 8, static_cast<std::uint32_t>(from));
        m.w16(r + 2, static_cast<std::uint16_t>(rate));
        m.w32(r + 0xc, static_cast<std::uint32_t>(to));
        m.w32(r + 0x10, static_cast<std::uint32_t>(wrap_mul(to - from, rate) >> 13 == 0 && from < to
                                                       ? 1
                                                       : wrap_mul(to - from, rate) >> 13));
        if (from == 0) {
            still = to == 0;
            out = m.f32(idle_level);
        } else {
            still = from == to;
            out = level_of(m, from, 3);
        }
    }
    m.wf(r + 0x14, out);
    if (!still) {
        m.w16(r, (flags & 0xfffe) | 1);
    }
}

void target_amp(Mem &m, int voice)
{
    if (voice >= 0x40) {
        return;
    }
    const Va r = amp + static_cast<Va>(voice) * stride;
    const std::uint32_t rate_word = m.u32(amp_rate + voice * 4);
    const std::int32_t target = m.s32(amp_target + voice * 4);
    const std::uint16_t rate = rate_word & 0xfff;
    m.w32(r + 0xc, static_cast<std::uint32_t>(target));
    m.w16(r + 2, rate);
    const std::uint16_t flags = flags_of_rate(m, rate_word);
    m.w16(r, flags & 0xfffe);
    if ((flags & 6) == 0) {
        m.w32(r + 0x10, static_cast<std::uint32_t>(linear_step(m.s32(r + 8), target, rate)));
    }
    if (m.s32(r + 8) != target) {
        m.w16(r, (flags & 0xfffe) | 1);
    }
}

void target_pitch(Mem &m, int voice)
{
    if (voice >= 0x40) {
        return;
    }
    const std::uint32_t rate_word = m.u32(pitch_rate + voice * 4);
    set_target_pitch(m, voice, flags_of_rate(m, rate_word), m.u32(pitch_start + voice * 4),
                     m.u32(pitch_target + voice * 4), static_cast<std::int16_t>(rate_word & 0xfff), false);
}

void target_aux(Mem &m, int voice)
{
    const Va r = ramp::gain4 + static_cast<Va>(voice) * stride;
    const std::int32_t start = m.s32(gain4_start + voice * 4), target = m.s32(gain4_target + voice * 4);
    const std::uint32_t rate_word = m.u32(gain4_rate + voice * 4);
    m.w32(r + 4, 0);
    m.w32(r + 8, static_cast<std::uint32_t>(start));
    m.w32(r + 0xc, static_cast<std::uint32_t>(target));
    m.w16(r + 2, rate_word & 0xfff);
    const std::uint16_t bits = static_cast<std::uint16_t>(m.u32(mask_bits + ((rate_word >> 12) & 3) * 4));
    m.w32(r + 0x10, static_cast<std::uint32_t>(start) << 10);
    m.w16(r, (bits & 0xfffe) | 2);
    m.wf(r + 0x14, start != 0 ? level_of(m, start, 3) : m.f32(idle_level));
    if (start != target) {
        m.w16(r, (bits & 0xfffe) | 3);
    }
}

void compute_sends(Mem &m, int voice)
{
    for (int s = 0; s < 4; ++s) {
        const std::uint16_t w = m.u16(send_word[s] + voice * 2);
        const float level = (w >> 6) != 0 ? static_cast<float>(w >> 6) * m.f32(send_unit) : m.f32(idle_level);
        m.wf(send_level[s] + voice * 4, level);
        m.w32(send_bus[s] + voice * 4, w & 0x3f);
    }
}

void start(Mem &m, int voice)
{
    compute_sends(m, voice);
    const std::uint32_t pr = m.u32(pitch_rate + voice * 4), ar = m.u32(amp_rate + voice * 4);
    const std::uint32_t cr = m.u32(cutoff_rate + voice * 4);
    set_target_pitch(m, voice, flags_of_rate(m, pr), m.u32(pitch_start + voice * 4), m.u32(pitch_target + voice * 4),
                     static_cast<std::int16_t>(pr & 0xfff), true);
    set_target_amp(m, voice, flags_of_rate(m, ar), m.s32(amp_start + voice * 4), m.s32(amp_target + voice * 4),
                   static_cast<std::int16_t>(ar & 0xfff), true);
    set_target_cutoff(m, voice, flags_of_rate(m, cr), m.u32(cutoff_start + voice * 4),
                      m.u32(cutoff_target + voice * 4), static_cast<std::int16_t>(cr & 0xfff), true);
    const std::uint32_t qr = m.u32(q_rate + voice * 4);
    const std::int32_t qs = static_cast<std::int32_t>(m.u32(q_start4 + voice * 4) >> 2);
    const std::int32_t qt = m.s32(q_target + voice * 4);
    const Va rq = ramp::q + static_cast<Va>(voice) * stride;
    const std::uint16_t qbits = static_cast<std::uint16_t>(m.u32(mask_bits + ((qr >> 12) & 3) * 4)) & 0xfffe;
    m.w16(rq + 2, qr & 0xfff);
    m.w16(rq, qbits);
    m.w32(rq + 4, 0);
    m.w32(rq + 8, static_cast<std::uint32_t>(qs));
    m.w32(rq + 0xc, static_cast<std::uint32_t>(qt));
    m.w32(rq + 0x10, static_cast<std::uint32_t>(qs) << 10);
    m.wf(rq + 0x14, qs != 0 ? level_of(m, qs, 3) : m.f32(idle_level));
    if (qs != qt) {
        m.w16(rq, qbits | 1);
    }
    const std::uint32_t gr = m.u32(gain4_rate + voice * 4);
    const std::int32_t gs = m.s32(gain4_start + voice * 4), gt = m.s32(gain4_target + voice * 4);
    const Va rg = ramp::gain4 + static_cast<Va>(voice) * stride;
    const std::uint16_t gbits = static_cast<std::uint16_t>(m.u32(mask_bits + ((gr >> 12) & 3) * 4)) & 0xfffe;
    m.w16(rg + 2, gr & 0xfff);
    m.w16(rg, gbits | 2);
    m.w32(rg + 4, 0);
    m.w32(rg + 8, static_cast<std::uint32_t>(gs));
    m.w32(rg + 0xc, static_cast<std::uint32_t>(gt));
    m.w32(rg + 0x10, static_cast<std::uint32_t>(gs) << 10);
    m.wf(rg + 0x14, gs != 0 ? level_of(m, gs, 3) : m.f32(idle_level));
    if (gs != gt) {
        m.w16(rg, gbits | 3);
    }
}

void targets_writeback(Mem &m, int voice)
{
    if (voice >= 0x40) {
        return;
    }
    compute_sends(m, voice);
    const std::uint32_t pr = m.u32(pitch_rate + voice * 4);
    set_target_pitch(m, voice, flags_of_rate(m, pr), m.u32(pitch_start + voice * 4), m.u32(pitch_target + voice * 4),
                     static_cast<std::int16_t>(pr & 0xfff), false);
    target_amp(m, voice);
    const std::uint32_t cr = m.u32(cutoff_rate + voice * 4);
    set_target_cutoff(m, voice, flags_of_rate(m, cr), m.u32(cutoff_start + voice * 4),
                      m.u32(cutoff_target + voice * 4), static_cast<std::int16_t>(cr & 0xfff), false);
    // the damping ramp gets no mode bits (voice_ctrl_ramp_d always approaches)
    const std::uint32_t qr = m.u32(q_rate + voice * 4);
    const Va rq = ramp::q + static_cast<Va>(voice) * stride;
    const std::uint16_t qbits = static_cast<std::uint16_t>(m.u32(mask_bits + ((qr >> 12) & 3) * 4)) & 0xfffe;
    m.w16(rq + 2, qr & 0xfff);
    m.w16(rq, qbits);
    m.w32(rq + 0xc, m.u32(q_target + voice * 4));
    if (m.s32(rq + 8) != m.s32(q_target + voice * 4)) {
        m.w16(rq, qbits | 1);
    }
    const std::uint32_t gr = m.u32(gain4_rate + voice * 4);
    const Va rg = ramp::gain4 + static_cast<Va>(voice) * stride;
    const std::uint16_t gbits = static_cast<std::uint16_t>(m.u32(mask_bits + ((gr >> 12) & 3) * 4)) & 0xfffe;
    const std::int32_t current = m.s32(rg + 8), target = m.s32(gain4_target + voice * 4);
    m.w32(rg + 0xc, static_cast<std::uint32_t>(target));
    m.w16(rg, gbits | 2);
    m.w16(rg + 2, gr & 0xfff);
    if (current != target) {
        m.w16(rg, gbits | 3);
    }
}

} // namespace scva::ramp
