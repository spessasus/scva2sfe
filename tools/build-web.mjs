// npm run build:web: the web converter (web/) to build/web, a static site. Needs the bake renderer's WebAssembly
// (npm run build:wasm). The page's cache id covers the same code as the CLI's (src/cli/cache.ts buildId), the page
// adds the browser's version to it
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { buildId } from "../src/cli/cache.ts";

const at = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const wasm = new URL("../build/bake-renderer/sbr.wasm", import.meta.url);
if (!fs.existsSync(wasm)) {
    console.error(`build:web needs the bake renderer's WebAssembly, ${fileURLToPath(wasm)} is missing.
Build it first with npm run build:wasm (Emscripten 6.0.13, see README.md "Building from source").`);
    process.exit(1);
}
const pkg = JSON.parse(fs.readFileSync(at("package.json"), "utf8"));
const out = at("build/web");
fs.rmSync(out, { recursive: true, force: true });
await esbuild.build({
    entryPoints: ["main", "zone-worker"].map((n) => at(`web/${n}.ts`)),
    outdir: out,
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "browser",
    target: "es2024",
    minify: true,
    legalComments: "linked",
    logLevel: "warning",
    define: {
        __BUILD_ID__: JSON.stringify(buildId(wasm, "web")),
        __STEM__: JSON.stringify(`scva-v${pkg.version.split(".")[0]}`)
    }
});
for (const f of ["index.html", "style.css"]) fs.copyFileSync(at(`web/${f}`), `${out}/${f}`);
fs.copyFileSync(wasm, `${out}/sbr.wasm`);
// the licenses travel with the site, like with the compiled converter
for (const f of ["LICENSE", "LICENSE.NativeTS", "NOTICE.md"]) fs.copyFileSync(at(f), `${out}/${f}`);
console.log(`build/web: ${fs.readdirSync(out).map((f) => `${f} ${fs.statSync(`${out}/${f}`).size}`).join(", ")}`);
