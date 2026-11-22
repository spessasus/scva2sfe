/**
 * SFe custom curve modulators that carry an engine value exactly at every 7 bit source value.
 */
import type { BankModulator, BankSource } from "./bank.js";

/**
 * The source value (0 to 16384) a 7 bit value reaches, SFe 4.0 7.2 "center-max": 128 * v up to 64, above it the
 * rest of the range in 63 steps, so 64 is the center and 127 the full scale.
 */
export const sourceX = (v: number) => (v <= 64 ? v * 128 : Math.round(8192 + (8192 * (v - 64)) / 63));

/**
 * A bipolar custom curve modulator from a 7 bit source (velocity, key or a controller) whose output at value x is
 * values[x] in the destination's units: a point at every sourceX(x), y = 8192 + 8192 * values[x] / amount. Undefined
 * where every value rounds to nothing.
 */
export function curveModulator(source: "velocity" | "key" | "cc", values: ArrayLike<number>, dest: string, cc?: number) {
    let amount = 0;
    for (let x = 0; x < 128; x++) amount = Math.max(amount, Math.abs(values[x]));
    amount = Math.round(amount);
    if (amount < 1) return undefined;
    const points = new Array<[number, number]>();
    for (let x = 0; x < 128; x++) {
        points.push([sourceX(x), Math.round(Math.min(16384, Math.max(0, 8192 + (8192 * values[x]) / amount)))]);
    }
    const m: BankModulator = { source, curve: "custom", points, negative: false, bipolar: true, dest, amount };
    if (cc !== undefined) m.cc = cc;
    return m;
}

/**
 * A controller custom curve: the destination moves by values[x] at controller value x (0 at the controller's
 * default, so a curve drawn from the engine's answer against 64 stays put there).
 */
export const ccCurve = (cc: number, values: ArrayLike<number>, dest: string) => curveModulator("cc", values, dest, cc);

/**
 * Values at the 7 bit points of a grid (ascending, from 0 to 127) at every 7 bit value, linear in between.
 */
export function gridValues(grid: readonly number[], at: readonly number[]) {
    const out = new Float64Array(128);
    for (let x = 0; x < 128; x++) {
        let j = 0;
        while (j < grid.length - 2 && grid[j + 1] <= x) j++;
        out[x] = at[j] + ((at[j + 1] - at[j]) * (x - grid[j])) / (grid[j + 1] - grid[j]);
    }
    return out;
}

/**
 * A controller as a unipolar amount source through a custom curve: values[x] (0 to 1) at every 7 bit value.
 */
export function ccScale(cc: number, values: ArrayLike<number>): BankSource {
    const points = new Array<[number, number]>();
    for (let x = 0; x < 128; x++) points.push([sourceX(x), Math.round(16384 * Math.min(1, Math.max(0, values[x])))]);
    return { source: "cc", cc, curve: "custom", points, negative: false, bipolar: false };
}

/**
 * A modulator of a standard curve, for the zero amount copies that switch off a default modulator of the same
 * identity (a custom curve does not replace it).
 */
export function ccModulator(cc: number, curve: "linear" | "convex" | "concave", amount: number, dest: string): BankModulator {
    return { source: "cc", cc, curve, negative: false, bipolar: true, dest, amount: Math.round(amount) };
}
