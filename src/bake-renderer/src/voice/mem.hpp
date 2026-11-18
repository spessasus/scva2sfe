#pragma once

// The memory the voice control code runs in: the DLL's read-only data (.rdata, read from the file), its writable
// globals (.data and .bss, started from the file's bytes and zeros) and a heap for the objects the DLL allocates
// (voice structs, the part, the LFO nodes). The control stages use the DLL's own data addresses and struct
// offsets, so a value read here is the same byte the DLL reads, and a struct can be compared with the DLL's
// memory field for field.

#include "rom/rom.hpp"

#include <cstdint>
#include <cstring>
#include <stdexcept>
#include <string>
#include <vector>

namespace scva {

using Va = std::uint64_t;

class Mem {
public:
    /** Where the heap's objects live: above anything in the DLL's image, so no address can mean both. */
    static constexpr Va heap_base = 0x300000000ULL;

    explicit Mem(const Rom &rom);

    /**
     * Back to the state after loading: .data from the file, .bss zero, an empty heap.
     */
    void reset();

    /**
     * A zeroed heap block, 16-byte aligned. Its address stays valid until reset().
     */
    Va alloc(std::size_t size);

    /**
     * The file's bytes of a read-only VA range, for building objects from tables. Throws like a read.
     */
    void read(Va va, void *out, std::size_t size) const;
    void write(Va va, const void *in, std::size_t size);

    template <typename T> T ld(Va va) const
    {
        T v;
        read(va, &v, sizeof v);
        return v;
    }
    template <typename T> void st(Va va, T v) { write(va, &v, sizeof v); }

    std::uint8_t u8(Va va) const { return ld<std::uint8_t>(va); }
    std::int8_t s8(Va va) const { return ld<std::int8_t>(va); }
    std::uint16_t u16(Va va) const { return ld<std::uint16_t>(va); }
    std::int16_t s16(Va va) const { return ld<std::int16_t>(va); }
    std::uint32_t u32(Va va) const { return ld<std::uint32_t>(va); }
    std::int32_t s32(Va va) const { return ld<std::int32_t>(va); }
    float f32(Va va) const { return ld<float>(va); }
    Va ptr(Va va) const { return ld<std::uint64_t>(va); }

    void w8(Va va, std::uint32_t v) { st<std::uint8_t>(va, static_cast<std::uint8_t>(v)); }
    void w16(Va va, std::uint32_t v) { st<std::uint16_t>(va, static_cast<std::uint16_t>(v)); }
    void w32(Va va, std::uint32_t v) { st<std::uint32_t>(va, v); }
    void wf(Va va, float v) { st<float>(va, v); }
    void wptr(Va va, Va v) { st<std::uint64_t>(va, v); }

    /**
     * A code pointer the DLL keeps in .rdata (a function table entry): the address the file holds, at the
     * preferred image base. Such a slot is relocated at load, so a plain read refuses it.
     */
    Va code_pointer(Va va) const;

    /**
     * A pointer to the VA in the file image or in a writable region, for bulk copies. Null when unmapped.
     */
    const std::uint8_t *host(Va va, std::size_t size) const;
    std::uint8_t *host_rw(Va va, std::size_t size);

private:
    const Rom *rom_;
    Va data_va_ = 0, data_end_ = 0;    // .data and .bss, writable
    Va rdata_va_ = 0, rdata_end_ = 0;  // .rdata, read from the file
    std::int64_t rdata_file_ = 0;
    std::vector<std::uint8_t> data_init_, data_;
    std::vector<std::uint8_t> heap_;
    std::vector<std::uint8_t> relocated_; // 1 per .rdata byte the loader relocates (pointer slots)

    [[noreturn]] void fault(const char *what, Va va) const;
};

} // namespace scva
