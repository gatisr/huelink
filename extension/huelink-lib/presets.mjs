/**
 * presets - one name that sets the seven picture knobs at once.
 *
 * The catalogue is data (`presets.json`). A preset is applied, never
 * enforced: sliders keep working, and `match()` says which preset (if any)
 * describes the live values, so every path that moves a knob gets one answer.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { t } from "./i18n/index.mjs";
import { toFinite } from "./num.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Knobs a preset owns. Same names as the pacer, plus `saturationPct` (percent, as on the wire). */
export const KNOB_KEYS = [
    "fps",
    "occupancyBudget",
    "smoothingFactor",
    "bigChangeThreshold",
    "fastSmoothingMs",
    "maxFastPerSec",
    "saturationPct",
];

/**
 * Read the catalogue. A bad entry is skipped with an error, not thrown: the
 * file is human-edited and must not cost the user sync.
 *
 * @returns {Array<{id: string, name: string, knobs: object}>}
 */
export function loadPresets(logger = console, file = join(HERE, "presets.json")) {
    let doc;
    try {
        doc = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
        logger.error(`[huelink] ${t("log.jsonUnreadable", { what: t("label.presetCatalog"), file, error: e.message })}`);
        return [];
    }

    const out = [];
    for (const entry of doc.presets ?? []) {
        const id = entry?.id;
        const name = entry?.name;
        if (typeof id !== "string" || typeof name !== "string" || !name.trim()) {
            logger.error(`[huelink] ${t("log.presetBadId", { entry: JSON.stringify(entry) })}`);
            continue;
        }
        // "Custom" is the slot for hand-set values (`CUSTOM_PRESET`), never a catalogue entry.
        if (name === "Custom" || out.some((p) => p.id === id || p.name === name)) {
            logger.error(`[huelink] ${t("log.presetDuplicate", { id })}`);
            continue;
        }
        const knobs = {};
        const bad = KNOB_KEYS.find((key) => (knobs[key] = toFinite(entry[key])) === null);
        if (bad) {
            logger.error(`[huelink] ${t("log.presetBadKnob", { id, knob: bad })}`);
            continue;
        }
        out.push({ id, name, knobs });
    }
    return out;
}

/** What the preset lands as here: only fps can exceed what this install allows. */
export function landed(preset, maxFps) {
    return { ...preset.knobs, fps: Math.min(preset.knobs.fps, maxFps) };
}

/**
 * The preset whose landed values equal `live`, or `null` (shown as no
 * selection). Strict `===` is safe: catalogue values sit on the slider grid
 * and the setters return in-range values unchanged.
 */
export function match(presets, live, maxFps) {
    return presets.find((p) => KNOB_KEYS.every((key) => live[key] === landed(p, maxFps)[key])) ?? null;
}
