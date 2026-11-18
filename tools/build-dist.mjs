// npm run build:dist, around tsc -p tsconfig.dist.json:
//   node tools/build-dist.mjs before    checks for the bake renderer's WebAssembly, then empties dist/
//   node tools/build-dist.mjs after     copies the WebAssembly next to the compiled converter (dist/sbr.wasm)
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const at = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const wasm = at("build/bake-renderer/sbr.wasm");
if (process.argv[2] === "before") {
    // the WebAssembly is built from src/bake-renderer and never tracked: check before anything is deleted
    if (!fs.existsSync(wasm)) {
        console.error(`build:dist needs the bake renderer's WebAssembly, ${wasm} is missing.
Build it first with npm run build:wasm (Emscripten 6.0.13, see README.md "Building from source").`);
        process.exit(1);
    }
    fs.rmSync(at("dist"), { recursive: true, force: true });
} else {
    fs.copyFileSync(wasm, at("dist/sbr.wasm"));
}
