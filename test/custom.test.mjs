/**
 * The custom effect, the colour read back from the strip, and the saved state file.
 */
import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
process.env.HUELINK_CONFIG = join(HERE, "fixtures", "entities.config.json");

const { CUSTOM_STYLES, CustomEffect, MAX_OWN_COLOURS, loadState, parseColours, saveState, stateFile } = await import(
    "../extension/huelink-lib/custom.mjs"
);
const { EffectEngine, loadEffects } = await import("../extension/huelink-lib/effects/index.mjs");
const { dim, miredToXy, rgbToXy, xyToHex } = await import("../extension/huelink-lib/huepack.mjs");

const quiet = { info() {}, warning() {}, error() {} };
const effects = await loadEffects(quiet);

test("own colours: separators and case are forgiven, anything else is refused", () => {
    assert.deepEqual(parseColours("#FF0000, #00ff88;#0000ff"), ["#ff0000", "#00ff88", "#0000ff"]);
    assert.deepEqual(parseColours(""), []);
    for (const bad of ["red", "#fff", "ff0000", "#ff0000 nope", Array(MAX_OWN_COLOURS + 1).fill("#ffffff").join(" ")]) {
        assert.equal(parseColours(bad), null, bad);
    }
});

test("every style runs with own colours, a borrowed palette and no colours at all", () => {
    const custom = new CustomEffect(effects);
    // `t` returns the key itself for a missing translation.
    for (const label of [...custom.styleOptions, custom.ownLabel, custom.entry.name]) assert.ok(!/^(style|custom)\./.test(label), label);
    assert.deepEqual(
        custom.styles.map((s) => s.kind),
        CUSTOM_STYLES,
        "every style has a catalogue effect to take its generator from",
    );
    const engine = new EffectEngine({ effects: [...effects, custom.entry], segments: 7, seed: 1, logger: quiet });
    const palettes = [() => custom.setOwn("#ff0000"), () => custom.setOwn("#ff0000 #00ff00 #0000ff"), () => custom.setOwn(""), () => custom.setColours(custom.sources[0].name)];
    for (const label of custom.styleOptions) {
        for (const use of palettes) {
            custom.setColours(null);
            assert.ok(use());
            assert.ok(custom.setStyle(label));
            assert.ok(engine.select(custom.entry.name), `${label} did not start`);
            let lit = false;
            for (let i = 0; i < 100; i++) {
                const frame = engine.frame(1000 + i * 100);
                assert.equal(frame.length, 7);
                for (const c of frame) for (const v of [c.r, c.g, c.b]) assert.ok(Number.isInteger(v) && v >= 0 && v <= 255, `${label}: ${JSON.stringify(c)}`);
                lit ||= frame.some((c) => c.r + c.g + c.b > 0);
            }
            assert.ok(lit, `${label} stayed black for 10 s`);
        }
    }
});

test("an unknown style or colour source changes nothing", () => {
    const custom = new CustomEffect(effects);
    const before = JSON.stringify(custom.snapshot());
    assert.equal(custom.setStyle("constructor"), false);
    assert.equal(custom.setColours("No Such Effect"), false);
    assert.equal(custom.setOwn("#12"), false);
    assert.equal(JSON.stringify(custom.snapshot()), before);
});

test("adding a colour switches to the own list and stops when it is full", () => {
    const custom = new CustomEffect(effects);
    for (let i = 0; i < MAX_OWN_COLOURS; i++) assert.ok(custom.addOwn("#102030"));
    assert.equal(custom.addOwn("#ffffff"), false);
    assert.equal(custom.colourLabel, custom.ownLabel);
    assert.equal(custom.entry.params.palette.length, MAX_OWN_COLOURS);
});

test("a snapshot restores the same effect, and a broken one is ignored", () => {
    const a = new CustomEffect(effects);
    a.setStyle("flame");
    a.setOwn("#ff0000 #00ff00");
    a.setColours(null);
    const b = new CustomEffect(effects);
    b.restore(JSON.parse(JSON.stringify(a.snapshot())));
    assert.deepEqual(b.snapshot(), a.snapshot());
    assert.deepEqual(b.entry.params, { palette: ["#ff0000", "#00ff00"] });
    const before = JSON.stringify(b.snapshot());
    for (const junk of [null, 5, "x", { style: "nope", source: "nope", own: "zzz" }]) b.restore(junk);
    assert.equal(JSON.stringify(b.snapshot()), before);
});

test("a colour read back from xy is the colour that was set", () => {
    for (const [r, g, b] of [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 128, 0], [255, 255, 255], [40, 255, 200]]) {
        const { x, y } = rgbToXy(r, g, b);
        const hex = xyToHex(x, y);
        const got = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
        for (let i = 0; i < 3; i++) assert.ok(Math.abs(got[i] - [r, g, b][i]) <= 2, `${[r, g, b]} came back as ${hex}`);
    }
    // Brightness is not in xy: a dim colour comes back at full brightness.
    const dark = rgbToXy(60, 0, 0);
    assert.equal(xyToHex(dark.x, dark.y), "#ff0000");
});

test("colour temperature lands on warm and cool white", () => {
    const d65 = miredToXy(1e6 / 6500);
    assert.ok(Math.abs(d65.x - 0.3127) < 0.005 && Math.abs(d65.y - 0.329) < 0.01, JSON.stringify(d65));
    const warm = xyToHex(...Object.values(miredToXy(370))); // 2700 K
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(warm.slice(i, i + 2), 16));
    assert.ok(r === 255 && g > b && b < 200, warm);
});

test("dim scales every channel and leaves full brightness untouched", () => {
    const frame = [{ r: 200, g: 100, b: 0 }];
    assert.equal(dim(frame, 1), frame);
    assert.deepEqual(dim(frame, 0.5), [{ r: 100, g: 50, b: 0 }]);
});

test("the state file round-trips, and a broken one costs nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "huelink-state-"));
    try {
        const file = join(dir, "huelink.state.json");
        const errors = [];
        const logger = { error: (m) => errors.push(m) };
        assert.equal(loadState(file, logger), null, "no file is a normal state");
        assert.deepEqual(errors, []);
        saveState(file, JSON.stringify({ preset: "Calm" }), logger);
        assert.deepEqual(loadState(file, logger), { preset: "Calm" });
        assert.equal(JSON.parse(readFileSync(file, "utf8")).preset, "Calm");
        for (const junk of ["{half", "[1]", "null"]) {
            writeFileSync(file, junk);
            assert.equal(loadState(file, logger), null, junk);
        }
        assert.equal(errors.length, 3, "each unreadable file is said out loud");
        saveState(join(dir, "missing-dir", "x.json"), "{}", logger);
        assert.equal(errors.length, 4, "a failed write is logged, not thrown");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("tools and tests get no state file unless they ask for one", () => {
    assert.equal(stateFile(), null);
    process.env.HUELINK_STATE = "/tmp/x.json";
    assert.equal(stateFile(), "/tmp/x.json");
    process.env.HUELINK_STATE = "";
    assert.equal(stateFile(), null);
    delete process.env.HUELINK_STATE;
});
