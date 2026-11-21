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
    CONFIGURATION,
    DIAGNOSTIC,
    FIELDS,
    MAIN,
    categoryOf,
} = await import("../extension/huelink-lib/huelink-ui.mjs");

/** The strip's z2m IEEE address in this test. Only the shape matters. */
const DEVICE_ID = "0x00178801aabbccdd";

/**
 * A started extension with stubbed z2m, recording what it published.
 */
async function started() {
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
        { get: () => ({ state: "ON" }) },
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

test("grouping: five main controls incl. status, the rest config or diagnostic, no overlap", () => {
    assert.deepEqual(MAIN, ["mode", "effect", "preset", "effect_speed", "status"]);
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

    for (const [id, payload] of discovery(h.published)) {
        // z2m device identifiers use the literal `zigbee2mqtt` prefix, not the base topic.
        assert.equal(payload.device.via_device, `zigbee2mqtt_${DEVICE_ID}`, id);
        assert.deepEqual(payload.device.identifiers, [`huelink_${CONFIG.name}`], id);
    }
});
