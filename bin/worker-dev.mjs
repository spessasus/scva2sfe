// The zone worker's entry when the converter runs from its TypeScript sources (tsx): registers tsx first
import { register } from "tsx/esm/api";

register();
await import("../src/cli/worker.ts");
