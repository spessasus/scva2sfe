import { parentPort, workerData } from "node:worker_threads";
import type { PoolMessage } from "../pool/worker.js";
import { poolWorker } from "../pool/worker.js";

/**
 * A worker of src/cli/pool.ts: the shared pool worker (src/pool/worker.ts) on a Node worker thread.
 */
const handle = await poolWorker(workerData.dll as Uint8Array, workerData.wasm as WebAssembly.Module | undefined);
parentPort!.on("message", (m: PoolMessage) => {
    const [reply, transfer] = handle(m);
    parentPort!.postMessage(reply, transfer);
});
