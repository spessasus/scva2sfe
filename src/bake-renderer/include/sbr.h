/*
 * sbr: the bake renderer. One note of SOUND Canvas VA (SCCore.dll, SC-VA 1.1.6 x64) on a fresh part, rendered the
 * way the converter's bakes render it: its voices (one per sounding partial) with every LFO output held at 0, at
 * the DLL's native 32 kHz rate, before the pan, the mix and the effects.
 *
 * It is the part of SC-VA's engine one such voice needs: the DLL's tables read from its bytes, the patch directory,
 * the DPCM sampler and the interpolator, the SVF, the voice control (pitch, TVA and TVF envelopes, the control tick,
 * the ramps). No scheduler beyond the one note on and note off, no other parts or notes, no controllers, no LFOs, no
 * output buses. A render is bit-identical to SC-VA's own voice output for the same note with the LFO outputs held
 * at 0 and the converter's part setup (sends 91 / 93 / 94 at 0, no other controller, no bend).
 *
 * Built to WebAssembly (tools/build-bake-renderer.cmd / .sh) and loaded from TypeScript (src/bake-renderer/index.ts).
 * The structs are plain C, little-endian, with 32-bit fields and no pointers, so they read the same on wasm32 and
 * x64. A renderer is not thread safe, open one per thread (per Web Worker).
 */
#ifndef SBR_H
#define SBR_H

#include <stdint.h>

#if defined(__EMSCRIPTEN__)
#  include <emscripten/emscripten.h>
#  define SBR_API EMSCRIPTEN_KEEPALIVE
#elif defined(_WIN32)
#  define SBR_API __declspec(dllexport)
#else
#  define SBR_API __attribute__((visibility("default")))
#endif

#ifdef __cplusplus
extern "C" {
#endif

#define SBR_VERSION 1
/* the result buffer's first word, "SBR1" */
#define SBR_MAGIC 0x31524253u

/* The map selectors (the DLL's own numbers) */
#define SBR_MAP_SC55 1
#define SBR_MAP_SC88 2
#define SBR_MAP_SC88PRO 3
#define SBR_MAP_SC8820 4
#define SBR_MAP_GM2 0x7A

/* One bake render. All fields 32-bit, 14 of them (56 bytes). */
typedef struct {
    int32_t map;           /* the map the part runs on when lsb picks none (SBR_MAP_*) */
    int32_t msb;           /* bank select MSB */
    int32_t lsb;           /* bank select LSB: 1..4 pick the map, 0 keeps `map` */
    int32_t program;       /* 0..127 */
    int32_t drum;          /* 1: a drum part (the program picks a kit, the key a kit key) */
    int32_t key;           /* 0..127 */
    int32_t velocity;      /* 1..127 */
    int32_t tone;          /* >= 0: play this tone number directly (melodic parts), -1: look the program up */
    int32_t hold_frames;   /* the note off frame */
    int32_t frames;        /* frames to render */
    uint32_t seed[2];      /* the random generator at the note on (the converter's: 0xEFA6, 0x9C23) */
    int32_t blocks_before; /* 32-sample blocks before the note on's block, places the 100 Hz control tick (the
                              converter's: 129, a GS reset and 'settle 8') */
    int32_t call_frames;   /* frames per host call the events arrive in (0 takes 64, the converter's) */
} sbr_request;

/* The sampler after a block */
typedef struct {
    float hist[4];
    uint32_t position;
    int32_t predictor;
    int16_t scale_index;
    uint16_t phase;
    uint8_t flags;
    uint8_t nibble;
    uint8_t scale_byte;
    uint8_t event;         /* bit 2: the sampler raised the loop / end event in this block */
} sbr_sampler_record;

/* Per voice, per 32-sample block it renders in */
typedef struct {
    int32_t block;         /* block index from the note on */
    int32_t voice;         /* slot */
    int32_t ratio[4];      /* the playback ratio (16.16) per 8 samples */
    uint32_t loop_point;
    uint32_t length;
    sbr_sampler_record sampler;
    float gain16[16];      /* the TVA's ramps: sample i is the interpolation times gain4[i / 8] * gain16[i / 2] */
    float gain4[4];        /* the part level stage (CC7, CC11, the drum key level) */
    float f[4];            /* the SVF coefficients per 8 samples */
    float q[4];
    int32_t svf_tap;
    int32_t reserved0;
} sbr_block_record;

/* Per voice, per 64-frame call, the state after the call. The LFO fields are 0. */
typedef struct {
    int32_t call;
    int32_t voice;
    uint32_t position;
    uint32_t loop_point;
    uint32_t length;
    uint32_t ratio;        /* playback ratio, 16.16 */
    int32_t pitch_current;
    float pitch_env_cents;
    uint32_t amp_flags;
    int32_t amp_current;
    uint16_t tva_env_level;
    uint16_t reserved0;
    float tva_amp;         /* the TVA gain */
    float level_table_gain;
    int32_t tvf_env;
    int32_t cutoff_sum;
    int32_t cutoff_current;
    float svf_f;           /* the SVF coefficient */
    float lfo1_pitch, lfo1_tvf, lfo1_tva;
    float lfo2_pitch, lfo2_tvf, lfo2_tva;
    float pan;
} sbr_call_record;

/* A voice's 4 sends for one block it is active in: send 0 / 1 the dry pair
 * (buses 51 / 52), their levels the pan law's */
typedef struct {
    int32_t block;
    int32_t bus[4];
    float level[4];
} sbr_send_record;

/*
 * The result buffer of sbr_render (sbr_result), little-endian, every offset in bytes from its start:
 *   header, 8 x int32: magic (SBR_MAGIC), version (SBR_VERSION), frames, voice count, tone (-1 none), kit (-1
 *     none), map (the one the note resolved against), 0
 *   per voice, 12 x int32: slot, partial (0 / 1), tone, block count, call count, send count, offset of out, of pre,
 *     of the block records, of the call records, of the send records, 0
 *   then the arrays: out and pre (frames float32 each: the voice's output and its SVF input, 0 where it is not
 *     active), sbr_block_record, sbr_call_record and sbr_send_record arrays.
 * The voices come in slot order. A partial with neither a block nor a call record is left out (allocated and
 * never started, as SC-VA leaves it silent). A voice may have call records and no block.
 */
#define SBR_HEADER_WORDS 8
#define SBR_VOICE_WORDS 12

typedef struct sbr_renderer sbr_renderer;

SBR_API int sbr_version(void);
/* The last error as text (empty when none). */
SBR_API const char *sbr_last_error(void);
/* Memory for the caller's buffers (the DLL's bytes, the request). */
SBR_API void *sbr_alloc(uint32_t size);
SBR_API void sbr_free(void *p);
/* Opens a renderer on SCCore.dll's bytes (copied, the caller frees its buffer). NULL for another build or bad bytes,
 * see sbr_last_error. */
SBR_API sbr_renderer *sbr_open(const uint8_t *dll, uint32_t size);
SBR_API void sbr_close(sbr_renderer *renderer);
/* Renders a note. Returns 0, or -1 on error (see sbr_last_error). */
SBR_API int sbr_render(sbr_renderer *renderer, const sbr_request *request);
/* The last render's result buffer and its size in bytes. Valid until the next sbr_render or sbr_close. */
SBR_API const uint8_t *sbr_result(sbr_renderer *renderer);
SBR_API uint32_t sbr_result_size(sbr_renderer *renderer);

#ifdef __cplusplus
}
#endif

#endif
