#include "patch/directory.hpp"

#include "rom/wave_rom.hpp"

#include <algorithm>
#include <cstdlib>
#include <cstring>

namespace scva {
namespace {

int clamp7(int x)
{
    return std::clamp(x, 0, 0x7F);
}

int i8(int x)
{
    return static_cast<std::int8_t>(static_cast<std::uint8_t>(x & 0xFF));
}

void copy_name(char *out, const std::uint8_t *raw, int n)
{
    std::memcpy(out, raw, static_cast<std::size_t>(n));
    out[n] = 0;
    for (int i = n - 1; i >= 0 && (out[i] == ' ' || out[i] == 0); --i) {
        out[i] = 0;
    }
}

} // namespace

Directory::Directory(const Tables &tables) : t_(&tables)
{
    tone_count_ = static_cast<int>(tables.tone.size()) / tone_stride;
    multisample_count_ = static_cast<int>(tables.multisample.size()) / multisample_stride;
    wave_count_ = static_cast<int>(tables.wavedesc.size()) / WaveDescriptor::stride;
    kit_count_ = static_cast<int>(tables.drum_kits.size()) / kit_stride;
    alternate_count_ = static_cast<int>(tables.layered.size()) / alternate_stride;
}

const std::uint8_t *Directory::tone(int n) const noexcept
{
    return n >= 0 && n < tone_count_ ? t_->tone.data() + std::size_t(n) * tone_stride : nullptr;
}

const std::uint8_t *Directory::partial(int n, int slot) const noexcept
{
    const std::uint8_t *r = tone(n);
    if (!r || slot < 0 || slot > 1) {
        return nullptr;
    }
    const std::uint8_t *b = r + tone_header + slot * partial_stride;
    return u16(b + 2) == 0xFFFF ? nullptr : b;
}

const std::uint8_t *Directory::multisample(int m) const noexcept
{
    return m >= 0 && m < multisample_count_ ? t_->multisample.data() + std::size_t(m) * multisample_stride
                                            : nullptr;
}

const std::uint8_t *Directory::wave(int w) const noexcept
{
    return w >= 0 && w < wave_count_ ? t_->wavedesc.data() + std::size_t(w) * WaveDescriptor::stride : nullptr;
}

const std::uint8_t *Directory::kit(int k) const noexcept
{
    return k >= 0 && k < kit_count_ ? t_->drum_kits.data() + std::size_t(k) * kit_stride : nullptr;
}

std::optional<int> Directory::lut3_raw(int program, int map, int bank) const
{
    if (map < 0 || map >= static_cast<int>(t_->lut1.size()) || bank < 0 || bank > 0x7F || program < 0
        || program > 0x7F) {
        return std::nullopt;
    }
    const int level1 = t_->lut1[std::size_t(map)];
    if (level1 == 0xFF) {
        return std::nullopt;
    }
    const std::size_t i2 = std::size_t(level1) * 0x80 + std::size_t(bank);
    if (i2 >= t_->lut2.size() || t_->lut2[i2] == 0xFF) {
        return std::nullopt;
    }
    const std::size_t i3 = std::size_t(t_->lut2[i2]) * 0x80 + std::size_t(program);
    if (i3 * 2 + 1 >= t_->lut3.size()) {
        return std::nullopt;
    }
    // unsigned on purpose: 0x8000 marks a tone reachable only through an alternate articulation entry
    return u16(t_->lut3.data() + i3 * 2);
}

std::optional<int> Directory::lut3_resolved(int program, int map, int bank) const
{
    // banks 0x40 and 0x41 redirect through a table indexed by program whose three planes replace map, bank and
    // program (the SC-88 and SC-55 compatibility banks)
    if (bank == 0x40 || bank == 0x41) {
        const auto table = bank == 0x40 ? t_->indirect64 : t_->indirect65;
        if (program < 0 || program > 0x7F) {
            return std::nullopt;
        }
        const int sub_bank = table[0x80 + std::size_t(program)];
        if (sub_bank == 0x40 || sub_bank == 0x41) {
            return std::nullopt;
        }
        return lut3_resolved(table[0x100 + std::size_t(program)], table[std::size_t(program)], sub_bank);
    }
    std::optional<int> raw = lut3_raw(program, map, bank);
    // an empty variation plays the capital tone of bank 0
    if (bank != 0 && (!raw || *raw == unassigned)) {
        raw = lut3_raw(program, map, 0);
    }
    return raw;
}

int Directory::program_tone(int program, int map, int bank, bool raw, int *word) const
{
    const std::optional<int> w = raw ? lut3_raw(program, map, bank) : lut3_resolved(program, map, bank);
    if (word) {
        *word = w ? *w : -1;
    }
    if (!w || *w == unassigned || *w >= indirect_only) {
        return -1;
    }
    // 0x4000..0x5fff point into the drum table: per key voices built like kits (TeeBee, Jazz Scat on the
    // SC-8820 map). Not resolved yet
    if (*w >= drum_space && *w < alternate_space) {
        return -1;
    }
    if (*w < drum_space) {
        return *w;
    }
    const int index = *w - alternate_space;
    if (index >= alternate_count_) {
        return -1;
    }
    // the alternate articulation's primary reference (map, bank, program at +0x10)
    const std::uint8_t *r = t_->layered.data() + std::size_t(index) * alternate_stride;
    const std::optional<int> p = lut3_raw(r[0x12], r[0x10], r[0x11]);
    if (!p || *p == unassigned) {
        return -1;
    }
    const int n = *p & 0x7FFF;
    return n < drum_space ? n : -1;
}

int Directory::kit_for_program(int program, int map) const
{
    if (map < 0 || map >= static_cast<int>(t_->drum_bank_row.size()) || program < 0 || program > 0x7F) {
        return -1;
    }
    const int row = t_->drum_bank_row[std::size_t(map)];
    if (row == 0xFF || std::size_t(row) * 0x80 >= t_->drum_prog_map.size()) {
        return -1;
    }
    const int slot = t_->drum_prog_map[std::size_t(row) * 0x80 + std::size_t(program)];
    if (slot == 0xFF) {
        return -1;
    }
    return u16(t_->drum_kit_index.data() + std::size_t(slot) * 2);
}

std::pair<int, int> Directory::key_follow(const std::uint8_t *b, int note) const
{
    // multisample_key_zone has two paths. The one that pivots at the multisample's first bound needs the tone
    // header's byte 0x16 to be 0. That byte is the partial mask (1 or 3 in every tone), so the DLL always takes
    // the other one: the pivot is key 60
    const int pivot = 60;
    const int key = note;
    const int kf = b[0x13];
    if (kf == 0x4A) {
        return {key, 0};
    }
    if (kf == 0x40) {
        return pivot <= key ? std::pair{pivot, 0} : std::pair{pivot - 1, 1000};
    }
    const int d = kf - 0x40;
    const int dist = key - pivot;
    // the engine's sign test: a negative distance always counts as negative
    const bool neg = dist < 0 || d < 0;
    // byte 0x13 is 0x40..0x4f in the shipped data, 21 slopes cover it. Any byte is possible (|d| up to 191): the
    // DLL then reads on in .rdata (pointer slots among it), past the table's 130 bytes the file's bytes stand in
    const std::size_t at = 2 * static_cast<std::size_t>(std::abs(d));
    const std::uint32_t slope = at + 2 <= t_->kf_slope.size()
                                    ? u16(t_->kf_slope.data() + at)
                                    : std::uint32_t(t_->file_byte(t_->kf_slope, at)) |
                                          std::uint32_t(t_->file_byte(t_->kf_slope, at + 1)) << 8;
    const std::uint32_t u = slope * std::uint32_t(2 * std::abs(dist));
    const int hi = static_cast<int>(u >> 16);
    const int lo = static_cast<int>(u & 0xFFFF);
    int k, frac;
    if (lo < 65000) {
        frac = lo * 999 / 65000;
        if (neg) {
            k = -hi - 1;
            frac = 1000 - frac;
        } else {
            k = hi;
        }
    } else {
        k = neg ? -hi - 1 : hi + 1;
        frac = 0;
    }
    k += pivot;
    return k < 0 ? std::pair{0, frac} : std::pair{std::min(k, 127), frac};
}

std::optional<Directory::Zone> Directory::select_wave(const std::uint8_t *b, int note) const
{
    const std::uint8_t *r = multisample(u16(b + 2));
    if (!r) {
        return std::nullopt;
    }
    int key = key_follow(b, note).first;
    key = clamp7(key + b[0x10] - 0x40);
    key = clamp7(key + 0x40 - b[0x04]);
    // the wave select has the same two paths as the key follow (header byte 0x16), and the one the DLL takes has
    // no tail entry and no fallbacks: a key above the last bound and an empty zone are silent, the partial starts
    // no voice (measured: 54 of 54 notes on the 12 tones with such zones)
    if (r[0x2B] < key) {
        return Zone{-1, 0, -1, key};
    }
    int z = 0;
    while (r[0x0C + z] < key) {
        ++z;
    }
    if (s16(r + 0x2C + z * 2) >= 0) {
        return Zone{s16(r + 0x2C + z * 2), r[0x6C + z], z, key};
    }
    return Zone{-1, 0, -1, key};
}

std::optional<int> Directory::level_byte(const std::uint8_t *b, int velocity) const
{
    const int low = b[0x4F];
    const int high = b[0x51];
    const int wl = std::min(low, high);
    const int wh = std::max(low, high);
    if (velocity < wl || velocity > wh) {
        return std::nullopt;
    }
    int position;
    if (wh == wl) {
        position = 0x7F;
    } else {
        const int off = velocity - wl;
        const int scaled = (((off * 0x100) | (off >> 8)) & 0xFFFF) / (wh - wl);
        position = scaled > 0xFF ? 0x7F : scaled >> 1;
    }
    const int span = i8(b[0x52] - b[0x50]);
    const int index = low <= high ? position : (wl - position) & 0xFF;
    // a reversed window can index past its row (the next rows of g_vel_xfade, as the DLL reads them)
    const std::size_t at = std::size_t(b[0x4E] & 15) * 0x80 + std::size_t(index);
    const int curve = at < t_->vel_xfade.size() ? t_->vel_xfade[at] : t_->vel_xfade_tail(at);
    const int delta = i8(((curve * std::abs(span)) + 0x7F) * 2 >> 8);
    const int level = i8(b[0x50] + (span >= 0 ? delta : -delta));
    return level == 0 ? 1 : level;
}

bool Directory::resolve(const scva_patch_query &q, scva_patch &out) const
{
    std::memset(&out, 0, sizeof out);
    out.raw = out.tone = out.kit = -1;
    for (scva_partial_ref &p : out.partials) {
        p.zone = p.wave = p.level_byte = -1;
    }
    if (q.program < 0 || q.program > 0x7F || q.key < 0 || q.key > 0x7F || q.velocity < 0 || q.velocity > 0x7F
        || q.msb < 0 || q.msb > 0x7F || q.lsb < 0 || q.lsb > 0x7F) {
        return false;
    }
    // the bank LSB picks the map like the GS map select, 0 (or an unknown one) keeps the part's
    const int map = q.lsb >= SCVA_MAP_SC55 && q.lsb <= SCVA_MAP_SC8820 ? q.lsb : q.map;
    out.map = map;
    int play_key = q.key;
    bool note_on = true;
    if (q.drum) {
        out.kit = kit_for_program(q.program, map);
        const std::uint8_t *k = kit(out.kit);
        if (!k) {
            out.kit = -1;
            return true;
        }
        copy_name(out.kit_name, k + 0x500, 12);
        const std::size_t n = std::size_t(q.key);
        const int t = u16(k + 2 * n);
        out.raw = t;
        out.tone = t == 0xFFFF ? -1 : t;
        out.drum_level = k[0x100 + n];
        out.drum_pitch = k[0x180 + n];
        out.drum_group = k[0x200 + n];
        out.drum_pan = k[0x280 + n];
        out.drum_reverb = k[0x300 + n];
        out.drum_chorus = k[0x380 + n];
        out.drum_delay = k[0x400 + n];
        out.drum_note_off = k[0x480 + n] & 1;
        out.drum_note_on = (k[0x480 + n] >> 4) & 1;
        note_on = out.drum_note_on != 0;
        // the kit's pitch plane is the key the drum plays
        play_key = out.drum_pitch;
    } else if (q.tone >= 0) {
        out.tone = out.raw = q.tone;
    } else {
        out.tone = program_tone(q.program, map, q.msb, (q.flags & SCVA_RESOLVE_RAW) != 0, &out.raw);
    }
    const std::uint8_t *r = tone(out.tone);
    if (!r) {
        out.tone = -1;
        return true;
    }
    copy_name(out.name, r, 12);
    out.tone_level = r[0x0C];
    out.random_select = r[0x22] != 0;
    for (int slot = 0; slot < 2; ++slot) {
        scva_partial_ref &p = out.partials[slot];
        const std::uint8_t *b = partial(out.tone, slot);
        if (!b) {
            continue;
        }
        p.present = 1;
        p.multisample = u16(b + 2);
        p.play_key = play_key;
        const auto [fk, frac] = key_follow(b, play_key);
        p.follow_key = fk;
        p.follow_frac = frac;
        p.vel_low = std::min(b[0x4F], b[0x51]);
        p.vel_high = std::max(b[0x4F], b[0x51]);
        const std::optional<int> level = level_byte(b, q.velocity);
        p.level_byte = level ? *level : -1;
        const std::optional<Zone> z = select_wave(b, play_key);
        if (z && z->wave >= 0) {
            p.zone = z->zone;
            p.wave = z->wave;
            p.zone_level = z->level;
            p.zone_key = z->key;
        } else if (z) {
            p.zone_key = z->key;
        }
        p.sounding = note_on && level.has_value() && p.wave >= 0 && wave(p.wave) != nullptr;
        out.partial_count += p.sounding;
    }
    return true;
}

} // namespace scva
