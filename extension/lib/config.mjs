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

import { BURST_MAX_FPS, FPS_CEILING, NOMINAL_SEND_MS, DEFAULTS as PACER } from "./pacer.mjs";

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
    /** Target frame rate for sync and effects. Upper bound is `maxFps`. */
    fps: PACER.fps,
    /**
     * Highest fps the slider and MQTT will accept. The default comes from a
     * send cost measured on a SHARED coordinator; a dedicated one is a
     * different machine and may honestly carry more. See README, "Separate
     * coordinator". Raising this does not raise `fps`: it only permits it.
     */
    maxFps: PACER.maxFps,
    /**
     * Frames the pacer may send in any 100 ms. A hard instantaneous ceiling,
     * so it is also an fps ceiling: 2 per 100 ms is 20 fps, and anything above
     * that needs 3. Home Assistant owns it afterwards (`huelink_duty`); this
     * is only where it starts.
     */
    dutyCap: PACER.maxPerWindow,
    /**
     * Pacer knobs. Taken from the pacer's own defaults rather than written out
     * again: these are its numbers, measured in docs/PACING.md, and a second
     * copy here would be free to disagree with the engine that uses them. The
     * file only decides whether to OVERRIDE them.
     */
    occupancyBudget: PACER.occupancyBudget,
    smoothingFactor: PACER.smoothingFactor,
    bigChangeThreshold: PACER.bigChangeThreshold,
    fastSmoothingMs: PACER.fastSmoothingMs,
    maxFastPerSec: PACER.maxFastPerSec,
    burstFps: PACER.burstFps,
    burstMaxMs: PACER.burstMaxMs,
    burstCreditMs: PACER.burstCreditMs,
    burstRefill: PACER.burstRefill,
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
    // Not `maxFps` but `FPS_CEILING`: what this file may ASK for is bounded by
    // the absolute limit, and asking for more than `maxFps` is a question
    // about consistency rather than about typing, answered by a warning below
    // instead of by throwing the value away.
    fps: { kind: "number", min: 1, max: FPS_CEILING },
    maxFps: { kind: "integer", min: 1, max: FPS_CEILING },
    dutyCap: { kind: "integer", min: 1, max: 10 },
    occupancyBudget: { kind: "number", min: 0.01, max: 1 },
    // Pacer knobs. The bounds below are wider than the pacer's `LIMITS`
    // because they are two different jobs: this one catches `"0.5"` and a
    // misplaced decimal point, the pacer's clamp decides what the engine will
    // actually run. A value between the two is taken, clamped, and the
    // published `pacer` stats then show what it really became.
    smoothingFactor: { kind: "number", min: 0.5, max: 4 },
    bigChangeThreshold: { kind: "number", min: 0.5, max: 100 },
    fastSmoothingMs: { kind: "integer", min: 0, max: 2000 },
    maxFastPerSec: { kind: "integer", min: 0, max: 50 },
    burstFps: { kind: "integer", min: 0, max: 4 * BURST_MAX_FPS },
    burstMaxMs: { kind: "integer", min: 0, max: 30000 },
    burstCreditMs: { kind: "integer", min: 0, max: 60000 },
    burstRefill: { kind: "number", min: 0, max: 2 },
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
 * Where the config file would be, whether or not it exists.
 *
 * `CONFIG_PATH` answers a different question ("where was it read from", `null`
 * when there is none), and the watcher needs this one: a file created after
 * startup has to be noticed too, and you cannot watch `null`.
 */
export function configFile(file = null) {
    return file ?? process.env.HUELINK_CONFIG ?? join(resolve(HERE, "..", ".."), "huelink.config.json");
}

/**
 * Fields that are each valid but cannot all be true at once.
 *
 * These are not errors: every value is within its own range, and the pacer
 * will do something reasonable with them. They are the cases where what it
 * does is quietly less than what was asked for, which is the worst way for a
 * limit to work. Asking for 25 fps with a duty cap of 2 gives 20, and without
 * this it gives 20 in silence, leaving the dial that did nothing looking like
 * the dial that did.
 *
 * Both ceilings are arithmetic, not opinion:
 *   duty cap:  dutyCap frames per windowMs  ->  dutyCap * 1000 / windowMs fps
 *   budget:    occupancyBudget of each second / cost of one frame
 *
 * The budget line uses the measured 51 ms from docs/PACING.md as its estimate.
 * The real price is this coordinator's, visible as `avgSendMs` in the
 * published `pacer` stats, so the warning says what it assumed.
 */
export function consistency(config) {
    const warnings = [];
    const { fps, maxFps, dutyCap, occupancyBudget } = config;
    const windowMs = PACER.windowMs;

    if (fps > maxFps) {
        warnings.push(`'fps' is ${fps} but 'maxFps' is ${maxFps}: the stream will run at ${maxFps}`);
    }
    const asked = Math.min(fps, maxFps);

    const dutyFps = (dutyCap * 1000) / windowMs;
    if (asked > dutyFps) {
        const needed = Math.ceil((asked * windowMs) / 1000);
        warnings.push(
            `'fps' ${asked} is above the ${dutyFps} fps that 'dutyCap' ${dutyCap} per ${windowMs} ms can pass: ` +
                `raise 'dutyCap' to ${needed}, or the extra frames are dropped`,
        );
    }

    const budgetFps = Math.round(((occupancyBudget * 1000) / NOMINAL_SEND_MS) * 10) / 10;
    if (asked > budgetFps) {
        warnings.push(
            `'fps' ${asked} is above the ~${budgetFps} fps that 'occupancyBudget' ${occupancyBudget} buys at ` +
                `${NOMINAL_SEND_MS} ms per frame: raise the budget, or expect frames skipped as 'skippedDuty'. ` +
                `Check 'avgSendMs' in the published pacer stats for this coordinator's real price`,
        );
    }
    return warnings;
}

/**
 * Read the file and merge it over the defaults.
 * Separate from module load so tests can call it with another path.
 *
 * @param {string|null} file  full path, or `null` for automatic
 * @returns {{config: object, errors: string[], warnings: string[], path: string|null}}
 */
export function loadConfig(file = null) {
    const path = configFile(file);
    const errors = [];

    // Defaults alone never contradict each other, and a test holds that, so
    // the early returns below skip the consistency pass rather than carry a
    // result everyone already knows.
    let raw;
    try {
        raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
        // A missing file is a normal state; broken JSON is not.
        if (e.code !== "ENOENT") errors.push(`${path}: ${e.message}, using defaults for every field`);
        return { config: { ...DEFAULTS }, errors, warnings: [], path: e.code === "ENOENT" ? null : path };
    }

    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        errors.push(`${path}: top level must be a JSON object, using defaults for every field`);
        return { config: { ...DEFAULTS }, errors, warnings: [], path };
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
    return { config, errors, warnings: consistency(config), path };
}

const loaded = loadConfig();

/** One parsed configuration object for the whole process. */
export const CONFIG = loaded.config;
/** Where it was read from, or `null` if there was no file. */
export const CONFIG_PATH = loaded.path;
/** Where it would be read from. Always a path, even with no file. */
export const CONFIG_FILE = configFile();
/**
 * Validation errors. `huelink.mjs` `start()` prints them, because that is
 * where the z2m logger exists; this file loads earlier and cannot see it.
 */
export const CONFIG_ERRORS = loaded.errors;
/**
 * Combinations that are individually valid and jointly impossible. Printed
 * next to the errors, one level quieter: nothing was thrown away, the house
 * just will not deliver what the file asks for.
 */
export const CONFIG_WARNINGS = loaded.warnings;
