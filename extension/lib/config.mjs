/**
 * Configuration outside the code: everything installation-specific lives in
 * `huelink.config.json`, so the code is identical for everyone.
 *
 * Looked up as `HUELINK_CONFIG` (full path, for tools and tests), else
 * `<z2m data>/huelink.config.json`, next to `configuration.yaml`.
 *
 * The second path is resolved from THIS file's location, not `process.cwd()`:
 * z2m loads external files by copying them to a temp file in the same
 * directory, so relative paths survive. Two levels up is the data directory,
 * and the same line lands on the repo root during development.
 *
 * A missing file means defaults; an invalid field is loud. See docs/DESIGN.md.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { MAX_FPS } from "./pacer.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Locales with a `lib/i18n/<code>.json`. Here so `i18n` imports this, not the reverse. */
export const LOCALES = ["en", "lv"];

/**
 * Deliberately neutral: these describe an ordinary Hue gradient strip, not one
 * particular house. Each field is explained in `huelink.config.example.json`,
 * since JSON has no comments.
 */
export const DEFAULTS = {
    /** z2m device name (friendly_name). This is also the power switch. */
    device: "Hue Gradient Strip",
    /** Gradient segment count; LCX002 has 7. */
    segments: 7,
    /** UDP port Hyperion's udpraw output targets; must match the Hyperion side. */
    udpPort: 19447,
    /**
     * Address the UDP listener binds to. `0.0.0.0` is every interface, which is
     * what a Hyperion on another machine needs. Narrow it to one address, or to
     * `127.0.0.1` when Hyperion runs alongside z2m, and the port stops existing
     * for the rest of the network.
     */
    udpBind: "0.0.0.0",
    /**
     * Addresses allowed to send frames. Empty means "anyone who can reach the
     * port", which is the only default that cannot break an existing setup.
     * List your Hyperion host and everything else is dropped unread.
     *
     * Frozen because `{ ...DEFAULTS }` copies the reference, so every config
     * built from the defaults would otherwise share one array.
     */
    udpAllowFrom: Object.freeze([]),
    /**
     * Loop period, NOT the frame rate: how many frames actually go out is the
     * pacer's decision. The loop runs faster than frames so a scene change is
     * noticed immediately. See docs/PACING.md.
     */
    tickMs: 20,
    /** Quiet window after start, so echoes from the previous life can finish. */
    startSettleMs: 2000,
    /** Target frame rate for sync and effects. Upper bound is `Pacer.MAX_FPS`. */
    fps: MAX_FPS,
    /** Share of wall time sync may keep the coordinator busy (0..1). */
    occupancyBudget: 0.35,
    /** How long a source stays live without a UDP packet. */
    sourceTtlMs: 1000,
    /** Last segment of the MQTT topic (base_topic/huelink). */
    name: "huelink",
    /** Language for human-visible strings; see lib/i18n/. */
    locale: "en",
};

/**
 * What each field may contain. The ranges are wide on purpose: this is a typo
 * catcher, not the safety limit (the pacer holds that). `fps: "7"` and
 * `segments: 0` deserve a log line; `fps: 6` does not.
 */
const SPEC = {
    device: { kind: "string" },
    segments: { kind: "integer", min: 1, max: 64 },
    udpPort: { kind: "integer", min: 1, max: 65535 },
    udpBind: { kind: "string" },
    udpAllowFrom: { kind: "stringList" },
    tickMs: { kind: "integer", min: 1, max: 1000 },
    startSettleMs: { kind: "integer", min: 0, max: 60000 },
    fps: { kind: "number", min: 1, max: MAX_FPS },
    occupancyBudget: { kind: "number", min: 0.01, max: 1 },
    sourceTtlMs: { kind: "integer", min: 50, max: 600000 },
    name: { kind: "string" },
    locale: { kind: "enum", values: LOCALES },
};

/** Human-readable problem, or `null` if the value is fine. */
function validate(key, value) {
    const spec = SPEC[key];
    const shown = JSON.stringify(value);
    if (spec.kind === "string") {
        if (typeof value !== "string" || value.trim() === "") return `'${key}' must be a non-empty string, got ${shown}`;
        return null;
    }
    if (spec.kind === "stringList") {
        if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || v.trim() === "")) {
            return `'${key}' must be a list of non-empty strings, got ${shown}`;
        }
        return null;
    }
    if (spec.kind === "enum") {
        if (!spec.values.includes(value)) return `'${key}' must be one of ${spec.values.join(", ")}, got ${shown}`;
        return null;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
        return `'${key}' must be a number between ${spec.min} and ${spec.max}, got ${shown}`;
    }
    if (spec.kind === "integer" && !Number.isInteger(value)) {
        return `'${key}' must be a whole number between ${spec.min} and ${spec.max}, got ${shown}`;
    }
    if (value < spec.min || value > spec.max) {
        return `'${key}' must be between ${spec.min} and ${spec.max}, got ${shown}`;
    }
    return null;
}

/**
 * Read the file and merge it over the defaults.
 * Separate from module load so tests can call it with another path.
 *
 * @param {string|null} file  full path, or `null` for automatic
 * @returns {{config: object, errors: string[], path: string|null}}
 */
export function loadConfig(file = null) {
    const path = file ?? process.env.HUELINK_CONFIG ?? join(resolve(HERE, "..", ".."), "huelink.config.json");
    const errors = [];

    let raw;
    try {
        raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
        // A missing file is a normal state; broken JSON is not.
        if (e.code !== "ENOENT") errors.push(`${path}: ${e.message}, using defaults for every field`);
        return { config: { ...DEFAULTS }, errors, path: e.code === "ENOENT" ? null : path };
    }

    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        errors.push(`${path}: top level must be a JSON object, using defaults for every field`);
        return { config: { ...DEFAULTS }, errors, path };
    }

    const config = { ...DEFAULTS };
    for (const [key, value] of Object.entries(raw)) {
        // `_comment` and friends are the user's own notes, not fields.
        if (key.startsWith("_")) continue;
        // `hasOwn`, not `in`: `in` walks the prototype, so a field called
        // "constructor" or "toString" would be accepted as known and then
        // validated against a function. Same hole as `MODE_BY_LABEL` had.
        if (!Object.hasOwn(SPEC, key)) {
            errors.push(`${path}: unknown field '${key}', ignored`);
            continue;
        }
        const problem = validate(key, value);
        if (problem) {
            errors.push(`${path}: ${problem}, using default ${JSON.stringify(DEFAULTS[key])}`);
            continue;
        }
        config[key] = value;
    }
    return { config, errors, path };
}

const loaded = loadConfig();

/** One parsed configuration object for the whole process. */
export const CONFIG = loaded.config;
/** Where it was read from, or `null` if there was no file. */
export const CONFIG_PATH = loaded.path;
/**
 * Validation errors. `huelink.mjs` `start()` prints them, because that is
 * where the z2m logger exists; this file loads earlier and cannot see it.
 */
export const CONFIG_ERRORS = loaded.errors;
