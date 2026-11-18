#include "voice/interp.hpp"

#include <cstring>
#include <stdexcept>

namespace scva {

Interpolator::Interpolator(std::span<const std::uint8_t> table)
{
    if (table.size() < coef_.size() * sizeof(float)) {
        throw std::runtime_error("the interpolation table is too short");
    }
    std::memcpy(coef_.data(), table.data(), coef_.size() * sizeof(float));
}

} // namespace scva
