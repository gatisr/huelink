/**
 * bytediff - proves our frame packer emits EXACTLY the bytes a real Bifrost
 * emits. We stand in for Hyperion and talk to Bifrost directly, because the
 * Hyperion driver rewrites the colour first; the method: `docs/TOOLS.md`.
 *
 * Every address here belongs to whatever rig you built, so all of them come
 * from the environment. The defaults are localhost and an empty area id: a
 * forgotten setting fails on your own machine rather than reaching a stranger.
 *
 * usage: BIFROST_HOST=... BIFROST_AREA=... Z2MFAKE_STATS=... node tools/bytediff.mjs
 */

import { readFileSync } from "node:fs";
import { dtls } from "node-dtls-client";
import { encodeFrame, MODE_SEGMENT } from "../extension/huelink-lib/huepack.mjs";

const BIFROST_HOST = process.env.BIFROST_HOST ?? "127.0.0.1";
const BIFROST_PORT = Number(process.env.BIFROST_PORT ?? 2100);
const PSK_IDENTITY = process.env.BIFROST_PSK_IDENTITY ?? "01010101-0202-0303-0404-050505050505";
const PSK_KEY = Buffer.from(process.env.BIFROST_PSK_KEY ?? "BifrostHueTlsKey", "ascii");
/** Entertainment configuration id. Every Bifrost install generates its own. */
const AREA = process.env.BIFROST_AREA ?? "";
/** Where the synthetic z2m writes down what it received. */
const STATS = process.env.Z2MFAKE_STATS ?? process.argv[2] ?? "stats.json";

// The strip's network address on the synthetic rig. Segment addrs are nwk + 0..6.
const NWK = Number(process.env.NWK ?? 0x1001);
const SEGMENTS = Number(process.env.SEGMENTS ?? 7);

const CASES = [
    {
        name: "all 7 identical (warm white)",
        leds: Array.from({ length: SEGMENTS }, () => [255, 170, 90]),
    },
    {
        name: "7 DISTINCT segments (rainbow)",
        leds: [
            [255, 0, 0],
            [255, 128, 0],
            [255, 255, 0],
            [0, 255, 0],
            [0, 128, 255],
            [60, 0, 255],
            [200, 0, 200],
        ],
    },
    {
        name: "edges: black, white, pure primaries",
        leds: [
            [0, 0, 0],
            [255, 255, 255],
            [255, 0, 0],
            [0, 255, 0],
            [0, 0, 255],
            [1, 1, 1],
            [254, 254, 0],
        ],
    },
    {
        name: "dark and nearly identical shades",
        leds: [
            [10, 0, 0],
            [0, 10, 0],
            [0, 0, 10],
            [7, 7, 7],
            [12, 11, 10],
            [3, 200, 3],
            [128, 128, 127],
        ],
    },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A Hue Entertainment v2 packet: 16B header, 36B ASCII UUID, then channels
 * (u8 channel number + r,g,b u16 BE). Bifrost keeps only the high byte, so an
 * 8-bit colour is carried as `r << 8` and comes back unchanged.
 */
function huePacket(seq, leds) {
    const head = Buffer.alloc(16);
    head.write("HueStream", 0, "ascii");
    head[9] = 0x02;
    head[10] = 0x00;
    head[11] = seq & 0xff;
    head.writeUInt16BE(0, 12);
    head[14] = 0x00; // RGB
    head[15] = 0x00;

    const area = Buffer.from(AREA, "ascii");
    const body = Buffer.alloc(leds.length * 7);
    leds.forEach(([r, g, b], i) => {
        const o = i * 7;
        body[o] = i;
        body.writeUInt16BE(r << 8, o + 1);
        body.writeUInt16BE(g << 8, o + 3);
        body.writeUInt16BE(b << 8, o + 5);
    });

    return Buffer.concat([head, area, body]);
}

function connect() {
    return new Promise((resolve, reject) => {
        const sock = dtls.createSocket({
            type: "udp4",
            address: BIFROST_HOST,
            port: BIFROST_PORT,
            psk: { [PSK_IDENTITY]: PSK_KEY },
            timeout: 5000,
            ciphers: ["TLS_PSK_WITH_AES_128_GCM_SHA256", "TLS_PSK_WITH_AES_128_CBC_SHA256"],
        });
        sock.on("connected", () => resolve(sock));
        sock.on("error", (e) => reject(e));
    });
}

/**
 * Bifrost only accepts frames once the entertainment area is in streaming mode
 * (normally Hyperion's job, over the Hue REST API).
 */
async function setStreaming(action) {
    const res = await fetch(
        `http://${BIFROST_HOST}/clip/v2/resource/entertainment_configuration/${AREA}`,
        {
            method: "PUT",
            headers: {
                "hue-application-key": PSK_IDENTITY,
                "content-type": "application/json",
            },
            body: JSON.stringify({ action }),
        },
    );
    if (!res.ok) throw new Error(`entertainment ${action} failed: ${res.status}`);
}

function readStats() {
    return JSON.parse(readFileSync(STATS, "utf8"));
}

/** Waits until the frame z2mfake recorded is both new AND stable. */
async function settledFrame(before, tries = 30) {
    let prev = null;
    let stable = 0;
    for (let i = 0; i < tries; i++) {
        await sleep(500);
        let hex;
        try {
            hex = readStats().last_frame_hex;
        } catch {
            continue;
        }
        if (!hex || hex === before) continue;
        // The counter (first 4 bytes) and smoothing keep moving; it is the
        // colour part that has to settle.
        const body = hex.slice(12);
        if (body === prev) {
            stable += 1;
            if (stable >= 2) return hex;
        } else {
            stable = 0;
            prev = body;
        }
    }
    throw new Error("the Bifrost frame never settled");
}

async function main() {
    if (!AREA) {
        console.error("BIFROST_AREA is required: the entertainment configuration id to stream to");
        process.exit(2);
    }
    await setStreaming("start");
    const sock = await connect();
    console.log("DTLS session with Bifrost open");

    let seq = 0;
    let streaming = null;

    // A continuous background stream: the Bifrost session lives while frames flow.
    let current = CASES[0].leds;
    let alive = true;
    const pump = (async () => {
        while (alive) {
            sock.send(huePacket(seq++, current));
            await sleep(25);
        }
    })();
    streaming = pump;

    let pass = 0;
    let fail = 0;

    for (const tc of CASES) {
        const before = (() => { try { return readStats().last_frame_hex; } catch { return null; } })();
        current = tc.leds;

        const hex = await settledFrame(before);
        const data = Buffer.from(hex, "hex");
        const counter = data.readUInt32LE(0);
        const smoothing = data.readUInt16LE(4);

        const lights = tc.leds.map((c, i) => ({
            addr: NWK + i,
            color: { r: c[0], g: c[1], b: c[2] },
            mode: MODE_SEGMENT,
        }));
        const mine = Buffer.from(encodeFrame(counter, smoothing, lights));

        const ok = mine.equals(data);
        console.log(`\n=== ${tc.name}`);
        console.log(`  input   : ${tc.leds.map((c) => c.join("/")).join("  ")}`);
        console.log(`  Bifrost : ${data.toString("hex")}`);
        console.log(`  ours    : ${mine.toString("hex")}`);
        if (ok) {
            console.log("  RESULT: IDENTICAL (byte for byte)");
            pass += 1;
        } else {
            fail += 1;
            console.log("  RESULT: DIFFERENT");
            const n = Math.max(mine.length, data.length);
            for (let i = 0; i < n; i++) {
                if (mine[i] !== data[i]) {
                    console.log(`    byte ${i}: bifrost=${data[i]} ours=${mine[i]}`);
                }
            }
        }
    }

    alive = false;
    await streaming;
    sock.close();
    await setStreaming("stop");
    console.log(`\n=== total: ${pass} identical, ${fail} different`);
    process.exit(fail ? 1 : 0);
}

main().catch((e) => {
    console.error("ERROR:", e.message);
    process.exit(2);
});
