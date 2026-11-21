/**
 * INPUT: what the extension does with values it did not choose.
 *
 * Everything here arrives as JSON over MQTT, which means anyone who can reach
 * the broker can send `{"effect_speed": "fast"}` or `{"mode": "constructor"}`.
 * Two whole classes of bug came out of that:
 *
 *   - "not a number" converted instead of refused. `Number("fast")` is `NaN`,
 *     `clamp` lets `NaN` straight through because every comparison with it is
 *     false, the value is stored, and from then on every frame throws until
 *     the circuit breaker calls the strip broken and switches it off. One typo
 *     from a dark room.
 *   - lookups on plain objects. An object inherits from `Object.prototype`, so
 *     `table["constructor"]` is a function rather than `undefined`, and a check
 *     for "did we find it" says yes to a name nobody defined.
 *
 * Both are only visible from outside as "the strip did something odd", so each
 * one gets a test that fails the moment the guard is removed.
 */

import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

const { toFinite } = await import(join(REPO, "extension/huelink-lib/num.mjs"));
const { Pacer, MAX_FPS, LIMITS } = await import(join(REPO, "extension/huelink-lib/pacer.mjs"));
const { EffectEngine, EFFECT_NONE, loadEffects } = await import(join(REPO, "extension/huelink-lib/effects/index.mjs"));
const { MODE_BY_LABEL, MODE_LABEL } = await import(join(REPO, "extension/huelink-lib/huelink-ui.mjs"));
const { loadConfig, DEFAULTS } = await import(join(REPO, "extension/huelink-lib/config.mjs"));

const quiet = { error: () => {}, warn: () => {}, info: () => {} };

/** The values that reach a setter when the sender is wrong, a typo or hostile. */
const NOT_NUMBERS = ["fast", "", "   ", "12px", null, undefined, true, false, [], [5], {}, NaN, Infinity, -Infinity];

// ------------------------------------------------------------ toFinite ----

test("toFinite takes numbers, including the zero `||` would have eaten", () => {
    assert.equal(toFinite(0), 0);
    assert.equal(toFinite("0"), 0);
    assert.equal(toFinite(-1.5), -1.5);
    assert.equal(toFinite("250"), 250);
    assert.equal(toFinite(" 250 "), 250);
});

test("toFinite refuses everything that is not a number", () => {
    for (const v of NOT_NUMBERS) assert.equal(toFinite(v), null, JSON.stringify(v) ?? String(v));
});

// --------------------------------------------------------------- pacer ----

test("pacer setters refuse garbage and keep the value they had", () => {
    const p = new Pacer();
    p.setFps(3);
    p.setOccupancyBudget(0.4);
    p.setDeltaScale(200);
    p.setDutyCap(4);

    for (const v of NOT_NUMBERS) {
        assert.equal(p.setFps(v), false, `setFps(${String(v)})`);
        assert.equal(p.setOccupancyBudget(v), false, `setOccupancyBudget(${String(v)})`);
        assert.equal(p.setDeltaScale(v), false, `setDeltaScale(${String(v)})`);
        assert.equal(p.setDutyCap(v), false, `setDutyCap(${String(v)})`);
    }

    assert.equal(p.fps, 3);
    assert.equal(p.occupancyBudget, 0.4);
    assert.equal(p.deltaScale, 2);
    assert.equal(p.maxPerWindow, 4);
});

test("a refused fps does NOT land on the maximum", () => {
    // The whole point of the fix. `Number(fps) || DEFAULTS.fps` sent every
    // unreadable value to DEFAULTS.fps, which is MAX_FPS, so the worst input
    // asked the coordinator for the most air time of anything.
    const p = new Pacer();
    p.setFps(2);
    assert.equal(p.setFps("fast"), false);
    assert.equal(p.fps, 2);
    assert.notEqual(p.fps, MAX_FPS);
});

test("a zero is a real value, clamped, not treated as missing", () => {
    const p = new Pacer();
    assert.equal(p.setFps(0), true);
    assert.equal(p.fps, 1, "clamped to the floor, not bounced to MAX_FPS");
    assert.equal(p.setDutyCap(0), true);
    assert.equal(p.maxPerWindow, LIMITS.dutyCap.min);
});

test("pacer setters clamp the numbers they do take", () => {
    const p = new Pacer();
    assert.equal(p.setFps(99), true);
    assert.equal(p.fps, MAX_FPS);
    assert.equal(p.setDeltaScale(10000), true);
    assert.equal(p.deltaScale, LIMITS.deltaScalePct.max / 100);
    assert.equal(p.setOccupancyBudget(5), true);
    assert.ok(p.occupancyBudget <= 1);
});

// ------------------------------------------------------------- effects ----

const effects = await loadEffects(quiet);

/** An engine with a real effect running, which is the only state that can break. */
function engine() {
    const e = new EffectEngine({ effects, segments: 7, seed: 1 });
    assert.equal(e.select(effects[0].name), true);
    return e;
}

test("effect speed and brightness refuse garbage and keep working", () => {
    const e = engine();
    e.setSpeed(150);
    e.setBrightness(80);

    for (const v of NOT_NUMBERS) {
        assert.equal(e.setSpeed(v), false, `setSpeed(${String(v)})`);
        assert.equal(e.setBrightness(v), false, `setBrightness(${String(v)})`);
    }

    assert.equal(e.speed, 1.5);
    assert.equal(e.brightness, 0.8);
    // The real symptom: a stored NaN made every frame throw, which the circuit
    // breaker read as an unresponsive strip and answered by switching it off.
    const frame = e.frame(1000);
    assert.equal(frame.length, 7);
    for (const c of frame) {
        assert.ok(Number.isInteger(c.r) && Number.isInteger(c.g) && Number.isInteger(c.b), JSON.stringify(c));
    }
});

test("a NaN never reaches speed or brightness, so no frame can be NaN", () => {
    const e = engine();
    e.setSpeed(NaN);
    e.setBrightness(NaN);
    assert.ok(Number.isFinite(e.speed));
    assert.ok(Number.isFinite(e.brightness));
    e.frame(0);
    for (const c of e.frame(500)) {
        assert.ok(Number.isFinite(c.r) && Number.isFinite(c.g) && Number.isFinite(c.b));
    }
});

test("restart() rewinds an effect that has already run", () => {
    // A sunrise that finished rising stays at full daylight for ever, so
    // re-entering effect mode used to show a still frame.
    const e = engine();
    e.frame(0);
    e.frame(10_000);
    assert.ok(e.phase > 0, "the effect has to have advanced for this to test anything");
    e.restart();
    assert.equal(e.phase, 0);
    assert.equal(e.lastAt, null);
    assert.equal(e.selected, effects[0].name, "a restart is not a deselect");
    assert.equal(e.active, true);
});

test("restart() on an idle engine does nothing rather than selecting something", () => {
    const e = new EffectEngine({ effects, segments: 7, seed: 1 });
    e.restart();
    assert.equal(e.active, false);
    assert.equal(e.selected, EFFECT_NONE);
});

// ---------------------------------------------- inherited-name lookups ----

test("MODE_BY_LABEL answers only for modes that were put in it", () => {
    for (const [mode, label] of Object.entries(MODE_LABEL)) assert.equal(MODE_BY_LABEL.get(label), mode);
    // A plain object would hand back a function for each of these, and the
    // caller's "did we find a mode" check would say yes.
    for (const name of ["constructor", "toString", "valueOf", "__proto__", "hasOwnProperty"]) {
        assert.equal(MODE_BY_LABEL.get(name), undefined, name);
    }
});

test("a palette named after a prototype member is refused, not resolved", async () => {
    const dir = mkdtempSync(join(tmpdir(), "huelink-palette-"));
    const catalogue = join(dir, "effects.json");
    const palettes = join(dir, "palettes.json");
    writeFileSync(
        catalogue,
        JSON.stringify({
            effects: [
                { id: "christmas", kind: "wave", params: { palette: ["#ff0000", "#00ff00"] } },
                { id: "newyear", kind: "wave", params: { palette: "constructor" } },
                { id: "valentines", kind: "wave", params: { palette: "toString" } },
            ],
        }),
    );
    writeFileSync(palettes, JSON.stringify({ palettes: { real: ["#0000ff"] } }));

    const loaded = await loadEffects(quiet, catalogue, palettes);
    assert.deepEqual(
        loaded.map((e) => e.id),
        ["christmas"],
        "only the effect with a real palette may survive",
    );
});

// ------------------------------------------- the catalogue as an input ----
//
// `effects.json` is data, and data is something a user copies from a forum
// post, a tool writes, or anything with write access to the extension
// directory edits. The loader's contract is that a bad entry costs that one
// effect, so the two ways a single line could cost more than that get a test.

/** A logger that keeps what it was told, for asserting the entry was reported. */
function recorder() {
    const errors = [];
    return { errors, error: (m) => errors.push(m), warn: () => {}, info: () => {} };
}

/**
 * Real ids on purpose: names come from `effect.<id>` in i18n, so an invented
 * id would be skipped for having no name, not for the fault under test.
 */
const REAL_IDS = ["christmas", "newyear", "valentines", "easter", "ligo", "halloween", "independence", "lacplesis"];

/** `effects.json` and `palettes.json` in a throwaway directory. */
function catalogue(effects, palettes = { real: ["#0000ff"] }) {
    const dir = mkdtempSync(join(tmpdir(), "huelink-catalogue-"));
    const a = join(dir, "effects.json");
    const b = join(dir, "palettes.json");
    writeFileSync(a, JSON.stringify({ effects }));
    writeFileSync(b, JSON.stringify({ palettes }));
    return { dir, files: [a, b] };
}

test("a `kind` that climbs out of the generator directory is never imported", async () => {
    // `kind` used to go straight into `import(\`./generators/${kind}.mjs\`)`,
    // so a catalogue entry could name any `.mjs` on the disk and have it
    // executed inside zigbee2mqtt's own process, with its broker credentials
    // and its Zigbee adapter.
    const dir = mkdtempSync(join(tmpdir(), "huelink-traversal-"));
    const marker = join(dir, "it-ran");
    // Importing this file is the only thing that can create the marker, so the
    // marker is proof of execution rather than proof of a resolved path.
    writeFileSync(join(dir, "evil.mjs"), `import {writeFileSync} from "node:fs";writeFileSync(${JSON.stringify(marker)},"x");export const create=()=>()=>[];\n`);

    // Built with `relative`, not written by hand: the number of `..` segments
    // depends on where the generators live, and a hardcoded one would stop
    // climbing far enough the moment a directory is added or removed, and
    // would then pass for the wrong reason.
    const kind = relative(join(REPO, "extension/huelink-lib/effects/generators"), join(dir, "evil"));
    assert.match(kind, /\.\./, "the test is only meaningful if the path really climbs out");

    const log = recorder();
    const { files } = catalogue([
        { id: "easter", kind },
        { id: "christmas", kind: "wave", params: { palette: ["#ff0000", "#00ff00"] } },
    ]);
    const loaded = await loadEffects(log, ...files);

    assert.equal(existsSync(marker), false, "the module outside the generator directory was executed");
    assert.deepEqual(
        loaded.map((e) => e.id),
        ["christmas"],
        "the traversing entry must be skipped and the rest of the catalogue must still load",
    );
    assert.equal(log.errors.length, 1, log.errors.join(" | "));
    assert.match(log.errors[0], /Easter|Lieldienas/, "the skipped entry has to be named, or it is unfindable");
});

test("a `kind` that is not a plain generator name is refused before import", async () => {
    // The spellings that are not `../` but are still not a file in there.
    const log = recorder();
    const kinds = ["Wave", "wave.mjs", "wave/../wave", "./wave", "sub/wave", "", "constructor", "toString"];
    const { files } = catalogue(kinds.map((kind, i) => ({ id: REAL_IDS[i], kind })));
    assert.deepEqual(await loadEffects(log, ...files), []);
    assert.equal(log.errors.length, kinds.length, log.errors.join(" | "));
});

test("a malformed colour costs its own effect, not the extension", async () => {
    // FIRST in the catalogue on purpose: `start()` selects `effects[0]`, so
    // before colours were checked at load time a single typo here threw out of
    // `start()` and the extension did not come up at all. Sync, effects and
    // the HA entities all went with it.
    const log = recorder();
    const { files } = catalogue([
        { id: "newyear", kind: "wave", params: { palette: ["#ff0000", "0000ff"] } },
        { id: "ligo", kind: "wave", params: { palette: ["#fff"] } },
        { id: "halloween", kind: "wave", params: { palette: ["#ff0000", 42] } },
        { id: "christmas", kind: "wave", params: { palette: ["#ff0000", "#00FF00"] } },
    ]);
    const loaded = await loadEffects(log, ...files);

    assert.deepEqual(
        loaded.map((e) => e.id),
        ["christmas"],
        "only the effect whose colours are all #rrggbb may survive",
    );
    assert.equal(log.errors.length, 3, log.errors.join(" | "));
    // And the survivor is usable, which is what "skipped, not broken" means.
    const e = new EffectEngine({ effects: loaded, segments: 7, seed: 1, logger: quiet });
    assert.equal(e.select(loaded[0].name), true);
    assert.equal(e.frame(0).length, 7);
});

test("an effect that will not start leaves nothing selected, not a lie", async () => {
    // `selected` used to be assigned before `create()` ran. A generator that
    // threw then left the MQTT state and the HA select naming the new effect
    // while `render` still drew the old one, and nothing visible said which of
    // the two was true.
    const good = (await loadEffects(quiet))[0];
    const log = recorder();
    const boom = {
        id: "boom",
        name: "Boom",
        kind: "wave",
        params: {},
        create: () => {
            throw new Error("nope");
        },
    };
    const e = new EffectEngine({ effects: [good, boom], segments: 7, seed: 1, logger: log });
    assert.equal(e.select(good.name), true);
    const before = e.frame(0);

    assert.equal(e.select("Boom"), false, "a failed start is not a selection");
    assert.equal(e.selected, EFFECT_NONE, `selected was ${e.selected}`);
    assert.equal(e.active, false);
    // The old effect must be GONE, not left running under the new name.
    assert.equal(e.frame(100), null, "a failed start must not leave the previous effect rendering");
    assert.notEqual(before, null, "the previous effect really was running");
    assert.equal(log.errors.length, 1, log.errors.join(" | "));
    assert.match(log.errors[0], /Boom/);
});

test("a config field named after a prototype member is rejected as unknown", () => {
    const dir = mkdtempSync(join(tmpdir(), "huelink-config-"));
    const file = join(dir, "huelink.config.json");
    writeFileSync(file, JSON.stringify({ constructor: "x", toString: 5, segments: 7 }));

    const { config, errors } = loadConfig(file);
    assert.equal(errors.length, 2, errors.join(" | "));
    for (const e of errors) assert.match(e, /unknown field/);
    assert.equal(config.segments, 7, "the real field still works");
});

test("loadConfig names the keys it could not take, so a live reload keeps what runs", () => {
    const dir = mkdtempSync(join(tmpdir(), "huelink-config-"));
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ fps: "7", segments: 7 }));
    assert.deepEqual(loadConfig(bad).invalid, ["fps"]);

    // Half-saved JSON: every key is unknown, none may be applied as a default.
    const broken = join(dir, "broken.json");
    writeFileSync(broken, "{ \"fps\": ");
    assert.deepEqual(loadConfig(broken).invalid, Object.keys(DEFAULTS));
});

// ------------------------------------------------- UDP exposure config ----

test("udpBind and udpAllowFrom are real fields with safe defaults", () => {
    assert.equal(DEFAULTS.udpBind, "0.0.0.0");
    assert.deepEqual(DEFAULTS.udpAllowFrom, []);

    const dir = mkdtempSync(join(tmpdir(), "huelink-udp-"));
    const file = join(dir, "huelink.config.json");
    writeFileSync(file, JSON.stringify({ udpBind: "127.0.0.1", udpAllowFrom: ["10.0.0.5", "10.0.0.6"] }));

    const { config, errors } = loadConfig(file);
    assert.deepEqual(errors, []);
    assert.equal(config.udpBind, "127.0.0.1");
    assert.deepEqual(config.udpAllowFrom, ["10.0.0.5", "10.0.0.6"]);
});

test("a malformed allow list is reported and falls back to the default", () => {
    const dir = mkdtempSync(join(tmpdir(), "huelink-udp-bad-"));
    const file = join(dir, "huelink.config.json");
    writeFileSync(file, JSON.stringify({ udpAllowFrom: "10.0.0.5", udpBind: 42 }));

    const { config, errors } = loadConfig(file);
    assert.equal(errors.length, 2, errors.join(" | "));
    assert.deepEqual(config.udpAllowFrom, []);
    assert.equal(config.udpBind, "0.0.0.0");
});

test("the defaults are not shared between configs", () => {
    // `{ ...DEFAULTS }` copies the reference, so an unfrozen default array
    // would be one array every config in the process could push onto.
    const a = loadConfig(join(tmpdir(), "huelink-missing-a.json")).config;
    const b = loadConfig(join(tmpdir(), "huelink-missing-b.json")).config;
    assert.throws(() => a.udpAllowFrom.push("10.0.0.1"), TypeError);
    assert.deepEqual(b.udpAllowFrom, []);
});
