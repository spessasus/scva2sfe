#pragma once

// SCCore.dll as a data file: the caller hands over the file's bytes (27 MB), never loaded as code.
// Adapted from NativeTS src/rom/rom_image.cpp (BSD 3-Clause, see NOTICE.md): one build only, identified by its
// md5, and no segment translation between builds. It takes the bytes instead of a path (no file access in the
// library).

#include <cstdint>
#include <cstring>
#include <span>
#include <stdexcept>
#include <string>
#include <vector>

namespace scva {

/**
 * The one supported build: SC-VA 1.1.6 x64.
 */
inline constexpr const char *dll_md5 = "dbd9a30c168efef577d40a28d9adf37d";
inline constexpr std::int64_t dll_size = 27347456;
inline constexpr std::int64_t image_base = 0x180000000LL;

/**
 * Thrown when the file is not the supported SCCore.dll.
 */
class RomIdentityError : public std::runtime_error {
public:
    explicit RomIdentityError(const std::string &message) : std::runtime_error(message) {}
};

class Rom {
public:
    /**
     * Identifies the DLL's bytes. Throws RomIdentityError for another file.
     */
    explicit Rom(std::vector<std::uint8_t> data);

    std::int64_t size() const noexcept { return static_cast<std::int64_t>(data_.size()); }

    /**
     * Bytes at a file offset. Throws std::out_of_range past the end of the file.
     */
    std::span<const std::uint8_t> bytes(std::int64_t offset, std::int64_t size) const;

    /**
     * The virtual address (at the preferred image base) a file offset is mapped to, 0 when it is in no section.
     */
    std::int64_t file_to_va(std::int64_t offset) const noexcept;

    /**
     * The file offset of a virtual address, -1 when it has no file bytes (outside any section's raw data).
     */
    std::int64_t va_to_file(std::int64_t va) const noexcept;

    /**
     * The 8-byte pointer slots the loader relocates (IMAGE_REL_BASED_DIR64) inside a file range, as file offsets.
     * Their bytes in the DLL's memory depend on where Windows loaded it, so no table may read them as data.
     */
    std::vector<std::int64_t> relocations(std::int64_t offset, std::int64_t size) const;

    struct Section {
        char name[9];
        std::int64_t rva, virtual_size, raw, raw_size;
    };

    /**
     * A section by name (".rdata", ".data"), nullptr when the image has none.
     */
    const Section *section(const char *name) const noexcept;

private:

    std::vector<std::uint8_t> data_;
    std::vector<Section> sections_;
    std::vector<std::int64_t> relocations_; // sorted file offsets
};

/**
 * Little-endian reads from a byte pointer.
 */
inline std::uint16_t u16(const std::uint8_t *p) noexcept
{
    return static_cast<std::uint16_t>(p[0] | (p[1] << 8));
}

inline std::int16_t s16(const std::uint8_t *p) noexcept
{
    return static_cast<std::int16_t>(u16(p));
}

inline std::uint32_t u32(const std::uint8_t *p) noexcept
{
    return std::uint32_t(p[0]) | std::uint32_t(p[1]) << 8 | std::uint32_t(p[2]) << 16 | std::uint32_t(p[3]) << 24;
}

} // namespace scva
