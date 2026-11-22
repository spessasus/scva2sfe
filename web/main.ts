/**
 * The page: picks the files, checks the DLL's build, runs the conversion (conversion.ts) and shows its stages and the
 * finished banks.
 */
import { Dll, DLL_SHA256 } from "../src/lib/dll.js";
import { cacheSummary, clearCache } from "./idb-cache.js";
import type { ConvertRequest, OutputId, StageState, ConversionMessage } from "./messages.js";
import { OUTPUTS } from "./messages.js";

declare const __STEM__: string;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/**
 * One zone worker per thread, at most 16 like the CLI. Each holds its own copy of the DLL, an engine renderer and its
 * models (about 350 MB in Firefox), so a device that reports little memory gets one per GB. The field lets a user go
 * lower.
 */
const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
const WORKERS = Math.max(1, Math.min(navigator.hardwareConcurrency || 4, 16, memory !== undefined && memory < 8 ? Math.floor(memory) : 16));
const workersInput = $<HTMLInputElement>("workers");
workersInput.value = String(WORKERS);
const workers = () => {
    const n = Math.round(Number(workersInput.value));
    return Number.isFinite(n) && n >= 1 ? Math.min(n, 32) : WORKERS;
};
workersInput.addEventListener("input", () => updateButton());

const files: { dll?: File; scvsc?: File; gm2?: File } = {};
let busy = false;
const urls = new Array<string>();

const mb = (bytes: number) => `${(bytes / 1e6).toFixed(1)} MB`;
const duration = (s: number) => (s < 60 ? `${s.toFixed(1)} s` : `${Math.floor(Math.round(s) / 60)} min ${Math.round(s) % 60} s`);

function status(id: string, text: string, kind: "ok" | "bad" | "") {
    const el = $(id);
    el.textContent = text;
    el.className = `file_status ${kind}`;
}

async function pickDll(file: File) {
    files.dll = undefined;
    status("dll_status", "Checking…", "");
    updateButton();
    try {
        await Dll.open(new Uint8Array(await file.arrayBuffer()));
        files.dll = file;
        status("dll_status", `SOUND Canvas VA 1.1.6 x64, verified (sha256 ${DLL_SHA256})`, "ok");
    } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        status("dll_status", `Refused: ${file.name} is ${why.startsWith("not ") ? why : `not readable (${why})`}. Only SCCore.dll from SOUND Canvas VA 1.1.6 (x64) converts, other versions are not supported.`, "bad");
    }
    updateButton();
}

async function pickDrk(which: "scvsc" | "gm2", file: File) {
    const id = `${which}_status`;
    const text = new TextDecoder("shift_jis").decode(await file.arrayBuffer());
    if (!/^PAGE=\d+/m.test(text)) {
        files[which] = undefined;
        status(id, `Not used: ${file.name} is not a SOUND Canvas VA drum key list.`, "bad");
        return;
    }
    files[which] = file;
    status(id, `${file.name}, ${(file.size / 1000).toFixed(0)} kB, the drum keys get its names`, "ok");
}

function route(file: File) {
    if (busy) return;
    const name = file.name.toLowerCase();
    if (name.endsWith(".dll")) void pickDll(file);
    else if (name.startsWith("gm2")) void pickDrk("gm2", file);
    else if (name.endsWith(".drk")) void pickDrk("scvsc", file);
}

$<HTMLInputElement>("dll_input").addEventListener("change", (e) => {
    const f = (e.target as HTMLInputElement).files?.[0];
    if (f) void pickDll(f);
});
for (const which of ["scvsc", "gm2"] as const) {
    $<HTMLInputElement>(`${which}_input`).addEventListener("change", (e) => {
        const f = (e.target as HTMLInputElement).files?.[0];
        if (f) void pickDrk(which, f);
    });
}
document.addEventListener("dragover", (e) => {
    e.preventDefault();
    document.querySelectorAll(".file_row").forEach((r) => r.classList.add("drop_target"));
});
document.addEventListener("dragleave", (e) => {
    if (e.relatedTarget === null) document.querySelectorAll(".file_row").forEach((r) => r.classList.remove("drop_target"));
});
document.addEventListener("drop", (e) => {
    e.preventDefault();
    document.querySelectorAll(".file_row").forEach((r) => r.classList.remove("drop_target"));
    for (const f of e.dataTransfer?.files ?? []) route(f);
});

// the bank choices: the main bank always, it is what the map banks are cut out of
const groups = [
    { group: "main", legend: "Main bank" },
    { group: "maps", legend: "One map per bank (on bank LSB 0, with the GM2 kits)" },
    { group: "full", legend: "Full banks with another map on bank LSB 0" }
];
for (const g of groups) {
    const set = document.createElement("fieldset");
    const legend = document.createElement("legend");
    legend.textContent = g.legend;
    set.append(legend);
    for (const o of OUTPUTS.filter((x) => x.group === g.group)) {
        const label = document.createElement("label");
        label.className = "check";
        const box = document.createElement("input");
        box.type = "checkbox";
        box.value = o.id;
        box.name = "output";
        if (o.id === "") {
            box.checked = true;
            box.disabled = true;
        }
        const name = document.createElement("code");
        name.textContent = `${__STEM__}${o.id}.sf4`;
        const note = document.createElement("span");
        note.textContent = o.label;
        label.append(box, name, note);
        set.append(label);
    }
    $("outputs").append(set);
}

function updateButton() {
    $<HTMLButtonElement>("convert").disabled = busy || !files.dll;
    workersInput.disabled = busy;
    // nothing the running conversion read or writes changes under it (the main bank's box stays disabled)
    for (const id of ["clear_cache", "use_cache", "dll_input", "scvsc_input", "gm2_input"]) $<HTMLInputElement | HTMLButtonElement>(id).disabled = busy;
    for (const box of document.querySelectorAll<HTMLInputElement>("input[name=output]")) if (box.value !== "") box.disabled = busy;
    $("convert_hint").textContent = busy ? `Converting on ${workers()} workers…` : files.dll ? "The first conversion takes several minutes, a cached one well under two. Fewer workers use less memory." : "Pick SCCore.dll first.";
}

async function showCache() {
    try {
        const s = await cacheSummary();
        $("cache_line").textContent = s.entries
            ? `Holds ${s.entries} ${s.entries === 1 ? "entry" : "entries"} (${mb(s.bytes)}): the zone fits and filter maps of your DLL for this converter build and this browser, so a later conversion skips the slow part. It never leaves this browser.`
            : "Empty. After a conversion it holds the zone fits of your DLL (about 35 MB), so a later conversion skips the slow part. It never leaves this browser.";
    } catch {
        $("cache_line").textContent = "This browser does not allow IndexedDB here, every conversion starts from scratch.";
    }
}

$("clear_cache").addEventListener("click", async () => {
    await clearCache().catch(() => undefined);
    await showCache();
});

const STAGES: Record<string, string> = {
    read: "Loading the converter and reading the DLL",
    maps: "Filter maps",
    waves: "Wave data",
    zones: "Fitting the zones to the engine's curves",
    bake: "Engine renders",
    assemble: "Assembling the bank"
};

function stageRows(outputs: OutputId[]) {
    const list = $("stages");
    list.replaceChildren();
    // the order they are written in: the main bank, the full banks, the map banks
    const order = [...OUTPUTS.filter((o) => o.group !== "maps"), ...OUTPUTS.filter((o) => o.group === "maps")].filter((o) => outputs.includes(o.id));
    const rows: [string, string][] = [...Object.entries(STAGES), ...order.map((o): [string, string] => [`write${o.id}`, `Writing ${__STEM__}${o.id}.sf4`])];
    for (const [id, text] of rows) {
        const li = document.createElement("li");
        li.className = "stage";
        li.dataset.stage = id;
        const label = document.createElement("span");
        label.textContent = text;
        const note = document.createElement("span");
        note.className = "stage_note";
        li.append(label, note);
        list.append(li);
    }
}

function setStage(id: string, state: StageState) {
    const li = document.querySelector<HTMLLIElement>(`[data-stage="${id}"]`);
    if (!li) return;
    li.className = `stage ${state}`;
    const note = li.querySelector(".stage_note")!;
    if (state === "run") li.dataset.start = String(performance.now());
    if (state === "cached") note.textContent = "from the cache";
    if (state === "done" && li.dataset.start) note.textContent = duration((performance.now() - Number(li.dataset.start)) / 1000);
    if (state !== "run") li.querySelector(".bar")?.remove();
}

function setProgress(id: string, done: number, total: number) {
    const li = document.querySelector<HTMLLIElement>(`[data-stage="${id}"]`);
    if (!li || done === total) return;
    let bar = li.querySelector<HTMLDivElement>(".bar > div");
    if (!bar) {
        const outer = document.createElement("div");
        outer.className = "bar";
        bar = document.createElement("div");
        outer.append(bar);
        li.append(outer);
    }
    bar.style.width = `${((100 * done) / total).toFixed(1)}%`;
    li.querySelector(".stage_note")!.textContent = `${done} / ${total}`;
}

function finish(message?: string) {
    busy = false;
    $("stop").hidden = true;
    if (message) {
        $("error").textContent = message;
        $("error").hidden = false;
        document.querySelectorAll(".stage.run").forEach((li) => li.classList.remove("run"));
    }
    updateButton();
    void showCache();
}

// the conversion runs on this page's thread, so it stops with the page (the solve cache keeps what it holds)
$("stop").addEventListener("click", () => location.reload());

$("convert").addEventListener("click", async () => {
    if (!files.dll || busy) return;
    busy = true;
    const outputs = [...document.querySelectorAll<HTMLInputElement>("input[name=output]:checked")].map((b) => b.value as OutputId);
    for (const u of urls) URL.revokeObjectURL(u);
    urls.length = 0;
    $("downloads").replaceChildren();
    $("downloads_group").hidden = true;
    $("error").hidden = true;
    $("log").textContent = "";
    stageRows(outputs);
    $("progress_group").hidden = false;
    $("stop").hidden = false;
    updateButton();
    const started = performance.now();
    const handle = (m: ConversionMessage) => {
        if (m.type === "stage") setStage(m.id, m.state);
        else if (m.type === "progress") setProgress(m.id, m.done, m.total);
        else if (m.type === "log") $("log").textContent += `${m.line}
`;
        else if (m.type === "file") {
            const url = URL.createObjectURL(m.blob);
            urls.push(url);
            const li = document.createElement("li");
            const a = document.createElement("a");
            a.className = "button";
            a.href = url;
            a.download = m.name;
            a.textContent = `Download ${m.name}`;
            const meta = document.createElement("span");
            meta.className = "download_meta";
            meta.textContent = `${mb(m.blob.size)}, sha256 ${m.sha256}${m.over ? `, over the ${m.cap / 1e6} MB cap` : ""}`;
            li.append(a, meta);
            $("downloads").append(li);
            $("downloads_group").hidden = false;
        } else if (m.type === "done") {
            $("log").textContent += `Done in ${duration((performance.now() - started) / 1000)}
`;
            finish();
        } else if (m.type === "error") finish(`The conversion stopped: ${m.message}`);
    };
    try {
        const drk = new Array<Uint8Array>();
        for (const f of [files.scvsc, files.gm2]) if (f) drk.push(new Uint8Array(await f.arrayBuffer()));
        const req: ConvertRequest = { dll: await files.dll.arrayBuffer(), drk, outputs, workers: workers(), cache: $<HTMLInputElement>("use_cache").checked };
        // loaded on the first conversion, so the page itself stays small
        const { runConversion } = await import("./conversion.js");
        await runConversion(req, handle);
    } catch (err) {
        finish(`The conversion stopped: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
        // runConversion reports its own end, this catches a file that could not be read or a chunk that did not load
        if (busy) finish();
    }
});

updateButton();
void showCache();
