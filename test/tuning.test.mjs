/**
 * TUNING: the knobs that moved out of the source and into
 * `huelink.config.json`, and the token bucket they can now switch on.
 *
 * Three different kinds of claim are tested here, and they fail for three
 * different reasons:
 *
 *   - "the defaults did not change". The whole point of making a constant
 *     configurable is that nobody who ignores the file notices. A test that
 *     pins the shipped defaults is the only thing standing between "I made it
 *     adjustable" and "I quietly re-tuned every installation".
 *   - "the ranges are enforced in one place". `LIMITS` is the clamp and the
 *     config SPEC is a typo catcher. If a value can reach the pacer without
 *     passing a clamp, a hand-edited file can set `occupancyBudget: 50`.
 *   - "the burst does not spend money it does not have". This is the one real
 *     behavioural claim of the whole feature. It is not "the strip looks
 *     smoother", which is a matter of taste, but "over a long run the stream
 *     still averages `occupancyBudget`", which is arithmetic and can be
 *     checked.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

const { BURST_MAX_FPS, DEFAULTS: PACER, FPS_CEILING, LIMITS, MAX_FPS, NOMINAL_SEND_MS, Pacer, TUNABLE } = await import(
    join(REPO, "extension/lib/pacer.mjs")
);
const { DEFAULTS: CONFIG_DEFAULTS, consistency, loadConfig } = await import(join(REPO, "extension/lib/config.mjs"));

/** A config file in its own temp dir, since `loadConfig` takes a path. */
function configWith(values) {
    const dir = mkdtempSync(join(tmpdir(), "huelink-tuning-"));
    const file = join(dir, "huelink.config.json");
    writeFileSync(file, JSON.stringify(values));
    return loadConfig(file);
}

/** Seven segments of one colour, which is all the pacer looks at. */
const frame = (r, g, b) => Array.from({ length: 7 }, () => ({ r, g, b }));

// ------------------------------------------------ D: nothing moved ----

test("the shipped defaults are the ones that were measured", () => {
    // Pinned literally, not read from the module. Comparing `DEFAULTS.fps` to
    // `DEFAULTS.fps` would pass however the file is edited, which is exactly
    // the edit this test exists to catch.
    assert.equal(MAX_FPS, 5);
    assert.equal(PACER.fps, 5);
    assert.equal(PACER.maxFps, 5);
    assert.equal(PACER.occupancyBudget, 0.35);
    assert.equal(PACER.maxPerWindow, 2);
    assert.equal(PACER.windowMs, 100);
    assert.equal(PACER.smoothingFactor, 1.15);
    assert.equal(PACER.bigChangeThreshold, 6);
    assert.equal(PACER.maxFastPerSec, 1);
    assert.equal(PACER.fastSmoothingMs, 50);
});

test("the burst ships OFF, by every switch that can turn it off", () => {
    assert.equal(PACER.burstFps, 0, "burstFps 0 is the off switch");
    const p = new Pacer();
    assert.equal(p.burstFps, 0);
    // `#bursting` is private, so this is checked through the counter: a pacer
    // on defaults can never report a burst however loud the content is.
    for (let i = 0; i < 200; i++) {
        const c = i % 2 ? frame(0, 0, 0) : frame(255, 255, 255);
        const d = p.decide(c, i * 20);
        if (d) p.noteSent(d.perceptual, 51, i * 20, d.fast);
    }
    assert.equal(p.stats(4000).bursts, 0, "a default pacer must never burst");
});

test("the config defaults agree with the pacer defaults", () => {
    // Two files, one set of numbers. A config default that drifted from the
    // pacer default would mean the shipped behaviour depends on whether a
    // config file happens to exist, which is the one thing it must not do.
    assert.equal(CONFIG_DEFAULTS.fps, PACER.fps);
    assert.equal(CONFIG_DEFAULTS.maxFps, PACER.maxFps);
    assert.equal(CONFIG_DEFAULTS.dutyCap, PACER.maxPerWindow);
    for (const key of TUNABLE) {
        assert.equal(CONFIG_DEFAULTS[key], PACER[key], `config default for ${key}`);
    }
});

test("an absent config file produces no complaints", () => {
    // `loadConfig` returns early when there is no file, with `warnings: []`
    // hard-coded. That shortcut is only honest while the defaults really are
    // self-consistent, so check the thing the shortcut assumes.
    assert.deepEqual(consistency(CONFIG_DEFAULTS), []);
});

// --------------------------------------------------------- tune() ----

test("tune applies only TUNABLE keys and reports what changed", () => {
    const p = new Pacer();
    const changed = p.tune({ occupancyBudget: 0.5, bigChangeThreshold: 9 });
    assert.deepEqual(changed.sort(), ["bigChangeThreshold", "occupancyBudget"]);
    assert.equal(p.occupancyBudget, 0.5);
    assert.equal(p.bigChangeThreshold, 9);

    // Same values again: nothing changed, so nothing is reported. This is what
    // stops the hot reload from logging "applied" on every poll of an
    // untouched file.
    assert.deepEqual(p.tune({ occupancyBudget: 0.5, bigChangeThreshold: 9 }), []);
});

test("tune refuses to set the knobs their live owners hold", () => {
    // `fps`, `deltaScalePct` and `dutyCap` are set from Home Assistant and the
    // z2m device page. If the file also set them, every poll of the file would
    // undo whatever a person just moved the slider to.
    const p = new Pacer({ fps: 4, maxPerWindow: 3 });
    p.setDeltaScale(200);
    const before = { fps: p.fps, maxFps: p.maxFps, duty: p.maxPerWindow, delta: p.deltaScale };

    assert.deepEqual(p.tune({ fps: 1, maxFps: 20, dutyCap: 5, deltaScalePct: 400 }), []);
    assert.equal(p.fps, before.fps);
    assert.equal(p.maxFps, before.maxFps);
    assert.equal(p.maxPerWindow, before.duty);
    assert.equal(p.deltaScale, before.delta);
});

test("tune clamps rather than trusting the file", () => {
    const p = new Pacer();
    p.tune({ occupancyBudget: 50, smoothingFactor: 0, bigChangeThreshold: 999, burstRefill: -3 });
    assert.equal(p.occupancyBudget, LIMITS.occupancyBudget.max);
    assert.equal(p.smoothingFactor, LIMITS.smoothingFactor.min);
    assert.equal(p.bigChangeThreshold, LIMITS.bigChangeThreshold.max);
    assert.equal(p.burstRefill, LIMITS.burstRefill.min);
});

test("tune keeps the current value for anything unreadable", () => {
    const p = new Pacer();
    p.tune({ occupancyBudget: 0.5 });
    for (const bad of ["fast", null, undefined, NaN, Infinity, [], {}, true]) {
        p.tune({ occupancyBudget: bad });
        assert.equal(p.occupancyBudget, 0.5, `occupancyBudget survived ${String(bad)}`);
    }
});

test("the constructor and tune are the same path", () => {
    // The constructor used to assign `opts` straight onto `this`, so a value
    // out of range was clamped when it arrived over MQTT but not when it came
    // from the file. Both routes have to end up in the same state.
    const built = new Pacer({ occupancyBudget: 50, bigChangeThreshold: 999 });
    const tuned = new Pacer();
    tuned.tune({ occupancyBudget: 50, bigChangeThreshold: 999 });
    assert.equal(built.occupancyBudget, tuned.occupancyBudget);
    assert.equal(built.bigChangeThreshold, tuned.bigChangeThreshold);
});

// ------------------------------------------------- F: maxFps ceiling ----

test("maxFps is the ceiling setFps clamps to", () => {
    const p = new Pacer({ maxFps: 12, fps: 12 });
    assert.equal(p.fps, 12, "a raised ceiling actually lets fps up");

    const stock = new Pacer();
    assert.equal(stock.setFps(12), true, "the value is accepted...");
    assert.equal(stock.fps, MAX_FPS, "...and then clamped to the default ceiling");
});

test("a lowered ceiling pulls a stale retained value back down", () => {
    // This is the reason the clamp survived becoming configurable: Home
    // Assistant restores the last `number` it saw, so an old 12 arrives on
    // every restart and has to meet the ceiling that is current now.
    const p = new Pacer({ maxFps: 3 });
    p.setFps(12);
    assert.equal(p.fps, 3);
});

test("maxFps is itself bounded, so the ceiling is still a ceiling", () => {
    assert.equal(new Pacer({ maxFps: 9999 }).maxFps, FPS_CEILING);
    assert.equal(new Pacer({ maxFps: 0 }).maxFps, LIMITS.maxFps.min);
    assert.equal(new Pacer({ maxFps: "nonsense" }).maxFps, MAX_FPS, "garbage falls back to the default");
});

test("the burst ceiling follows maxFps instead of pinning it to 15", () => {
    // On a dedicated coordinator running at 17 fps, a burst capped at
    // BURST_MAX_FPS would be a brake wearing a burst's name.
    const stock = new Pacer();
    assert.equal(stock.limit("burstFps").max, BURST_MAX_FPS);

    const fast = new Pacer({ maxFps: 30 });
    assert.equal(fast.limit("burstFps").max, 30);
    fast.tune({ burstFps: 30 });
    assert.equal(fast.burstFps, 30);

    // And the shared LIMITS table is untouched by that: it is one object for
    // every pacer in the process.
    assert.equal(LIMITS.burstFps.max, BURST_MAX_FPS);
    assert.equal(stock.limit("burstFps").max, BURST_MAX_FPS);
});

// ------------------------------------------------ B: the token bucket ----

test("credit accrues from elapsed time, not from skipped frames", () => {
    const p = new Pacer({ burstFps: 10, occupancyBudget: 0.5, burstRefill: 1, burstCreditMs: 5000 });
    p.decide(frame(0, 0, 0), 0); // first call only sets the clock
    assert.equal(p.credit, 0);
    p.decide(frame(0, 0, 0), 1000);
    // 1000 ms of wall time at a 0.5 budget is 500 ms of coordinator time we
    // were entitled to and did not use.
    assert.equal(Math.round(p.credit), 500);
});

test("credit is capped, so an hour of darkness does not buy a minute of burst", () => {
    const p = new Pacer({ burstFps: 10, occupancyBudget: 0.5, burstCreditMs: 300 });
    p.decide(frame(0, 0, 0), 0);
    p.decide(frame(0, 0, 0), 3600_000);
    assert.equal(p.credit, 300);
});

test("burstRefill scales what time grants, and 0 freezes the bucket", () => {
    const half = new Pacer({ burstFps: 10, occupancyBudget: 0.5, burstRefill: 0.5, burstCreditMs: 5000 });
    half.decide(frame(0, 0, 0), 0);
    half.decide(frame(0, 0, 0), 1000);
    assert.equal(Math.round(half.credit), 250);

    const frozen = new Pacer({ burstFps: 10, occupancyBudget: 0.5, burstRefill: 0, burstCreditMs: 5000 });
    frozen.decide(frame(0, 0, 0), 0);
    frozen.decide(frame(0, 0, 0), 1000);
    assert.equal(frozen.credit, 0);
});

test("every send is paid for, burst or not, and the debt has a floor", () => {
    const p = new Pacer({ burstCreditMs: 200 });
    p.noteSent(null, 51, 100);
    assert.equal(p.credit, -51, "an ordinary frame spends from the same bucket");
    for (let i = 0; i < 50; i++) p.noteSent(null, 51, 200 + i);
    assert.equal(p.credit, -200, "a stalled coordinator cannot invent unbounded debt");
});

test("a burst cannot start on an empty bucket", () => {
    const p = new Pacer({ burstFps: 12, burstCreditMs: 0 });
    for (let i = 0; i < 100; i++) {
        const c = i % 2 ? frame(0, 0, 0) : frame(255, 255, 255);
        const d = p.decide(c, i * 20);
        if (d) p.noteSent(d.perceptual, 51, i * 20, d.fast);
    }
    assert.equal(p.stats(2000).bursts, 0, "no credit, no burst");
});

test("the bucket prices frames at what they MEASURED, not at the nominal", () => {
    const p = new Pacer();
    assert.equal(p.sendPrice, NOMINAL_SEND_MS, "before any frame, the opening estimate");
    for (let i = 0; i < 40; i++) p.noteSent(null, 120, i);
    assert.equal(p.sendPrice, 120, "a slow coordinator makes every frame dearer");
});

test("over a long run the burst still averages the occupancy budget", () => {
    // THE claim. A burst reschedules budget; it does not create any. The bound
    // is exact and falls out of the ledger: every send debits the bucket,
    // every millisecond credits it, and the balance never goes below
    // `-burstCreditMs`. So
    //
    //     spent <= earned + burstCreditMs = elapsed * budget * refill + burstCreditMs
    //
    // i.e. the long-run average is the budget plus a term that vanishes as the
    // run gets longer. Checked against a loud film, which is the worst case.
    const budget = 0.35;
    const creditMs = 500;
    const sendMs = 51;
    const totalMs = 600_000;
    const p = new Pacer({ burstFps: 15, maxFps: 15, occupancyBudget: budget, burstCreditMs: creditMs });

    let busyUntil = 0;
    let pending = null;
    let spent = 0;
    for (let now = 0; now < totalMs; now += 20) {
        if (pending && now >= busyUntil) {
            p.noteSent(pending.perceptual, sendMs, busyUntil, pending.fast);
            spent += sendMs;
            pending = null;
        }
        if (pending) continue;
        // A cut every ~400 ms: far louder than any real film, so the burst is
        // being offered every chance it could possibly take.
        const phase = Math.floor(now / 400) % 3;
        const d = p.decide(frame(phase * 120, 255 - phase * 100, phase * 60), now);
        if (d) {
            pending = d;
            busyUntil = now + sendMs;
        }
    }

    const bound = totalMs * budget + creditMs;
    assert.ok(spent <= bound, `spent ${spent} ms must not exceed the ledger bound ${bound} ms`);
    const average = spent / totalMs;
    assert.ok(average <= budget + creditMs / totalMs, `long-run occupancy ${average.toFixed(4)} vs budget ${budget}`);
    // And the burst really did fire, or the assertion above proves nothing.
    assert.ok(p.stats(totalMs).bursts > 0, "the burst never ran, so the bound was not tested");
});

test("the burst raises the frame clock and nothing else", () => {
    // The hard per-window cap is what bounds how many of our frames can sit
    // ahead of a wall switch press at any instant. A burst must not touch it,
    // or the worst case for the rest of the house changes.
    const p = new Pacer({ burstFps: 15, maxFps: 15, maxPerWindow: 2 });
    const before = p.maxPerWindow;
    p.tune({ burstFps: 15 });
    assert.equal(p.maxPerWindow, before);
    assert.equal(p.windowMs, PACER.windowMs);
});

// ------------------------------------------- H: consistency warnings ----

test("asking for more fps than the ceiling allows is said out loud", () => {
    const w = consistency({ ...CONFIG_DEFAULTS, fps: 12, maxFps: 5 });
    assert.equal(w.length, 1, w.join(" | "));
    assert.match(w[0], /maxFps/);
});

test("asking for more fps than the duty cap can pass is said out loud", () => {
    // 1 frame per 100 ms window is 10 fps, so 12 cannot be delivered however
    // generous the budget is. Silently trimming it is what the warning exists
    // to replace.
    const w = consistency({ ...CONFIG_DEFAULTS, fps: 12, maxFps: 20, dutyCap: 1, occupancyBudget: 0.9 });
    assert.ok(
        w.some((x) => /dutyCap/.test(x)),
        w.join(" | "),
    );
});

test("asking for more fps than the budget can pay for is said out loud", () => {
    // 0.35 of a second, at 51 ms a frame, is about 6.9 fps.
    const w = consistency({ ...CONFIG_DEFAULTS, fps: 15, maxFps: 20, dutyCap: 5, occupancyBudget: 0.35 });
    assert.ok(
        w.some((x) => /occupancyBudget|budget/i.test(x)),
        w.join(" | "),
    );
});

test("a coherent fast setup is not nagged about", () => {
    // The dedicated-coordinator case from the README. If this warns, the
    // warning is noise and will be ignored when it matters.
    const fast = { ...CONFIG_DEFAULTS, fps: 15, maxFps: 15, dutyCap: 3, occupancyBudget: 0.9 };
    const budgetFps = (fast.occupancyBudget * 1000) / NOMINAL_SEND_MS;
    assert.ok(budgetFps >= 15, `the premise: ${budgetFps.toFixed(1)} fps is affordable at 0.9`);
    assert.deepEqual(consistency(fast), []);
});

// ----------------------------------------------- the config file edge ----

test("the new fields load from the file", () => {
    const { config, errors, warnings } = configWith({
        maxFps: 15,
        fps: 15,
        dutyCap: 3,
        occupancyBudget: 0.9,
        fastSmoothingMs: 30,
        burstFps: 12,
        burstMaxMs: 800,
        burstCreditMs: 400,
        burstRefill: 0.5,
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, []);
    assert.equal(config.maxFps, 15);
    assert.equal(config.fastSmoothingMs, 30);
    assert.equal(config.burstFps, 12);
    assert.equal(config.burstRefill, 0.5);
});

test("an out-of-range field is a loud error, not a silent clamp", () => {
    const { config, errors } = configWith({ maxFps: 9999, burstFps: -4, smoothingFactor: 17 });
    assert.equal(errors.length, 3, errors.join(" | "));
    // ... and the value that reaches the pacer is the default, not the junk.
    assert.equal(config.maxFps, CONFIG_DEFAULTS.maxFps);
    assert.equal(config.burstFps, CONFIG_DEFAULTS.burstFps);
    assert.equal(config.smoothingFactor, CONFIG_DEFAULTS.smoothingFactor);
});

test("a file that sets nothing changes nothing", () => {
    // The strongest form of "the defaults did not move": an empty file has to
    // build a pacer indistinguishable from `new Pacer()`.
    const { config, errors, warnings } = configWith({});
    assert.deepEqual(errors, []);
    assert.deepEqual(warnings, []);

    const fromFile = new Pacer({
        fps: config.fps,
        maxFps: config.maxFps,
        maxPerWindow: config.dutyCap,
        ...Object.fromEntries(TUNABLE.map((k) => [k, config[k]])),
    });
    const stock = new Pacer();
    for (const key of ["fps", "maxFps", "maxPerWindow", "windowMs", ...TUNABLE]) {
        assert.equal(fromFile[key], stock[key], `${key} differs`);
    }
});

test("the example file documents every field, and documents them truthfully", () => {
    // Two failures this catches, both of which are invisible until someone
    // copies the file: a field added to the loader and never written down, and
    // an example value that drifted away from the default it claims to show.
    const example = loadConfig(join(REPO, "huelink.config.example.json"));
    assert.deepEqual(example.errors, [], "the example file must load cleanly");
    assert.deepEqual(example.warnings, [], "the example file must not warn about itself");

    const documented = JSON.parse(readFileSync(join(REPO, "huelink.config.example.json"), "utf8"));
    for (const key of Object.keys(CONFIG_DEFAULTS)) {
        assert.ok(Object.hasOwn(documented, key), `${key} is missing from the example file`);
        assert.ok(documented._fields[key], `${key} has no description in the example file`);
        assert.deepEqual(documented[key], CONFIG_DEFAULTS[key], `the example value for ${key} is not the default`);
    }
});

// --------------------------------------------- G: the slider agrees ----

test("the fps slider is built from the configured ceiling", async () => {
    // The converter and the extension are loaded separately by z2m, so this is
    // the only thing keeping the device page from offering a range the engine
    // overrides.
    const { CONFIG } = await import(join(REPO, "extension/lib/config.mjs"));
    const { FIELDS } = await import(join(REPO, "extension/lib/huelink-ui.mjs"));
    const fps = FIELDS.find((f) => f.key === "huelink_fps");
    assert.equal(fps.max, CONFIG.maxFps);
    assert.ok(fps.min <= fps.max, "a ceiling below the floor would be an empty slider");
});
