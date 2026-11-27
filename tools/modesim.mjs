/**
 * modesim - mode priority, and the handover back to ordinary z2m control.
 * Like `extsim.mjs` it runs the REAL extension class; see `docs/TOOLS.md`.
 *
 * The claim under test: a chosen effect overrides Hyperion sync, and choosing
 * sync again lets Hyperion resume without the stream ever breaking.
 *
 * Nothing here spells out an effect or a mode name. Both come from the running
 * extension (discovery payloads, `MODE_LABEL`), so this checks BEHAVIOUR and
 * keeps passing in any locale and after any edit to `effects.json`.
 *
 * The synthetic z2m is a MIRROR, not the measurement: every check below reads
 * the frames the extension handed to the fake endpoint, in memory. So the
 * WebSocket is optional, and without one the checks still run and still mean
 * the same thing. Point `Z2M_WS` at a rig when you want to inspect the bytes
 * that went out on the other side as well.
 *
 * usage: [Z2M_WS=ws://host:8080/api] node tools/modesim.mjs
 */

import dgram from "node:dgram";

import HueLink from "../extension/huelink.mjs";
import { CONFIG } from "../extension/huelink-lib/config.mjs";
import { MODE_LABEL } from "../extension/huelink-lib/huelink-ui.mjs";
import { t } from "../extension/huelink-lib/i18n/index.mjs";

const WS = process.env.Z2M_WS ?? "ws://127.0.0.1:8080/api";
const DEVICE = process.env.Z2M_DEVICE ?? "lightstrip_test";
const BASE = "zigbee2mqtt";
/** The port the extension really listens on, not a second copy of the number. */
const UDP_PORT = CONFIG.udpPort;
const SET_TOPIC = `${BASE}/${CONFIG.name}/set`;
const STATE_TOPIC = `${BASE}/${CONFIG.name}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * How long each measured window lasts, and how many frames one must contain to
 * count as "the stream is running".
 *
 * The floor is derived from `CONFIG.fps`, never written as a number: the pacer
 * is allowed to send FEWER frames than asked (delta suppression, occupancy
 * budget), so the bar is half the theoretical count. A fixed `> 20` would have
 * measured the configuration rather than the behaviour, and would fail on every
 * install whose `fps` is not the one this file was written on.
 */
const WINDOW_MS = 2000;
const MIN_FRAMES = Math.max(2, Math.floor((CONFIG.fps * WINDOW_MS) / 1000 / 2));

const log = [];
const published = [];
let fail = 0;

function check(label, cond, detail = "") {
    if (!cond) fail++;
    console.log(`   ${cond ? "OK    " : "FAILED"} ${label}${detail ? `  (${detail})` : ""}`);
}

/** Independent frame decoder, same as in effectproof.mjs. */
function decode(data) {
    const out = [];
    for (let i = 6; i + 7 <= data.length; i += 7) {
        out.push({
            addr: data[i] | (data[i + 1] << 8),
            bri: (data[i + 2] | (data[i + 3] << 8)) >> 5,
            xy: `${data[i + 4]},${data[i + 5]},${data[i + 6]}`,
        });
    }
    return out;
}

function stubs(sock) {
    const send = (payload) => sock?.send(JSON.stringify({ topic: `${DEVICE}/set`, payload }));
    const endpoint = {
        zclCommand(cluster, command, payload, options) {
            log.push({ command, data: payload.data });
            send({ zclcommand: { cluster, command, payload, frametype: 1, options } });
        },
        write(cluster, payload, options) {
            log.push({ command: "write" });
            const [attr, spec] = Object.entries(payload)[0];
            send({ write: { cluster, payload: { [attr]: { ...spec, manufacturerCode: options.manufacturerCode } } } });
        },
    };
    let mqttHandler = null;
    return {
        zigbee: { resolveEntity: () => ({ zh: { networkAddress: 0x1001 }, endpoint: () => endpoint }) },
        mqtt: {
            publish: async (topic, payload, opts = {}) => {
                published.push([`${opts.baseTopic ?? BASE}/${topic}`, payload]);
            },
        },
        eventBus: {
            onMQTTMessage: (_k, cb) => (mqttHandler = cb),
            // The extension's second power path, for an off that arrives from a
            // wall switch rather than over MQTT. Accepted but never driven here:
            // every command below is sent the MQTT way on purpose.
            onPublishEntityState: () => {},
            removeListeners: () => (mqttHandler = null),
        },
        settings: { get: () => ({ mqtt: { base_topic: BASE }, homeassistant: {} }) },
        /** z2m's state store; the strip is dark when the simulation starts. */
        state: { get: () => ({ state: "OFF" }) },
        /** The exposes echo back to z2m. Stubbed so that path runs, not throws. */
        publishEntityState: async () => {},
        logger: { info: () => {}, error: (m) => console.log("  ERR:", m) },
        fire: (msg) => mqttHandler?.({ topic: SET_TOPIC, message: msg }),
        plainSet: (payload) => send(payload),
    };
}

/**
 * Hyperion udpraw. Segment 0 is a fixed red: that is the SIGNATURE the checks
 * below recognise Hyperion's output by.
 *
 * The other segments move, because a television picture moves. A wholly static
 * feed would be suppressed by the pacer's delta filter, correctly, and the
 * frame counts would then measure that filter rather than whether sync runs.
 */
function udpFrame() {
    const b = Buffer.alloc(CONFIG.segments * 3);
    b[0] = 200;
    b[1] = 10;
    b[2] = 10;
    const phase = Date.now() / 200;
    for (let i = 1; i < CONFIG.segments; i++) {
        b[i * 3] = Math.floor(127 + 120 * Math.sin(phase + i));
        b[i * 3 + 1] = Math.floor(127 + 120 * Math.sin(phase + i + 2));
        b[i * 3 + 2] = Math.floor(127 + 120 * Math.sin(phase + i + 4));
    }
    return b;
}

/** Since the last call: frame count, reset count, and the last frame. */
function take() {
    const frames = log.filter((e) => e.command === 1);
    const resets = log.filter((e) => e.command === 3).length;
    const last = frames.length ? decode(frames[frames.length - 1].data) : null;
    log.length = 0;
    return { frames: frames.length, resets, last };
}

const state = () => JSON.parse(published.filter(([t]) => t === STATE_TOPIC).pop()[1]);

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
        console.log(`no synthetic z2m at ${WS} (${e.message}); checking in memory only`);
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

    // Retired entities are published as an empty payload to remove them; only
    // the ones with a body are entities that exist.
    const disc = published
        .filter(([t, payload]) => t.startsWith("homeassistant/") && payload)
        .map(([t, payload]) => [t, JSON.parse(payload)]);
    const entity = (suffix) => disc.find(([t]) => t.endsWith(`/${suffix}/config`))?.[1];
    const modeSelect = entity("mode");
    const effectSelect = entity("effect");

    // Effect and mode names are never written out by hand: the catalogue is
    // data and it grows. Everything below is taken from what was published.
    const options = effectSelect.options;
    const FIRST = options[0];
    const SECOND = options[1];

    console.log("\n0) HA discovery");
    check("a mode select is published", Boolean(modeSelect));
    check("an effect select is published", Boolean(effectSelect));
    check(
        "the mode select offers Off plus exactly the modes the extension knows",
        modeSelect.options.join("|") === [t("status.off"), ...Object.values(MODE_LABEL)].join("|"),
        modeSelect.options.join(", "),
    );
    check("the effect select carries the whole catalogue", options.length >= 20, `${options.length} effects`);
    check(
        "every effect name is grouped by a prefix",
        options.every((o) => o.includes(": ")),
        options.filter((o) => !o.includes(": ")).join(", ") || "all prefixed",
    );
    check("both effect knobs are there", Boolean(entity("effect_brightness") && entity("effect_speed")));
    check("the status sensor is there", Boolean(entity("status")));

    const tx = dgram.createSocket("udp4");
    let pump = null;
    const hyperion = (on) => {
        if (pump) clearInterval(pump);
        pump = on ? setInterval(() => tx.send(udpFrame(), UDP_PORT, "127.0.0.1"), 30) : null;
    };

    // The extension makes no decisions during its settle window, so measuring
    // inside it would count the silence as a result. Waited out once, here.
    await sleep(CONFIG.startSettleMs + 300);

    console.log("\n1) Nothing is feeding");
    take();
    await sleep(WINDOW_MS);
    let r = take();
    check("nothing goes out", ext.output === "off", ext.output);
    check("but sync is armed, waiting for the TV", ext.armed === "sync", String(ext.armed));
    check("no frames go out", r.frames === 0, `${r.frames}`);

    console.log("\n2) Hyperion starts feeding");
    hyperion(true);
    await sleep(WINDOW_MS);
    r = take();
    check("output sync", ext.output === "sync", ext.output);
    check("frames go out", r.frames >= MIN_FRAMES, `${r.frames} of ${MIN_FRAMES} needed`);
    check("state says output=sync", state().output === "sync");
    const syncXy = r.last[0].xy;
    check("every segment is in the frame", r.last.length === CONFIG.segments, `${r.last.length}`);

    console.log("\n3) An effect is chosen while Hyperion still feeds  <- PRIORITY");
    s.fire(JSON.stringify({ effect: FIRST }));
    await sleep(200);
    s.fire(JSON.stringify({ mode: MODE_LABEL.effect }));
    await sleep(WINDOW_MS);
    r = take();
    check("output effect (the effect overrides sync)", ext.output === "effect", ext.output);
    check("frames go out", r.frames >= MIN_FRAMES, `${r.frames} of ${MIN_FRAMES} needed`);
    check(`state says effect=${FIRST}`, state().effect === FIRST);
    check("the colours are no longer Hyperion's", r.last[0].xy !== syncXy);
    check(
        "the segments differ from one another",
        new Set(r.last.map((x) => x.xy)).size >= 4,
        `${new Set(r.last.map((x) => x.xy)).size} distinct`,
    );
    check("the stream was not broken by the handover", r.resets === 0, `${r.resets} reset`);

    console.log("\n4) Sync is chosen again, Hyperion still feeds  <- SYNC RESUMES");
    s.fire(JSON.stringify({ mode: MODE_LABEL.sync }));
    await sleep(WINDOW_MS);
    r = take();
    check("output sync", ext.output === "sync", ext.output);
    check("Hyperion's colours are back", r.last[0].xy === syncXy);
    check("the stream was not broken", r.resets === 0, `${r.resets} reset`);

    console.log("\n5) The controls");
    s.fire(JSON.stringify({ effect: SECOND, effect_speed: 200, effect_brightness: 40 }));
    await sleep(200);
    s.fire(JSON.stringify({ mode: MODE_LABEL.effect }));
    await sleep(800);
    take();
    check("state says speed 200", state().effect_speed === 200);
    check("state says brightness 40", state().effect_brightness === 40);
    check("output effect", ext.output === "effect", ext.output);

    console.log("\n6) An unknown effect is refused, the chosen one survives");
    s.fire('{"effect":"NoSuchEffectAtAll"}');
    await sleep(900);
    take();
    check("the previous effect is still selected", state().effect === SECOND, state().effect);

    console.log("\n7) Everything quiet  <- HANDOVER BACK TO ORDINARY z2m CONTROL");
    s.fire(JSON.stringify({ mode: MODE_LABEL.sync }));
    await sleep(600);
    hyperion(false);
    await sleep(2000);
    r = take();
    check("nothing goes out", ext.output === "off", ext.output);
    check("a CMD_RESET went out", r.resets >= 1, `${r.resets}`);

    await sleep(800);
    r = take();
    check("no frames go out any more", r.frames === 0, `${r.frames}`);

    // An ordinary z2m command after the reset: it must reach the device uncontested.
    s.plainSet({ state: "ON", brightness: 128 });
    await sleep(800);
    r = take();
    check("an ordinary z2m command is not cut into by frames", r.frames === 0, `${r.frames}`);

    console.log("\n8) The TV comes back  <- THE STRIP RELIGHTS ITSELF");
    // Step 7 left the strip dark because the source fell silent, not because
    // anyone switched it off, so sync is armed. That is the whole point of
    // arming: one event, no second click.
    check("sync is armed after the stream ended", ext.armed === "sync", String(ext.armed));
    hyperion(true);
    await sleep(WINDOW_MS);
    r = take();
    check("output sync, with nobody having pressed anything", ext.output === "sync", ext.output);
    check("frames go out", r.frames >= MIN_FRAMES, `${r.frames} of ${MIN_FRAMES} needed`);

    console.log("\n9) Switched OFF by hand while Hyperion still feeds  <- NO SELF-RELIGHT");
    // The difference step 8 relies on: an off the USER asked for must not arm,
    // or the strip would light itself straight back up from the next frame.
    s.fire('{"power":"OFF"}');
    await sleep(WINDOW_MS);
    r = take();
    check("nothing goes out", ext.output === "off", ext.output);
    check("nothing is armed either", ext.armed === null, String(ext.armed));
    check("state says power=OFF", state().power === "OFF", state().power);
    take();
    await sleep(WINDOW_MS);
    r = take();
    check("and it stays dark while the frames keep arriving", r.frames === 0, `${r.frames}`);

    console.log("\n10) Choosing an effect switches the strip back on by itself");
    s.fire(JSON.stringify({ mode: MODE_LABEL.effect }));
    await sleep(WINDOW_MS);
    r = take();
    check("output effect", ext.output === "effect", ext.output);
    check("frames go out", r.frames >= MIN_FRAMES, `${r.frames} of ${MIN_FRAMES} needed`);

    hyperion(false);
    tx.close();
    await ext.stop();
    await sleep(400);
    r = take();
    check("stop() sends a CMD_RESET", r.resets >= 1, `${r.resets}`);
    sock?.close();

    console.log(`\n${fail === 0 ? "ALL STEPS OK" : `${fail} CHECKS FAILED`}`);
    process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
    console.error("ERROR:", e);
    process.exit(1);
});
