import type { SolveCache } from "../src/lib/cache.js";

/**
 * The solve cache (src/lib/cache.ts) in this browser's IndexedDB: one record per entry, keyed by the converter's build
 * id and the library's key. Entries of other builds go when a build first writes, so the store holds one build's
 * entries, like the CLI's cache folder. Nothing in it ever leaves the browser.
 */
const DB = "scva2sfe";
const STORE = "solve-cache";

function request<T>(r: IDBRequest<T>) {
    return new Promise<T>((resolve, reject) => {
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error ?? new Error("IndexedDB request failed"));
    });
}

async function open() {
    const r = indexedDB.open(DB, 1);
    // a later version may keep the store, so it is made only when missing
    r.onupgradeneeded = () => {
        if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE);
    };
    const blocked = new Promise<never>((_, reject) => {
        r.onblocked = () => reject(new Error("the solve cache is held open by another tab of this page, close it and try again"));
    });
    const db = await Promise.race([request(r), blocked]);
    // an upgrade from another tab must not wait on this connection
    db.onversionchange = () => db.close();
    return db;
}

async function withStore<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => Promise<T>) {
    const db = await open();
    try {
        const tx = db.transaction(STORE, mode);
        const done = new Promise<void>((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
            tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
        });
        const out = await run(tx.objectStore(STORE));
        await done;
        return out;
    } finally {
        db.close();
    }
}

/**
 * Entries are stored as Blobs, which IndexedDB keeps as files.
 */
export class IdbCache implements SolveCache {
    private readonly version;
    private pruned = false;

    public constructor(version: string) {
        this.version = version;
    }

    public async get(key: string) {
        try {
            const v = await withStore("readonly", (s) => request(s.get(`${this.version} ${key}`)));
            return v instanceof Blob ? new Uint8Array(await v.arrayBuffer()) : undefined;
        } catch {
            return undefined;
        }
    }

    public async set(key: string, value: Uint8Array) {
        if (!this.pruned) {
            this.pruned = true;
            const keys = await withStore("readonly", (s) => request(s.getAllKeys()));
            const old = keys.filter((k) => typeof k !== "string" || !k.startsWith(`${this.version} `));
            if (old.length) await withStore("readwrite", async (s) => old.forEach((k) => s.delete(k)));
        }
        await withStore("readwrite", (s) => request(s.put(new Blob([value as Uint8Array<ArrayBuffer>]), `${this.version} ${key}`)));
    }
}

/**
 * The number of entries and their bytes.
 */
export async function cacheSummary() {
    const values = await withStore("readonly", (s) => request(s.getAll()));
    return { entries: values.length, bytes: values.reduce((n: number, v) => n + (v instanceof Blob ? v.size : v instanceof Uint8Array ? v.byteLength : 0), 0) };
}

export async function clearCache() {
    await withStore("readwrite", (s) => request(s.clear()));
}
