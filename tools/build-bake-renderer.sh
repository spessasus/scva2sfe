#!/bin/sh
# Builds the bake renderer (src/bake-renderer) to WebAssembly: build/bake-renderer/sbr.wasm.
#   tools/build-bake-renderer.sh [output dir]
# The flags and sources are in src/bake-renderer/build.rsp, shared with tools\build-bake-renderer.cmd. Needs
# Emscripten 6.0.13 (the version the bit checks ran on, another is refused unless SCVA_EMSDK_ANY=1): em++ on PATH,
# or the emsdk in SCVA_EMSDK (6.0.13 installed and activated there).
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=${1:-$ROOT/build/bake-renderer}
mkdir -p "$OUT" "$ROOT/build/tmp"
OUT=$(cd "$OUT" && pwd)
if ! command -v em++ >/dev/null 2>&1 && [ -n "$SCVA_EMSDK" ]; then
    EMSDK_QUIET=1 . "$SCVA_EMSDK/emsdk_env.sh" >/dev/null
fi
command -v em++ >/dev/null 2>&1 || { echo "em++ not found: install the emsdk or set SCVA_EMSDK" >&2; exit 1; }
if [ "$SCVA_EMSDK_ANY" != 1 ] && ! em++ --version | head -n 1 | grep -q " 6\.0\.13 "; then
    echo "em++ is not Emscripten 6.0.13 (set SCVA_EMSDK_ANY=1 to build anyway)" >&2
    exit 1
fi
cd "$ROOT/src/bake-renderer"
# Emscripten's temporary files go to the build tree, not /tmp
TMPDIR="$ROOT/build/tmp" em++ @build.rsp -o "$OUT/sbr.wasm"
