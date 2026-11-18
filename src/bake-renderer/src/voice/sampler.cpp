#include "voice/sampler.hpp"

#include <cstring>

namespace scva {

WaveRegisters WaveRegisters::decode(const std::uint8_t *r) noexcept
{
    const auto p20 = [r](int o) {
        return std::uint32_t((r[o] & 15) << 16 | r[o + 1] << 8 | r[o + 2]);
    };
    const std::uint32_t f = r[0x0A];
    WaveRegisters reg;
    reg.flags = ((f & 4) + ((f & 1) + 8) * 8) * 0x200 + (r[0] & 0x7Fu);
    if (!(f & 4)) {
        reg.a = p20(1);
        reg.b = p20(7);
        reg.c = p20(0x0B);
    } else if (f & 2) {
        // a reverse wave with the loop bit: both ends of the walk sit one below the data start
        reg.a = p20(0x0B);
        reg.b = p20(1) - 1;
        reg.c = p20(1) - 1;
    } else {
        reg.a = p20(0x0B);
        reg.b = p20(7);
        reg.c = p20(1);
    }
    return reg;
}

Sampler::Sampler(const Tables &tables, float scale, float idle) noexcept
    : bank_a_(tables.wave_rom_a), bank_b_(tables.wave_rom_b), scale_(scale), idle_(idle)
{
}

void Sampler::load_window(std::int64_t at) noexcept
{
    // the DLL reads 16 bytes through a raw pointer. Inside the bank that is the ROM, a read outside it (no wave
    // of the ROM gets there) would be whatever the heap holds, here zeros
    const std::int64_t from = deltas_ + at;
    if (from >= 0 && from + 16 <= static_cast<std::int64_t>(bank_.size())) {
        std::memcpy(window, bank_.data() + from, 16);
        return;
    }
    for (int i = 0; i < 16; ++i) {
        const std::int64_t o = from + i;
        window[i] = o >= 0 && o < static_cast<std::int64_t>(bank_.size()) ? bank_[std::size_t(o)] : 0;
    }
}

std::uint8_t Sampler::scale_at(std::int64_t index) const noexcept
{
    const std::int64_t o = scales_ + index;
    return o >= 0 && o < static_cast<std::int64_t>(bank_.size()) ? bank_[std::size_t(o)] : 0;
}

void Sampler::add(std::int32_t index) noexcept
{
    // 32-bit wrapping, as the engine's accumulator
    const std::uint32_t delta = static_cast<std::uint32_t>(static_cast<std::int32_t>(static_cast<std::int8_t>(window[index])));
    predictor = static_cast<std::int32_t>(static_cast<std::uint32_t>(predictor) + (delta << ((nibble + 10) & 0x1F)));
}

void Sampler::push() noexcept
{
    hist[0] = hist[1];
    hist[1] = hist[2];
    hist[2] = hist[3];
    hist[3] = static_cast<float>(predictor) * scale_;
}

void Sampler::start(const WaveRegisters &reg) noexcept
{
    const std::uint32_t walk = ((reg.flags >> 2) & 0x400) | (reg.flags & 0x800);
    const bool reverse = reg.flags & 0x800;
    // wave ROM descriptors always take this branch: bits 8..10 and 14 of the flags are clear
    std::uint32_t base, loop, len, begin;
    if (!reverse) {
        base = reg.a & 0xFFFFFFE0u;
        loop = reg.b - base;
        len = reg.c - base;
        begin = 0;
    } else {
        base = reg.c & 0xFFFFFFE0u;
        begin = reg.a - base;
        loop = reg.c - base;
        len = reg.b - base;
    }
    const std::int64_t region = static_cast<std::int64_t>(reg.flags & 0x7F) * 0x100000;
    const std::int32_t sbase = static_cast<std::int32_t>(base);
    const std::int64_t scale_block = (sbase + ((sbase >> 31) & 0x1F)) >> 5;
    if (!(reg.flags & 0x10)) {
        bank_ = bank_a_;
        deltas_ = region | static_cast<std::int64_t>(sbase);
        scales_ = region | scale_block;
    } else {
        bank_ = bank_b_;
        deltas_ = (region - 0x1000000) | static_cast<std::int64_t>(sbase);
        scales_ = (region - 0x1000000) | scale_block;
    }
    event_ = false;
    loop_point = static_cast<std::int32_t>(loop);
    length = static_cast<std::int32_t>(len);
    switch (walk >> 10) {
    case 0:
        flags = sampler_loop;
        init_forward(static_cast<std::int32_t>(begin));
        break;
    case 1:
        flags = sampler_ping_pong;
        init_forward(static_cast<std::int32_t>(begin));
        break;
    case 2:
        flags = sampler_reverse | sampler_loop;
        init_backward(static_cast<std::int32_t>(begin));
        break;
    default:
        flags = sampler_reverse | sampler_ping_pong;
        init_backward(static_cast<std::int32_t>(begin));
        break;
    }
}

void Sampler::init_forward(std::int32_t start) noexcept
{
    predictor = 0;
    scale_index = 0;
    phase = 0;
    load_window(0);
    position = start;
    std::uint8_t b = scale_at(scale_index);
    scale_byte = b;
    ++scale_index;
    if (start & 0x10) {
        b = static_cast<std::uint8_t>(static_cast<std::int8_t>(b) >> 4);
    }
    nibble = b & 0x0F;
    hist[0] = hist[1] = hist[2] = hist[3] = idle_;
    for (int i = 0; i < 4; ++i) {
        // the priming reads the window by the position itself. It starts at 0, so it stays inside
        add(position & 15);
        ++position;
        push();
        if (position == 0x10) {
            load_window(0x10);
        }
    }
    flags |= sampler_running;
    if (loop_point == length) {
        flags = static_cast<std::uint8_t>((flags & 0xF9) | sampler_running);
    }
    --position;
}

void Sampler::init_backward(std::int32_t start) noexcept
{
    phase = 0;
    predictor = 0;
    scale_index = static_cast<std::int16_t>(static_cast<std::int16_t>((start + ((start >> 31) & 0x1F)) >> 5) + 1);
    position = start;
    load_window(static_cast<std::int64_t>(start >> 2 & ~3) * 4);
    std::uint8_t b = scale_at(static_cast<std::int64_t>(scale_index) - 1);
    scale_byte = b;
    if (start & 0x10) {
        b = static_cast<std::uint8_t>(static_cast<std::int8_t>(b) >> 4);
    }
    nibble = b & 0x0F;
    hist[0] = hist[1] = hist[2] = hist[3] = idle_;
    int index = start & 15;
    for (int i = 0; i < 4; ++i) {
        add(index);
        --position;
        --index;
        push();
        if (index < 0) {
            index = 15;
            load_window(static_cast<std::int64_t>(position >> 2 & ~3) * 4);
            if (!(position & 0x10)) {
                nibble = scale_byte & 0x0F;
            } else {
                const std::int16_t s = scale_index;
                scale_index = static_cast<std::int16_t>(s - 1);
                scale_byte = scale_at(static_cast<std::int64_t>(s) - 2);
                nibble = static_cast<std::uint8_t>(static_cast<std::int8_t>(scale_byte) >> 4) & 0x0F;
            }
        }
    }
    flags |= sampler_running;
    if (loop_point == length) {
        flags = static_cast<std::uint8_t>((flags & 0xF9) | sampler_running);
    }
    // the position steps back up by one. When the fourth sample crossed into the half block below, the next
    // fetch crosses it again and moves the scale byte a second time (the engine's own behaviour)
    ++position;
}

void Sampler::fetch_forward() noexcept
{
    ++position;
    if ((position & 15) != 0) {
        return;
    }
    load_window(static_cast<std::int64_t>(position >> 2) * 4);
    if (position & 0x10) {
        nibble = static_cast<std::uint8_t>(static_cast<std::int8_t>(scale_byte) >> 4) & 0x0F;
        return;
    }
    scale_byte = scale_at(scale_index);
    nibble = scale_byte & 0x0F;
    ++scale_index;
}

void Sampler::fetch_backward() noexcept
{
    --position;
    if ((position & 15) != 15) {
        return;
    }
    load_window(static_cast<std::int64_t>((position - 15) >> 2) * 4);
    if (position & 0x10) {
        const std::int16_t s = scale_index;
        scale_index = static_cast<std::int16_t>(s - 1);
        scale_byte = scale_at(static_cast<std::int64_t>(s) - 2);
        nibble = static_cast<std::uint8_t>(static_cast<std::int8_t>(scale_byte) >> 4) & 0x0F;
        return;
    }
    nibble = scale_byte & 0x0F;
}

void Sampler::wrap_to_loop() noexcept
{
    const std::int32_t to = loop_point;
    const std::int16_t s = static_cast<std::int16_t>(to >> 5);
    position = to;
    scale_byte = scale_at(s);
    scale_index = static_cast<std::int16_t>(s + 1);
    nibble = (to & 0x10) ? scale_byte >> 4 : scale_byte & 0x0F;
    load_window(static_cast<std::int64_t>(to >> 2 & ~3) * 4);
}

void Sampler::step() noexcept
{
    const bool reverse = flags & sampler_reverse;
    switch (flags & sampler_mode_mask) {
    case 0: {
        // one-shot: at the end the flags clear and the samples are zero from there
        if (position == length) {
            if (!(flags & sampler_loop_event)) {
                event_ = true;
            }
            flags = 0;
        } else if (reverse) {
            fetch_backward();
        } else {
            fetch_forward();
        }
        add(position & 15);
        if (flags == 0) {
            predictor = 0;
        }
        push();
        break;
    }
    case sampler_loop: {
        if (position == length) {
            wrap_to_loop();
        } else if (reverse) {
            fetch_backward();
        } else {
            fetch_forward();
        }
        if (position == loop_point && !(flags & sampler_loop_event)) {
            flags |= sampler_loop_event;
            event_ = true;
        }
        add(position & 15);
        push();
        break;
    }
    case sampler_ping_pong: {
        // the position stays on a turn, so the turn's delta is added twice. The predictor keeps adding on the
        // way back, which makes the return leg the point mirror of the way out
        if (!(flags & sampler_turned)) {
            if (position == length) {
                flags ^= sampler_turned;
            } else if (reverse) {
                fetch_backward();
            } else {
                fetch_forward();
            }
        } else if (position == loop_point) {
            flags ^= sampler_turned;
        } else if (reverse) {
            fetch_forward();
        } else {
            fetch_backward();
        }
        add(position & 15);
        push();
        if (position == loop_point) {
            flags |= sampler_loop_event;
            event_ = true;
        }
        break;
    }
    default:
        // mode bits 6: voice_render_dispatch renders nothing for it and no setup produces it
        break;
    }
}

} // namespace scva
