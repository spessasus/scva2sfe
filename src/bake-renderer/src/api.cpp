// The C API (include/sbr.h) over sbr::Renderer. Exceptions stop here and become sbr_last_error.

#include "render.hpp"
#include "sbr.h"

#include <cstdlib>
#include <exception>
#include <memory>
#include <string>

static_assert(sizeof(sbr_request) == 56);
static_assert(sizeof(sbr_sampler_record) == 32);
static_assert(sizeof(sbr_block_record) == 184);
static_assert(sizeof(sbr_call_record) == 96);
static_assert(sizeof(sbr_send_record) == 36);

struct sbr_renderer {
    std::unique_ptr<sbr::Renderer> renderer;
};

namespace {

std::string last_error;

} // namespace

extern "C" {

SBR_API int sbr_version(void)
{
    return SBR_VERSION;
}

SBR_API const char *sbr_last_error(void)
{
    return last_error.c_str();
}

SBR_API void *sbr_alloc(uint32_t size)
{
    return std::malloc(size ? size : 1);
}

SBR_API void sbr_free(void *p)
{
    std::free(p);
}

SBR_API sbr_renderer *sbr_open(const uint8_t *dll, uint32_t size)
{
    try {
        last_error.clear();
        if (!dll) {
            last_error = "no DLL bytes";
            return nullptr;
        }
        auto r = std::make_unique<sbr_renderer>();
        r->renderer = std::make_unique<sbr::Renderer>(std::vector<std::uint8_t>(dll, dll + size));
        return r.release();
    } catch (const std::exception &e) {
        last_error = e.what();
        return nullptr;
    }
}

SBR_API void sbr_close(sbr_renderer *renderer)
{
    delete renderer;
}

SBR_API int sbr_render(sbr_renderer *renderer, const sbr_request *request)
{
    try {
        last_error.clear();
        if (!renderer || !request) {
            last_error = "null argument";
            return -1;
        }
        if (!renderer->renderer->render(*request)) {
            last_error = "request out of range";
            return -1;
        }
        return 0;
    } catch (const std::exception &e) {
        last_error = e.what();
        return -1;
    }
}

SBR_API const uint8_t *sbr_result(sbr_renderer *renderer)
{
    return renderer && !renderer->renderer->result().empty() ? renderer->renderer->result().data() : nullptr;
}

SBR_API uint32_t sbr_result_size(sbr_renderer *renderer)
{
    return renderer ? static_cast<uint32_t>(renderer->renderer->result().size()) : 0;
}

} // extern "C"
