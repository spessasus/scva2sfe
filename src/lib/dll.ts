/**
 * SCCore.dll's bytes (SOUND Canvas VA 1.1.6 x64) and little endian reads into them. File offsets of the pinned build
 * only, the tables are read in place at conversion time and never copied into the source.
 *
 * Table offsets and record layouts are adapted from Tabula Sonora (https://github.com/TabulaSonora/spec) and NativeTS
 * (https://github.com/TabulaSonora/NativeTS), both BSD 3-Clause, Copyright (c) 2026 Kevin López Brante (see
 * NOTICE.md).
 */

export const DLL_SIZE = 27347456;
export const DLL_SHA256 = "117e6aa147a96fbde5e10d2caf16c89965acc1e44235fd245992216cc620bdb1";

/**
 * The pinned build's sections with file data: virtual address, size of the data in the file, file offset (the PE
 * section table of SCCore.dll 1.1.6 x64). .data's tail past its file data is zero filled at load and has no offset.
 */
const SECTIONS = [
    { name: ".text", va: 0x180001000, size: 0x90c00, raw: 0x400 },
    { name: ".rdata", va: 0x180092000, size: 0x1976c00, raw: 0x91000 },
    { name: ".data", va: 0x181a09000, size: 0x8600, raw: 0x1a07c00 }
];

/**
 * A virtual address of the DLL's image as a file offset, through the section that holds it.
 */
export const fileOffset = (va: number) => {
    const s = SECTIONS.find((x) => va >= x.va && va < x.va + x.size);
    if (!s) throw new Error(`0x${va.toString(16)} is not in SCCore.dll's file data`);
    return va - s.va + s.raw;
};

/**
 * Little endian reads in a record sliced out of the DLL (a tone header, a partial, a multisample).
 */
export const readU16 = (d: Uint8Array, at: number) => d[at] | (d[at + 1] << 8);
export const readS16 = (d: Uint8Array, at: number) => (readU16(d, at) << 16) >> 16;

export class Dll {
    public readonly bytes;
    private readonly view;

    public constructor(bytes: Uint8Array) {
        this.bytes = bytes;
        this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }

    /**
     * Checks the build by size and SHA-256 (WebCrypto, in Node and in a browser alike) and wraps its bytes.
     */
    public static async open(data: ArrayBuffer | Uint8Array) {
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        if (bytes.length !== DLL_SIZE) {
            throw new Error("not SOUND Canvas VA 1.1.6 x64 SCCore.dll (size)");
        }
        const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
        const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
        if (hex !== DLL_SHA256) {
            throw new Error(`not SOUND Canvas VA 1.1.6 x64 SCCore.dll (sha256 ${hex})`);
        }
        return new Dll(bytes);
    }

    public u8(at: number) {
        return this.bytes[at];
    }

    public s8(at: number) {
        return this.view.getInt8(at);
    }

    public u16(at: number) {
        return this.view.getUint16(at, true);
    }

    public s16(at: number) {
        return this.view.getInt16(at, true);
    }

    public u32(at: number) {
        return this.view.getUint32(at, true);
    }

    public s32(at: number) {
        return this.view.getInt32(at, true);
    }

    public slice(at: number, length: number) {
        return this.bytes.subarray(at, at + length);
    }
}
