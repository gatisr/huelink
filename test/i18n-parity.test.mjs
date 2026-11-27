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

const { CONFIG } = await import(join(REPO, "extension/huelink-lib/config.mjs"));
const { LOCALE, makeTranslator } = await import(join(REPO, "extension/huelink-lib/i18n/index.mjs"));
const { MODE_LABEL, FIELDS } = await import(join(REPO, "extension/huelink-lib/huelink-ui.mjs"));
const { EFFECT_NONE, loadEffects } = await import(join(REPO, "extension/huelink-lib/effects/index.mjs"));

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

/*
 * The same escape hatch for `FIELDS`, and for the same reason: the device page
 * is allowed to grow new controls, but not to reword the ones already in the
 * fixture.
 *
 * It buys exactly one freedom, adding a field. It does not license editing a
 * frozen description: a reworded one still fails here, which is deliberate even
 * for a string nobody matches on, because "it is only documentation" is how the
 * first wire value gets edited too. The test below proves every name on this
 * list is a real field, so it cannot be used to hide a deletion either.
 */
const FIELDS_ADDED_SINCE_SNAPSHOT = [
    "huelink_budget",
    "huelink_smoothing",
    "huelink_cut_threshold",
    "huelink_cut_ms",
    "huelink_cut_per_sec",
    "huelink_preset",
    "huelink_saturation",
];

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
    const got = Object.fromEntries(
        FIELDS.filter((f) => !FIELDS_ADDED_SINCE_SNAPSHOT.includes(f.key)).map((f) => [
            f.key,
            { label: f.label, description: f.description },
        ]),
    );
    assert.deepEqual(got, LIVE.fields);
});

test("every field claimed as new really is one", () => {
    const keys = FIELDS.map((f) => f.key);
    for (const key of FIELDS_ADDED_SINCE_SNAPSHOT) {
        assert.ok(keys.includes(key), `${key} is on the list but not in FIELDS`);
        assert.ok(!(key in LIVE.fields), `${key} is in the frozen fixture, so it is not new`);
    }
});

test("the new fields are translated too, not just present", () => {
    for (const key of FIELDS_ADDED_SINCE_SNAPSHOT) {
        const field = FIELDS.find((f) => f.key === key);
        // A missing i18n key makes `t()` hand back the key itself, which is a
        // perfectly valid-looking string and would sail through every other
        // check here. These are the Latvian strings, so the English word
        // "HueLink" aside, a label that is still an ASCII dotted key is the
        // tell.
        for (const part of ["label", "description"]) {
            assert.ok(!/^field\.[\w.]+$/.test(field[part]), `${key} ${part} is an untranslated key`);
            assert.ok(field[part].length > 20, `${key} ${part} is too short to be a real ${part}`);
        }
    }
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

const en = JSON.parse(readFileSync(join(REPO, "extension/huelink-lib/i18n/en.json"), "utf8"));
const lv = JSON.parse(readFileSync(join(REPO, "extension/huelink-lib/i18n/lv.json"), "utf8"));

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
        "extension/huelink-lib/huelink-ui.mjs",
        "extension/huelink-lib/effects/index.mjs",
        "extension/huelink-lib/presets.mjs",
        "extension/huelink-lib/custom.mjs",
        "extension/huelink-lib/discovery.mjs",
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

test("every catalogue effect has a name in both locales, English included", () => {
    const doc = JSON.parse(readFileSync(join(REPO, "extension/huelink-lib/effects/effects.json"), "utf8"));
    const ids = doc.effects.map((e) => e.id);
    assert.equal(new Set(ids).size, ids.length, "ids must be unique");
    for (const id of ids) {
        for (const [loc, table] of [["en", en], ["lv", lv]]) {
            assert.ok(
                typeof table[`effect.${id}`] === "string" && table[`effect.${id}`].trim() !== "",
                `effect.${id} missing in ${loc}.json`,
            );
        }
    }
});

test("no orphan effect.<id> keys, and English names are unique and plain English", () => {
    const doc = JSON.parse(readFileSync(join(REPO, "extension/huelink-lib/effects/effects.json"), "utf8"));
    const ids = new Set(doc.effects.map((e) => e.id));
    const keys = Object.keys(en).filter((k) => k.startsWith("effect.") && k !== "effect.none");
    assert.deepEqual(
        keys.filter((k) => !ids.has(k.slice("effect.".length))),
        [],
    );
    const names = keys.map((k) => en[k]);
    assert.equal(new Set(names).size, names.length);
});
