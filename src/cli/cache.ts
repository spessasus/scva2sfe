import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SolveCache } from "../lib/cache.js";

/**
 * The converter's own entry files (build id, key hash), and the temporary files a stopped write left behind. Only
 * these are ever deleted, whatever else sits in the folder stays.
 */
const OWN = /^[0-9a-f]{16}-[0-9a-f]{32}\.bin(\.\d+\.tmp)?$/;

/**
 * The solve cache in a folder (src/lib/cache.ts): one file per entry, named by the converter's build id and a hash
 * of the key, written through a temporary file so a stopped run leaves no half entry. Entries of other builds are
 * deleted when a build first writes, so the folder holds one build's entries. A folder that cannot be read is a
 * miss, a failed write is the library's to report.
 */
export class FolderCache implements SolveCache {
    private readonly dir;
    private readonly version;
    private pruned = false;

    public constructor(dir: string, version: string) {
        this.dir = dir;
        this.version = version;
    }

    private file(key: string) {
        return path.join(this.dir, `${this.version}-${crypto.createHash("sha256").update(key).digest("hex").slice(0, 32)}.bin`);
    }

    public async get(key: string) {
        try {
            return new Uint8Array(await fs.promises.readFile(this.file(key)));
        } catch {
            return undefined;
        }
    }

    public async set(key: string, value: Uint8Array) {
        await fs.promises.mkdir(this.dir, { recursive: true });
        if (!this.pruned) {
            this.pruned = true;
            // best effort: an old entry that will not go only takes space
            try {
                for (const f of await fs.promises.readdir(this.dir)) {
                    if (OWN.test(f) && !f.startsWith(`${this.version}-`)) await fs.promises.rm(path.join(this.dir, f), { force: true }).catch(() => undefined);
                }
            } catch {
                // the folder could not be listed, nothing is pruned
            }
        }
        const file = this.file(key);
        const tmp = `${file}.${process.pid}.tmp`;
        try {
            await fs.promises.writeFile(tmp, value);
            await fs.promises.rename(tmp, file);
        } catch (e) {
            await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
            throw e;
        }
    }
}

/**
 * The user's cache folder for the converter (the OS's per user cache location).
 */
export function defaultCacheDir() {
    const home = os.homedir();
    if (process.platform === "win32") return path.join(process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"), "scva2sfe", "cache");
    if (process.platform === "darwin") return path.join(home, "Library", "Caches", "scva2sfe");
    return path.join(process.env.XDG_CACHE_HOME ?? path.join(home, ".cache"), "scva2sfe");
}

/**
 * The converter's build id: a hash of the code that makes the zones and the bakes (the library, the rules, the bake
 * renderer and its WebAssembly) and of the runtime's version (the JavaScript engine's Math gives the fits' numbers),
 * so a changed converter or a new engine never reads an old entry.
 */
export function buildId(wasm: URL, runtime: string) {
    const h = crypto.createHash("sha256");
    h.update(`runtime ${runtime}\0`);
    const here = path.dirname(fileURLToPath(import.meta.url));
    for (const sub of ["lib", "rules", "bake-renderer"]) {
        const dir = path.join(here, "..", sub);
        if (!fs.existsSync(dir)) continue;
        for (const f of fs.readdirSync(dir).filter((n) => /\.(js|ts)$/.test(n)).sort()) {
            h.update(`${sub}/${f}\0`);
            h.update(fs.readFileSync(path.join(dir, f)));
        }
    }
    h.update(fs.readFileSync(wasm));
    return h.digest("hex").slice(0, 16);
}
