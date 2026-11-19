/**
 * burstbench - what the token bucket costs the rest of the house.
 *
 * The question the burst raises is not "is the strip smoother", which anyone
 * can see, but "does pressing a wall switch get slower while it happens". This
 * answers that, with the same content fed to the same real `Pacer` twice, once
 * with `burstFps: 0` and once with the burst on, so the two columns differ by
 * one setting and nothing else.
 *
 * IT IS A SIMULATION, and says so rather than pretending otherwise. The
 * coordinator is modelled as what ZNP actually is: a single server with one
 * outstanding request, each of our frames occupying it for `SEND_MS`. That
 * model is worth something because its one input is measured
 * (`avgSendMs` = 51.2 ms median over 135 samples, docs/PACING.md) and because
 * the quantity it produces, "how long a foreign command waits for our frame to
 * finish", is bounded by that same number. It is worth nothing as a claim
 * about radio behaviour, retries or a congested mesh: for those, run
 * `tools/fpsrun.mjs` against the real rig.
 *
 * The wait distribution is sampled at EVERY tick, not at random times, which
 * is the same thing as a uniformly arriving press and has no RNG noise in it.
 *
 * usage: node tools/burstbench.mjs [seconds] [burstFps]
 *        SEND_MS=51 TICK_MS=20 CUT_S=4 node tools/burstbench.mjs 300 12
 */

import { DEFAULTS, Pacer } from "../extension/lib/pacer.mjs";

/** Measured cost of one frame on the coordinator. The one real input. */
const SEND_MS = Number(process.env.SEND_MS ?? 51);
/** The extension's loop period: how often a frame is OFFERED to the pacer. */
const TICK_MS = Number(process.env.TICK_MS ?? 20);
/** Mean seconds between scene cuts. Film averages one every 4-6 s. */
const CUT_S = Number(process.env.CUT_S ?? 4);
/**
 * Colour units per second WITHIN a shot, out of 255.
 *
 * This is the input the result is most sensitive to, so it is a knob rather
 * than a buried constant. A pure random walk is the wrong model and was the
 * first thing this bench got wrong: steps that cancel leave the colour where
 * it started, delta suppression eats everything, and the stream idles at 1 fps
 * no matter what the limiter is set to. Real shots TRAVEL: a pan, a fade, a
 * face turning to the light. So each shot gets a velocity and keeps it.
 *
 * 60 units/s is a moderate pan, roughly a quarter of the range per second. At
 * that speed ordinary frames clear the perceptual threshold and the fps cap is
 * what binds, which is the regime worth measuring.
 */
const DRIFT = Number(process.env.DRIFT ?? 60);
/**
 * Resolution of the press-wait distribution, in ms. 1 ms is a uniformly
 * arriving press to any precision anyone cares about, and costs one array.
 */
const SAMPLE_MS = 1;

const seconds = Number(process.argv[2] ?? 300);
const burstFps = Number(process.argv[3] ?? 12);

/** Deterministic PRNG, so the two runs see the identical film. */
function rng(seed) {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
    };
}

/**
 * Synthetic film: shots that travel, separated by cuts.
 *
 * Two properties matter and nothing else does. The cuts have to be large
 * enough to cross `bigChangeThreshold`, or the fast path never fires and the
 * burst has nothing to trigger it. The movement within a shot has to be fast
 * enough to clear the perceptual threshold at the frame cap, or delta
 * suppression answers every question before the limiter gets to, and every
 * setting looks identical.
 *
 * It is deliberately NOT a strobe. A limiter looks free on content that
 * changes completely every tick, because there is nothing left to suppress,
 * and that would flatter the burst for the wrong reason.
 */
function film(seed, totalMs) {
    const rnd = rng(seed);
    const frames = [];
    /** Per-tick travel, from the per-second figure. */
    const step = (DRIFT * TICK_MS) / 1000;
    const velocity = () => {
        // A direction on the cube, times the shot's own pace (half to full).
        const dir = [rnd() - 0.5, rnd() - 0.5, rnd() - 0.5];
        const len = Math.hypot(...dir) || 1;
        const pace = step * (0.5 + rnd() * 0.5);
        return dir.map((d) => (d / len) * pace);
    };
    let base = [rnd() * 255, rnd() * 255, rnd() * 255];
    let vel = velocity();
    let nextCut = CUT_S * 1000 * rnd();
    for (let t = 0; t <= totalMs; t += TICK_MS) {
        if (t >= nextCut) {
            base = [rnd() * 255, rnd() * 255, rnd() * 255];
            vel = velocity();
            // Exponential gaps, so cuts cluster the way they really do.
            nextCut = t - Math.log(1 - rnd()) * CUT_S * 1000;
        } else {
            base = base.map((v, i) => {
                const next = v + vel[i];
                // Bounce off the ends rather than clamping: a shot that walks
                // into black and sticks there is a shot that stops moving.
                if (next < 0 || next > 255) vel[i] = -vel[i];
                return Math.min(255, Math.max(0, v + vel[i]));
            });
        }
        frames.push(
            Array.from({ length: 7 }, (_, i) => ({
                r: Math.round(Math.min(255, Math.max(0, base[0] + i * 3))),
                g: Math.round(Math.min(255, Math.max(0, base[1] - i * 2))),
                b: Math.round(Math.min(255, Math.max(0, base[2] + i))),
            })),
        );
    }
    return frames;
}

const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0);

/**
 * One run over the given film.
 *
 * `busyUntil` is the whole coordinator model. While it is in the future the
 * port is held by our frame, which is also why no new frame is offered then:
 * the real `tick()` returns early while `this.sending` is true.
 */
function run(frames, opts) {
    const pacer = new Pacer(opts);
    let busyUntil = 0;
    let pending = null;

    const waits = [];
    const occ = [];
    let sent = 0;
    let lastCut = -Infinity;
    /** Waits sampled within one second of a cut: the moment people ask about. */
    const waitsAfterCut = [];

    for (let i = 0; i < frames.length; i++) {
        const now = i * TICK_MS;

        // The send that was in flight has landed.
        if (pending && now >= busyUntil) {
            pacer.noteSent(pending.perceptual, SEND_MS, busyUntil, pending.fast);
            pending = null;
            sent++;
        }

        if (!pending) {
            const decision = pacer.decide(frames[i], now);
            if (decision) {
                if (decision.fast) lastCut = now;
                pending = decision;
                busyUntil = now + SEND_MS;
            }
        }

        // What a wall switch press would wait for, sampled ACROSS the tick and
        // after the decision, not only at the tick boundary. Sampling on the
        // tick grid alone quietly understates the worst case: a send started at
        // the top of a tick is already TICK_MS old by the next sample, so a
        // 51 ms frame can never show a wait above 31 ms and the one number
        // people actually care about comes out a whole tick too small.
        // Nothing here changes between ticks, so the sub-samples are exact.
        for (let d = 0; d < TICK_MS; d += SAMPLE_MS) {
            const at = now + d;
            const wait = busyUntil > at ? busyUntil - at : 0;
            waits.push(wait);
            if (at - lastCut <= 1000) waitsAfterCut.push(wait);
        }

        // Occupancy as the pacer itself sees it, once a second.
        if (now % 1000 === 0) occ.push(pacer.occupancy(now));
    }

    const sortedWaits = [...waits].sort((a, b) => a - b);
    const sortedOcc = [...occ].sort((a, b) => a - b);
    const stats = pacer.stats(frames.length * TICK_MS);
    return {
        fps: Math.round((sent / ((frames.length * TICK_MS) / 1000)) * 100) / 100,
        sent,
        bursts: stats.bursts,
        burstFrames: stats.burstFrames,
        creditMs: stats.creditMs,
        occMean: Math.round((occ.reduce((a, b) => a + b, 0) / occ.length) * 1000) / 10,
        occP95: Math.round(pct(sortedOcc, 0.95) * 1000) / 10,
        waitedPct: Math.round((waits.filter((w) => w > 0).length / waits.length) * 1000) / 10,
        waitMean: Math.round((waits.reduce((a, b) => a + b, 0) / waits.length) * 10) / 10,
        waitP95: Math.round(pct(sortedWaits, 0.95) * 10) / 10,
        // From the sorted copy, not `Math.max(...waits)`: spreading a
        // 300k-element array into a call blows the stack.
        waitMax: Math.round(sortedWaits[sortedWaits.length - 1] * 10) / 10,
        cutWaitMean:
            waitsAfterCut.length
                ? Math.round((waitsAfterCut.reduce((a, b) => a + b, 0) / waitsAfterCut.length) * 10) / 10
                : 0,
    };
}

const frames = film(20260101, seconds * 1000);
const base = { fps: DEFAULTS.fps, occupancyBudget: DEFAULTS.occupancyBudget };

const off = run(frames, { ...base, burstFps: 0 });
const on = run(frames, { ...base, burstFps, maxFps: Math.max(DEFAULTS.maxFps, burstFps) });

const rows = [
    ["frames sent", off.sent, on.sent],
    ["fps (whole run)", off.fps, on.fps],
    ["bursts started", off.bursts, on.bursts],
    ["frames paid from the bucket", off.burstFrames, on.burstFrames],
    ["credit left (coordinator ms)", off.creditMs, on.creditMs],
    ["occupancy mean %", off.occMean, on.occMean],
    ["occupancy p95 %", off.occP95, on.occP95],
    // Equal to the occupancy mean above by construction, and printed anyway:
    // that line is the pacer's OWN accounting, this one is counted
    // independently from the wait samples. When the two drift apart, the
    // pacer's published occupancy is lying and that is worth seeing.
    ["a press hits a busy port, % (= occ mean)", off.waitedPct, on.waitedPct],
    ["press wait mean, ms", off.waitMean, on.waitMean],
    ["press wait p95, ms", off.waitP95, on.waitP95],
    ["press wait WORST, ms", off.waitMax, on.waitMax],
    ["press wait mean within 1 s of a cut, ms", off.cutWaitMean, on.cutWaitMean],
];

console.log(
    `burstbench: ${seconds}s of synthetic film, cut every ~${CUT_S}s, drift ${DRIFT} units/s, ` +
        `send cost ${SEND_MS} ms, tick ${TICK_MS} ms, budget ${base.occupancyBudget}`,
);
console.log(`${"".padEnd(40)}  ${"burst off".padStart(10)}  ${`burst ${burstFps}`.padStart(10)}`);
for (const [label, a, b] of rows) {
    console.log(`${label.padEnd(40)}  ${String(a).padStart(10)}  ${String(b).padStart(10)}`);
}
console.log(
    "\nThe worst wait is one frame either way: the hard per-window cap means at most\n" +
        "`dutyCap` of our frames can be queued ahead of anyone else at any instant, and the\n" +
        "burst does not touch it. What the burst changes is how OFTEN a press meets a busy\n" +
        "port, which is the occupancy line, and only for as long as the bucket lasts.",
);
