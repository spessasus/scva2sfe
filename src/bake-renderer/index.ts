/**
 * The bake renderer (src/bake-renderer/include/sbr.h) loaded from its WebAssembly build. Runs in Node and in a
 * browser Web Worker alike: the caller hands in the module's bytes and SCCore.dll's bytes, nothing here touches a
 * file system.
 *
 *     const renderer = await BakeRenderer.create(wasmBytes, dllBytes)
 *     const result = renderer.render({map: 3, msb: 0, lsb: 3, program: 0, drum: false, key: 60, velocity: 127,
 *         holdFrames: 48000, frames: 49664})
 *
 * A renderer is single threaded: open one per worker.
 */

/**
 * One bake render, sbr_request. The optional fields default to the converter's part setup.
 */
export interface BakeRequest {
    /**
     * The map the part runs on when lsb picks none (1 SC-55, 2 SC-88, 3 SC-88Pro, 4 SC-8820, 0x7a GM2).
     */
    map: number;
    msb: number;
    /**
     * Bank select LSB: 1..4 pick the map, 0 keeps map.
     */
    lsb: number;
    program: number;
    drum: boolean;
    key: number;
    velocity: number;
    /**
     * A tone number to play directly (melodic parts), -1 (the default) to look the program up.
     */
    tone?: number;
    /**
     * The note off frame (32 kHz).
     */
    holdFrames: number;
    frames: number;
    /**
     * The random generator's two registers at the note on, default [0xefa6, 0x9c23].
     */
    seed?: [number, number];
    /**
     * Blocks of 32 samples before the note on's block (places the control tick), default 129.
     */
    blocksBefore?: number;
    /**
     * Frames per host call the events arrive in, default 64.
     */
    callFrames?: number;
}

/**
 * A voice's per block records (sbr_block_record), one per 32-sample block it renders in.
 */
export interface BlockRecords {
    count: number;
    /**
     * The records as the renderer wrote them, 184 bytes each.
     */
    raw: ArrayBuffer;
    block: Int32Array;
    /**
     * The playback ratio (16.16) of each 8 samples, 4 per block.
     */
    ratio: Int32Array;
    /**
     * The TVA's ramps, 16 per block: sample i is the interpolation times gain4[i / 8] * gain16[i / 2].
     */
    gain16: Float32Array;
    /**
     * The part level stage, 4 per block.
     */
    gain4: Float32Array;
    /**
     * The SVF coefficients, 4 per block each.
     */
    f: Float32Array;
    q: Float32Array;
    /**
     * Bit 2: the sampler raised its loop or end event in this block.
     */
    event: Uint8Array;
    svfTap: Int32Array;
}

/**
 * A voice's per call records (sbr_call_record), the state after each 64-frame call.
 */
export interface CallRecords {
    count: number;
    /**
     * The records as the renderer wrote them, 96 bytes each.
     */
    raw: ArrayBuffer;
    call: Int32Array;
    position: Uint32Array;
    /**
     * The playback ratio, 16.16.
     */
    ratio: Uint32Array;
    pitchCurrent: Int32Array;
    pitchEnvCents: Float32Array;
    ampCurrent: Int32Array;
    tvaEnvLevel: Uint16Array;
    /**
     * The TVA gain.
     */
    tvaAmp: Float32Array;
    levelTableGain: Float32Array;
    tvfEnv: Int32Array;
    cutoffSum: Int32Array;
    cutoffCurrent: Int32Array;
    /**
     * The SVF coefficient.
     */
    svfF: Float32Array;
    pan: Float32Array;
}

/**
 * A voice's sends per block it is active in (sbr_send_record): send 0 / 1 the dry pair (buses 51 / 52).
 */
export interface SendRecords {
    count: number;
    /**
     * The records as the renderer wrote them, 36 bytes each.
     */
    raw: ArrayBuffer;
    block: Int32Array;
    /**
     * 4 per block.
     */
    bus: Int32Array;
    level: Float32Array;
}

export interface BakeVoice {
    slot: number;
    /**
     * The partial slot, 0 or 1.
     */
    partial: number;
    tone: number;
    /**
     * The voice's output, frames samples (0 where it is not active).
     */
    out: Float32Array;
    /**
     * Its SVF input.
     */
    pre: Float32Array;
    blocks: BlockRecords;
    calls: CallRecords;
    sends: SendRecords;
}

export interface BakeResult {
    frames: number;
    /**
     * What the note resolved to (-1 none).
     */
    tone: number;
    kit: number;
    map: number;
    voices: BakeVoice[];
}

interface Exports {
    memory: WebAssembly.Memory;
    _initialize?: () => void;
    sbr_version: () => number;
    sbr_last_error: () => number;
    sbr_alloc: (size: number) => number;
    sbr_free: (pointer: number) => void;
    sbr_open: (dll: number, size: number) => number;
    sbr_close: (renderer: number) => void;
    sbr_render: (renderer: number, request: number) => number;
    sbr_result: (renderer: number) => number;
    sbr_result_size: (renderer: number) => number;
}

const VERSION = 1;
const MAGIC = 0x31524253;
const HEADER_WORDS = 8;
const VOICE_WORDS = 12;
const REQUEST_WORDS = 14;
const BLOCK_SIZE = 184;
const CALL_SIZE = 96;
const SEND_SIZE = 36;

/**
 * Copies a strided field out of an array of records into a typed array of its own.
 */
function field<T extends Int32Array | Uint32Array | Float32Array | Uint16Array | Uint8Array>(
    view: DataView,
    count: number,
    stride: number,
    offset: number,
    width: number,
    make: new (length: number) => T,
    read: (view: DataView, at: number) => number
) {
    const out = new make(count * width);
    const size = out.BYTES_PER_ELEMENT;
    for (let i = 0; i < count; i++) {
        for (let k = 0; k < width; k++) {
            out[i * width + k] = read(view, i * stride + offset + k * size);
        }
    }
    return out;
}

const i32 = (v: DataView, at: number) => v.getInt32(at, true);
const u32 = (v: DataView, at: number) => v.getUint32(at, true);
const f32 = (v: DataView, at: number) => v.getFloat32(at, true);
const u16 = (v: DataView, at: number) => v.getUint16(at, true);
const u8 = (v: DataView, at: number) => v.getUint8(at);

/**
 * The result buffer (sbr.h) at `base` in the module's memory, every array copied out once so it outlives the next
 * render.
 */
function parse(memory: ArrayBuffer, base: number) {
    const view = new DataView(memory, base);
    const word = (index: number) => view.getInt32(index * 4, true);
    if (view.getUint32(0, true) !== MAGIC || word(1) !== VERSION) {
        throw new Error("bake renderer: unexpected result layout");
    }
    const copy = (offset: number, size: number) => memory.slice(base + offset, base + offset + size);
    const frames = word(2);
    const voices = new Array<BakeVoice>();
    for (let i = 0; i < word(3); i++) {
        const at = HEADER_WORDS + VOICE_WORDS * i;
        const nb = word(at + 3);
        const nc = word(at + 4);
        const ns = word(at + 5);
        const b = copy(word(at + 8), nb * BLOCK_SIZE);
        const c = copy(word(at + 9), nc * CALL_SIZE);
        const s = copy(word(at + 10), ns * SEND_SIZE);
        const bv = new DataView(b);
        const cv = new DataView(c);
        const sv = new DataView(s);
        const blocks: BlockRecords = {
            count: nb,
            raw: b,
            block: field(bv, nb, BLOCK_SIZE, 0, 1, Int32Array, i32),
            ratio: field(bv, nb, BLOCK_SIZE, 8, 4, Int32Array, i32),
            event: field(bv, nb, BLOCK_SIZE, 32 + 31, 1, Uint8Array, u8),
            gain16: field(bv, nb, BLOCK_SIZE, 64, 16, Float32Array, f32),
            gain4: field(bv, nb, BLOCK_SIZE, 128, 4, Float32Array, f32),
            f: field(bv, nb, BLOCK_SIZE, 144, 4, Float32Array, f32),
            q: field(bv, nb, BLOCK_SIZE, 160, 4, Float32Array, f32),
            svfTap: field(bv, nb, BLOCK_SIZE, 176, 1, Int32Array, i32)
        };
        const calls: CallRecords = {
            count: nc,
            raw: c,
            call: field(cv, nc, CALL_SIZE, 0, 1, Int32Array, i32),
            position: field(cv, nc, CALL_SIZE, 8, 1, Uint32Array, u32),
            ratio: field(cv, nc, CALL_SIZE, 20, 1, Uint32Array, u32),
            pitchCurrent: field(cv, nc, CALL_SIZE, 24, 1, Int32Array, i32),
            pitchEnvCents: field(cv, nc, CALL_SIZE, 28, 1, Float32Array, f32),
            ampCurrent: field(cv, nc, CALL_SIZE, 36, 1, Int32Array, i32),
            tvaEnvLevel: field(cv, nc, CALL_SIZE, 40, 1, Uint16Array, u16),
            tvaAmp: field(cv, nc, CALL_SIZE, 44, 1, Float32Array, f32),
            levelTableGain: field(cv, nc, CALL_SIZE, 48, 1, Float32Array, f32),
            tvfEnv: field(cv, nc, CALL_SIZE, 52, 1, Int32Array, i32),
            cutoffSum: field(cv, nc, CALL_SIZE, 56, 1, Int32Array, i32),
            cutoffCurrent: field(cv, nc, CALL_SIZE, 60, 1, Int32Array, i32),
            svfF: field(cv, nc, CALL_SIZE, 64, 1, Float32Array, f32),
            pan: field(cv, nc, CALL_SIZE, 92, 1, Float32Array, f32)
        };
        const sends: SendRecords = {
            count: ns,
            raw: s,
            block: field(sv, ns, SEND_SIZE, 0, 1, Int32Array, i32),
            bus: field(sv, ns, SEND_SIZE, 4, 4, Int32Array, i32),
            level: field(sv, ns, SEND_SIZE, 20, 4, Float32Array, f32)
        };
        voices.push({
            slot: word(at),
            partial: word(at + 1),
            tone: word(at + 2),
            out: new Float32Array(copy(word(at + 6), frames * 4)),
            pre: new Float32Array(copy(word(at + 7), frames * 4)),
            blocks,
            calls,
            sends
        });
    }
    const result: BakeResult = { frames, tone: word(4), kit: word(5), map: word(6), voices };
    return result;
}

/**
 * Memory in the module, refused when its allocator has none left.
 */
function alloc(exports: Exports, size: number) {
    const at = exports.sbr_alloc(size);
    if (!at) {
        throw new Error(`bake renderer: out of memory (${size} bytes)`);
    }
    return at;
}

// the module's only import tells the host its memory grew: the views here are made fresh on every read
const imports = () => ({ env: { emscripten_notify_memory_growth: () => {} } });

function lastError(exports: Exports) {
    const at = exports.sbr_last_error();
    const memory = new Uint8Array(exports.memory.buffer);
    let end = at;
    while (memory[end] !== 0) {
        end++;
    }
    return new TextDecoder().decode(memory.subarray(at, end));
}

/**
 * A fresh instance's setup: its constructors, the version check, SCCore.dll opened and the request's memory.
 */
function start(instance: WebAssembly.Instance, dll: Uint8Array) {
    const exports = instance.exports as unknown as Exports;
    exports._initialize?.();
    if (exports.sbr_version() !== VERSION) {
        throw new Error(`bake renderer: module version ${exports.sbr_version()}, the loader wants ${VERSION}`);
    }
    const at = alloc(exports, dll.length);
    new Uint8Array(exports.memory.buffer, at, dll.length).set(dll);
    const handle = exports.sbr_open(at, dll.length);
    exports.sbr_free(at);
    if (!handle) {
        throw new Error(`bake renderer: ${lastError(exports)}`);
    }
    return { exports, handle, request: alloc(exports, REQUEST_WORDS * 4) };
}

/**
 * The renderer's WebAssembly instance and its open handle on SCCore.dll.
 */
export class BakeRenderer {
    private module;
    private dll;
    private exports;
    private handle;
    private request;

    private constructor(module: WebAssembly.Module, dll: Uint8Array, state: ReturnType<typeof start>) {
        this.module = module;
        this.dll = dll;
        this.exports = state.exports;
        this.handle = state.handle;
        this.request = state.request;
    }

    /**
     * Instantiates the module (its bytes or a compiled module, the same one can serve every worker) and opens
     * SCCore.dll's bytes (SC-VA 1.1.6 x64, another build is refused).
     */
    public static async create(wasm: ArrayBuffer | Uint8Array | WebAssembly.Module, dll: ArrayBuffer | Uint8Array) {
        const module = wasm instanceof WebAssembly.Module ? wasm : await WebAssembly.compile(wasm as BufferSource);
        // a copy of its own (a Node Buffer's slice shares the caller's memory), kept for a fresh instance after a trap
        const bytes = new Uint8Array(dll);
        const instance = await WebAssembly.instantiate(module, imports());
        return new BakeRenderer(module, bytes, start(instance, bytes));
    }

    /**
     * Renders one note. Throws on a request out of range or a failure inside the renderer (a trap resets the
     * instance, so the next render starts clean).
     */
    public render(request: BakeRequest) {
        if (!this.handle) {
            throw new Error("bake renderer: closed");
        }
        const e = this.exports;
        const words = new Int32Array(e.memory.buffer, this.request, REQUEST_WORDS);
        const seed = request.seed ?? [0xefa6, 0x9c23];
        words.set([
            request.map,
            request.msb,
            request.lsb,
            request.program,
            request.drum ? 1 : 0,
            request.key,
            request.velocity,
            request.tone ?? -1,
            request.holdFrames,
            request.frames,
            seed[0],
            seed[1],
            request.blocksBefore ?? 129,
            request.callFrames ?? 64
        ]);
        let status: number;
        try {
            status = e.sbr_render(this.handle, this.request);
        } catch (error) {
            // a trap leaves the C++ state undefined: a fresh instance for the next render, or none if that fails
            const trap = `bake renderer: trapped (${String(error)})`;
            try {
                this.reset();
            } catch (again) {
                throw new Error(`${trap}, and the fresh instance failed (${String(again)})`);
            }
            throw new Error(trap);
        }
        if (status !== 0) {
            throw new Error(`bake renderer: ${lastError(e)}`);
        }
        return parse(e.memory.buffer, e.sbr_result(this.handle));
    }

    private reset() {
        // nothing points into the old instance while the new one starts, a failed start leaves the renderer closed
        this.handle = 0;
        // synchronous instantiation: allowed in Node and in workers (a browser's main thread refuses modules this
        // size, the renderer belongs in a worker there anyway)
        const state = start(new WebAssembly.Instance(this.module, imports()), this.dll);
        this.exports = state.exports;
        this.handle = state.handle;
        this.request = state.request;
    }

    /**
     * Frees the renderer's tables (the instance itself goes with the last reference).
     */
    public close() {
        if (this.handle) {
            this.exports.sbr_close(this.handle);
            this.handle = 0;
        }
    }
}
