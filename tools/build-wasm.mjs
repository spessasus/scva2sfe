// npm run build:wasm: the bake renderer to build/bake-renderer/sbr.wasm through the platform's build script
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const tools = fileURLToPath(new URL(".", import.meta.url));
const r = process.platform === "win32"
    ? spawnSync("cmd", ["/c", `${tools}build-bake-renderer.cmd`], { stdio: "inherit" })
    : spawnSync("sh", [`${tools}build-bake-renderer.sh`], { stdio: "inherit" });
process.exit(r.status ?? 1);
