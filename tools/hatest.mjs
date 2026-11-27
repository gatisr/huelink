/**
 * hatest - proves a REAL Home Assistant sees the entities and that they work
 * both ways. `modesim.mjs` only checks the discovery payloads we think are
 * right; what this touches and what it leaves alone: `docs/TOOLS.md`.
 *
 * Nothing about one particular house is written here. The broker and HA come
 * from the environment, and the entity ids are LOOKED UP from the discovery
 * payloads the extension actually published, so this works in any locale and
 * survives any rename.
 *
 * Everything goes out under its own device id AND device name, so the test
 * cannot squat the entities of a real installation. It ends by deleting every
 * retained topic, so HA is left as it was found.
 *
 * usage: MQTT_URL=mqtt://host:1883 MQTT_USER=... MQTT_PASS=... \
 *        HA_URL=http://host:8123 HA_TOKEN=... node tools/hatest.mjs
 */

import mqtt from "mqtt";

import HueLink from "../extension/huelink.mjs";
import { CONFIG } from "../extension/huelink-lib/config.mjs";
import { MODE_LABEL } from "../extension/huelink-lib/huelink-ui.mjs";

const BROKER = process.env.MQTT_URL ?? "mqtt://127.0.0.1:1883";
const MQTT_USER = process.env.MQTT_USER;
const MQTT_PASS = process.env.MQTT_PASS;
const HA = process.env.HA_URL ?? "http://127.0.0.1:8123";
const TOKEN = process.env.HA_TOKEN;

const BASE = "huelink_hatest"; // NOT zigbee2mqtt: the production z2m never sees this
const DISCOVERY = process.env.HA_DISCOVERY_TOPIC ?? "homeassistant"; // the real one, or HA ignores us
/** The extension's own device id and name, rewritten onto a test device. */
const REAL_ID = `huelink_${CONFIG.name}`;
const TEST_NAME = "HueLink hatest";

const SET_TOPIC = `${BASE}/${CONFIG.name}/set`;
const STATE_TOPIC = `${BASE}/${CONFIG.name}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(ok, label, detail = "") {
    console.log(`  ${ok ? "OK  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
    ok ? pass++ : fail++;
}

/* ---------------------------------------------------------------- HA REST */

async function ha(path, init = {}) {
    const r = await fetch(`${HA}${path}`, {
        ...init,
        headers: {
            Authorization: `Bearer ${TOKEN}`,
            "Content-Type": "application/json",
            ...(init.headers ?? {}),
        },
    });
    if (!r.ok) throw new Error(`HA ${path} -> ${r.status} ${await r.text()}`);
    return r.json();
}

const callService = (domain, service, data) =>
    ha(`/api/services/${domain}/${service}`, { method: "POST", body: JSON.stringify(data) });

/**
 * The entity id is never written out by hand. HA builds the friendly name of an
 * MQTT device entity as "<device name> <entity name>", and both halves are in
 * the payload we just published, so the id can be LOOKED UP rather than guessed
 * from a slug that only holds in one language.
 */
async function findEntity(domain, friendlyName, timeoutMs = 20000) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
        const states = await ha("/api/states").catch(() => []);
        const hit = states.find(
            (s) => s.entity_id.startsWith(`${domain}.`) && s.attributes.friendly_name === friendlyName,
        );
        if (hit) return hit;
        await sleep(500);
    }
    return null;
}

/** Waits for the entity state to become `want` (state travels over MQTT). */
async function waitState(entityId, want, timeoutMs = 8000) {
    const until = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < until) {
        const s = await ha(`/api/states/${entityId}`).catch(() => null);
        last = s?.state;
        if (last === want) return last;
        await sleep(300);
    }
    return last;
}

/* ------------------------------------------------------------ z2m stand-ins */

/**
 * @param {object} client         the real MQTT client everything is proxied to
 * @param {Map} discovery         filled in as the extension publishes: topic -> entity
 */
function stubs(client, discovery) {
    const sent = [];
    const endpoint = {
        zclCommand: async (cluster, command) => void sent.push(command),
        write: async () => void sent.push("write"),
    };
    let mqttHandler = null;

    /**
     * Moves a discovery payload onto the test device. Done by parsing rather
     * than by replacing strings: the device NAME has to change too, or HA
     * derives the same entity ids as a real installation and the two fight
     * over them.
     */
    const relabel = (payload) => {
        const cfg = JSON.parse(payload);
        cfg.unique_id = cfg.unique_id.replace(REAL_ID, BASE);
        cfg.device = { ...cfg.device, identifiers: [BASE], name: TEST_NAME };
        return cfg;
    };

    return {
        sent,
        zigbee: {
            resolveEntity: () => ({ zh: { networkAddress: 0x1001 }, endpoint: () => endpoint }),
        },
        mqtt: {
            publish: async (topic, payload, opts = {}) => {
                const prefix = opts.baseTopic ?? BASE;
                const full = `${prefix}/${topic}`.replace(REAL_ID, BASE);
                let body = payload;
                if (prefix === DISCOVERY) {
                    if (payload) {
                        // The key is the entity id in the topic: .../<domain>/<device>/<key>/config
                        const key = full.split("/").at(-2);
                        const cfg = relabel(payload);
                        body = JSON.stringify(cfg);
                        discovery.set(full, { key, domain: full.split("/")[1], friendly: `${TEST_NAME} ${cfg.name}`, cfg });
                    } else {
                        // An empty payload RETIRES an entity: nothing to relabel,
                        // but the topic still has to be cleaned up at the end.
                        discovery.set(full, null);
                    }
                }
                client.publish(full, body, { retain: Boolean(opts.clientOptions?.retain) });
            },
        },
        // z2m already subscribes to base_topic/#; here our own client does it.
        eventBus: {
            onMQTTMessage: (_k, cb) => (mqttHandler = cb),
            // The extension's second power path, for an off that arrives from a
            // wall switch rather than over MQTT. HA drives this test over MQTT,
            // so the listener is accepted and never fired.
            onPublishEntityState: () => {},
            removeListeners: () => (mqttHandler = null),
        },
        settings: {
            get: () => ({ mqtt: { base_topic: BASE }, homeassistant: { discovery_topic: DISCOVERY } }),
        },
        /** z2m's state store; the strip is dark when the harness starts. */
        state: { get: () => ({ state: "OFF" }) },
        /** The exposes echo back to z2m. Stubbed so that path runs, not throws. */
        publishEntityState: async () => {},
        logger: { info: () => {}, error: (m) => console.log("  z2m-ERR:", m) },
        deliver: (topic, message) => mqttHandler?.({ topic, message }),
    };
}

/* -------------------------------------------------------------------- run */

async function main() {
    // HA_TOKEN has no sensible default, so it is demanded rather than guessed.
    // The broker login is NOT demanded: plenty of brokers accept anonymous
    // clients, and insisting on a password would lock those out for nothing.
    if (!TOKEN) {
        console.error("HA_TOKEN is required: a long-lived access token for HA_URL");
        process.exit(2);
    }

    const client = await mqtt.connectAsync(BROKER, { username: MQTT_USER, password: MQTT_PASS });

    /** topic -> entity info, or null for a retired one. */
    const discovery = new Map();
    const s = stubs(client, discovery);

    client.on("message", (topic, buf) => {
        if (topic === SET_TOPIC) s.deliver(topic, buf.toString());
    });
    await client.subscribeAsync(`${BASE}/#`);

    const ext = new HueLink(
        s.zigbee, s.mqtt, s.state, s.publishEntityState,
        s.eventBus, null, null, null, s.settings, s.logger,
    );

    const cleanup = async () => {
        for (const topic of discovery.keys()) client.publish(topic, "", { retain: true });
        client.publish(STATE_TOPIC, "", { retain: true });
        await sleep(1500);
    };

    const ids = {};
    try {
        console.log(`\nHA: ${HA}   broker: ${BROKER}   base: ${BASE}\n`);
        await ext.start();

        console.log("1) HA sees the entities (discovery)");
        let effectCfg = null;
        for (const info of discovery.values()) {
            if (!info) continue;
            if (info.key === "effect") effectCfg = info.cfg;
            const entity = await findEntity(info.domain, info.friendly);
            ids[info.key] = entity?.entity_id;
            check(
                Boolean(entity),
                `${info.domain}: ${info.friendly}`,
                entity ? `-> ${entity.entity_id}` : "not found",
            );
            if (info.key === "effect" && entity) {
                // Compared against what WE published, never against a list
                // typed out here: the catalogue is data and it grows.
                check(
                    entity.attributes.options.join("|") === effectCfg.options.join("|"),
                    "the HA select carries exactly the published effects",
                    `${effectCfg.options.length} effects`,
                );
            }
        }
        if (!ids.mode || !ids.effect) throw new Error("the mode and effect selects are missing, no point going on");

        console.log("\n2) HA -> extension: pick an effect");
        const effect = effectCfg.options[0];
        await callService("select", "select_option", { entity_id: ids.effect, option: effect });
        await sleep(600);
        check(ext.effects.selected === effect, "the extension received the choice", ext.effects.selected);
        check((await waitState(ids.effect, effect)) === effect, "the HA state came back over MQTT");

        console.log("\n3) HA -> extension: switch to effect mode");
        await callService("select", "select_option", { entity_id: ids.mode, option: MODE_LABEL.effect });
        await sleep(800);
        check(ext.arbiter.requested === "effect", "the arbiter is in effect mode", ext.arbiter.requested);
        check(
            (await waitState(ids.mode, MODE_LABEL.effect)) === MODE_LABEL.effect,
            "the HA mode select reads back",
        );

        console.log("\n4) HA -> extension: the controls");
        await callService("number", "set_value", { entity_id: ids.effect_speed, value: 200 });
        await sleep(800);
        check(Math.round(ext.effects.speed * 100) === 200, "speed 200%", String(ext.effects.speed));
        const hs = await waitState(ids.effect_speed, "200");
        check(Number(hs) === 200, "HA speed 200", `state=${hs}`);

        console.log("\n5) Another client publishes to /set: the HA state is real, not just our own echo");
        client.publish(SET_TOPIC, JSON.stringify({ mode: MODE_LABEL.light }));
        await sleep(600);
        check(
            (await waitState(ids.mode, MODE_LABEL.light)) === MODE_LABEL.light,
            "the HA mode select moved by itself",
        );

        console.log("\n6) Sync with nothing feeding: the strip waits instead of lighting up");
        s.sent.length = 0;
        client.publish(SET_TOPIC, JSON.stringify({ mode: MODE_LABEL.sync }));
        await sleep(2500);
        check(ext.armed === "sync", "sync is armed, waiting for the TV", String(ext.armed));
        check(ext.output === "off", "nothing is being sent", ext.output);
        check(s.sent.includes(3), "a CMD_RESET went out", `commands=${[...new Set(s.sent)].join(",")}`);
    } finally {
        await ext.stop().catch(() => {});
        console.log("\n7) Cleanup: the retained discovery is deleted, the HA entities go away");
        await cleanup();
        const left = ids.mode ? await ha(`/api/states/${ids.mode}`).catch(() => null) : null;
        check(left === null || left.state === "unavailable", "the test entities are gone", left?.state ?? "none");
        await client.endAsync();
    }

    console.log(`\n${fail === 0 ? "ALL STEPS OK" : `${fail} FAILED`}  (${pass} ok, ${fail} fail)`);
    process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error("ERROR:", e);
    process.exit(1);
});
