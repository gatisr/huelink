/**
 * extsim - runs the REAL extension class against a fake z2m environment.
 * Only what comes from z2m is substituted; see `docs/TOOLS.md`.
 *
 * Checks:
 *   1. UDP frames        -> sync output, frames go out
 *   2. UDP stops         -> output off AND a CMD_RESET is sent
 *   3. {"power":"OFF"}   -> stays off even while UDP keeps arriving
 *   4. mode back to sync -> the stream resumes
 *
 * The synthetic z2m is a MIRROR: the counts printed below are taken from the
 * fake endpoint in memory, so the WebSocket is optional. Point `Z2M_WS` at a
 * rig when you also want to inspect the bytes on the other side.
 *
 * usage: [Z2M_WS=ws://host:8080/api] node tools/extsim.mjs
 */

import dgram from "node:dgram";

import HueLink from "../extension/huelink.mjs";
import { CONFIG } from "../extension/huelink-lib/config.mjs";
import { MODE_LABEL } from "../extension/huelink-lib/huelink-ui.mjs";

const WS = process.env.Z2M_WS ?? "ws://127.0.0.1:8080/api";
const DEVICE = process.env.Z2M_DEVICE ?? "lightstrip_test";
const BASE = "zigbee2mqtt";
/** The port the extension really listens on, not a second copy of the number. */
const UDP_PORT = CONFIG.udpPort;
const SET_TOPIC = `${BASE}/${CONFIG.name}/set`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sent = [];
const published = [];

function stubs(sock) {
    const send = (payload) => sock?.send(JSON.stringify({ topic: `${DEVICE}/set`, payload }));

    const endpoint = {
        zclCommand(cluster, command, payload, options) {
            sent.push(command);
            send({ zclcommand: { cluster, command, payload, frametype: 1, options } });
        },
        write(cluster, payload, options) {
            sent.push("write");
            const [attr, spec] = Object.entries(payload)[0];
            send({
                write: {
                    cluster,
                    payload: { [attr]: { ...spec, manufacturerCode: options.manufacturerCode } },
                },
            });
        },
    };

    let mqttHandler = null;

    return {
        zigbee: {
            resolveEntity: () => ({
                zh: { networkAddress: 0x1001 },
                endpoint: () => endpoint,
            }),
        },
        mqtt: {
            publish: async (topic, payload, opts = {}) => {
                published.push([`${opts.baseTopic ?? BASE}/${topic}`, payload]);
            },
        },
        eventBus: {
            onMQTTMessage: (_key, cb) => {
                mqttHandler = cb;
            },
            // The extension's second power path, for an off that arrives from a
            // wall switch rather than over MQTT. Accepted but never driven here:
            // every command below is sent the MQTT way on purpose.
            onPublishEntityState: () => {},
            removeListeners: () => {
                mqttHandler = null;
            },
        },
        settings: {
            get: () => ({ mqtt: { base_topic: BASE }, homeassistant: {} }),
        },
        /** z2m's state store; the strip is dark when the simulation starts. */
        state: { get: () => ({ state: "OFF" }) },
        /** The exposes echo back to z2m. Stubbed so that path runs, not throws. */
        publishEntityState: async () => {},
        logger: {
            info: (m) => console.log("  log:", m),
            error: (m) => console.log("  ERR:", m),
        },
        fire: (topic, message) => mqttHandler?.({ topic, message }),
    };
}

/** Hyperion udpraw: three bytes per segment, colours only. */
function udpFrame(seed) {
    const b = Buffer.alloc(CONFIG.segments * 3);
    for (let i = 0; i < CONFIG.segments; i++) {
        b[i * 3] = (seed + i * 20) % 256;
        b[i * 3 + 1] = (seed * 2 + i * 10) % 256;
        b[i * 3 + 2] = (255 - seed + i) % 256;
    }
    return b;
}

/** Connects to the mirror if there is one. A missing rig is not a failure. */
async function connect() {
    const sock = new WebSocket(WS);
    try {
        await new Promise((res, rej) => {
            sock.onopen = res;
            sock.onerror = (e) => rej(new Error(String(e.message || e)));
        });
        return sock;
    } catch (e) {
        console.log(`no synthetic z2m at ${WS} (${e.message}); counting in memory only`);
        return null;
    }
}

async function main() {
    const sock = await connect();

    const s = stubs(sock);
    const ext = new HueLink(
        s.zigbee, s.mqtt, s.state, s.publishEntityState,
        s.eventBus, null, null, null, s.settings, s.logger,
    );
    await ext.start();

    const tx = dgram.createSocket("udp4");
    const pump = (on) => {
        if (!on) return null;
        return setInterval(() => tx.send(udpFrame(Date.now() % 255), UDP_PORT, "127.0.0.1"), 30);
    };

    const show = (label) => {
        const frames = sent.filter((c) => c === 1).length;
        const resets = sent.filter((c) => c === 3).length;
        const maps = sent.filter((c) => c === 7).length;
        const writes = sent.filter((c) => c === "write").length;
        console.log(
            `${label}: output=${ext.output} armed=${ext.armed ?? "-"}`
            + ` frames=${frames} reset=${resets} segmap=${maps} write=${writes}`,
        );
        sent.length = 0;
    };

    console.log("\n1) Hyperion is sending UDP");
    let p = pump(true);
    // The extension makes no decisions during its settle window, so a count taken
    // inside it would report the silence rather than the stream. Waited out once.
    await sleep(CONFIG.startSettleMs + 300);
    sent.length = 0;
    await sleep(2000);
    show("   result");

    console.log("\n2) Hyperion stops");
    clearInterval(p);
    await sleep(2500);
    show("   result");

    // Power off is the one command that also disarms: without it the next UDP
    // frame would arm sync again and the strip would light itself back up.
    console.log("\n3) UDP resumes, but the strip is switched off");
    p = pump(true);
    await sleep(1000); // long enough for the arming to relight it, which is the point
    s.fire(SET_TOPIC, '{"power":"OFF"}');
    await sleep(500);
    // Counted only from here: the frames before the off are the relight, and
    // including them would hide the very thing this step is about.
    sent.length = 0;
    await sleep(1500);
    show("   result");

    console.log("\n4) Sync is selected again");
    s.fire(SET_TOPIC, JSON.stringify({ mode: MODE_LABEL.sync }));
    await sleep(1500);
    show("   result");

    clearInterval(p);
    tx.close();
    await ext.stop();
    await sleep(300);
    sock?.close();

    console.log("\nMQTT output:");
    for (const [topic, payload] of published) console.log(`  ${topic}  ${payload}`);
    process.exit(0);
}

main().catch((e) => {
    console.error("ERROR:", e);
    process.exit(1);
});
