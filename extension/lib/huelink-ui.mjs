/**
 * The shared boundary between `huelink.mjs` (the extension) and
 * `converter/huelink-exposes.mjs` (the device definition).
 *
 * The definition declares the fields; the extension publishes the values.
 * Two files, loaded independently, so a name written twice would fail
 * silently. Names, ranges and descriptions live here only; both sides import.
 *
 * Ranges come from `pacer.mjs` LIMITS because the pacer clamps to them anyway.
 * The `huelink_` prefix is mandatory: the strip already has `effect`,
 * `effect_speed` and `identify` from the Philips definition.
 */

import { LIMITS, MAX_FPS } from "./pacer.mjs";
import { t } from "./i18n/index.mjs";

/**
 * Human-facing mode names. One list for the HA `select`, the z2m `enum` and
 * the status line, because this is also what the user types in a command.
 */
export const MODE_LABEL = {
    light: t("mode.light"),
    effect: t("mode.effect"),
    sync: t("mode.sync"),
};

/**
 * The same table backwards, for turning what the user typed into a mode.
 *
 * A `Map`, not a plain object: mode names arrive from MQTT, and a plain object
 * answers for its prototype too, so `"constructor"`, `"toString"` and
 * `"__proto__"` would all "resolve" to something truthy and walk straight
 * through the caller's `?? null` check. A `Map` only knows what was put in it.
 */
export const MODE_BY_LABEL = new Map(
    Object.entries(MODE_LABEL).map(([mode, label]) => [label, mode]),
);

/**
 * Fields shown on the z2m device page, deliberately a short list rather than
 * everything the extension knows. The rich UI is the HA card; here the goal is
 * to open the device, see which version is running and what it is doing, and
 * turn a basic knob without leaving z2m. A fuller panel here would be a second
 * place to set the same thing differently.
 *
 * `access`: 1 = read only (STATE), 3 = read/write (STATE_SET). Numbers, not
 * zhc constants, so the extension need not import the converter library.
 */
export const ACCESS_STATE = 1;
export const ACCESS_STATE_SET = 3;

export const FIELDS = [
    {
        key: "huelink_version",
        type: "text",
        access: ACCESS_STATE,
        label: t("field.version.label"),
        description: t("field.version.description"),
        category: "diagnostic",
    },
    {
        key: "huelink_status",
        type: "text",
        access: ACCESS_STATE,
        label: t("field.status.label"),
        description: t("field.status.description"),
        category: "diagnostic",
    },
    {
        key: "huelink_fps_real",
        type: "numeric",
        access: ACCESS_STATE,
        label: t("field.fpsReal.label"),
        description: t("field.fpsReal.description"),
        unit: "fps",
        category: "diagnostic",
    },
    {
        key: "huelink_dropped",
        type: "numeric",
        access: ACCESS_STATE,
        label: t("field.dropped.label"),
        description: t("field.dropped.description"),
        category: "diagnostic",
    },
    {
        key: "huelink_mode",
        type: "enum",
        access: ACCESS_STATE_SET,
        label: t("field.mode.label"),
        description: t("field.mode.description"),
        values: Object.values(MODE_LABEL),
        category: "config",
    },
    {
        key: "huelink_fps",
        type: "numeric",
        access: ACCESS_STATE_SET,
        label: t("field.fps.label"),
        description: t("field.fps.description", { max: MAX_FPS }),
        unit: "fps",
        // A UI choice, not the pacer's clamp (which allows 1). 1 fps is not a
        // usable mode; 2 is an honest way to nearly stop the stream.
        min: 2,
        max: MAX_FPS,
        step: 1,
        category: "config",
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
        category: "config",
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
        category: "config",
    },
];

/** Writable keys only: the ones that need a toZigbee converter. */
export const SETTABLE_KEYS = FIELDS.filter((f) => f.access === ACCESS_STATE_SET).map((f) => f.key);
