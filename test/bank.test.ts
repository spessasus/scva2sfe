/**
 * The invariants of a converted bank, read back through spessasynth_core. Skipped without SCVA_TEST_BANK (the path of
 * a bank the converter wrote): a conversion needs SCCore.dll, which CI does not have.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import type { BasicZone, Modulator, ModulatorSource } from "spessasynth_core";
import { CustomCurve, GeneratorTypes, SoundBankLoader } from "spessasynth_core";

const path = process.env.SCVA_TEST_BANK;
const skip = path ? false : "set SCVA_TEST_BANK to a converted bank";
const bank = path ? SoundBankLoader.fromArrayBuffer(fs.readFileSync(path).buffer as ArrayBuffer) : undefined;

// every zone with its global zone's modulators, the way core merges them
const zones = () => {
    const out = new Array<{ name: string; zone: BasicZone; mods: Modulator[] }>();
    for (const instrument of bank!.instruments) {
        for (const zone of instrument.zones) out.push({ name: instrument.name, zone, mods: [...instrument.globalZone.modulators, ...zone.modulators] });
    }
    return out;
};

// a custom curve's y at a source value, as core interpolates it
const yAt = (source: ModulatorSource, x: number) => {
    const curve = source.curve;
    if (!(curve instanceof CustomCurve)) return undefined;
    const p = curve.points;
    for (let i = 1; i < p.length; i++) {
        if (p[i].x >= x) return p[i].x === p[i - 1].x ? p[i].y : p[i - 1].y + ((p[i].y - p[i - 1].y) * (x - p[i - 1].x)) / (p[i].x - p[i - 1].x);
    }
    return p[p.length - 1].y;
};

test("every controller curve is 0 at 64", { skip }, () => {
    const off = new Set<string>();
    for (const { name, mods } of zones()) {
        for (const m of mods) {
            if (!m.primarySource.isCC || !m.primarySource.isBipolar) continue;
            const y = yAt(m.primarySource, 8192);
            if (y !== undefined && y !== 8192) off.add(`${name}: CC${m.primarySource.index} -> ${m.destination} (${y})`);
        }
    }
    assert.deepEqual([...off].slice(0, 10), []);
});

test("every modulator amount fits in 16 bits", { skip }, () => {
    for (const { name, mods } of zones()) {
        for (const m of mods) assert.ok(m.transformAmount >= -32768 && m.transformAmount <= 32767, `${name}: ${m.transformAmount}`);
    }
});

test("an attack without fade in stays so at default controllers", { skip }, () => {
    for (const { name, zone, mods } of zones()) {
        if (zone.getGenerator(GeneratorTypes.attackVolEnv, 0) !== -32768) continue;
        for (const m of mods) {
            if (m.destination !== GeneratorTypes.attackVolEnv || m.transformAmount === 0) continue;
            // a key or velocity curve on it must be gated by a controller that is off at 64
            const gated = m.primarySource.isCC || m.secondarySource.isCC;
            assert.ok(gated, `${name}: an ungated attack modulator on an instant attack`);
            if (!m.primarySource.isCC) assert.equal(yAt(m.secondarySource, 8192), 0, `${name}: the gate is open at 64`);
        }
    }
});

test("every amount curve stays within 0 to 1", { skip }, () => {
    for (const { name, mods } of zones()) {
        for (const m of mods) {
            const c = m.secondarySource.curve;
            if (!(c instanceof CustomCurve) || m.secondarySource.isBipolar) continue;
            for (const p of c.points) assert.ok(p.y >= 0 && p.y <= 16384, `${name}: ${p.y}`);
        }
    }
});
