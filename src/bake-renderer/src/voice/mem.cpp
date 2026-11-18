#include "voice/mem.hpp"

#include <algorithm>
#include <cstdio>

namespace scva {

Mem::Mem(const Rom &rom) : rom_(&rom)
{
    const Rom::Section *rdata = rom.section(".rdata"), *data = rom.section(".data");
    if (!rdata || !data) {
        throw std::runtime_error("SCCore.dll has no .rdata or .data section");
    }
    rdata_va_ = static_cast<Va>(image_base + rdata->rva);
    rdata_end_ = rdata_va_ + static_cast<Va>(std::min(rdata->raw_size, rdata->virtual_size));
    rdata_file_ = rdata->raw;
    data_va_ = static_cast<Va>(image_base + data->rva);
    data_end_ = data_va_ + static_cast<Va>(std::max(data->raw_size, data->virtual_size));
    data_init_.assign(static_cast<std::size_t>(data_end_ - data_va_), 0);
    const std::int64_t raw = std::min(data->raw_size, data->virtual_size);
    const auto bytes = rom.bytes(data->raw, raw);
    std::memcpy(data_init_.data(), bytes.data(), bytes.size());
    // the loader rewrites these 8-byte slots with addresses, so their file bytes are no data
    relocated_.assign(static_cast<std::size_t>(rdata_end_ - rdata_va_), 0);
    for (std::int64_t at : rom.relocations(rdata_file_, static_cast<std::int64_t>(rdata_end_ - rdata_va_))) {
        for (std::int64_t i = 0; i < 8; ++i) {
            const std::int64_t k = at + i - rdata_file_;
            if (k >= 0 && k < static_cast<std::int64_t>(relocated_.size())) {
                relocated_[static_cast<std::size_t>(k)] = 1;
            }
        }
    }
    reset();
}

void Mem::reset()
{
    data_ = data_init_;
    heap_.clear();
}

Va Mem::alloc(std::size_t size)
{
    const std::size_t at = (heap_.size() + 15) & ~std::size_t(15);
    heap_.resize(at + size, 0);
    return heap_base + at;
}

void Mem::fault(const char *what, Va va) const
{
    char text[96];
    std::snprintf(text, sizeof text, "%s at 0x%llx", what, static_cast<unsigned long long>(va));
    throw std::logic_error(text);
}

const std::uint8_t *Mem::host(Va va, std::size_t size) const
{
    if (va >= heap_base && va + size <= heap_base + heap_.size()) {
        return heap_.data() + (va - heap_base);
    }
    if (va >= data_va_ && va + size <= data_end_) {
        return data_.data() + (va - data_va_);
    }
    if (va >= rdata_va_ && va + size <= rdata_end_) {
        const std::size_t k = static_cast<std::size_t>(va - rdata_va_);
        for (std::size_t i = 0; i < size; ++i) {
            if (relocated_[k + i]) {
                fault("read of a relocated pointer slot", va + i);
            }
        }
        return rom_->bytes(rdata_file_ + static_cast<std::int64_t>(k), static_cast<std::int64_t>(size)).data();
    }
    return nullptr;
}

Va Mem::code_pointer(Va va) const
{
    if (va < rdata_va_ || va + 8 > rdata_end_) {
        fault("a code pointer outside .rdata", va);
    }
    const std::size_t k = static_cast<std::size_t>(va - rdata_va_);
    if (!relocated_[k]) {
        fault("not a relocated pointer slot", va);
    }
    Va v;
    std::memcpy(&v, rom_->bytes(rdata_file_ + static_cast<std::int64_t>(k), 8).data(), 8);
    return v;
}

std::uint8_t *Mem::host_rw(Va va, std::size_t size)
{
    if (va >= heap_base && va + size <= heap_base + heap_.size()) {
        return heap_.data() + (va - heap_base);
    }
    if (va >= data_va_ && va + size <= data_end_) {
        return data_.data() + (va - data_va_);
    }
    return nullptr;
}

void Mem::read(Va va, void *out, std::size_t size) const
{
    const std::uint8_t *p = host(va, size);
    if (!p) {
        fault("read of unmapped memory", va);
    }
    std::memcpy(out, p, size);
}

void Mem::write(Va va, const void *in, std::size_t size)
{
    std::uint8_t *p = host_rw(va, size);
    if (!p) {
        fault("write to read-only or unmapped memory", va);
    }
    std::memcpy(p, in, size);
}

} // namespace scva
