import { MIDIPatchTools } from "spessasynth_core";
import type { BasicPreset, BasicSoundBank, MIDIPatch } from "spessasynth_core";

/**
 * Removes melodic presets that core's own fallback replaces with one that sounds the same, so a tone shows up once
 * in a preset list instead of under every variation bank SC-VA answers with it.
 * The converter writes explicit presets where core's fallback could pick another map's tone. In a bank with
 * one map, and for many banks of the full one, the fallback already lands on the same tone.
 * A preset goes only when every bank select that could reach it still plays the same instrument zones without it,
 * checked with core's own selectPatch (GS). Returns the number removed.
 * removable limits the pass to those presets, and a removal must also hold in every view (a subset of the
 * presets). The full bank passes its fallback presets and one view per map: the per map banks are cut from it
 * with only that map left, so a fallback that another map's preset or the LSB 0 copies alone make redundant has
 * to stay.
 */
export function pruneFallbacks(
    bank: BasicSoundBank,
    removable?: Set<BasicPreset>,
    views = new Array<(p: BasicPreset) => boolean>()
) {
    bank.flush();
    const same = (a: BasicPreset, b: BasicPreset) =>
        a === b ||
        (a.zones.length === b.zones.length &&
            a.zones.every((z, i) => {
                const o = b.zones[i];
                return (
                    z.instrument === o.instrument &&
                    z.keyRange.min === o.keyRange.min &&
                    z.keyRange.max === o.keyRange.max &&
                    z.velRange.min === o.velRange.min &&
                    z.velRange.max === o.velRange.max &&
                    z.generators.length === 0 &&
                    o.generators.length === 0
                );
            }));
    let removed = 0;
    const byProgram = new Map<number, BasicPreset[]>();
    for (const p of bank.presets) {
        if (p.isGMGSDrum) continue;
        byProgram.set(p.program, [...(byProgram.get(p.program) ?? []), p]);
    }
    for (const [program, presets] of byProgram) {
        // the selection only looks at MSB values some preset of the program has, any other value acts like one
        // unused value. GS uses the LSB for the map select only (0, or 1 to 4 for SC-55 to SC-8820)
        const banks = new Set<number>();
        for (const p of presets) banks.add(p.bankMSB).add(p.bankLSB);
        let unused = 0;
        while (banks.has(unused)) unused++;
        const requests = new Array<MIDIPatch>();
        for (const bankMSB of [...banks, unused]) {
            for (let bankLSB = 0; bankLSB <= 4; bankLSB++) requests.push({ bankMSB, bankLSB, program, isGMGSDrum: false });
        }
        // a melodic request only looks at presets of its program (the MSB 0 ones always stay, so the list never
        // runs empty), in the bank's sorted order. One scenario per preset list the selection has to keep
        const lists = [presets, ...views.map((view) => presets.filter(view))].filter((l) => l.length > 0);
        const scenarios = lists.map((list) => {
            const before = requests.map((r) => MIDIPatchTools.selectPatch(list, r, "gs"));
            return { list, before, now: [...before] };
        });
        // the capital tones (MSB 0) of every map stay, variations go first from the highest bank down
        for (const p of [...presets].reverse()) {
            if (p.bankMSB === 0 || (removable && !removable.has(p))) continue;
            // a view without the preset has nothing to lose
            const inViews = scenarios.map(({ list }) => list.includes(p));
            // every step of the selection takes the first preset that fits, so only requests that picked p can change
            const next = scenarios.map(({ list, now }, k) => {
                if (!inViews[k]) return { without: list, picks: now };
                const without = list.filter((x) => x !== p);
                return {
                    without,
                    picks: now.map((pick, i) => (pick === p ? MIDIPatchTools.selectPatch(without, requests[i], "gs") : pick))
                };
            });
            if (!next.every((n, k) => n.picks.every((pick, i) => same(pick, scenarios[k].before[i])))) continue;
            next.forEach((n, k) => {
                scenarios[k].list = n.without;
                scenarios[k].now = n.picks;
            });
            bank.deletePreset(p);
            removed++;
        }
    }
    bank.flush();
    return removed;
}
