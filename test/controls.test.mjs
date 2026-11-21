/**
 * Controls: the pacer sliders, the 25 fps ceiling, and that default
 * installs behave exactly as before. fast.config.json raises maxFps only.
 */

import { strict as assert } from "node:assert";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");

process.env.HUELINK_CONFIG = join(HERE, "fixtures", "fast.config.json");

const { CONFIG, DEFAULTS: CONFIG_DEFAULTS } = await import(join(REPO, "extension/huelink-lib/config.mjs"));
const { DEFAULTS, LIMITS, Pacer, TUNABLE } = await import(join(REPO, "extension/huelink-lib/pacer.mjs"));
const { FIELDS, KNOBS } = await import(join(REPO, "extension/huelink-lib/huelink-ui.mjs"));

const field = (key) => FIELDS.find((f) => f.key === key);

test("each slider moves the value it names and is clamped to its range", () => {
    for (const { knob, command } of KNOBS) {
        // A knob missing from TUNABLE makes setTunable refuse every value.
        assert.ok(TUNABLE.includes(knob), `${knob} is wired to a slider but is not TUNABLE`);
        const f = field(`huelink_${command}`);
        assert.ok(f, `huelink_${command} is not shown`);
        const pacer = new Pacer({});
        assert.equal(pacer.setTunable(knob, f.max * 10), true);
        assert.equal(pacer[knob], f.max, `${knob} over the top`);
        pacer.setTunable(knob, f.min - 1000);
        assert.equal(pacer[knob], f.min, `${knob} under the bottom`);
    }
});

test("a slider sent nonsense says no rather than taking NaN", () => {
    const pacer = new Pacer({});
    for (const { knob } of KNOBS) {
        const before = pacer[knob];
        for (const bad of ["", "abc", null, undefined, {}, [], NaN, Infinity]) {
            assert.equal(pacer.setTunable(knob, bad), false, `${knob} accepted ${JSON.stringify(bad)}`);
        }
        assert.equal(pacer[knob], before, `${knob} moved while refusing`);
    }
    assert.equal(pacer.setTunable("notAKnob", 5), false);
    // maxFps exists on the pacer but is not TUNABLE.
    assert.equal(pacer.setTunable("maxFps", 50), false);
});

test("default install: pacer, stats and config defaults are the pre-1.3.0 values", () => {
    // Literals on purpose: changing a default must mean changing this test.
    for (const key of Object.keys(DEFAULTS)) {
        if (key in CONFIG_DEFAULTS) assert.equal(CONFIG_DEFAULTS[key], DEFAULTS[key], key);
    }
    const pacer = new Pacer(CONFIG_DEFAULTS);
    assert.equal(pacer.fps, 5);
    assert.equal(pacer.maxFps, 5);
    assert.equal(pacer.occupancyBudget, 0.35);
    assert.equal(pacer.maxPerWindow, 2);
    assert.equal(DEFAULTS.windowMs, 100);
    assert.equal(pacer.smoothingFactor, 1.15);
    assert.equal(pacer.bigChangeThreshold, 6);
    assert.equal(pacer.fastSmoothingMs, 50);
    assert.equal(pacer.maxFastPerSec, 1);
    assert.equal(pacer.burstFps, 0);
    assert.equal(pacer.stats().occupancyBudgetPct, 35);
});

test("the ceiling permits a frame rate but never raises it", () => {
    // maxFps is what MAY be asked for, not what IS asked for.
    const pacer = new Pacer({ ...CONFIG_DEFAULTS, maxFps: 25 });
    assert.equal(pacer.fps, 5);
    assert.equal(pacer.occupancyBudget, 0.35);
    assert.equal(pacer.maxPerWindow, 2);
    // The test fixture's ceiling reaches the z2m slider.
    assert.equal(field("huelink_fps").max, CONFIG.maxFps);

    assert.equal(pacer.setFps(25), true);
    assert.equal(pacer.fps, 25);
    const slow = new Pacer({ maxFps: 5 });
    assert.equal(slow.setFps(25), true, "the value was readable");
    assert.equal(slow.fps, 5, "but 25 must not survive a ceiling of 5");
});

test("paying for 25 fps takes BOTH the quota and the budget", () => {
    const pacer = new Pacer({ maxFps: 25, fps: 25 });
    assert.ok(pacer.ceiling().effective < 25);

    pacer.setDutyCap(3);
    assert.equal(pacer.ceiling().duty, 30, "3 per 100 ms is 30 a second");
    assert.ok(pacer.ceiling().effective < 25, "the budget still has not been paid");

    // 25 frames at 51 ms is 1275 ms per second, more than any budget buys.
    pacer.setOccupancyBudget(LIMITS.occupancyBudget.max);
    assert.ok(pacer.ceiling().effective < 25, "even 90 % cannot buy 25 at 51 ms a frame");
    assert.equal(pacer.ceiling().effective, 17.6);
});

test("the ceiling follows the coordinator's measured price, not the nominal one", () => {
    const pacer = new Pacer({ maxFps: 25, fps: 25, maxPerWindow: 5 });
    const now = Date.now();
    assert.equal(pacer.ceiling().sendMs, 51, "the nominal price, until a frame has gone out");
    // The price is the mean of the last 40 sends, counted from the first.
    for (let i = 0; i < 40; i++) pacer.noteSent(null, 10, now + i);
    assert.equal(pacer.ceiling().sendMs, 10);
    assert.equal(pacer.ceiling().budget, 35, "0.35 of a second at 10 ms a frame");
    assert.equal(pacer.ceiling().effective, 25, "and now 25 really is deliverable");
});
