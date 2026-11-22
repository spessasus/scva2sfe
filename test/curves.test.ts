/**
 * The curve invariants the bank relies on, on synthetic curves: controller curves are exactly 0 at their default, the
 * CC74 amount curves exactly 1 there, controller curves are written and shared exactly.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ccCurve, ccScale, gridValues, sourceX } from "../src/lib/curves.js";
import { shareCurves, simplify } from "../src/lib/convert.js";
import type { PackedModulator } from "../src/lib/zones.js";

// y of a point list at a source value, as core's CustomCurve.getY reads it: the last point at or before x (at a
// vertical step the last one wins), the first y below the first point, the last y after the last
const yAt = (points: [number, number][], x: number) => {
    let i = -1;
    while (i < points.length - 1 && points[i + 1][0] <= x) i++;
    if (i < 0) return points[0][1];
    if (i === points.length - 1) return points[i][1];
    const [x0, y0] = points[i];
    const [x1, y1] = points[i + 1];
    return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
};

// a steep curve, 0 at 64, the shape the CC71 and CC75 curves take
const steep = Float64Array.from({ length: 128 }, (_, x) => (x < 64 ? 1200 * Math.tanh((64 - x) / 9) : -900 * Math.tanh((x - 64) / 5)));

test("a controller curve is exactly 0 at 64", () => {
    const m = ccCurve(71, steep, "initialFilterFc")!;
    assert.equal(yAt(m.points!, sourceX(64)), 8192);
    assert.ok(Math.abs(m.amount) <= 32767);
});

test("a CC74 amount curve is exactly 1 at 64", () => {
    const s = ccScale(74, Float64Array.from({ length: 128 }, (_, x) => (x === 64 ? 1 : 0.5)));
    assert.equal(yAt(s.points!, sourceX(64)), 16384);
});

test("grid values hit their grid points", () => {
    const grid = [0, 16, 32, 48, 64, 80, 96, 112, 127];
    const at = [5, -3, 7, 0, 0, 2, -8, 4, 9];
    const c = gridValues(grid, at);
    grid.forEach((x, j) => assert.equal(c[x], at[j]));
});

test("a pinned curve keeps its point at 64", () => {
    const ys = Uint16Array.from(ccCurve(75, steep, "decayVolEnv")!.points!, (p) => p[1]);
    // a tolerance wide enough to drop 64 when unpinned
    const points = simplify(ys, 4000, true);
    assert.ok(points.some(([x, y]) => x === sourceX(64) && y === ys[64]));
    assert.equal(yAt(points, sourceX(64)), 8192);
});

const packed = (source: "cc" | "velocity", ys: Uint16Array, amount: number): PackedModulator => ({
    source,
    ...(source === "cc" ? { cc: 71 } : {}),
    curve: "custom",
    negative: false,
    bipolar: true,
    dest: "initialFilterFc",
    amount,
    ys
});

test("controller curves are shared only when identical", () => {
    const a = Uint16Array.from(ccCurve(71, steep, "initialFilterFc")!.points!, (p) => p[1]);
    const b = a.slice();
    b[100] += 1;
    const c = a.slice();
    const out = shareCurves([packed("cc", a, 1000), packed("cc", b, 1000), packed("cc", c, 1000)], [[0, 127, 0, 127], [0, 127, 0, 127], [0, 127, 0, 127]]);
    assert.notEqual(out[1]!.ys, out[0]!.ys);
    assert.equal(out[2]!.ys, out[0]!.ys);
});

test("velocity curves still share within their tolerance", () => {
    const a = Uint16Array.from(ccCurve(71, steep, "initialFilterFc")!.points!, (p) => p[1]);
    const b = a.slice();
    b[100] += 1;
    const out = shareCurves([packed("velocity", a, 1000), packed("velocity", b, 1000)], [[0, 127, 0, 127], [0, 127, 0, 127]]);
    assert.equal(out[1]!.ys, out[0]!.ys);
});
