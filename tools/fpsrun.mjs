/**
 * fpsrun - how many frames per second our path actually sustains.
 *
 * Measures frames reaching the synthetic z2m, the same way the Bifrost
 * measurement was taken, so the numbers are comparable. It does NOT measure
 * Zigbee radio throughput: see `docs/TOOLS.md` and `docs/PACING.md`.
 *
 * usage: Z2M_WS=ws://host:8080/api node tools/fpsrun.mjs [fps] [seconds]
 */

import { HueStream } from "../extension/huelink-lib/huestream.mjs";

/** The synthetic z2m's WebSocket API; add `?token=...` if yours asks for one. */
const WS = process.env.Z2M_WS ?? "ws://127.0.0.1:8080/api";
const DEVICE = process.env.Z2M_DEVICE ?? "lightstrip_test";
const NWK = Number(process.env.NWK ?? 0x1001);

const targetFps = Number(process.argv[2] ?? 30);
const seconds = Number(process.argv[3] ?? 20);

/** Transport: the z2m MQTT API over WebSocket, exactly as Bifrost does it. */
function wsTransport(sock) {
    const send = (payload) =>
        sock.send(JSON.stringify({ topic: `${DEVICE}/set`, payload }));
    return {
        zclCommand: (cmd) => send({ zclcommand: cmd }),
        writeAttribute: (attr) =>
            send({
                write: {
                    cluster: attr.cluster,
                    payload: {
                        [attr.attribute]: {
                            manufacturerCode: attr.options.manufacturerCode,
                            type: attr.type,
                            value: attr.value,
                        },
                    },
                },
            }),
    };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
    const sock = new WebSocket(WS);
    await new Promise((res, rej) => {
        sock.onopen = res;
        sock.onerror = (e) => rej(new Error(String(e.message || e)));
    });

    const stream = new HueStream({
        transport: wsTransport(sock),
        networkAddress: NWK,
        segments: 7,
        smoothingMs: Math.round(1000 / targetFps),
    });

    await stream.start();

    const period = 1000 / targetFps;
    const t0 = Date.now();
    let sent = 0;
    let next = t0;

    while (Date.now() - t0 < seconds * 1000) {
        // A moving colour, so nothing along the way optimises identical frames away.
        const phase = (Date.now() - t0) / 1000;
        const colors = Array.from({ length: 7 }, (_, i) => {
            const v = Math.floor(127 + 127 * Math.sin(phase * 2 + i));
            return { r: v, g: 255 - v, b: (v * 2) % 256 };
        });
        await stream.frame(colors);
        sent += 1;
        next += period;
        const wait = next - Date.now();
        if (wait > 0) await sleep(wait);
    }

    const elapsed = (Date.now() - t0) / 1000;
    await stream.stop();
    await sleep(500);
    sock.close();

    console.log(`target  : ${targetFps} fps`);
    console.log(`sent    : ${sent} frames in ${elapsed.toFixed(2)} s`);
    console.log(`sender  : ${(sent / elapsed).toFixed(2)} fps`);
    console.log("on the z2m side see z2mfake/stats.json -> ent_fps_mean");
}

main().catch((e) => {
    console.error("ERROR:", e.message);
    process.exit(1);
});
