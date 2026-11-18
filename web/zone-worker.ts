import type { PoolMessage } from "../src/pool/worker.js";
import { poolWorker } from "../src/pool/worker.js";

/**
 * A worker of pool.ts: the shared pool worker (src/pool/worker.ts) in a Web Worker. The first message brings the DLL's
 * bytes and the compiled bake renderer, the handler is set right away so no message waits on a missing listener.
 */
type Handler = Awaited<ReturnType<typeof poolWorker>>;
let handler: Promise<Handler> | undefined;
self.onmessage = async (e: MessageEvent<PoolMessage & { dll?: Uint8Array; wasm?: WebAssembly.Module }>) => {
    const m = e.data;
    try {
        if (m.kind === "init") {
            handler = poolWorker(m.dll!, m.wasm);
            await handler;
            return;
        }
        const [reply, transfer] = (await handler!)(m);
        self.postMessage(reply, transfer);
    } catch (err) {
        self.postMessage({ error: err instanceof Error ? err.message : String(err) });
    }
};
