/**
 * i18n PARITY: with `locale: "lv"` the code may say only what the hardcoded
 * version said before the strings were pulled out.
 *
 * These strings are values on the wire (HA `select` options, the `huelink_mode`
 * enum, `huelink_status`), so one translated word silently breaks automations.
 * Compared against `fixtures/live-lv.json`, a frozen print of the live
 * deployment. Why that fixture and why dynamic imports: `docs/TESTING.md`.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");

const LIVE = JSON.parse(readFileSync(join(HERE, "fixtures", "live-lv.json"), "utf8"));

// The locale is set through the same path a human uses (a config file), not a
// test-only back door: if config loading breaks, this test must break too.
process.env.HUELINK_CONFIG = join(HERE, "fixtures", "lv.config.json");

const { CONFIG } = await import(join(REPO, "extension/lib/config.mjs"));
const { LOCALE, makeTranslator } = await import(join(REPO, "extension/lib/i18n/index.mjs"));
const { MODE_LABEL, FIELDS } = await import(join(REPO, "extension/lib/huelink-ui.mjs"));
const { EFFECT_NONE, loadEffects } = await import(join(REPO, "extension/lib/effects/index.mjs"));

const t = makeTranslator("lv");
const quiet = { error: () => {}, warn: () => {}, info: () => {} };
const effects = await loadEffects(quiet);

/*
 * Effect ids added to the catalogue AFTER the golden snapshot was taken.
 *
 * The fixture is frozen on purpose and must not be "fixed" by pasting in new
 * output; that is how a parity test quietly stops testing parity. But the
 * catalogue is allowed to grow, so new ids are named here instead: the frozen
 * names still have to be present, unchanged and in the same order, and every id
 * on this list has to really exist, so it cannot be used to hide a deletion.
 */
const ADDED_SINCE_SNAPSHOT = ["wakeup"];
const frozen = (list, key) => list.filter((e) => !ADDED_SINCE_SNAPSHOT.includes(e.id)).map((e) => e[key]);

test("the config really did switch the locale", () => {
    assert.equal(CONFIG.locale, "lv");
    assert.equal(LOCALE, "lv");
});

test("mode names are unchanged (HA select values and the huelink_mode enum)", () => {
    assert.deepEqual(MODE_LABEL, LIVE.modeLabel);
    const mode = FIELDS.find((f) => f.key === "huelink_mode");
    assert.deepEqual(mode.values, LIVE.modeValues);
});

test("z2m field labels and descriptions are unchanged", () => {
    const got = Object.fromEntries(FIELDS.map((f) => [f.key, { label: f.label, description: f.description }]));
    assert.deepEqual(got, LIVE.fields);
});

test("status lines are unchanged", () => {
    assert.equal(t("status.tripped", { mode: "Sync" }), LIVE.status.tripped);
    assert.equal(t("status.waitingTv"), LIVE.status.waitingTv);
    assert.equal(t("status.off"), LIVE.status.off);
    assert.equal(t("status.effect", { effect: "Noskaņa: Fejas" }), LIVE.status.effect);
    assert.equal(t("status.sync"), LIVE.status.sync);
    // The last `status()` branch returns the mode name, not a string of its own.
    assert.equal(MODE_LABEL.light, LIVE.status.light);
});

test("HA discovery entity names are unchanged", () => {
    for (const [key, expected] of Object.entries(LIVE.ha)) {
        assert.equal(t(`ha.${key}`), expected, `ha.${key}`);
    }
});

test("the converter log line is unchanged", () => {
    assert.equal(t("log.exposesAdded", { count: 8, model: "929002994101", settable: 4 }), LIVE.exposesAdded);
});

test("effect names and their order are unchanged (HA select options)", () => {
    assert.equal(EFFECT_NONE, LIVE.effectNone);
    assert.deepEqual(frozen(effects, "name"), LIVE.effectNames);
});

test("effect ids were left alone (renaming a palette must not touch them)", () => {
    assert.deepEqual(frozen(effects, "id"), LIVE.effectIds);
});

test("every id claimed as a new effect really is one", () => {
    const ids = effects.map((e) => e.id);
    for (const id of ADDED_SINCE_SNAPSHOT) assert.ok(ids.includes(id), `${id} is on the list but not loaded`);
});

test("every effect loaded: none dropped out over a renamed palette", () => {
    assert.equal(effects.length, LIVE.effectIds.length + ADDED_SINCE_SNAPSHOT.length);
    for (const e of effects) assert.equal(typeof e.create, "function", e.id);
});

/*
 * Below is no longer parity but the hygiene without which parity would collapse
 * silently: a missing key makes `t()` return the key itself.
 */

const en = JSON.parse(readFileSync(join(REPO, "extension/lib/i18n/en.json"), "utf8"));
const lv = JSON.parse(readFileSync(join(REPO, "extension/lib/i18n/lv.json"), "utf8"));

test("both locales carry exactly the same set of keys", () => {
    assert.deepEqual(Object.keys(lv).sort(), Object.keys(en).sort());
});

test("en.json contains no Latvian letters", () => {
    const bad = Object.entries(en).filter(([, v]) => /[āčēģīķļņōŗšūž]/i.test(v));
    assert.deepEqual(bad, []);
});

test("every key the code uses is known to both locales", () => {
    // Scraped from the source, not a hand-written list: that would go stale quietly.
    const files = [
        "extension/huelink.mjs",
        "extension/lib/huelink-ui.mjs",
        "extension/lib/effects/index.mjs",
        "converter/huelink-exposes.mjs",
    ];
    const used = new Set();
    for (const f of files) {
        const src = readFileSync(join(REPO, f), "utf8");
        for (const m of src.matchAll(/\bt\(\s*"([a-zA-Z][\w.]*)"/g)) used.add(m[1]);
    }
    assert.ok(used.size > 30, `only ${used.size} keys found, the scraper is broken`);
    const missing = [...used].filter((k) => !(k in en));
    assert.deepEqual(missing, []);
});

test("every effect has an English name (that is the fallback locale)", () => {
    const doc = JSON.parse(readFileSync(join(REPO, "extension/lib/effects/effects.json"), "utf8"));
    const bad = doc.effects.filter((e) => typeof e.name?.en !== "string" || e.name.en.trim() === "");
    assert.deepEqual(
        bad.map((e) => e.id),
        [],
    );
});

test("with 'en' the effect names really change and stay unique", async () => {
    const names = [];
    const doc = JSON.parse(readFileSync(join(REPO, "extension/lib/effects/effects.json"), "utf8"));
    for (const e of doc.effects) names.push(e.name.en);
    assert.equal(new Set(names).size, names.length);
    for (const n of names) assert.ok(!/[āčēģīķļņōŗšūž]/i.test(n), n);
});
