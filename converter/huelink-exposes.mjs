/**
 * An external converter that adds the `huelink_*` fields to the Hue Play
 * gradient lightstrip (LCX002) on its own z2m device page, so the running
 * version and the main settings are visible without going to Home Assistant.
 *
 * It does NOT replace the Philips definition: the stock `extend` (light,
 * brightness, colour, gradient, effects, identify) is untouched and our fields
 * are appended after it. If light control broke, this would be worse than
 * nothing, so that is the one thing to check after any change here.
 *
 * This file declares only the SHAPE of the fields. Values are published by the
 * extension; writes reach it over the eventBus. The field list itself lives in
 * huelink-lib/huelink-ui.mjs so it is written once. Why it is wired this way, and why
 * `convertSet` returns nothing, is in docs/DESIGN.md.
 */

import * as exposes from "zigbee-herdsman-converters/lib/exposes";
import { definitions as philipsDefinitions } from "zigbee-herdsman-converters/devices/philips";
import { logger } from "zigbee-herdsman-converters/lib/logger";

// These paths are written for the DEPLOYED layout, not the repo one: z2m loads
// this file from `<data>/external_converters/` and the extension from
// `<data>/external_extensions/`. A repo-relative path would look right here and
// never load in production.
import { t } from "../external_extensions/huelink-lib/i18n/index.mjs";
import { FIELDS } from "../external_extensions/huelink-lib/huelink-ui.mjs";

const NS = "zhc:huelink-exposes";
const ZIGBEE_MODEL = "LCX002";

const stock = philipsDefinitions.find((d) => d.zigbeeModel?.includes(ZIGBEE_MODEL));

if (!stock) {
    throw new Error(`huelink-exposes: stock definition for '${ZIGBEE_MODEL}' not found`);
}

if (!Array.isArray(stock.extend)) {
    // Appending to the stock `extend` is the only way our fields land AFTER the
    // light in the UI. If upstream ever changes shape, fail loudly and keep the
    // stock definition rather than quietly building half of this.
    throw new Error(`huelink-exposes: '${ZIGBEE_MODEL}' no longer uses modern extend`);
}

/** One field descriptor -> one zhc expose. */
const toExpose = (field) => {
    let expose;

    switch (field.type) {
        case "text":
            expose = exposes.text(field.key, field.access);
            break;
        case "enum":
            expose = exposes.enum(field.key, field.access, field.values);
            break;
        case "numeric":
            expose = exposes.numeric(field.key, field.access);
            if (field.unit !== undefined) expose = expose.withUnit(field.unit);
            if (field.min !== undefined) expose = expose.withValueMin(field.min);
            if (field.max !== undefined) expose = expose.withValueMax(field.max);
            if (field.step !== undefined) expose = expose.withValueStep(field.step);
            break;
        default:
            throw new Error(`huelink-exposes: unknown field type '${field.type}' for '${field.key}'`);
    }

    return (
        expose
            .withLabel(field.label)
            .withDescription(field.description)
            // `category` does nothing in the z2m UI, but HA discovery reads it:
            // `config`/`diagnostic` makes the entity a setting or a diagnostic
            // rather than a normal control (`undefined` = normal control).
            .withCategory(field.category)
            // Disabled in HA on purpose: the strip already has a full HueLink
            // control set there (its own device). Always visible in the z2m UI.
            // Only affects newly discovered entities; delete old ones in HA once.
            .withHomeAssistant({ enabledByDefault: false })
    );
};

/**
 * One converter per key, not one for all of them: z2m uses each converter only
 * ONCE per `/set` message, so a shared converter would silently drop every key
 * but the first out of `{"huelink_fps": 3, "huelink_duty": 1}`.
 *
 * `convertSet` deliberately does nothing. There is no Zigbee traffic here; it
 * exists only so z2m does not reject the key, and so the message reaches the
 * extension over the eventBus. Returning a state would be actively harmful,
 * see docs/DESIGN.md.
 */
const settingConverters = FIELDS.filter((f) => f.access & 0b010).map((field) => ({
    key: [field.key],
    convertSet: async () => undefined,
}));

logger.info(
    `huelink-exposes: ${t("log.exposesAdded", {
        count: FIELDS.length,
        model: stock.model,
        settable: settingConverters.length,
    })}`,
    NS,
);

export default {
    ...stock,
    extend: [
        ...stock.extend,
        {
            isModernExtend: true,
            exposes: FIELDS.map(toExpose),
            toZigbee: settingConverters,
        },
    ],
};
