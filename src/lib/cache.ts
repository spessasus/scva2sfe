/**
 * The solve cache: a conversion's zone results (and the filter maps) kept on the user's machine, so a later
 * conversion of the same DLL with the same converter (Vorbis, the map banks, the full banks) skips the zones stage.
 * The host gives the store (a folder in the Node CLI, IndexedDB on a web page later) and the converter's build id,
 * which covers the code and the runtime the numbers come from (the host hashes the JavaScript engine's version into
 * it). Every key holds that id, so an entry never answers another build. The zones key also holds the DLL's SHA-256
 * and a hash of the job list. The filter maps key has no DLL hash on purpose: the maps fit the engine's SVF response
 * with core's lowpass, computed without the DLL, so one entry serves any DLL.
 * Entries are pack.ts data, gzip compressed (CompressionStream, in Node and browsers alike).
 */
import { pack, unpack } from "./pack.js";

export interface SolveCache {
    get(key: string): Promise<Uint8Array | undefined>;
    set(key: string, value: Uint8Array): Promise<void>;
}

export async function sha256Hex(data: Uint8Array | string) {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
    return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function through(bytes: Uint8Array, stream: CompressionStream | DecompressionStream) {
    const body = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(stream);
    return new Uint8Array(await new Response(body).arrayBuffer());
}

/**
 * An entry's value, undefined when it is missing or does not read (a damaged entry or a store that fails is a miss).
 */
export async function cacheGet<T>(cache: SolveCache, key: string) {
    try {
        const z = await cache.get(key);
        if (!z) return undefined;
        return unpack(await through(z, new DecompressionStream("gzip"))) as T;
    } catch {
        return undefined;
    }
}

/**
 * Stores an entry. The cache is optional, so a store that fails does not stop the conversion: the error goes to
 * failed and the entry is simply not kept.
 */
export async function cachePut(cache: SolveCache, key: string, value: unknown, failed: (e: unknown) => void) {
    try {
        await cache.set(key, await through(pack(value), new CompressionStream("gzip")));
    } catch (e) {
        failed(e);
    }
}
