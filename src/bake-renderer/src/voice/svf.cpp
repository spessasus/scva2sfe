#include "voice/svf.hpp"

namespace scva {

std::uint32_t Svf::tap_bits_of_word(std::uint16_t word, int voice) noexcept
{
    std::uint32_t value;
    if (word >= 0x1000) {
        // the DLL's local for the tap still holds the function's first argument here, the voice number
        value = static_cast<std::uint32_t>(voice);
    } else {
        switch (word & 0xc00) {
        case 0:
            value = static_cast<std::uint32_t>(SvfTap::low);
            break;
        case 0x400:
            value = static_cast<std::uint32_t>(SvfTap::band);
            break;
        case 0x800:
            value = static_cast<std::uint32_t>(SvfTap::high);
            break;
        default:
            value = static_cast<std::uint32_t>(SvfTap::low_less_high);
            break;
        }
    }
    return value << ((voice & 3) * 2);
}

void Svf::render(const float *in, const float *f, const float *q, float *out) noexcept
{
    float b = band, l = low;
    for (int step = 0; step < 4; ++step) {
        const float fc = f[step], damp = q[step];
        for (int i = step * 8; i < step * 8 + 8; ++i) {
            // each product and sum on its own, in the DLL's order (no fused multiply add)
            const float fb = b * fc;
            l = fb + l;
            const float qb = b * damp;
            const float high = in[i] - (qb + l);
            const float fh = high * fc;
            b = fh + b;
            switch (tap) {
            case SvfTap::low:
                out[i] = l;
                break;
            case SvfTap::high:
                out[i] = high;
                break;
            case SvfTap::band:
                out[i] = b;
                break;
            case SvfTap::low_less_high:
                out[i] = l - high;
                break;
            }
        }
    }
    band = b;
    low = l;
}

} // namespace scva
