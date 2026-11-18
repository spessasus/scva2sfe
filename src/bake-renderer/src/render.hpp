#pragma once

// The bake renderer behind the C API: the DLL's bytes, its tables, the patch directory and the stages one note's
// voices run through. A render is SC-VA's engine cut down to a single note on a fresh part with the LFOs held at 0
// (render.cpp says what was left out and why the result stays the same).

#include "patch/directory.hpp"
#include "rom/rom.hpp"
#include "rom/tables.hpp"
#include "sbr.h"
#include "voice/interp.hpp"
#include "voice/mem.hpp"

#include <cstdint>
#include <vector>

namespace sbr {

class Renderer {
public:
    explicit Renderer(std::vector<std::uint8_t> dll);

    /**
     * Renders a note into the result buffer (sbr.h). Returns false for a request out of range.
     */
    bool render(const sbr_request &request);

    const std::vector<std::uint8_t> &result() const noexcept { return result_; }

private:
    scva::Rom rom_;
    scva::Tables tables_;
    scva::Directory directory_;
    float sample_scale_; // predictor to sample (2^-27 in the DLL's .rdata)
    float idle_level_;   // what the DLL writes where nothing sounds (1e-5)
    scva::Interpolator interpolator_;
    scva::Mem mem_;
    std::vector<std::uint8_t> result_;
};

} // namespace sbr
