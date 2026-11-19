/**
 * effectproof - proves every effect really addresses all 7 segments.
 *
 * It measures the same byte array that would reach the strip: real engine, real
 * encoder, then an INDEPENDENT decoder written from the protocol description.
 * Why that, and why two criteria instead of one: `docs/TOOLS.md`.
 *
 * usage: node tools/effectproof.mjs [seconds]
 */

import { EffectEngine, loadEffects } from "../extension/lib/effects/index.mjs";
import { encodeFrame, segmentAddrs, smoothingFromMs } from "../extension/lib/huepack.mjs";

const SEGMENTS = 7;
const NWK = 0x1001;
const FPS = 25;
const SECONDS = Number(process.argv[2] ?? 8);
const SEED = 20261116; // fixed, so runs are comparable

const WIDE_X = 0.7347;
const WIDE_Y = 0.8264;

/*
 * The strip is a BIAS LIGHT BEHIND A TELEVISION, not room lighting. An effect
 * that is black for minutes does not read as subtle from the sofa, it reads as
 * broken, and the segment criteria above cannot see that: seven *different*
 * shades of nothing still count as seven segments.
 *
 * Both thresholds are on the DECODED brightness field (0..2047), because that
 * is what the strip is actually told, and because 8-bit rounding happens before
 * it: an effect can ask for "2 % of #1a0a14" and have the encoder deliver
 * literally nothing.
 */

// Visible at all. 64/2047 is an 8/255 channel: the dimmest level that still
// carries a colour rather than a rounding artefact.
const VISIBLE_BRI = 64;

// Lit enough to look deliberate. Mean over the 7 segments; 160/2047 is 20/255.
// Picked by measurement, not by taste: at this floor every effect in the
// catalogue measures 0.0 s except the two ramps that are dark ON PURPOSE, and
// the dimmest moods (`calm`, `fairies`, `birthday`) stay clear of it until 256.
const LIT_MEAN = 160;

// How long an effect may take to show anything after being selected. Picking an
// effect and watching nothing happen is the complaint this gates.
const VISIBLE_WITHIN = 2;

// How long the WHOLE strip may sit below `LIT_MEAN` in one stretch. The gap
// between two fireworks is fine; a minute of nothing is not.
const MAX_DIM_RUN = 30;

/**
 * Independent decoder: bytes back to (address, brightness, x, y). Written from
 * the protocol description, never calling the encoder's own helpers.
 */
function decodeFrame(bytes) {
    const b = Uint8Array.from(bytes);
    const counter = b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24);
    const smoothing = b[4] | (b[5] << 8);
    const records = [];
    for (let i = 6; i + 7 <= b.length; i += 7) {
        const addr = b[i] | (b[i + 1] << 8);
        const field = b[i + 2] | (b[i + 3] << 8);
        const x12 = b[i + 4] | ((b[i + 5] & 0x0f) << 8);
        const y12 = (b[i + 6] << 4) | (b[i + 5] >> 4);
        records.push({
            addr,
            brightness: field >> 5,
            mode: field & 0x1f,
            x: (x12 * WIDE_X) / 0xfff,
            y: (y12 * WIDE_Y) / 0xfff,
        });
    }
    return { counter, smoothing, records };
}

/** A segment's "signature" in a frame: rounded xy plus brightness. */
const sig = (r) => `${r.brightness}|${r.x.toFixed(3)}|${r.y.toFixed(3)}`;

function run(engine, name, seconds) {
    engine.select(name);
    const addrs = segmentAddrs(NWK, SEGMENTS);
    const smoothing = smoothingFromMs(1000 / FPS);

    const perFrameDistinct = [];
    const timelines = Array.from({ length: SEGMENTS }, () => []);
    const addrSeen = new Set();
    const modeSeen = new Set();
    let recordCounts = new Set();
    let timeToVisible = null; // seconds, or null if it never gets there
    let dimRun = 0; // current unbroken dim stretch, in samples
    let longestDimRun = 0;

    const t0 = 1_000_000; // synthetic time: independent of machine speed
    // The engine clamps dt at 0.25 s, so time must be stepped, not jumped:
    // real 1/FPS steps, sampling every k-th frame (see `docs/TOOLS.md`).
    const total = Math.round(seconds * FPS);
    const every = Math.max(1, Math.round(total / (SECONDS * FPS)));
    for (let f = 0; f < total; f++) {
        const colors = engine.frame(t0 + (f * 1000) / FPS);
        if (!colors) throw new Error(`effect '${name}' returned no frame`);
        if (f % every !== 0) continue;

        const lights = addrs.map((addr, i) => ({ addr, color: colors[i] }));
        const { records } = decodeFrame(encodeFrame(f, smoothing, lights));

        recordCounts.add(records.length);
        for (const r of records) {
            addrSeen.add(r.addr);
            modeSeen.add(r.mode);
        }
        records.forEach((r, i) => timelines[i].push(sig(r)));
        perFrameDistinct.push(new Set(records.map(sig)).size);

        // "Is anything on?" is the brightest segment, not the average: one lit
        // segment is already a visible strip.
        const brightest = Math.max(...records.map((r) => r.brightness));
        if (timeToVisible === null && brightest >= VISIBLE_BRI) timeToVisible = f / FPS;

        // "Does it look lit?" is the average: a single spark on an otherwise
        // black strip is not a bias light.
        const mean = records.reduce((s, r) => s + r.brightness, 0) / records.length;
        dimRun = mean < LIT_MEAN ? dimRun + 1 : 0;
        if (dimRun > longestDimRun) longestDimRun = dimRun;
    }

    // Is each segment's timeline unique? Two identical ones over the whole
    // window mean one of them is not actually driven on its own.
    const joined = timelines.map((tl) => tl.join(","));
    const uniqueTimelines = new Set(joined).size;

    return {
        name,
        frames: perFrameDistinct.length,
        records: [...recordCounts],
        addrs: addrSeen.size,
        segmentMode: [...modeSeen].every((m) => m === 0),
        frameBest: Math.max(...perFrameDistinct),
        frameMean: perFrameDistinct.reduce((a, c) => a + c, 0) / perFrameDistinct.length,
        uniqueTimelines,
        timeToVisible,
        // Samples are `every` frames apart, so a run of n samples is that long.
        longestDimRun: (longestDimRun * every) / FPS,
    };
}

const pad = (s, n) => String(s).padEnd(n);

async function main() {
    const effects = await loadEffects(console);
    if (!effects.length) throw new Error("effects.json yielded no effects");

    const engine = new EffectEngine({ effects, segments: SEGMENTS, seed: SEED });

    console.log(`\nEffect proof: ${SECONDS} s @ ${FPS} fps, ${SEGMENTS} segments, seed ${SEED}`);
    console.log("Measured on DECODED frame bytes, not on the generator output.\n");
    console.log(
        `${pad("effect", 26)}${pad("records", 9)}${pad("addrs", 7)}${pad("frame max", 11)}` +
            `${pad("frame mean", 12)}${pad("timelines", 11)}${pad("visible in", 12)}${pad("dim run", 10)}`,
    );
    console.log("-".repeat(106));

    let ok = true;
    for (const e of effects) {
        // Measured on the effect's own time scale: an 8 s window on a 900 s
        // sunrise would show seven identical segments and cry wolf.
        const seconds = e.preview?.seconds ?? SECONDS;
        // How many distinct segments this effect promises. 7 by default; a
        // lower bar needs a reason in the data (`proof.why`).
        const want = e.proof?.minDistinct ?? SEGMENTS;
        // How long this effect may stay dark. Longer than the default needs a
        // reason in the data too, so "it is meant to be dark" cannot be a
        // special case buried in the tool.
        const dimBudget = e.proof?.maxDimRunSeconds ?? MAX_DIM_RUN;
        const r = run(engine, e.name, seconds);
        const visible = r.timeToVisible !== null && r.timeToVisible <= VISIBLE_WITHIN;
        const lit = r.longestDimRun <= dimBudget;
        const pass =
            r.records.length === 1 &&
            r.records[0] === SEGMENTS &&
            r.addrs === SEGMENTS &&
            r.segmentMode &&
            r.uniqueTimelines >= want &&
            r.frameBest >= want &&
            visible &&
            lit;
        ok &&= pass;
        const seen = r.timeToVisible === null ? "never" : `${r.timeToVisible.toFixed(1)} s`;
        console.log(
            `${pad(r.name, 26)}${pad(r.records.join("/"), 9)}${pad(`${r.addrs}/7`, 7)}` +
                `${pad(`${r.frameBest}/7`, 11)}${pad(r.frameMean.toFixed(2), 12)}` +
                `${pad(`${r.uniqueTimelines}/7`, 11)}${pad(`${seen}${visible ? "" : " !"}`, 12)}` +
                `${pad(`${r.longestDimRun.toFixed(1)} s${lit ? "" : " !"}`, 10)}${pass ? "OK" : "FAILED"}`,
        );
    }

    console.log("\nCriteria: 7 records per frame, 7 distinct addresses, mode=Segment,");
    console.log("7 unique segment timelines, and at least one frame with 7 distinct colours.");
    console.log(`Plus, because the strip is a bias light behind a TV, not room lighting:`);
    console.log(`  visible in - first frame with any segment >= ${VISIBLE_BRI}/2047; must be <= ${VISIBLE_WITHIN} s`);
    console.log(`  dim run    - longest stretch with the 7-segment mean < ${LIT_MEAN}/2047; <= ${MAX_DIM_RUN} s`);
    console.log("Each effect is measured on its OWN time scale (effects.json `preview.seconds`).");
    const relaxed = effects.filter((e) => e.proof?.minDistinct || e.proof?.maxDimRunSeconds);
    if (relaxed.length) {
        console.log("\nLower bar (deliberate, with a reason in the data):");
        for (const e of relaxed) {
            const bars = [
                e.proof.minDistinct ? `>=${e.proof.minDistinct}/7 segments` : null,
                e.proof.maxDimRunSeconds ? `dim run <= ${e.proof.maxDimRunSeconds} s` : null,
            ].filter(Boolean);
            console.log(`  ${e.name} (${bars.join(", ")}) - ${e.proof.why}`);
        }
    }

    // Speed and brightness controls, checked on a single effect.
    const probe = effects[0].name;
    engine.setSpeed(100);
    engine.setBrightness(100);
    engine.select(probe);
    const slow = [];
    for (let f = 0; f < 50; f++) slow.push(engine.frame(1_000_000 + f * 40)[0]);
    engine.select(probe);
    engine.setSpeed(300);
    const fast = [];
    for (let f = 0; f < 50; f++) fast.push(engine.frame(1_000_000 + f * 40)[0]);
    const travel = (a) => a.reduce((s, c, i) => (i ? s + Math.abs(c.r - a[i - 1].r) : 0), 0);
    engine.select(probe);
    engine.setSpeed(100);
    engine.setBrightness(25);
    const dim = [];
    for (let f = 0; f < 50; f++) dim.push(engine.frame(1_000_000 + f * 40)[0]);

    const mean = (a) => a.reduce((s, c) => s + c.r + c.g + c.b, 0) / a.length;
    console.log(`\nControls (on '${probe}', segment 1, 2 s):`);
    console.log(`  speed 100% -> colour travel ${travel(slow).toFixed(0)}`);
    console.log(`  speed 300% -> colour travel ${travel(fast).toFixed(0)}  (must be larger)`);
    console.log(`  brightness 100% -> mean ${mean(slow).toFixed(1)}`);
    console.log(`  brightness  25% -> mean ${mean(dim).toFixed(1)}  (must be ~4x smaller)`);

    const knobsOk = travel(fast) > travel(slow) * 1.5 && mean(dim) < mean(slow) * 0.4;
    console.log(`\n${ok && knobsOk ? "ALL EFFECTS OK" : "SOMETHING FAILED"}`);
    process.exit(ok && knobsOk ? 0 : 1);
}

main().catch((e) => {
    console.error("ERROR:", e);
    process.exit(1);
});
