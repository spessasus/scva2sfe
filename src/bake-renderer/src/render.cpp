// One note on a fresh part, block by block as TG_Process runs it, cut down to what a bake renders: the note on at
// frame 0 and its note off, the converter's part setup (a GS reset, the sends 91 / 93 / 94 at 0, nothing else) and
// every LFO output held at 0.
//
// Left out, with why the voices stay bit-identical to SC-VA's:
// - The MIDI queue: with two events at known frames, where they take effect is computed directly (dispatch_block,
//   the same stamps and the same parse and dispatch latency as SC-VA's queue).
// - Other notes: no exclusive class cut, no same-key rule, no voice stealing. Their loops find no earlier note.
// - The controller matrix: no controller message reaches the part, so its dirty mask stays 0 and the modulation
//   depth update changes nothing.
// - The LFOs: SC-VA zeroes every output word a voice reads before each tick's voice loop, and a fresh node's output
//   slots start at 0 (at the voice's first setup and at the note on), so a voice reads 0 from them at the note on
//   too. The nodes' own state is read by nothing else. What stays is their draws of the random generator at the
//   note on (one per fresh node, before the voices' own draws for random pitch and pan). The draws an S&H LFO makes
//   at a tick come after the last draw a voice makes (the pan and pitch draws happen once at the note on). The
//   one voice draw that can come later is the random pan of the note on's pan setup, which the release step runs
//   again when a delayed partial retriggers at a tick. It never draws there: the note on's draw left voice + 0xf8 at
//   0xffff on every voice of the chain, the random pan returns early on that, the pan slew skips a voice holding
//   it, and with no controllers the condition for a random pan (part pan or kit key pan 0) is the note on's. A
//   voice with a fixed pan keeps a position 0..0x7f there and never draws.
// - The output buses, the native mix, the tick records and the voice descriptor.

#include "render.hpp"

#include "scva/engine.h"
#include "voice/control.hpp"
#include "voice/ramp.hpp"
#include "voice/sampler.hpp"
#include "voice/svf.hpp"

#include <algorithm>
#include <cstring>
#include <stdexcept>

namespace sbr {
using scva::Va;
namespace g = scva::g;
namespace ramp = scva::ramp;

namespace {

constexpr Va system_defaults = 0x181986310; // the 12 bytes a GS reset loads into the system block
constexpr Va part_defaults = 0x1819a3260;   // the GS part parameters, 0x8a per part (a reset copies a row)
constexpr Va vel_sens = 0x181a01520;        // the TVF velocity curve (partial_velocity_gate)
constexpr Va gain16_first = 0x181a1d730;
constexpr Va tick_flags = 0x181a745d8;      // the timer tick's flags: the voice task's ready bit
constexpr Va kill_flags = 0x181a74518, killed_voice = 0x181a1dd40; // the MIDI task's work: a voice to free
constexpr int part_size = 0x488;
constexpr Va velmap = 0x181a20290;          // g_part_note_velmap: per part and key the velocity, 0xff released
constexpr Va active_mask = 0x181a6f628;     // the voices ever started (4 x u16), part_start_voices
constexpr Va new_mask = 0x181a6f638;        // the voices part_start_voices starts now
constexpr Va scan_mask = 0x181a73460;       // voice_pool_scan's mask: a voice outside it is cleared
constexpr Va filter_groups = 0x181a1d450;   // per group of 4: the filter mask, + 4 the SVF tap bits (stride 0x30)
// the five ramp structs voice_pool_scan clears: pitch, amp, cutoff, damping, volume
constexpr Va scan_ramps[5] = {0x181a1cbf0, 0x181a10140, 0x181a10740, 0x181a0fb40, 0x181a10d40};
constexpr float tick_step = 1000.0f, tick_period = 10000.0f; // 0x181a041bc and 0x181a041c0
constexpr Va ms_per_second = 0x181a041bc;   // 1000.0, TG_ShortMidiIn's stamp
constexpr float host_rate = 32000.0f;       // the rate the host runs the engine at: the native rate, no SRC
constexpr int default_call_frames = 64;
constexpr Va send_level[4] = {0x181a1d930, 0x181a1da30, 0x181a1db30, 0x181a1dc30};
constexpr Va send_bus[4] = {0x181a6e4b0, 0x181a6e5b0, 0x181a6e6b0, 0x181a6e7b0};
constexpr Va rng1 = 0x181a6f630, rng2 = 0x181a6f634;
constexpr int all_slots = 64;               // the DLL's voice slots (voice_pool_scan walks them all)
constexpr Va voice_size = 0x220, node_size = 0xa8, group_size = 0x50;

std::uint8_t clamp7(int x)
{
    return static_cast<std::uint8_t>(x < 0 ? 0 : x > 0x7f ? 0x7f : x);
}

/**
 * A partial's voice: slot 0 or 1 (the free list hands out voice 0 first), its struct and what it rendered.
 */
struct Voice {
    int slot = 0;
    int partial = 0;
    int tone = -1;
    Va v = 0;
    bool started = false;
    // the last tick's values the call records carry
    bool ticked = false;
    std::uint16_t tva_env = 0;
    std::int16_t tvf_env = 0;
    std::uint32_t cutoff_target = 0, volume = 0;
    std::int32_t pitch_env = 0;
    std::vector<scva_call_record> calls;
    std::vector<scva_block_record> blocks;
    std::vector<scva_send_record> sends;
    std::vector<float> pre, out;
};

class Note {
public:
    Note(scva::Mem &m, const scva::Rom &rom, const scva::Tables &tables, const scva::Directory &directory,
         const scva::Interpolator &interp, float scale, float idle)
        : m_(m), rom_(rom), dir_(directory), t_(tables), interp_(interp), idle_(idle), c_(m),
          samplers_{scva::Sampler(tables, scale, idle), scva::Sampler(tables, scale, idle)}
    {
    }

    void run(const sbr_request &request);

    std::vector<Voice> voices; // in the order the partials took them (slot order)

private:
    scva::Mem &m_;
    const scva::Rom &rom_;
    const scva::Directory &dir_;
    const scva::Tables &t_;
    const scva::Interpolator &interp_;
    float idle_;
    scva::Control c_;
    scva::Sampler samplers_[2];
    scva::Svf svfs_[2];
    int slot_voice_[2] = {-1, -1};
    const sbr_request *req_ = nullptr;
    Va part_ = 0, kit_ = 0;
    Va voice_pool_ = 0, voice_free_ = 0, group_ = 0;
    int free_voices_ = 2;

    Va rdata_of(const std::uint8_t *table_byte) const;
    Va voice_struct(int slot) const { return voice_pool_ + static_cast<Va>(slot) * voice_size; }
    void build_part();
    bool note_on_dispatch(int key, int velocity);
    void note_off_dispatch(int key);
    void voice_pool_scan();
    void start_voices();
    void voice_free(Va v);
    void tick();
    void render(int block);
};

Va Note::rdata_of(const std::uint8_t *p) const
{
    const std::int64_t offset = p - rom_.bytes(0, 1).data();
    const std::int64_t va = rom_.file_to_va(offset);
    if (va == 0) {
        throw std::logic_error("a table byte outside the DLL's sections");
    }
    return static_cast<Va>(va);
}

void Note::build_part()
{
    const sbr_request &q = *req_;
    const int channel = q.drum ? 9 : 0;
    part_ = m_.alloc(part_size);
    const Va part = part_;
    // the part's GS parameters: the ROM row whose receive channel (row + 4, part + 0x3d8) is the part's channel,
    // the part number is the row (part_pool_reset_all: the drum channel's part is 0, channel 0's is 1)
    int row = -1;
    for (int r = 0; r < 32 && row < 0; ++r) {
        if (m_.u8(part_defaults + static_cast<Va>(r) * 0x8a + 4) == channel) {
            row = r;
        }
    }
    if (row < 0) {
        throw std::logic_error("no GS part row receives the channel");
    }
    std::uint8_t block[0x8a];
    m_.read(part_defaults + static_cast<Va>(row) * 0x8a, block, sizeof block);
    m_.write(part + 0x3d4, block, sizeof block);
    // part_pool_reset_all
    m_.w8(part + 0x46d, m_.u8(part + 0x3dc));
    m_.w8(part + 0x13, static_cast<std::uint32_t>(row));
    m_.w8(part + 0x45f, 0);
    m_.w8(part + 0x460, 0x40);
    m_.w8(part + 0x461, 0x48);
    m_.w8(part + 0x24e, 0);
    m_.w8(part + 0x24f, 0);
    m_.w8(part + 0x46f, 0);
    m_.w8(part + 0x470, 0);
    m_.w8(part + 0x472, 0);
    m_.w8(part + 0x46e, 0);
    if (m_.u8(part + 0x3d9) & 0x10) {
        m_.w8(part + 0x12, m_.u8(part + 0x12) | 0x20);
    }
    m_.w8(part + 0x10, 1);
    m_.w8(part + 0x11, 0);
    // engine_all_parts_reset
    m_.w8(part + 8, m_.u8(part + 8) & 0xf0);
    m_.w8(part + 0xb, 0x3c);
    m_.w8(part + 0x462, 0);
    m_.w8(part + 0x465, 0);
    m_.w8(part + 0x463, 0);
    m_.w8(part + 0x464, 0x7f);
    m_.w8(part + 0x24d, 0xff);
    m_.w8(part + 0x46a, 0);
    m_.w16(part + 0x448, 0x2000);
    // bank select LSB (the map) and the program
    m_.w8(part + 0x44d, static_cast<std::uint32_t>(q.lsb));
    m_.w8(part + 0x3d5, static_cast<std::uint32_t>(q.program));
    // program_resolve_tone: the tone modify bytes, from the redirect bank's rows for banks 0x40 / 0x41
    const std::uint8_t bank = static_cast<std::uint8_t>(q.msb);
    std::uint8_t modify[8] = {0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40};
    if (!q.drum && static_cast<std::uint8_t>(bank - 0x40) < 2) {
        std::uint8_t map = m_.u8(part + 0x44d);
        if (map == 0) {
            map = m_.u8(part + 0x44e);
        }
        if (map != 1) {
            const auto table = bank == 0x40 ? t_.indirect64 : t_.indirect65;
            for (int i = 0; i < 8; ++i) {
                const std::size_t at = 0x180 + std::size_t(i) * 0x80 + std::size_t(q.program);
                modify[i] = at < table.size() ? table[at] : 0x40;
            }
        }
    }
    for (int i = 0; i < 7; ++i) {
        m_.w8(part + 0x453 + i, modify[i]);
    }
    m_.w8(part + 0x45a, modify[7]);
    m_.w8(part + 0x45b, 0x40);
    // the converter's controllers: reverb (91) and chorus (93) sends at 0 (94, the delay send, writes nothing)
    m_.w8(part + 0x3e3, 0);
    m_.w8(part + 0x3e2, 0);
    // the program change keeps the map it resolved with in 0x444 / 0x445. A drum part's assign mode then follows
    // the map (drum_part_program_change)
    m_.w8(part + 0x444, m_.u8(part + 0x44d));
    m_.w8(part + 0x445, m_.u8(part + 0x44e));
    if (q.drum) {
        std::uint8_t mode = m_.u8(part + 0x3d9);
        const std::uint8_t lsb = m_.u8(part + 0x444);
        if ((lsb == 0 && m_.u8(part + 0x445) == 1) || lsb == 1) {
            mode &= 0xfc;
        } else {
            mode = static_cast<std::uint8_t>((mode & 0xfd) | 1);
        }
        m_.w8(part + 0x3d9, mode);
    }
    // the drum part's kit, copied at the program change (drum_part_program_change, part + 0x18)
    if (q.drum) {
        scva_patch_query kq{q.map, q.msb, q.lsb, q.program, q.drum, 60, q.velocity, 0, q.tone};
        scva_patch kp{};
        if (!dir_.resolve(kq, kp) || kp.kit < 0) {
            throw std::runtime_error("the drum part's program has no kit");
        }
        kit_ = m_.alloc(scva::Directory::kit_stride);
        m_.write(kit_, dir_.kit(kp.kit), scva::Directory::kit_stride);
        m_.wptr(part + 0x18, kit_);
    }
    m_.w16(part + 0x23c, 2);
}

bool Note::note_on_dispatch(int key, int velocity)
{
    const Va part = part_;
    // note_on_dispatch: the part's key range and, on a drum part, the key's receive note on bit
    const bool drum = (m_.u8(part + 0x12) & 0x20) != 0;
    if (!(m_.u16(part + 0x3d6) & 0x200) || (drum && !(m_.u8(kit_ + 0x480 + static_cast<Va>(key)) & 0x10)) ||
        key < m_.s8(part + 0x3e0) || m_.s8(part + 0x3e1) < key) {
        return false;
    }
    m_.w8(part + 9, static_cast<std::uint32_t>(key));
    // the velocity through the part's sensitivity (0x3de, 0x40 = as is) and offset (0x3df)
    std::uint16_t vel = static_cast<std::uint16_t>(velocity);
    const std::uint8_t sens = m_.u8(part + 0x3de);
    if (sens == 0) {
        vel = 1;
    } else if (sens != 0x40) {
        vel = static_cast<std::uint16_t>(static_cast<std::uint32_t>(vel) * sens >> 6);
    }
    vel = static_cast<std::uint16_t>(vel + (m_.u8(part + 0x3df) - 0x40) * 2);
    const std::int16_t sv = static_cast<std::int16_t>(vel);
    vel = static_cast<std::uint16_t>(sv < 0 ? 1 : sv > 0x7f ? 0x7f : sv);
    m_.w8(part + 0x248, vel);
    m_.w8(velmap + static_cast<Va>(m_.s8(part + 0x13)) * 0x80 + static_cast<Va>(key), vel);
    if (m_.u8(part + 0x46f) != 0) {
        return false;
    }
    // the tone and its partials for the key and velocity (partial_build's zones through the directory)
    const sbr_request &r = *req_;
    const scva_patch_query q{r.map, r.msb, r.lsb, r.program, r.drum, key, vel, 0, r.tone};
    scva_patch patch{};
    if (!dir_.resolve(q, patch) || patch.tone < 0) {
        return false;
    }
    const Va header = rdata_of(dir_.tone(patch.tone));
    m_.w8(part + 0x24c, m_.u8(header + 0xd)); // tone_resolve: the tone's flags (bit 1: the damper does not hold)
    m_.wptr(part + 0x218, header);
    m_.wptr(part + 0x220, header + scva::Directory::tone_header);
    m_.w16(part + 0x23c, 2);
    if (drum) {
        m_.w8(part + 10, m_.u8(kit_ + 0x180 + static_cast<Va>(key)));
        m_.w8(part + 0x24b, m_.u8(kit_ + 0x200 + static_cast<Va>(key)));
        m_.w8(part + 0x24a, m_.u8(kit_ + 0x480 + static_cast<Va>(key)));
    } else {
        // voice_trigger_partials
        m_.w8(part + 10, clamp7(static_cast<std::int8_t>(m_.u8(part + 0x46a)) + m_.u8(part + 0x3da) +
                                m_.u8(g::system + 5) + key - 0x80));
        m_.wptr(part + 0x18, 0);
        m_.w8(part + 0x24a, 0xff);
        m_.w8(part + 0x24b, 0x80);
    }
    // tone_apply_velocity_splits: a random select tone (header 0x22) keeps one of its sounding partials, the one
    // whose place among them is the generator's next value modulo their count
    bool sounding[2] = {patch.partials[0].sounding != 0, patch.partials[1].sounding != 0};
    int count = int(sounding[0]) + int(sounding[1]);
    if (count > 1 && m_.u8(header + 0x22) != 0) {
        const std::uint16_t rnd = c_.prng();
        int place = 0;
        for (bool &on : sounding) {
            if (on) {
                if (place != static_cast<int>(rnd % count)) {
                    on = false;
                }
                ++place;
            }
        }
        count = 1;
    }
    if (count == 0) {
        return false;
    }
    if (!drum) {
        m_.w8(part + 8, m_.u8(part + 8) & 0xfe);
    }
    // note_group_alloc on a part without notes: the voices from the free list, one note group
    const std::uint8_t cls = m_.u8(part + 0x24b);
    Va taken[2] = {0, 0};
    for (int p = 0; p < 2; ++p) {
        if (sounding[p]) {
            const Va v = voice_free_;
            --free_voices_;
            voice_free_ = m_.ptr(v + 0x108);
            m_.w16(v + 0x94, 0xffff);
            taken[p] = v;
        }
    }
    const Va grp = group_;
    m_.w16(grp + 0x32, 2 < count ? 1u : 0u);
    m_.w8(grp + 0x31, cls);
    m_.w8(grp + 0x35, m_.u8(part + 0x24a));
    m_.w8(grp + 0x38, 1);
    m_.w8(grp + 0x30, 1);
    m_.w8(grp + 0x34, (m_.u16(part + 0x260 + static_cast<Va>(key >> 4) * 2) >> (key & 15)) & 1);
    m_.w8(grp + 0x36, static_cast<std::uint32_t>(key));
    m_.w8(grp + 0x37, m_.u8(part + 0x248));
    m_.wptr(part + 0x2a0, grp);
    m_.wptr(grp + 0x18, part);
    m_.wptr(part + 0x270, grp);
    m_.wptr(part + 0x278, grp);
    m_.wptr(grp + 0x20, 0);
    m_.wptr(grp + 0x28, 0);
    m_.w8(part + 0x45e, m_.u8(part + 0x45e) + static_cast<std::uint32_t>(count));
    // the note's voice chain in partial order
    Va prev = 0;
    for (int p = 0; p < 2; ++p) {
        const Va v = taken[p];
        if (!v) {
            continue;
        }
        if (!prev) {
            m_.wptr(grp, v);
            m_.wptr(grp + 8, v);
            m_.wptr(v + 0x110, 0);
            m_.wptr(v + 0x120, grp);
            m_.wptr(v + 0x128, part);
            m_.w16(v + 0xf8, 0);
        } else {
            m_.w16(prev + 0xf8, 0);
            m_.wptr(prev + 0x108, v);
            m_.wptr(grp + 8, v);
            m_.wptr(v + 0x110, prev);
            m_.wptr(v + 0x120, grp);
            m_.wptr(v + 0x128, part);
        }
        prev = v;
    }
    m_.wptr(prev + 0x108, 0);
    // partial_alloc_node: the note's LFO1 node and an LFO2 node per sounding partial. Their output slots stay 0
    // (the LFOs are held at 0), the voices only point at them
    const Va n1 = m_.alloc(node_size);
    Va lfo2[2] = {0, 0};
    for (int p = 0; p < 2; ++p) {
        if (sounding[p]) {
            lfo2[p] = m_.alloc(node_size);
        }
    }
    // the voices: what the partial and its zone give them
    for (int p = 0; p < 2; ++p) {
        const Va v = taken[p];
        if (!v) {
            continue;
        }
        const scva_partial_ref &ref = patch.partials[p];
        const std::uint8_t *b = dir_.partial(patch.tone, p);
        m_.w16(v + 0x16c, 0);
        m_.wptr(v + 0x138, rdata_of(dir_.wave(ref.wave)));
        m_.w8(v + 0x140, static_cast<std::uint32_t>(ref.zone_level));
        m_.w8(v + 0x141, 0);
        m_.w8(v + 0x142, 0);
        m_.wptr(v + 0x148, rdata_of(b));
        m_.wptr(v + 0x150, header);
        m_.wptr(v + 0x158, m_.ptr(part + 0x18));
        m_.w8(v + 0x160, m_.u8(part + 9));
        m_.w8(v + 0x161, m_.u8(part + 10));
        m_.w8(v + 0x162, 0xff);
        const std::uint8_t zone_key = clamp7(ref.follow_key + b[0x10] - 0x40);
        m_.w8(part + 0xc + static_cast<Va>(p), zone_key);
        m_.w8(v + 0x163, zone_key);
        m_.w8(v + 8, (m_.u8(part + 0x24c) >> 1) & 1);
        m_.w8(v + 0x169, m_.u8(part + 0x10));
        m_.w8(v + 0x164, static_cast<std::uint32_t>(ref.level_byte));
        const std::uint32_t vel0 = m_.u8(part + 0x248);
        const std::uint32_t velx = (m_.u8(part + 8) & 8) ? vel0 * 0x5b / 0x7f : vel0;
        m_.w8(v + 0x165, m_.u8(vel_sens + velx + (b[0x2e] & 0xfu) * 0x80));
        m_.w8(v + 0x166, vel0);
        m_.w8(v + 0x167, m_.u8(header + 0xc));
        m_.w8(v + 0x168, m_.u8(header + 0x17));
        m_.w16(v + 0x16a, static_cast<std::uint32_t>(ref.follow_frac));
        m_.wptr(v + 0x170, n1 + static_cast<Va>(p) * 0xc + 0x40);
        m_.wptr(v + 0x178, n1);
        m_.wptr(v + 0x180, lfo2[p]);
        m_.w8(v + 0x189, 0xff);
        m_.wptr(v + 0x198, part + 0x2f0 + static_cast<Va>(static_cast<std::int64_t>(m_.s8(part + 9))));
        m_.wptr(v + 400, part + 0x463);
        Voice nv;
        nv.slot = m_.u8(v) & 0x3f;
        nv.partial = p;
        nv.tone = patch.tone;
        nv.v = v;
        nv.pre.assign(static_cast<std::size_t>(req_->frames), 0.0f);
        nv.out.assign(static_cast<std::size_t>(req_->frames), 0.0f);
        slot_voice_[nv.slot] = static_cast<int>(voices.size());
        voices.push_back(std::move(nv));
    }
    return true;
}

void Note::voice_pool_scan()
{
    // a voice outside the scan mask has its ramps and its filter bits cleared and joins the mask
    for (int i = 0; i < all_slots; ++i) {
        const Va word = scan_mask + static_cast<Va>(i >> 4) * 2;
        const std::uint16_t bit = static_cast<std::uint16_t>(1u << (i & 15));
        if (m_.u16(word) & bit) {
            continue;
        }
        for (Va r : scan_ramps) {
            const Va at = r + static_cast<Va>(i) * ramp::stride;
            m_.w16(at, 0);
            m_.st<std::uint64_t>(at + 0xc, 0);
            m_.w32(at + 8, 0);
        }
        const Va grp = filter_groups + static_cast<Va>(i >> 2) * 0x30;
        m_.w32(grp, m_.u32(grp) & ~(1u << (i & 3)));
        m_.w32(grp + 4, m_.u32(grp + 4) & ~(3u << ((i & 3) * 2)));
        m_.w16(word, m_.u16(word) | bit);
    }
}

void Note::start_voices()
{
    // part_start_voices: note_on_voice_setup's draw of the generator per fresh LFO node (LFO1, then each LFO2),
    // then every voice's parameters, then every voice starts
    const Va grp = group_;
    for (std::size_t i = 0; i < 1 + voices.size(); ++i) {
        c_.prng();
    }
    if (m_.u8(grp + 0x38) == 0) {
        return;
    }
    m_.w8(grp + 0x38, 0);
    for (Va v = m_.ptr(grp); v; v = m_.ptr(v + 0x108)) {
        m_.w8(v + 1, 0);
    }
    const Va first = m_.ptr(grp);
    for (Va v = first; v; v = m_.ptr(v + 0x108)) {
        c_.partial_load_params(v);
        c_.partial_pitch_env_init(v);
        if (m_.u8(v + 1) != 0) {
            break;
        }
    }
    if (m_.u8(first + 1) != 0) {
        return;
    }
    std::uint16_t fresh[4] = {0, 0, 0, 0};
    for (Va v = first; v; v = m_.ptr(v + 0x108)) {
        for (int k = 0; k < 4; ++k) {
            fresh[k] = static_cast<std::uint16_t>(fresh[k] | m_.u16(v + 0x130 + static_cast<Va>(k) * 2));
        }
    }
    for (int k = 0; k < 4; ++k) {
        const Va a = active_mask + static_cast<Va>(k) * 2;
        m_.w16(new_mask + static_cast<Va>(k) * 2, fresh[k]);
        m_.w16(a, m_.u16(a) & ~fresh[k]);
        m_.w16(scan_mask + static_cast<Va>(k) * 2, m_.u16(a));
    }
    voice_pool_scan();
    for (Va v = first; v; v = m_.ptr(v + 0x108)) {
        m_.w16(g::send_base, m_.u8(v + 6));
        c_.voice_start(v);
        const int s = m_.u8(v) & 0x3f;
        scva::WaveRegisters reg;
        reg.a = m_.u32(v + 0x1a0);
        reg.b = m_.u32(v + 0x1a4);
        reg.c = m_.u32(v + 0x1a8);
        reg.flags = m_.u32(v + 0x1ac);
        samplers_[s].start(reg);
        svfs_[s].reset(idle_);
        svfs_[s].tap = scva::Svf::tap_of_word(static_cast<std::uint16_t>(m_.u32(v + 0x1ec)), s);
        voices[static_cast<std::size_t>(slot_voice_[s])].started = true;
    }
    for (int k = 0; k < 4; ++k) {
        const Va a = active_mask + static_cast<Va>(k) * 2;
        m_.w16(a, m_.u16(a) | fresh[k]);
        m_.w16(scan_mask + static_cast<Va>(k) * 2, m_.u16(a));
    }
    voice_pool_scan();
}

void Note::note_off_dispatch(int key)
{
    // note_off_dispatch on a poly or drum part: the note releases, a drum key only when it receives note off
    // (group + 0x35 bit 0), a note the damper holds (group + 0x34 bit 0) only later
    const Va part = part_;
    m_.w8(part + 9, static_cast<std::uint32_t>(key));
    m_.w8(velmap + static_cast<Va>(m_.s8(part + 0x13)) * 0x80 + static_cast<Va>(key), 0xff);
    if (m_.u8(part + 0x46f) != 0) {
        return;
    }
    const bool drum = (m_.u8(part + 0x12) & 0x20) != 0;
    if (!drum && !(m_.u8(part + 0x3d9) & 0x80)) {
        throw std::runtime_error("a mono part's note off is not modelled");
    }
    for (Va grp = m_.ptr(part + 0x278); grp; grp = m_.ptr(grp + 0x28)) {
        if (m_.u8(grp + 0x30) == 1 && m_.u8(grp + 0x36) == key && (m_.u8(grp + 0x35) & 1)) {
            m_.w8(grp + 0x30, 2);
            if (!(m_.u8(grp + 0x34) & 1)) {
                for (Va v = m_.ptr(grp); v; v = m_.ptr(v + 0x108)) {
                    m_.w8(v + 0x16d, 1);
                }
            }
            return;
        }
    }
}

void Note::voice_free(Va v)
{
    // partial_voice_free: the voice leaves its note's chain (a key off partial then finds itself alone at the note
    // off and is not started), the note group goes with its last voice, the voice goes first in the free list
    const Va p = m_.ptr(v + 0x128);
    m_.w8(p + 0x45e, m_.u8(p + 0x45e) - 1);
    const Va prev = m_.ptr(v + 0x110), next = m_.ptr(v + 0x108), grp = m_.ptr(v + 0x120);
    m_.w16(v + 1, 0x101);
    m_.w8(v + 0x16c, 0);
    if (prev == 0) {
        if (next == 0) {
            // note_group_free: the part's only note
            const Va owner = m_.ptr(grp + 0x18);
            m_.w8(grp + 0x38, 1);
            m_.wptr(owner + 0x270, 0);
            m_.wptr(owner + 0x278, 0);
            m_.wptr(grp, 0);
            m_.wptr(grp + 8, 0);
            m_.w8(grp + 0x30, 0);
            if (m_.ptr(owner + 0x2a0) == grp) {
                m_.wptr(owner + 0x2a0, 0);
            }
        } else {
            m_.wptr(grp, next);
            m_.wptr(next + 0x110, 0);
        }
    } else if (next == 0) {
        m_.wptr(prev + 0x108, 0);
        m_.wptr(grp + 8, prev);
    } else {
        m_.wptr(prev + 0x108, next);
        m_.wptr(next + 0x110, prev);
    }
    ++free_voices_;
    m_.wptr(v + 0x108, voice_free_);
    voice_free_ = v;
}

void Note::tick()
{
    // the timer counts the tick, the control update takes the count as the ticks to step, then runs
    // every voice struct in slot order (its LFO node loop is left out, the outputs stay 0)
    m_.w32(tick_flags, m_.u32(tick_flags) | 0x8000);
    m_.w16(g::tick_pending, 1);
    m_.w16(g::tick_count, m_.u16(g::tick_pending));
    m_.w16(g::tick_pending, 0);
    for (int s = 0; s < 2; ++s) {
        if (slot_voice_[s] < 0) {
            continue;
        }
        Voice &nv = voices[static_cast<std::size_t>(slot_voice_[s])];
        const Va v = nv.v;
        c_.control_update(v);
        if (!nv.started) {
            continue;
        }
        nv.ticked = true;
        nv.tva_env = m_.u16(v + 0x18);
        nv.tvf_env = m_.s16(v + 0xec);
        nv.cutoff_target = m_.u32(v + 0xcc);
        nv.pitch_env = m_.s32(v + 0x6c);
        nv.volume = m_.u32(v + 0x9c);
    }
}

void Note::render(int block)
{
    // render_block over the voice slots that hold a voice: the pitch ramp, then for an active voice the TVA's
    // ramps, the block renderer, the cutoff and damping ramps and the SVF. A freed voice's ramps run on until its
    // pitch ramp reaches 0
    for (int s = 0; s < 2; ++s) {
        if (slot_voice_[s] < 0) {
            continue;
        }
        Voice &nv = voices[static_cast<std::size_t>(slot_voice_[s])];
        scva_block_record b{};
        b.block = block;
        b.voice = s;
        ramp::pitch_block(m_, s, b.ratio);
        if (b.ratio[0] == 0) {
            m_.wf(gain16_first + static_cast<Va>(s) * 4, 0.0f);
            continue;
        }
        ramp::amp_block(m_, s, b.gain16);
        ramp::gain4_block(m_, s, b.gain4);
        m_.wf(gain16_first + static_cast<Va>(s) * 4, b.gain16[0]);
        scva::Sampler &sp = samplers_[s];
        float pre[32], out[32];
        sp.clear_event();
        interp_.render(sp, b.ratio, b.gain16, b.gain4, pre);
        ramp::cutoff_block(m_, s, b.f);
        ramp::q_block(m_, s, b.q, b.f);
        svfs_[s].render(pre, b.f, b.q, out);
        b.loop_point = static_cast<std::uint32_t>(sp.loop_point);
        b.length = static_cast<std::uint32_t>(sp.length);
        std::memcpy(b.sampler.hist, sp.hist, sizeof b.sampler.hist);
        b.sampler.position = static_cast<std::uint32_t>(sp.position);
        b.sampler.predictor = sp.predictor;
        b.sampler.scale_index = sp.scale_index;
        b.sampler.phase = sp.phase;
        b.sampler.flags = sp.flags;
        b.sampler.nibble = sp.nibble;
        b.sampler.scale_byte = sp.scale_byte;
        b.sampler.event = sp.event() ? 4 : 0;
        b.svf_tap = static_cast<std::int32_t>(svfs_[s].tap);
        nv.blocks.push_back(b);
        scva_send_record sr{};
        sr.block = block;
        for (int k = 0; k < 4; ++k) {
            sr.bus[k] = m_.s32(send_bus[k] + static_cast<Va>(s) * 4);
            sr.level[k] = m_.f32(send_level[k] + static_cast<Va>(s) * 4);
        }
        nv.sends.push_back(sr);
        const std::size_t at = static_cast<std::size_t>(block) * 32;
        if (at + 32 <= static_cast<std::size_t>(req_->frames)) {
            std::copy(pre, pre + 32, nv.pre.begin() + static_cast<std::ptrdiff_t>(at));
            std::copy(out, out + 32, nv.out.begin() + static_cast<std::ptrdiff_t>(at));
        }
    }
}

void Note::run(const sbr_request &request)
{
    req_ = &request;
    voices.clear();
    m_.reset();
    std::uint8_t sys[12];
    m_.read(system_defaults, sys, sizeof sys);
    m_.write(g::system, sys, sizeof sys);
    m_.w16(rng1, request.seed[0]);
    m_.w16(rng2, request.seed[1]);
    // note_alloc_process's pools as far as one note uses them: voices 0 and 1 at the head of the free list (each
    // knows its slot and its bit in the voice mask at + 0x130), one note group
    voice_pool_ = m_.alloc(2 * voice_size);
    voice_free_ = 0;
    for (int i = 1; i >= 0; --i) {
        const Va v = voice_struct(i);
        m_.wptr(v + 0x120, 0);
        m_.w8(v, static_cast<std::uint32_t>(i));
        m_.st<std::uint64_t>(v + 0x130, 0);
        m_.w16(v + 0x130 + static_cast<Va>(i >> 4) * 2, 1u << (i & 15));
        m_.wptr(v + 0x108, voice_free_);
        m_.w16(v + 2, 0);
        m_.w8(v + 1, 0);
        m_.w8(v + 0x16c, 0);
        voice_free_ = v;
    }
    free_voices_ = 2;
    group_ = m_.alloc(group_size);
    m_.w16(group_ + 0x3a, 0);
    build_part();
    // the control tick's accumulator after the blocks before the render
    float acc = 0.0f;
    for (int i = 0; i < request.blocks_before; ++i) {
        acc += tick_step;
        if (tick_period <= acc) {
            acc -= tick_period;
        }
    }
    // where the note on (frame 0) and the note off take effect: TG_ShortMidiIn stamps an event with its offset in
    // the host's call, it is queued at the start of its call (which renders from block ceil(c N / 32)), moved to
    // the port ring after the first block it is due at, parsed one iteration later and dispatched the next
    const int call_frames = request.call_frames > 0 ? request.call_frames : default_call_frames;
    const float ms = m_.f32(ms_per_second);
    const auto dispatch_block = [&](int frame) {
        const int call = frame / call_frames;
        const int offset = frame % call_frames;
        const int available = static_cast<int>((static_cast<long long>(call) * call_frames + 31) / 32);
        const int stamp = static_cast<int>(static_cast<float>(offset) * ms / host_rate);
        return std::max(available, stamp) + 2;
    };
    const int note_on = dispatch_block(0), note_off = dispatch_block(request.hold_frames);
    const int blocks = request.frames / 32;
    for (int b = 0; b < blocks; ++b) {
        render(b);
        // what TG_Process does after the block: the tick accumulator, the loop event, then the tasks (the note task
        // frees a killed voice and dispatches the notes, the voice start task starts them, the voice task ticks)
        acc += tick_step;
        bool ticked = false;
        if (tick_period <= acc) {
            acc -= tick_period;
            ticked = true;
        }
        for (int s = 0; s < 2; ++s) {
            if (slot_voice_[s] >= 0 && samplers_[s].take_loop_event()) {
                m_.w8(voices[static_cast<std::size_t>(slot_voice_[s])].v + 4, 1);
            }
        }
        if (m_.u32(kill_flags) & 0x4000) {
            m_.w32(kill_flags, m_.u32(kill_flags) & ~0x4000u);
            const Va dead = m_.ptr(killed_voice);
            if (dead && m_.u8(dead + 2) == 0) {
                voice_free(dead);
            }
        }
        bool start = false;
        if (b == note_on) {
            start = note_on_dispatch(request.key, request.velocity);
        }
        if (b == note_off) {
            note_off_dispatch(request.key);
        }
        if (start) {
            start_voices();
        }
        if (ticked) {
            tick();
        }
        // the call record: the state after the call's second block, for a voice the ramps keep sounding
        if (b % 2 == 1) {
            for (int s = 0; s < 2; ++s) {
                if (slot_voice_[s] < 0) {
                    continue;
                }
                Voice &nv = voices[static_cast<std::size_t>(slot_voice_[s])];
                const Va pr = ramp::pitch + static_cast<Va>(s) * ramp::stride;
                if (m_.u32(pr + 0x14) == 0) {
                    continue;
                }
                const Va ar = ramp::amp + static_cast<Va>(s) * ramp::stride;
                const Va cr = ramp::cutoff + static_cast<Va>(s) * ramp::stride;
                const scva::Sampler &sp = samplers_[s];
                scva_call_record c{};
                c.call = b / 2;
                c.voice = s;
                c.position = static_cast<std::uint32_t>(sp.position);
                c.loop_point = static_cast<std::uint32_t>(sp.loop_point);
                c.length = static_cast<std::uint32_t>(sp.length);
                c.ratio = m_.u32(pr + 0x14);
                c.pitch_current = m_.s32(pr + 8);
                c.amp_flags = m_.u32(ar);
                c.amp_current = m_.s32(ar + 8);
                c.tva_amp = m_.f32(ar + 0x14);
                c.cutoff_current = m_.s32(cr + 8);
                c.svf_f = m_.f32(cr + 0x14);
                // the pan as the dry pair's share: send 1's level over the two sends' (both idle: centre)
                const float left = m_.f32(send_level[0] + static_cast<Va>(s) * 4);
                const float right = m_.f32(send_level[1] + static_cast<Va>(s) * 4);
                c.pan = left + right > 0.0f ? right / (left + right) : 0.5f;
                if (nv.ticked) {
                    c.tva_env_level = nv.tva_env;
                    c.tvf_env = nv.tvf_env;
                    c.cutoff_sum = static_cast<std::int32_t>(nv.cutoff_target >> 2);
                    c.pitch_env_cents = static_cast<float>(nv.pitch_env) / 10.0f;
                    c.level_table_gain = static_cast<float>(nv.volume >> 2) / 65535.0f;
                }
                nv.calls.push_back(c);
            }
        }
    }
}

void put32(std::vector<std::uint8_t> &buf, std::size_t at, std::uint32_t value)
{
    std::memcpy(buf.data() + at, &value, 4);
}

template <typename T> std::size_t put_array(std::vector<std::uint8_t> &buf, const std::vector<T> &items)
{
    const std::size_t at = buf.size();
    buf.resize(at + items.size() * sizeof(T));
    if (!items.empty()) {
        std::memcpy(buf.data() + at, items.data(), items.size() * sizeof(T));
    }
    return at;
}

float float_at(std::span<const std::uint8_t> bytes)
{
    float f;
    std::memcpy(&f, bytes.data(), sizeof f);
    return f;
}

} // namespace

Renderer::Renderer(std::vector<std::uint8_t> dll)
    : rom_(std::move(dll)), tables_(rom_), directory_(tables_),
      sample_scale_(float_at(tables_.raw("sample_scale_a04144"))),
      idle_level_(float_at(tables_.raw("idle_level_a04160"))), interpolator_(tables_.raw("interp_coef_a0f210")),
      mem_(rom_)
{
}

bool Renderer::render(const sbr_request &r)
{
    if (r.hold_frames < 0 || r.frames < 0 || r.blocks_before < 0 || r.call_frames < 0 || r.key < 0 || r.key > 127 ||
        r.velocity < 1 || r.velocity > 127) {
        return false;
    }
    const scva_patch_query query{r.map, r.msb, r.lsb, r.program, r.drum, r.key, r.velocity, 0, r.tone};
    scva_patch patch{};
    if (!directory_.resolve(query, patch)) {
        return false;
    }
    Note note(mem_, rom_, tables_, directory_, interpolator_, sample_scale_, idle_level_);
    note.run(r);
    // a partial allocated and never sounding (a key off partial alone at the note off) is not handed out, SC-VA
    // never starts it
    std::vector<const Voice *> kept;
    for (const Voice &v : note.voices) {
        if (!v.blocks.empty() || !v.calls.empty()) {
            kept.push_back(&v);
        }
    }
    result_.assign((SBR_HEADER_WORDS + SBR_VOICE_WORDS * kept.size()) * 4, 0);
    const std::uint32_t header[SBR_HEADER_WORDS] = {SBR_MAGIC,
                                                    SBR_VERSION,
                                                    static_cast<std::uint32_t>(r.frames),
                                                    static_cast<std::uint32_t>(kept.size()),
                                                    static_cast<std::uint32_t>(patch.tone),
                                                    static_cast<std::uint32_t>(patch.kit),
                                                    static_cast<std::uint32_t>(patch.map),
                                                    0};
    for (int i = 0; i < SBR_HEADER_WORDS; ++i) {
        put32(result_, std::size_t(i) * 4, header[i]);
    }
    for (std::size_t i = 0; i < kept.size(); ++i) {
        const Voice &v = *kept[i];
        const std::size_t base = (SBR_HEADER_WORDS + SBR_VOICE_WORDS * i) * 4;
        put32(result_, base, static_cast<std::uint32_t>(v.slot));
        put32(result_, base + 4, static_cast<std::uint32_t>(v.partial));
        put32(result_, base + 8, static_cast<std::uint32_t>(v.tone));
        put32(result_, base + 12, static_cast<std::uint32_t>(v.blocks.size()));
        put32(result_, base + 16, static_cast<std::uint32_t>(v.calls.size()));
        put32(result_, base + 20, static_cast<std::uint32_t>(v.sends.size()));
        put32(result_, base + 24, static_cast<std::uint32_t>(put_array(result_, v.out)));
        put32(result_, base + 28, static_cast<std::uint32_t>(put_array(result_, v.pre)));
        put32(result_, base + 32, static_cast<std::uint32_t>(put_array(result_, v.blocks)));
        put32(result_, base + 36, static_cast<std::uint32_t>(put_array(result_, v.calls)));
        put32(result_, base + 40, static_cast<std::uint32_t>(put_array(result_, v.sends)));
    }
    return true;
}

} // namespace sbr
