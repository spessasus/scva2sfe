/**
 * A compact binary form of plain data (objects, arrays, strings, numbers, booleans, undefined, null and the typed
 * arrays the converter uses) for the solve cache: every number keeps its exact bits, object keys keep their order,
 * strings and keys are stored once. No Node APIs, so a browser can use it too.
 */

const Tag = {
    Undefined: 0,
    Null: 1,
    False: 2,
    True: 3,
    Int: 4,
    Float: 5,
    String: 6,
    StringRef: 7,
    Array: 8,
    Object: 9,
    U16: 10,
    F32: 11,
    F64: 12,
    U8: 13
} as const;
type Tag = (typeof Tag)[keyof typeof Tag];

class Writer {
    private buf = new Uint8Array(1 << 16);
    private view = new DataView(this.buf.buffer);
    public at = 0;

    private room(n: number) {
        if (this.at + n <= this.buf.length) return;
        let size = this.buf.length * 2;
        while (size < this.at + n) size *= 2;
        const next = new Uint8Array(size);
        next.set(this.buf.subarray(0, this.at));
        this.buf = next;
        this.view = new DataView(next.buffer);
    }

    public u8(v: number) {
        this.room(1);
        this.buf[this.at++] = v;
    }

    public u32(v: number) {
        this.room(4);
        this.view.setUint32(this.at, v, true);
        this.at += 4;
    }

    public i32(v: number) {
        this.room(4);
        this.view.setInt32(this.at, v, true);
        this.at += 4;
    }

    public f64(v: number) {
        this.room(8);
        this.view.setFloat64(this.at, v, true);
        this.at += 8;
    }

    public bytes(b: Uint8Array) {
        this.room(b.length);
        this.buf.set(b, this.at);
        this.at += b.length;
    }

    public result() {
        return this.buf.slice(0, this.at);
    }
}

/**
 * Packs a value. Throws on anything outside plain data (functions, maps, class instances).
 */
export function pack(value: unknown) {
    const w = new Writer();
    const strings = new Map<string, number>();
    const encoder = new TextEncoder();
    const str = (s: string) => {
        const n = strings.get(s);
        if (n !== undefined) {
            w.u8(Tag.StringRef);
            w.u32(n);
            return;
        }
        strings.set(s, strings.size);
        const b = encoder.encode(s);
        w.u8(Tag.String);
        w.u32(b.length);
        w.bytes(b);
    };
    const typed = (tag: Tag, v: ArrayBufferView, count: number) => {
        w.u8(tag);
        w.u32(count);
        w.bytes(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
    };
    const put = (v: unknown): void => {
        if (v === undefined) w.u8(Tag.Undefined);
        else if (v === null) w.u8(Tag.Null);
        else if (v === false) w.u8(Tag.False);
        else if (v === true) w.u8(Tag.True);
        else if (typeof v === "number") {
            if (Number.isInteger(v) && v >= -0x80000000 && v <= 0x7fffffff && !Object.is(v, -0)) {
                w.u8(Tag.Int);
                w.i32(v);
            } else {
                w.u8(Tag.Float);
                w.f64(v);
            }
        } else if (typeof v === "string") str(v);
        else if (Array.isArray(v)) {
            w.u8(Tag.Array);
            w.u32(v.length);
            for (let i = 0; i < v.length; i++) put(v[i]);
        } else if (v instanceof Uint16Array) typed(Tag.U16, v, v.length);
        else if (v instanceof Float32Array) typed(Tag.F32, v, v.length);
        else if (v instanceof Float64Array) typed(Tag.F64, v, v.length);
        else if (v instanceof Uint8Array) typed(Tag.U8, v, v.length);
        else if (typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype) {
            const keys = Object.keys(v);
            w.u8(Tag.Object);
            w.u32(keys.length);
            for (const k of keys) {
                str(k);
                put((v as Record<string, unknown>)[k]);
            }
        } else {
            throw new Error(`pack: no plain data (${Object.prototype.toString.call(v)})`);
        }
    };
    put(value);
    return w.result();
}

/**
 * The value back from pack's bytes.
 */
export function unpack(bytes: Uint8Array): unknown {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const decoder = new TextDecoder();
    const strings = new Array<string>();
    let at = 0;
    const u32 = () => {
        const v = view.getUint32(at, true);
        at += 4;
        return v;
    };
    // typed arrays are copied out (the data may sit at an offset their element size does not divide)
    const typed = <T>(size: number, make: (b: ArrayBuffer) => T) => {
        const n = u32();
        const b = bytes.slice(at, at + n * size);
        at += n * size;
        return make(b.buffer);
    };
    const get = (): unknown => {
        const tag = bytes[at++];
        switch (tag) {
            case Tag.Undefined:
                return undefined;
            case Tag.Null:
                return null;
            case Tag.False:
                return false;
            case Tag.True:
                return true;
            case Tag.Int: {
                const v = view.getInt32(at, true);
                at += 4;
                return v;
            }
            case Tag.Float: {
                const v = view.getFloat64(at, true);
                at += 8;
                return v;
            }
            case Tag.String: {
                const n = u32();
                const s = decoder.decode(bytes.subarray(at, at + n));
                at += n;
                strings.push(s);
                return s;
            }
            case Tag.StringRef:
                return strings[u32()];
            case Tag.Array: {
                const n = u32();
                const a = new Array<unknown>(n);
                for (let i = 0; i < n; i++) a[i] = get();
                return a;
            }
            case Tag.Object: {
                const n = u32();
                const o: Record<string, unknown> = {};
                for (let i = 0; i < n; i++) {
                    const k = get() as string;
                    o[k] = get();
                }
                return o;
            }
            case Tag.U16:
                return typed(2, (b) => new Uint16Array(b));
            case Tag.F32:
                return typed(4, (b) => new Float32Array(b));
            case Tag.F64:
                return typed(8, (b) => new Float64Array(b));
            case Tag.U8:
                return typed(1, (b) => new Uint8Array(b));
            default:
                throw new Error(`unpack: bad tag ${tag} at ${at - 1}`);
        }
    };
    return get();
}
