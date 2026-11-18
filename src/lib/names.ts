/**
 * Drum key names from SOUND Canvas VA's name lists (optional). SC-VA ships them as "SSW
 * DRUMKEYFILE" text files (SCVSC.drk, GM2.drk): pages (PAGE=<n>: 1 SC-55, 2 SC-88, 3 SC-88Pro, 4 SC-8820, 0 the
 * default map, 120 the GM2 kits), each a tab separated table of 128 rows (the note) by 128 columns (the kit's
 * program). "---" is an empty key.
 */
export type DrumNames = Map<number, Map<number, Map<number, string>>>;

/**
 * Every page of the given .drk files' bytes (Shift JIS text), later files adding to earlier ones.
 */
export function readDrk(files: Uint8Array[]) {
    const pages: DrumNames = new Map();
    for (const bytes of files) {
        const text = new TextDecoder("shift_jis").decode(bytes);
        let page: Map<number, Map<number, string>> | undefined;
        for (const line of text.split(/\r?\n/)) {
            const cells = line.split("\t");
            const head = cells[0].trim();
            if (head.startsWith("PAGE=")) {
                const n = Number(head.slice(5));
                if (!pages.has(n)) pages.set(n, new Map());
                page = pages.get(n);
                continue;
            }
            if (!page || !/^\d+$/.test(head)) continue;
            const note = Number(head);
            cells.slice(1, 129).forEach((cell, program) => {
                const name = cell.trim();
                if (!name || name === "---") return;
                if (!page!.has(program)) page!.set(program, new Map());
                page!.get(program)!.set(note, name);
            });
        }
    }
    return pages;
}
