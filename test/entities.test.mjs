/**
 * Where each control lands in Home Assistant: grouping, one category table for
 * z2m and our own discovery, the via_device link.
 */

import { strict as assert } from "node:assert";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// Set before the extension loads: device and locale are read at module load.
process.env.HUELINK_CONFIG = join(HERE, "fixtures", "entities.config.json");

const { default: HueLink } = await import("../extension/huelink.mjs");
const { CONFIG } = await import("../extension/huelink-lib/config.mjs");
const {
    ACCESS_STATE_SET,
    ACTIVITIES,
    CONFIGURATION,
    DIAGNOSTIC,
    FIELDS,
    MAIN,
    MODE_LABEL,
    categoryOf,
} = await import("../extension/huelink-lib/huelink-ui.mjs");
const { t: tr } = await import("../extension/huelink-lib/i18n/index.mjs");

/** The strip's z2m IEEE address in this test. Only the shape matters. */
const DEVICE_ID = "0x00178801aabbccdd";

/**
 * A started extension with stubbed z2m, recording what it published.
 */
async function started(cache = { state: "ON" }) {
    const deviceOptions = { ID: DEVICE_ID, friendly_name: CONFIG.device };
    const log = { info: [], error: [], warning: [], debug: [] };
    const published = [];

    const endpoint = { async zclCommand() {}, async write() {} };
    const device = {
        zh: { networkAddress: 0x1234 },
        endpoint: () => endpoint,
        name: CONFIG.device,
        get options() {
            return { ...deviceOptions };
        },
    };

    const link = new HueLink(
        { resolveEntity: () => device },
        { publish: async (topic, payload, options) => published.push({ topic, payload, options }) },
        { get: () => cache },
        async () => {},
        {
            onMQTTMessage() {},
            onPublishEntityState() {},
            removeListeners() {},
        },
        null,
        null,
        null,
        {
            get: () => ({ mqtt: { base_topic: "zigbee2mqtt" }, homeassistant: {} }),
        },
        {
            info: (m) => log.info.push(m),
            error: (m) => log.error.push(m),
            warning: (m) => log.warning.push(m),
            debug: (m) => log.debug.push(m),
        },
    );

    await link.start();
    return { link, log, published };
}

/** The discovery payloads this run published, keyed by the entity id. */
const discovery = (published) => {
    const found = new Map();
    for (const p of published) {
        // Matched by shape (`<type>/huelink_<name>/<id>/config`), not by rebuilding the prefix.
        const m = /^(?:.*\/)?(\w+)\/huelink_[^/]+\/([^/]+)\/config$/.exec(p.topic);
        // An empty payload is a retained-topic removal (RETIRED), not an entity.
        if (m && p.payload) found.set(m[2], JSON.parse(p.payload));
    }
    return found;
};

test("grouping: everyday controls are main, expert knobs config, readings diagnostic, no overlap", () => {
    for (const name of ["mode", "brightness", "status", "preset", "effect", "effect_speed", "custom_style"]) assert.ok(MAIN.includes(name), name);
    for (const name of ["fps", "budget", "smoothing"]) assert.ok(CONFIGURATION.includes(name), name);
    for (const name of MAIN) assert.equal(categoryOf(name), undefined, name);
    assert.equal(categoryOf("huelink_status"), undefined);
    for (const name of CONFIGURATION) assert.equal(categoryOf(name), "config", name);
    for (const name of DIAGNOSTIC) assert.equal(categoryOf(name), "diagnostic", name);
    const all = [...MAIN, ...CONFIGURATION, ...DIAGNOSTIC];
    assert.equal(new Set(all).size, all.length, `duplicate in the category table: ${all.join(", ")}`);
});

test("an unclassified name throws instead of defaulting", () => {
    assert.throws(() => categoryOf("huelink_not_a_real_field"), /no HA category/);
});

test("the categories satisfy what zigbee-herdsman-converters allows", () => {
    // zhc validateCategory(): config must be settable, diagnostic must not. A violation throws at load.
    for (const field of FIELDS) {
        const settable = (field.access & ACCESS_STATE_SET) === ACCESS_STATE_SET;
        if (field.category === "config") assert.ok(settable, `${field.key} is config but not settable`);
        if (field.category === "diagnostic") assert.ok(!settable, `${field.key} is diagnostic but settable`);
    }
});

// ------------------------------------------------------- the published side

test("our own discovery payloads carry the same categories", async (t) => {
    const h = await started();
    t.after(() => h.link.stop());

    const configs = discovery(h.published);
    assert.ok(configs.size >= 10, `only ${configs.size} discovery payloads were published`);

    for (const [id, payload] of configs) {
        const expected = categoryOf(id);
        assert.equal(payload.entity_category, expected, `${id} is in the wrong Home Assistant group`);
    }
});

test("the mode select offers Off as a view of power", async (t) => {
    const h = await started();
    t.after(() => h.link.stop());

    const mode = discovery(h.published).get("mode");
    const off = tr("status.off");
    assert.deepEqual(mode.options, [off, ...Object.values(MODE_LABEL)]);
    assert.ok(!Object.values(MODE_LABEL).includes(off), "Off must not collide with a mode name");
    // Off is the existing power command, everything else the existing mode command.
    assert.ok(mode.command_template.includes(`{% if value == ${JSON.stringify(off)} %}{"power": "OFF"}`));
    assert.ok(mode.command_template.includes('{"mode": {{ value | tojson }}}'));
    // Armed (dark, waiting for the TV) must still read as the chosen mode, not Off.
    assert.ok(mode.value_template.includes("value_json.armed"));
    assert.ok(mode.value_template.includes(JSON.stringify(off)));
});

test("every entity has availability and a stable entity id", async (t) => {
    const h = await started();
    t.after(() => h.link.stop());

    const ids = new Set();
    for (const p of h.published) {
        const m = /^(?:.*\/)?(\w+)\/huelink_[^/]+\/([^/]+)\/config$/.exec(p.topic);
        if (!m || !p.payload) continue;
        const [, kind, id] = m;
        const cfg = JSON.parse(p.payload);
        // Locale-independent, so a shared dashboard works everywhere.
        assert.equal(cfg.default_entity_id, `${kind}.${CONFIG.name}_${id}`, id);
        assert.ok(!ids.has(cfg.default_entity_id), `duplicate ${cfg.default_entity_id}`);
        ids.add(cfg.default_entity_id);
        assert.deepEqual(cfg.availability, [{ topic: "zigbee2mqtt/bridge/state", value_template: "{{ value_json.state }}" }], id);
    }
    assert.ok(ids.has(`sensor.${CONFIG.name}_activity`), "the activity sensor is published");
});

test("the published activity is one of the sensor's options", async (t) => {
    const h = await started();
    t.after(() => h.link.stop());

    const cfg = discovery(h.published).get("activity");
    assert.equal(cfg.device_class, "enum");
    assert.deepEqual(cfg.options, ACTIVITIES);
    const state = JSON.parse([...h.published].reverse().find((p) => p.topic === CONFIG.name).payload);
    // After a start the strip is dark and armed on sync.
    assert.equal(state.activity, "waiting");
    assert.ok(cfg.options.includes(state.activity));
});

test("the custom effect and the Custom preset are offered in HA", async (t) => {
    const h = await started();
    t.after(() => h.link.stop());

    const configs = discovery(h.published);
    assert.equal(configs.get("preset").options.at(-1), "Custom");
    assert.equal(configs.get("effect").options.at(-1), tr("custom.effect"));
    assert.ok(configs.get("custom_style").options.includes(tr("style.flame")));
    assert.equal(configs.get("custom_colours").options[0], tr("custom.own"));
    // The text field accepts what the extension accepts, the empty list included.
    const pattern = new RegExp(configs.get("custom_own").pattern);
    for (const ok of ["", "#ff0000", "#ff0000 #00FF88, #0000ff"]) assert.ok(pattern.test(ok), ok);
    for (const bad of ["red", "#fff", "#ff0000 x"]) assert.ok(!pattern.test(bad), bad);
    assert.equal(configs.get("custom_colour_add").payload_press, '{"custom_colour":"add"}');
    assert.equal(configs.get("custom_colour_clear").payload_press, '{"custom_colour":"clear"}');
    // One brightness: the strip's own. The old slider is removed from HA, not left dead.
    assert.ok(!configs.has("effect_brightness"));
    assert.ok(h.published.some((p) => p.topic.endsWith("number/huelink_" + CONFIG.name + "/effect_brightness/config") && p.payload === ""));
});

test("nothing read-only is published as a setting", async (t) => {
    const h = await started();
    t.after(() => h.link.stop());

    // HA rejects the whole discovery message for a read-only entity with category config.
    for (const [id, payload] of discovery(h.published)) {
        if (payload.command_topic) continue;
        assert.notEqual(
            payload.entity_category,
            "config",
            `${id} has no command_topic, so Home Assistant will reject it as 'config'`,
        );
    }
});

test("our device points at the strip's z2m device", async (t) => {
    const h = await started();
    t.after(() => h.link.stop());

    const main = `huelink_${CONFIG.name}`;
    const where = { mode: main, brightness: main, status: main, activity: main, preset: `${main}_sync`, fps: `${main}_sync`, occupancy: `${main}_sync`, effect: `${main}_effects`, custom_style: `${main}_effects` };
    const configs = discovery(h.published);
    for (const [id, device] of Object.entries(where)) assert.deepEqual(configs.get(id).device.identifiers, [device], id);
    for (const [id, payload] of configs) {
        const own = payload.device.identifiers[0];
        // z2m device identifiers use the literal `zigbee2mqtt` prefix, not the base topic.
        // The main device hangs off the strip; sync and effects hang off the main device.
        assert.equal(payload.device.via_device, own === main ? `zigbee2mqtt_${DEVICE_ID}` : main, id);
        assert.ok([main, `${main}_sync`, `${main}_effects`].includes(own), `${id} is on an unknown device ${own}`);
        assert.equal(typeof payload.device.name, "string", id);
    }
});

test("leaving a stream for light sends a forced on with the light's own look", async (t) => {
    const h = await started({ state: "ON", brightness: 127, color_mode: "xy", color: { x: 0.3, y: 0.4 } });
    t.after(() => h.link.stop());

    h.link.sources.sync.put(Array.from({ length: CONFIG.segments }, () => ({ r: 255, g: 0, b: 0 })));
    await h.link.setMode("sync");
    assert.equal(h.link.output, "sync");
    // The strip already reads "on": the guard in `light` must not swallow this one.
    h.link.stripState = "ON";
    h.published.length = 0;
    await h.link.setMode("light");

    const sets = h.published.filter((p) => p.topic === `${CONFIG.device}/set`).map((p) => JSON.parse(p.payload));
    assert.deepEqual(sets, [{ state: "ON", brightness: 127, color: { x: 0.3, y: 0.4 } }]);
});
