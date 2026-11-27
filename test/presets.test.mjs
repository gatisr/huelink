/**
 * Presets: Normal equals the shipped defaults, "no selection" is derived from
 * live values, and a broken catalogue entry is skipped.
 * fast.config.json raises maxFps to 25 so unclamped presets are reachable.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");

process.env.HUELINK_CONFIG = join(HERE, "fixtures", "fast.config.json");

const { DEFAULTS: CONFIG_DEFAULTS } = await import(join(REPO, "extension/huelink-lib/config.mjs"));
const { LIMITS, Pacer } = await import(join(REPO, "extension/huelink-lib/pacer.mjs"));
const { SATURATION_PCT } = await import(join(REPO, "extension/huelink-lib/huepack.mjs"));
const { KNOB_KEYS, landed, loadPresets, match } = await import(join(REPO, "extension/huelink-lib/presets.mjs"));

const quiet = { error: () => {} };
const PRESETS = loadPresets(quiet);
const byId = (id) => PRESETS.find((p) => p.id === id);

/** Live knob values of a pacer, in the preset's names and units. */
const liveKnobs = (pacer, saturationPct) => ({
    fps: pacer.fps,
    occupancyBudget: pacer.occupancyBudget,
    smoothingFactor: pacer.smoothingFactor,
    bigChangeThreshold: pacer.bigChangeThreshold,
    fastSmoothingMs: pacer.fastSmoothingMs,
    maxFastPerSec: pacer.maxFastPerSec,
    saturationPct,
});

/** Apply a preset through the real pacer setters. */
function applyTo(pacer, preset, maxFps) {
    const got = landed(preset, maxFps);
    pacer.setFps(got.fps);
    for (const key of KNOB_KEYS) if (key !== "fps" && key !== "saturationPct") pacer.setTunable(key, got[key]);
    return got;
}

test("every preset sets every knob, inside the limits the sliders clamp to", () => {
    assert.ok(PRESETS.length > 0);
    for (const p of PRESETS) {
        assert.deepEqual(Object.keys(p.knobs).sort(), [...KNOB_KEYS].sort(), p.id);
        for (const key of KNOB_KEYS) {
            const v = p.knobs[key];
            if (key === "fps") continue; // bounded by maxFps
            if (key === "saturationPct") {
                assert.ok(v >= SATURATION_PCT.min && v <= SATURATION_PCT.max, `${p.id} ${key}=${v}`);
                assert.equal(v % SATURATION_PCT.step, 0, `${p.id} saturation is off the slider grid`);
                continue;
            }
            const { min, max } = LIMITS[key];
            assert.ok(v >= min && v <= max, `${p.id} ${key}=${v} is outside ${min}..${max}`);
        }
    }
});

test("Normal is the shipped defaults", () => {
    assert.deepEqual(byId("normal").knobs, {
        fps: CONFIG_DEFAULTS.fps,
        occupancyBudget: CONFIG_DEFAULTS.occupancyBudget,
        smoothingFactor: CONFIG_DEFAULTS.smoothingFactor,
        bigChangeThreshold: CONFIG_DEFAULTS.bigChangeThreshold,
        fastSmoothingMs: CONFIG_DEFAULTS.fastSmoothingMs,
        maxFastPerSec: CONFIG_DEFAULTS.maxFastPerSec,
        saturationPct: Math.round(CONFIG_DEFAULTS.saturation * 100),
    });
});

test("a low ceiling trims only fps", () => {
    assert.equal(landed(byId("dynamic"), 4).fps, 4);
    assert.deepEqual({ ...landed(byId("dynamic"), 4), fps: 5 }, byId("dynamic").knobs);
    assert.deepEqual(landed(byId("normal"), 5), byId("normal").knobs);
});

test("after applying a preset through the pacer, the live values read back as it", () => {
    // 5 = default install: games is trimmed to 5 fps and must still read as itself.
    for (const maxFps of [25, CONFIG_DEFAULTS.maxFps]) {
        for (const preset of PRESETS) {
            const pacer = new Pacer({ maxFps });
            const got = applyTo(pacer, preset, maxFps);
            assert.equal(match(PRESETS, liveKnobs(pacer, got.saturationPct), maxFps)?.id, preset.id, `${preset.id} @${maxFps}`);
        }
    }
});

test("moving any single knob reads as no preset", () => {
    const moved = {
        fps: 12,
        occupancyBudget: 0.6,
        smoothingFactor: 1.5,
        bigChangeThreshold: 20,
        fastSmoothingMs: 200,
        maxFastPerSec: 7,
        saturationPct: 175,
    };
    for (const key of KNOB_KEYS) {
        const pacer = new Pacer({ maxFps: 25 });
        const got = applyTo(pacer, byId("normal"), 25);
        const live = { ...liveKnobs(pacer, got.saturationPct), [key]: moved[key] };
        assert.equal(match(PRESETS, live, 25), null, `moving ${key} should clear the selection`);
    }
});

test("a broken entry is skipped with an error, not thrown", () => {
    const knobs = {
        fps: 5,
        occupancyBudget: 0.35,
        smoothingFactor: 1.15,
        bigChangeThreshold: 6,
        fastSmoothingMs: 50,
        maxFastPerSec: 1,
        saturationPct: 100,
    };
    const { maxFastPerSec: _omit, ...partial } = knobs;
    const catalogue = {
        presets: [
            { name: "No id", ...knobs },
            { id: "nameless", ...knobs },
            { id: "half_written", name: "Half", ...partial },
            { id: "normal", name: "Normal", ...knobs },
            { id: "normal", name: "Again", ...knobs }, // duplicate id
            { id: "other", name: "Normal", ...knobs }, // duplicate name
        ],
    };
    const dir = mkdtempSync(join(tmpdir(), "huelink-presets-"));
    try {
        const file = join(dir, "presets.json");
        writeFileSync(file, JSON.stringify(catalogue));
        const errors = [];
        const loaded = loadPresets({ error: (m) => errors.push(m) }, file);
        assert.deepEqual(loaded.map((p) => p.id), ["normal"]);
        assert.equal(errors.length, 5, errors.join("\n"));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("an unreadable file gives no presets and no crash", () => {
    const errors = [];
    assert.deepEqual(loadPresets({ error: (m) => errors.push(m) }, join(HERE, "fixtures", "does-not-exist.json")), []);
    assert.equal(errors.length, 1);
});
