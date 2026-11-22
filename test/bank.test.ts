/**
 * The invariants of a converted bank, read back through spessasynth_core. Skipped without SCVA_TEST_BANK (the path of
 * a bank the converter wrote): a conversion needs SCCore.dll, which CI does not have. The writer itself refuses
 * amounts over 16 bits and core's loader refuses curve points out of range, so those need no test here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import type { BasicInstrument, BasicZone, Modulator, ModulatorSource } from "spessasynth_core";
import { GeneratorTypes, SoundBankLoader } from "spessasynth_core";

const path = process.env.SCVA_TEST_BANK;
const skip = path ? false : "set SCVA_TEST_BANK to a converted bank";
// a copy: a small file's Buffer is a view into a larger shared pool
const bank = path ? SoundBankLoader.fromArrayBuffer(new Uint8Array(fs.readFileSync(path)).buffer) : undefined;

// every zone with its instrument and its global zone's modulators, the way core merges them
const zones = () => {
    const out = new Array<{ instrument: BasicInstrument; zone: BasicZone; mods: Modulator[] }>();
    for (const instrument of bank!.instruments) {
        for (const zone of instrument.zones) out.push({ instrument, zone, mods: [...instrument.globalZone.modulators, ...zone.modulators] });
    }
    return out;
};

// a source's output at a controller value, through core's own curve code (evaluate is protected in the types only)
const output = (source: ModulatorSource, cc: number) => {
    const curve = source.curve as unknown as { evaluate(value: number, isBipolar: boolean): number };
    const x = (cc * 128) / 16384;
    return curve.evaluate(source.isNegative ? 1 - x : x, source.isBipolar);
};

test("every controller curve is 0 at 64", { skip }, () => {
    const off = new Set<string>();
    for (const { instrument, mods } of zones()) {
        for (const m of mods) {
            if (!m.primarySource.isCC || !m.primarySource.isBipolar) continue;
            const y = output(m.primarySource, 64);
            if (y !== 0) off.add(`${instrument.name}: CC${m.primarySource.index} -> ${m.destination} (${y})`);
        }
    }
    assert.deepEqual([...off].slice(0, 10), []);
});

test("an attack without fade in stays so at default controllers", { skip }, () => {
    let checked = 0;
    for (const { instrument, zone, mods } of zones()) {
        const attack = zone.getGenerator(GeneratorTypes.attackVolEnv, instrument.globalZone.getGenerator(GeneratorTypes.attackVolEnv, 0));
        if (attack !== -32768) continue;
        for (const m of mods) {
            if (m.destination !== GeneratorTypes.attackVolEnv || m.transformAmount === 0) continue;
            checked++;
            // a key or velocity curve on it must be gated by a controller whose output is 0 at 64
            const gate = m.primarySource.isCC ? m.primarySource : m.secondarySource;
            assert.ok(gate.isCC, `${instrument.name}: an ungated attack modulator on an instant attack`);
            assert.equal(output(gate, 64), 0, `${instrument.name}: CC${gate.index} opens the attack at 64`);
        }
    }
    console.log(`attack modulators on instant attacks: ${checked}`);
});
