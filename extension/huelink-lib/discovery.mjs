/**
 * Home Assistant MQTT discovery: which entities HueLink offers and how each
 * maps onto the state and command topics. No I/O; `HueLink.publishDiscovery`
 * builds the topics and the device block and publishes the result.
 *
 * Discovery rather than hand-written HA entities, because every other Zigbee
 * device already arrives that way, and because the effect list comes from
 * `effects.json`: a manual entity would make each new effect an edit in two
 * places, and the HA half would fall behind.
 */

import { MODES } from "./arbiter.mjs";
import { CONFIG } from "./config.mjs";
import { SATURATION_PCT } from "./huepack.mjs";
import { ACTIVITIES, KNOBS, MODE_LABEL, PRESETS, categoryOf } from "./huelink-ui.mjs";
import { t } from "./i18n/index.mjs";
import { LIMITS } from "./pacer.mjs";

/**
 * Entities that no longer exist in this model. An empty retained payload on the
 * discovery topic removes them from HA; without this the old standalone sync
 * switch would linger next to the mode select.
 */
export const RETIRED = [
    ["switch", "sync"],
    ["sensor", "sync_status"],
    ["sensor", "source"],
    ["sensor", "mode"],
];

/**
 * Mode select, effect select, knobs and the status, as `[kind, id, payload]`.
 * There is deliberately NO power switch: power is the strip's own HA `light`
 * entity, and a second switch beside it could disagree with it. The mode
 * select's "Off" option is not one: it is a view of the same power flag, so
 * the one control that knows what the strip is doing can also stop it.
 */
export function discoveryEntities({ stateTopic, commandTopic, availabilityTopic, device, effectOptions }) {
    /** A `number` slider entity: `[kind, id, payload]` like the literals below. */
    const slider = (id, haKey, { value, command, limits, unit, icon, expert }) => [
        "number",
        id,
        {
            name: t(`ha.${haKey}`),
            unique_id: `huelink_${CONFIG.name}_${id}`,
            state_topic: stateTopic,
            value_template: `{{ value_json.${value} }}`,
            command_topic: commandTopic,
            command_template: command,
            min: limits.min,
            max: limits.max,
            step: limits.step,
            ...(unit ? { unit_of_measurement: unit } : {}),
            mode: "slider",
            icon,
            // Expert knobs (presets cover everyday use): off until enabled in HA.
            ...(expert ? { enabled_by_default: false } : {}),
            device,
        },
    ];

    // Off is a view of power, not a fourth arbiter mode. `armed` keeps "Sync"
    // shown while the strip is dark waiting for the TV.
    const off = JSON.stringify(t("status.off"));
    let entities = [
        [
            "select",
            "mode",
            {
                name: t("ha.mode"),
                unique_id: `huelink_${CONFIG.name}_mode_select`,
                state_topic: stateTopic,
                value_template: `{{ value_json.mode if value_json.power == 'ON' or value_json.armed else ${off} }}`,
                command_topic: commandTopic,
                command_template: `{% if value == ${off} %}{"power": "OFF"}{% else %}{"mode": {{ value | tojson }}}{% endif %}`,
                options: [t("status.off"), ...MODES.map((m) => MODE_LABEL[m])],
                icon: "mdi:tune-variant",
                device,
            },
        ],
        [
            // Beside the mode select. Moving any slider turns the state
            // into "Custom", which must be an option because HA logs an
            // error for a select state outside its options; choosing it
            // does nothing.
            "select",
            "preset",
            {
                name: t("ha.preset"),
                unique_id: `huelink_${CONFIG.name}_preset`,
                state_topic: stateTopic,
                value_template: "{{ value_json.preset }}",
                command_topic: commandTopic,
                command_template: '{"preset": {{ value | tojson }}}',
                options: PRESETS.map((p) => p.name),
                icon: "mdi:playlist-star",
                device,
            },
        ],
        [
            "select",
            "effect",
            {
                name: t("ha.effect"),
                unique_id: `huelink_${CONFIG.name}_effect`,
                state_topic: stateTopic,
                value_template: "{{ value_json.effect }}",
                command_topic: commandTopic,
                command_template: '{"effect": {{ value | tojson }}}',
                options: effectOptions,
                icon: "mdi:auto-fix",
                device,
            },
        ],
        [
            "number",
            "effect_brightness",
            {
                name: t("ha.effectBrightness"),
                unique_id: `huelink_${CONFIG.name}_effect_brightness`,
                state_topic: stateTopic,
                value_template: "{{ value_json.effect_brightness }}",
                command_topic: commandTopic,
                command_template: '{"effect_brightness": {{ value | int }}}',
                min: 1,
                max: 100,
                step: 1,
                unit_of_measurement: "%",
                mode: "slider",
                icon: "mdi:brightness-6",
                device,
            },
        ],
        [
            "number",
            "effect_speed",
            {
                name: t("ha.effectSpeed"),
                unique_id: `huelink_${CONFIG.name}_effect_speed`,
                state_topic: stateTopic,
                value_template: "{{ value_json.effect_speed }}",
                command_topic: commandTopic,
                command_template: '{"effect_speed": {{ value | int }}}',
                // 10-300 stays, and that is measured rather than assumed.
                // Speed drives the effect's phase, not the send rate, so
                // once the pace binds it saturates there: the bench shows
                // the same 23.3 % occupancy at 50 % and at 300 % speed.
                // Above ~50 % it buys no air time, only a different look.
                min: 10,
                max: 300,
                step: 5,
                unit_of_measurement: "%",
                mode: "slider",
                icon: "mdi:speedometer",
                device,
            },
        ],
        [
            "sensor",
            "status",
            {
                name: t("ha.status"),
                unique_id: `huelink_${CONFIG.name}_status`,
                state_topic: stateTopic,
                value_template: "{{ value_json.status }}",
                icon: "mdi:information-outline",
                device,
            },
        ],
        [
            // `status` as a fixed word: card conditions and automations
            // must not depend on the locale or the wording.
            "sensor",
            "activity",
            {
                name: t("ha.activity"),
                unique_id: `huelink_${CONFIG.name}_activity`,
                state_topic: stateTopic,
                value_template: "{{ value_json.activity }}",
                device_class: "enum",
                options: ACTIVITIES,
                icon: "mdi:state-machine",
                device,
            },
        ],
        [
            // From `breaker`, not from the translated `status` text, so an
            // automation ("tell me when the strip needs me") survives a
            // locale or wording change.
            "binary_sensor",
            "breaker",
            {
                name: t("ha.breaker"),
                unique_id: `huelink_${CONFIG.name}_breaker`,
                state_topic: stateTopic,
                value_template: "{{ 'ON' if value_json.breaker == 'gave_up' else 'OFF' }}",
                device_class: "problem",
                device,
            },
        ],
        [
            "sensor",
            "fps_real",
            {
                name: t("ha.fpsReal"),
                unique_id: `huelink_${CONFIG.name}_fps_real`,
                state_topic: stateTopic,
                value_template: "{{ value_json.fps_real }}",
                unit_of_measurement: "fps",
                state_class: "measurement",
                icon: "mdi:speedometer-medium",
                device,
            },
        ],
        [
            "number",
            "fps",
            {
                name: t("ha.fps"),
                unique_id: `huelink_${CONFIG.name}_fps`,
                state_topic: stateTopic,
                value_template: "{{ value_json.fps }}",
                command_topic: commandTopic,
                command_template: '{"fps": {{ value | int }}}',
                // Was 5-25. Anything above ~6 was decoration: at the measured
                // 51 ms per send even 7 fps needs 29 % occupancy, and 25 fps
                // would need 128 %, which cannot happen. The slider showed
                // numbers the hardware silently clipped; now it only shows
                // reachable ones. The floor of 2 is a deliberate way to hand
                // the coordinator back to the rest of the house. docs/PACING.md.
                //
                // The ceiling follows `maxFps` from the config rather than
                // the built-in 5, for the same reason the number was 5 in
                // the first place: a slider should only offer what this
                // installation can actually deliver, and on a dedicated
                // coordinator that is a different number. Read once, so a
                // change to it needs a z2m restart like the z2m-side
                // slider in huelink-lib/huelink-ui.mjs.
                min: Math.min(2, CONFIG.maxFps),
                max: CONFIG.maxFps,
                step: 1,
                unit_of_measurement: "fps",
                mode: "slider",
                icon: "mdi:filmstrip",
                device,
            },
        ],
        [
            "sensor",
            "occupancy",
            {
                // The one number that says whether Sync is hurting the rest
                // of the house: the share of time the coordinator spends on
                // strip frames. Above ~40 % other commands start queueing.
                name: t("ha.occupancy"),
                unique_id: `huelink_${CONFIG.name}_occupancy`,
                state_topic: stateTopic,
                value_template: "{{ value_json.pacer.occupancyPct }}",
                unit_of_measurement: "%",
                state_class: "measurement",
                icon: "mdi:gauge",
                device,
            },
        ],
        // The budget is what really limits fps; raising the cap alone
        // changes nothing. The `fps_ceiling` sensor shows the net result.
        slider("budget", "budget", {
            value: "pacer.occupancyBudgetPct",
            command: '{"occupancy_budget": {{ value | int }}}',
            limits: LIMITS.occupancyBudgetPct,
            unit: "%",
            icon: "mdi:gauge",
            // Takes coordinator time from every other Zigbee device; presets cover everyday use.
            expert: true,
        }),
        [
            "sensor",
            "fps_ceiling",
            {
                // Deliverable rate: frame cap, quota and air budget combined.
                name: t("ha.fpsCeiling"),
                unique_id: `huelink_${CONFIG.name}_fps_ceiling`,
                state_topic: stateTopic,
                value_template: "{{ value_json.pacer.fpsCeiling }}",
                unit_of_measurement: "fps",
                state_class: "measurement",
                icon: "mdi:arrow-collapse-up",
                device,
            },
        ],
        // Built from `KNOBS`, the table that also wires the commands.
        ...KNOBS.map(({ knob, command, i18n, unit, icon }) =>
            slider(command, i18n, {
                value: `pacer.${knob}`,
                // `float`: `smoothingFactor` steps in 0.05, `int` would round it away.
                command: `{"${command}": {{ value | float }}}`,
                limits: LIMITS[knob],
                unit,
                icon,
                expert: true,
            }),
        ),
        // Costs the coordinator nothing (changes colours, not frame count); 100 is neutral.
        slider("saturation", "saturation", {
            value: "saturation",
            command: '{"saturation": {{ value | int }}}',
            limits: SATURATION_PCT,
            unit: "%",
            icon: "mdi:palette",
        }),
    ];

    // With no effects loaded, a `select` with an empty option list is just
    // an error in the HA log, so the entity is simply not published.
    if (!effectOptions.length) {
        entities = entities.filter(([kind, id]) => !(kind === "select" && id === "effect"));
    }
    // Same for presets: an unreadable `presets.json` leaves only "Custom".
    if (!PRESETS.length) {
        entities = entities.filter(([kind, id]) => !(kind === "select" && id === "preset"));
    }

    // Entity category folds the entity under Configuration/Diagnostic in HA;
    // same table as the z2m device page. `status` has none on purpose: it is
    // where the breaker state shows. `categoryOf` throws on unknown ids, so
    // new entities must be categorised.
    //
    // `default_entity_id` (HA 2025.10+) instead of the id HA would derive from
    // the translated name, so a shared dashboard works in every locale. Used
    // only when HA first registers the entity.
    const slug = CONFIG.name.toLowerCase().replace(/[^a-z0-9_]+/g, "_");
    // z2m's own `bridge/state`: without it every card keeps its last state while z2m is down.
    const availability = [{ topic: availabilityTopic, value_template: "{{ value_json.state }}" }];
    return entities.map(([kind, id, cfg]) => {
        const category = categoryOf(id);
        return [
            kind,
            id,
            {
                ...cfg,
                default_entity_id: `${kind}.${slug}_${id}`,
                availability,
                ...(category ? { entity_category: category } : {}),
            },
        ];
    });
}
