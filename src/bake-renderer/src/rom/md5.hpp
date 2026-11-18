#pragma once

#include <cstddef>
#include <cstdint>
#include <string>

namespace scva {

/**
 * MD5 of a buffer as lower case hex (RFC 1321). Only used to tell the one supported SCCore.dll build apart.
 */
std::string md5_hex(const std::uint8_t *data, std::size_t size);

} // namespace scva
