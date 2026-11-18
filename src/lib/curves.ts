/**
 * SFe custom curve modulators that carry an engine value exactly at every 7 bit source value.
 */
import type { BankModulator } from "./bank.js";

/**
 * A bipolar custom curve modulator from a 7 bit source (velocity, key or a controller) whose output at value x is
 * values[x] in the destination's units: a point at every x * 128, y = 8192 + 8192 * values[x] / amount. Undefined
 * where every value rounds to nothing.
 */
export function curveModulator(source: "velocity" | "key" | "cc", values: ArrayLike<number>, dest: string, cc?: number) {
    let amount = 0;
    for (let x = 0; x < 128; x++) amount = Math.max(amount, Math.abs(values[x]));
    amount = Math.round(amount);
    if (amount < 1) return undefined;
    const points = new Array<[number, number]>();
    for (let x = 0; x < 128; x++) {
        points.push([x * 128, Math.round(Math.min(16384, Math.max(0, 8192 + (8192 * values[x]) / amount)))]);
    }
    points.push([16383, points[127][1]]);
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
 * A modulator of a standard curve, for the zero amount copies that switch off a default modulator of the same
 * identity (a custom curve does not replace it).
 */
export function ccModulator(cc: number, curve: "linear" | "convex" | "concave", amount: number, dest: string): BankModulator {
    return { source: "cc", cc, curve, negative: false, bipolar: true, dest, amount: Math.round(amount) };
}
