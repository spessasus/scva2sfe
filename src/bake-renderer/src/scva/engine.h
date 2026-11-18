/*
 * The engine names the voice code here uses: the patch query and the resolved patch (patch/directory.*), the map
 * selectors, and the record structs (the same layouts as sbr.h's).
 */
#ifndef SBR_SCVA_ENGINE_H
#define SBR_SCVA_ENGINE_H

#include "sbr.h"

#include <stdint.h>

#define SCVA_MAP_SC55 SBR_MAP_SC55
#define SCVA_MAP_SC88 SBR_MAP_SC88
#define SCVA_MAP_SC88PRO SBR_MAP_SC88PRO
#define SCVA_MAP_SC8820 SBR_MAP_SC8820
#define SCVA_MAP_GM2 SBR_MAP_GM2

/* scva_patch_query.flags */
#define SCVA_RESOLVE_RAW 1u

typedef struct {
    int32_t map;
    int32_t msb;
    int32_t lsb;
    int32_t program;
    int32_t drum;
    int32_t key;
    int32_t velocity;
    uint32_t flags;
    int32_t tone;
} scva_patch_query;

typedef struct {
    int32_t present;
    int32_t sounding;
    int32_t multisample;
    int32_t play_key;
    int32_t follow_key;
    int32_t follow_frac;
    int32_t zone_key;
    int32_t zone;
    int32_t wave;
    int32_t zone_level;
    int32_t vel_low;
    int32_t vel_high;
    int32_t level_byte;
} scva_partial_ref;

typedef struct {
    int32_t map;
    int32_t raw;
    int32_t tone;
    int32_t kit;
    int32_t random_select;
    int32_t tone_level;
    int32_t partial_count;
    scva_partial_ref partials[2];
    int32_t drum_level, drum_pitch, drum_group, drum_pan, drum_reverb, drum_chorus, drum_delay;
    int32_t drum_note_off;
    int32_t drum_note_on;
    char name[16];
    char kit_name[16];
} scva_patch;

typedef sbr_sampler_record scva_sampler_record;
typedef sbr_block_record scva_block_record;
typedef sbr_call_record scva_call_record;
typedef sbr_send_record scva_send_record;

#endif
