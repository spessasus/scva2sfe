#!/usr/bin/env node
// The CLI's entry: the compiled converter (npm run build:dist writes dist/)
import fs from "node:fs";

if (!fs.existsSync(new URL("../dist/cli/main.js", import.meta.url))) {
    console.error("scva2sfe is not built yet: run npm run build:dist first (README.md, Building from source)");
    process.exit(1);
}
await import("../dist/cli/main.js");
