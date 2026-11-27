/**
 * Shared boundary between `huelink.mjs` (publishes values) and
 * `converter/huelink-exposes.mjs` (declares fields). Names, ranges and
 * descriptions live here only. Ranges come from `pacer.mjs` LIMITS and the fps
 * ceiling from the config, because the engine clamps to them anyway. The
 * `huelink_` prefix is mandatory: the strip already has `effect` and `identify`.
 */

import { CONFIG } from "./config.mjs";
import { LIMITS } from "./pacer.mjs";
import { SATURATION_PCT } from "./huepack.mjs";
import { loadPresets } from "./presets.mjs";
import { t } from "./i18n/index.mjs";

/** The fps slider follows the configured ceiling (read once: changing it needs a z2m restart). Min is 2 unless the ceiling is lower. */
const FPS_MAX = CONFIG.maxFps;
const FPS_MIN = Math.min(2, FPS_MAX);

/** Mode names: HA select, z2m enum and status line share this list. */
export const MODE_LABEL = {
    light: t("mode.light"),
    effect: t("mode.effect"),
    sync: t("mode.sync"),
};

/** Label -> mode. A `Map`, not an object: `"constructor"` from MQTT must not resolve. */
export const MODE_BY_LABEL = new Map(Object.entries(MODE_LABEL).map(([mode, label]) => [label, mode]));

/** `activity` values: the status line as fixed words, for card conditions and automations. Never translated. */
export const ACTIVITIES = ["off", "light", "effect", "sync", "waiting", "tripped", "gave_up"];

/**
 * Loaded at import so extension and converter share one list (editing
 * `presets.json` needs a restart). This module also loads in z2m's converter
 * process, which has no extension logger, so problems are collected for the
 * extension to log.
 */
export const PRESET_PROBLEMS = [];
export const PRESETS = loadPresets({ error: (m) => PRESET_PROBLEMS.push(m) });

/**
 * The one preset that is not in the catalogue: whatever the sliders were last
 * set to by hand. Fixed English, like the catalogue names. `loadPresets`
 * refuses a catalogue entry of this name.
 */
export const CUSTOM_PRESET = "Custom";
/** Preset select values: the catalogue, then Custom. */
export const PRESET_OPTIONS = [...PRESETS.map((p) => p.name), CUSTOM_PRESET];

/**
 * HA entity category of each control, one table for the z2m definition and our
 * discovery payloads. Keys are short names; `categoryOf()` accepts either form.
 * No category = main control; `config` = setting; `diagnostic` = reading.
 */
export const MAIN = [
    "mode",
    "brightness",
    "status",
    "preset",
    "saturation",
    "effect",
    "effect_speed",
    "custom_style",
    "custom_colours",
    "custom_own",
    "custom_colour_add",
    "custom_colour_clear",
];

/** Settings, kept off the main list so the few everyday controls stay visible. */
export const CONFIGURATION = [
    "fps",
    "delta",
    "duty",
    "budget",
    "smoothing",
    "cut_threshold",
    "cut_ms",
    "cut_per_sec",
];

/**
 * Which HA device a control sits on. One device held sync tuning and effect
 * setup in one alphabetical list; the device page has no other grouping, so
 * they are two more devices linked to the main one. Anything not listed is on
 * the main device. Entity ids do not depend on this.
 */
export const SYNC_DEVICE = ["preset", "saturation", "fps", "budget", "smoothing", "cut_threshold", "cut_ms", "cut_per_sec", "fps_real", "occupancy", "fps_ceiling"];
export const EFFECTS_DEVICE = ["effect", "effect_speed", "custom_style", "custom_colours", "custom_own", "custom_colour_add", "custom_colour_clear"];

/** Readings; read-only entities cannot be `config` (HA drops the whole discovery message). */
export const DIAGNOSTIC = ["version", "fps_real", "dropped", "occupancy", "fps_ceiling", "breaker", "activity"];

const CATEGORY = new Map([
    ...MAIN.map((name) => [name, undefined]),
    ...CONFIGURATION.map((name) => [name, "config"]),
    ...DIAGNOSTIC.map((name) => [name, "diagnostic"]),
]);

/** Category of one control. Throws on an unclassified name so a new control cannot skip the decision. */
export function categoryOf(name) {
    const short = name.startsWith("huelink_") ? name.slice("huelink_".length) : name;
    if (!CATEGORY.has(short)) {
        throw new Error(`huelink: no HA category declared for "${name}" (add it in huelink-lib/huelink-ui.mjs)`);
    }
    return CATEGORY.get(short);
}

/** z2m `access` bits (numbers, so the extension need not import zhc): 1 = read only, 3 = read/write. */
export const ACCESS_STATE = 1;
export const ACCESS_STATE_SET = 3;

/** Pacer knobs exposed as sliders: one row drives the z2m field, HA entity and command key (`huelink_<command>`). */
export const KNOBS = [
    { knob: "smoothingFactor", command: "smoothing", i18n: "smoothing", icon: "mdi:blur" },
    { knob: "bigChangeThreshold", command: "cut_threshold", i18n: "cutThreshold", icon: "mdi:content-cut" },
    { knob: "fastSmoothingMs", command: "cut_ms", i18n: "cutMs", unit: "ms", icon: "mdi:timer-outline" },
    { knob: "maxFastPerSec", command: "cut_per_sec", i18n: "cutPerSec", icon: "mdi:speedometer" },
];

const knobSpec = ({ knob, command, i18n, unit }) => ({
    key: `huelink_${command}`,
    type: "numeric",
    access: ACCESS_STATE_SET,
    label: t(`field.${i18n}.label`),
    description: t(`field.${i18n}.description`),
    ...(unit ? { unit } : {}),
    min: LIMITS[knob].min,
    max: LIMITS[knob].max,
    step: LIMITS[knob].step,
});

const SPECS = [
    {
        key: "huelink_version",
        type: "text",
        access: ACCESS_STATE,
        label: t("field.version.label"),
        description: t("field.version.description"),
    },
    {
        key: "huelink_status",
        type: "text",
        access: ACCESS_STATE,
        label: t("field.status.label"),
        description: t("field.status.description"),
    },
    {
        key: "huelink_fps_real",
        type: "numeric",
        access: ACCESS_STATE,
        label: t("field.fpsReal.label"),
        description: t("field.fpsReal.description"),
        unit: "fps",
    },
    {
        key: "huelink_dropped",
        type: "numeric",
        access: ACCESS_STATE,
        label: t("field.dropped.label"),
        description: t("field.dropped.description"),
    },
    {
        key: "huelink_mode",
        type: "enum",
        access: ACCESS_STATE_SET,
        label: t("field.mode.label"),
        description: t("field.mode.description"),
        values: Object.values(MODE_LABEL),
    },
    // "Custom" when no catalogue preset matches the live values.
    {
        key: "huelink_preset",
        type: "enum",
        access: ACCESS_STATE_SET,
        label: t("field.preset.label"),
        description: t("field.preset.description"),
        values: PRESET_OPTIONS,
    },
    {
        key: "huelink_fps",
        type: "numeric",
        access: ACCESS_STATE_SET,
        label: t("field.fps.label"),
        description: t("field.fps.description", { max: FPS_MAX }),
        unit: "fps",
        min: FPS_MIN,
        max: FPS_MAX,
        step: 1,
    },
    {
        key: "huelink_delta",
        type: "numeric",
        access: ACCESS_STATE_SET,
        label: t("field.delta.label"),
        description: t("field.delta.description"),
        unit: "%",
        min: LIMITS.deltaScalePct.min,
        max: LIMITS.deltaScalePct.max,
        step: LIMITS.deltaScalePct.step,
    },
    {
        key: "huelink_duty",
        type: "numeric",
        access: ACCESS_STATE_SET,
        label: t("field.duty.label"),
        description: t("field.duty.description"),
        min: LIMITS.dutyCap.min,
        max: LIMITS.dutyCap.max,
        step: LIMITS.dutyCap.step,
    },
    {
        key: "huelink_budget",
        type: "numeric",
        access: ACCESS_STATE_SET,
        label: t("field.budget.label"),
        description: t("field.budget.description"),
        unit: "%",
        min: LIMITS.occupancyBudgetPct.min,
        max: LIMITS.occupancyBudgetPct.max,
        step: LIMITS.occupancyBudgetPct.step,
    },
    ...KNOBS.map(knobSpec),
    {
        key: "huelink_saturation",
        type: "numeric",
        access: ACCESS_STATE_SET,
        label: t("field.saturation.label"),
        description: t("field.saturation.description"),
        unit: "%",
        min: SATURATION_PCT.min,
        max: SATURATION_PCT.max,
        step: SATURATION_PCT.step,
    },
];

/** SPECS with their category filled in. */
export const FIELDS = SPECS.map((spec) => ({ ...spec, category: categoryOf(spec.key) }));

/** Writable keys: the ones that need a toZigbee converter. */
export const SETTABLE_KEYS = FIELDS.filter((f) => f.access === ACCESS_STATE_SET).map((f) => f.key);
