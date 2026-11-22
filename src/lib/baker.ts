/**
 * Applies the bake plan to a job's zones: each entry's span of keys plays its render
 * from the entry's velocity floor up, the keys and velocities outside keep the rules' zones.
 */
import type { BankSample, BankZone } from "./bank.js";
import { pow } from "./math.js";
import type { BakeRender } from "./bake.js";
import { bakedGenerators, bakeGain, DROP_OUT, DROP_PRE } from "./bake.js";
import type { BakeEntry } from "../rules/bake-plan.js";
import type { Directory } from "./directory.js";
import type { Dll } from "./dll.js";
import { loops } from "./pitch-env.js";
import { PitchModel } from "./pitch.js";
import { corePanSum, CORE_VOLUME_GAIN } from "./zones.js";
import type { Job, PackedModulator, PackedZone } from "./zones.js";

type Zone = BankZone & { peak: number; mods: number[]; src: PackedZone };

export class Baker {
    public readonly stats = { zones: 0, none: 0 };
    private readonly dir;
    private readonly pitch;
    private readonly samples;
    private readonly mods;
    private readonly renders;
    private readonly plan;
    /**
     * The plan's entries by instrument: a melodic tone's partial (tone:slot) or a kit key (kit:note:single).
     */
    private readonly entriesOf = new Map<string, number[]>();
    private readonly sampleOf = new Map<BakeRender, number>();
    private readonly chunks = new Array<Float32Array>();
    private readonly byIndex = new Map<number, Float32Array>();
    public audioLength = 0;

    public constructor(dll: Dll, dir: Directory, samples: BankSample[], mods: PackedModulator[], renders: Map<number, BakeRender | undefined>, plan: readonly BakeEntry[]) {
        this.dir = dir;
        this.pitch = new PitchModel(dll, dir);
        this.samples = samples;
        this.mods = mods;
        this.renders = renders;
        this.plan = plan;
        plan.forEach((e, i) => {
            const key = e.kind === "melodic" ? `tone:${e.tone}` : `key:${e.kit}:${e.note}:${e.single ? 1 : 0}`;
            if (!this.entriesOf.has(key)) this.entriesOf.set(key, []);
            this.entriesOf.get(key)!.push(i);
        });
    }

    public get count() {
        return this.sampleOf.size;
    }

    public data(k: number) {
        return this.byIndex.get(k)!;
    }

    public audio() {
        const out = new Float32Array(this.audioLength);
        let at = 0;
        for (const c of this.chunks) {
            out.set(c, at);
            at += c.length;
        }
        return out;
    }

    private sample(r: BakeRender, e: BakeEntry, name: string) {
        let k = this.sampleOf.get(r);
        if (k === undefined) {
            k = this.samples.length;
            const s: BankSample = {
                name: `bake ${name} ${e.slot + 1} k${e.kind === "melodic" ? e.key : 60} v${e.velocity} ${e.tap}`, file: "bake.f32", offset: this.audioLength,
                length: r.data.length, loop_start: r.loop ? r.loop[0] : 0, loop_end: r.loop ? r.loop[1] : 0, mode: r.loop ? "loop" : "oneshot", baked: true
            };
            const g = bakeGain(r.data);
            if (g !== undefined) s.gain = g;
            this.samples.push(s);
            this.chunks.push(r.data);
            this.byIndex.set(k, r.data);
            this.audioLength += r.data.length;
            this.sampleOf.set(r, k);
        }
        return k;
    }

    /**
     * A job's zones with the plan's bakes applied.
     */
    public apply(job: Job, zones: Zone[]) {
        const key = job.kind === "tone" ? `tone:${job.tone}` : `key:${job.kit}:${job.note}:${job.single ? 1 : 0}`;
        const list = this.entriesOf.get(key);
        if (!list || !zones.length) return zones;
        let out = zones;
        for (const i of list) {
            const e = this.plan[i];
            const r = this.renders.get(i);
            if (!r) {
                this.stats.none++;
                continue;
            }
            const lo = e.kind === "melodic" ? e.lo : 0;
            const hi = e.kind === "melodic" ? e.hi : 127;
            const next = new Array<Zone>();
            for (const z of out) {
                if (z.src.slot !== e.slot || z.key_hi < lo || z.key_lo > hi || z.vel_hi < e.floor || this.samples[z.sample].baked) {
                    next.push(z);
                    continue;
                }
                // the keys outside the span keep the zone
                if (z.key_lo < lo) next.push({ ...z, gens: { ...z.gens }, key_hi: lo - 1 });
                const a = Math.max(lo, z.key_lo);
                const b = Math.min(hi, z.key_hi);
                if (z.vel_lo < e.floor) next.push({ ...z, gens: { ...z.gens }, key_lo: a, key_hi: b, vel_hi: e.floor - 1 });
                next.push(this.baked(e, r, { ...z, key_lo: a, key_hi: b, vel_lo: Math.max(e.floor, z.vel_lo) }));
                if (z.key_hi > hi) next.push({ ...z, gens: { ...z.gens }, key_lo: hi + 1 });
            }
            out = next;
        }
        return out;
    }

    private baked(e: BakeEntry, r: BakeRender, z: Zone) {
        const src = z.src;
        const tone = e.kind === "melodic" ? e.tone : src.tone;
        const header = this.dir.toneHeader(tone);
        const b = this.dir.partial(tone, e.slot)!;
        const scale = src.gens.scaleTuning ?? 0;
        const kb = e.kind === "melodic" ? e.key : 60;
        // the render's pitch at its key is the sample's own: the zone plays it at rate 1 there
        let tune = 0;
        if (e.kind === "melodic" && scale) {
            const looped = loops(this.dir.wave(src.wave));
            const c = (k: number) => this.pitch.cents(header, b, k, false, looped)!;
            const ckb = c(kb);
            const offs = new Array<number>();
            for (let k = z.key_lo; k <= z.key_hi; k++) offs.push(c(k) - ckb - (k - kb) * scale);
            tune = (Math.max(...offs) + Math.min(...offs)) / 2;
        }
        const gens = bakedGenerators(src.gens, r, e.tap, kb, tune);
        const drop = e.tap === "out" ? DROP_OUT : DROP_PRE;
        const keepAttack = r.attack !== undefined;
        const mods = z.mods.filter((i) => {
            const m = this.mods[i];
            // the decay is in the render too: CC75's curves (on the attack as well, zone-tva) have nothing to move
            if (m.source === "cc" && m.cc === 75) return false;
            // the filter's controller level curves go with the filter (gain itself stays, it holds the zone's level),
            // the live filter's on gain and a sample baked filter's on initialAttenuation
            const level = m.dest === "gain" || m.dest === "initialAttenuation";
            if (e.tap === "out" && level && m.source === "cc" && (m.cc === 71 || m.cc === 74) && m.amount !== 0) return false;
            return !drop.has(m.dest) || (keepAttack && (m.dest === "delayVolEnv" || m.dest === "attackVolEnv")) || m.amount === 0;
        });
        // the zone's level: the render's part level stage and dry sends over core's, the live filter's level terms
        // where it stays, and the key level curve's value at the render key (the render has it already)
        const send = r.send[0] + r.send[1];
        let level = (r.gain4 / CORE_VOLUME_GAIN) * (send > 0 ? send / corePanSum(src.gens.pan ?? 0) : 1);
        if (e.tap === "pre") level *= pow(10, src.filterCb / 200);
        for (const i of z.mods) {
            const m = this.mods[i];
            if (m.source === "key" && m.dest === "initialAttenuation" && m.ys) level *= pow(10, (((m.ys[kb] - 8192) / 8192) * m.amount) / 200);
        }
        this.stats.zones++;
        return { ...z, gens, mods, peak: level, sample: this.sample(r, e, e.kind === "melodic" ? this.dir.toneName(tone) : `${this.dir.toneName(tone)} ${e.note}`) };
    }
}
