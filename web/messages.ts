/**
 * What the page (main.ts) asks of the conversion (conversion.ts) and what the conversion reports back.
 */

/**
 * The banks the page can write, by file name suffix ("" is the main bank).
 */
export const OUTPUTS = [
    { id: "", label: "Every map, SC-55 on bank LSB 0", group: "main" },
    { id: "-55", label: "SC-55 map alone", group: "maps" },
    { id: "-88", label: "SC-88 map alone", group: "maps" },
    { id: "-88pro", label: "SC-88Pro map alone", group: "maps" },
    { id: "-8820", label: "SC-8820 map alone", group: "maps" },
    { id: "-88-full", label: "Every map, SC-88 on bank LSB 0", group: "full" },
    { id: "-88pro-full", label: "Every map, SC-88Pro on bank LSB 0", group: "full" },
    { id: "-8820-full", label: "Every map, SC-8820 on bank LSB 0", group: "full" }
] as const;

export type OutputId = (typeof OUTPUTS)[number]["id"];

export interface ConvertRequest {
    dll: ArrayBuffer;
    /**
     * SCVSC.drk and GM2.drk, in that order, the ones given.
     */
    drk: Uint8Array[];
    outputs: OutputId[];
    workers: number;
    cache: boolean;
}

export type StageState = "run" | "done" | "cached";

export type ConversionMessage =
    | { type: "stage"; id: string; state: StageState }
    | { type: "progress"; id: string; done: number; total: number }
    | { type: "log"; line: string }
    | { type: "file"; name: string; blob: Blob; sha256: string; over: boolean }
    | { type: "done"; times: Record<string, number> }
    | { type: "error"; message: string };
