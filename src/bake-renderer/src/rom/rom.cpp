#include "rom/rom.hpp"

#include "rom/md5.hpp"

#include <algorithm>

namespace scva {

Rom::Rom(std::vector<std::uint8_t> data) : data_(std::move(data))
{
    if (static_cast<std::int64_t>(data_.size()) != dll_size) {
        throw RomIdentityError("the file is not SOUND Canvas VA 1.1.6 x64 SCCore.dll (size "
                               + std::to_string(data_.size()) + ", want " + std::to_string(dll_size) + ")");
    }
    const std::string md5 = md5_hex(data_.data(), data_.size());
    if (md5 != dll_md5) {
        throw RomIdentityError("the file is not SOUND Canvas VA 1.1.6 x64 SCCore.dll (md5 " + md5 + ", want "
                               + dll_md5 + ")");
    }
    // the PE section table, for file offset <-> virtual address
    const std::uint32_t pe = u32(&data_[0x3C]);
    const int count = u16(&data_[pe + 6]);
    const int optional = u16(&data_[pe + 20]);
    const std::size_t table = pe + 24 + optional;
    for (int i = 0; i < count; ++i) {
        const std::uint8_t *s = &data_[table + 40 * std::size_t(i)];
        Section sec{{}, u32(s + 12), u32(s + 8), u32(s + 20), u32(s + 16)};
        std::memcpy(sec.name, s, 8);
        sections_.push_back(sec);
    }
    // the base relocation directory (data directory 5 of the PE32+ optional header)
    const std::size_t directory = pe + 24 + 112 + 5 * 8;
    const std::int64_t at = va_to_file(image_base + u32(&data_[directory]));
    const std::int64_t end = at + u32(&data_[directory + 4]);
    for (std::int64_t block = at; at >= 0 && block + 8 <= end;) {
        const std::uint32_t page = u32(&data_[std::size_t(block)]);
        const std::uint32_t size = u32(&data_[std::size_t(block) + 4]);
        if (size < 8) {
            break;
        }
        for (std::uint32_t i = 8; i + 2 <= size; i += 2) {
            const std::uint16_t entry = u16(&data_[std::size_t(block) + i]);
            if (entry >> 12 == 10) {
                const std::int64_t file = va_to_file(image_base + page + (entry & 0xFFF));
                if (file >= 0) {
                    relocations_.push_back(file);
                }
            }
        }
        block += size;
    }
    std::sort(relocations_.begin(), relocations_.end());
}

std::vector<std::int64_t> Rom::relocations(std::int64_t offset, std::int64_t size) const
{
    // a slot that starts up to 7 bytes before the range still reaches into it
    auto it = std::lower_bound(relocations_.begin(), relocations_.end(), offset - 7);
    std::vector<std::int64_t> out;
    for (; it != relocations_.end() && *it < offset + size; ++it) {
        out.push_back(*it);
    }
    return out;
}

std::span<const std::uint8_t> Rom::bytes(std::int64_t offset, std::int64_t size) const
{
    if (offset < 0 || size < 0 || offset + size > static_cast<std::int64_t>(data_.size())) {
        throw std::out_of_range("read past the end of SCCore.dll");
    }
    return {data_.data() + offset, static_cast<std::size_t>(size)};
}

std::int64_t Rom::file_to_va(std::int64_t offset) const noexcept
{
    for (const Section &s : sections_) {
        if (offset >= s.raw && offset < s.raw + s.raw_size) {
            return image_base + s.rva + (offset - s.raw);
        }
    }
    return 0;
}

const Rom::Section *Rom::section(const char *name) const noexcept
{
    for (const Section &s : sections_) {
        if (std::strncmp(s.name, name, 8) == 0) {
            return &s;
        }
    }
    return nullptr;
}

std::int64_t Rom::va_to_file(std::int64_t va) const noexcept
{
    const std::int64_t rva = va - image_base;
    for (const Section &s : sections_) {
        if (rva >= s.rva && rva < s.rva + s.raw_size) {
            return s.raw + (rva - s.rva);
        }
    }
    return -1;
}

} // namespace scva
