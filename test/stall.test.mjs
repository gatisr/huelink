/**
 * StallWatch, Throttle, and the pacer's skip reason and send-charge cap.
 * Fake clock throughout; the real tick loop is covered in `breaker.test.mjs`.
 */

import { strict as assert } from "node:assert";
import test from "node:test";

import { MAX_CHARGE_MS, Pacer } from "../extension/huelink-lib/pacer.mjs";
import { STALL_MS, StallWatch, Throttle } from "../extension/huelink-lib/stallwatch.mjs";

/** Drive the watch the way `tick()` does: observe on a skip, `sent` on a frame. */
function run(watch, steps) {
    let report = null;
    for (const [at, kind, arg] of steps) {
        if (kind === "sent") report = watch.sent(at, arg) ?? report;
        else if (kind === "failed") watch.failed(at, arg);
        else watch.observe(at, kind);
    }
    return report;
}

test("the fps clock, a quiet picture and an ordinary gap are never a stall", () => {
    const w = new StallWatch();
    w.sent(1, 50); // a first frame to measure from
    // A 5 s still scene: nothing changed, so nothing was late.
    assert.equal(
        run(w, [
            [1000, "quiet"],
            [3000, "quiet"],
            [5000, "clock"],
            [5200, "sent", 50],
        ]),
        null,
    );
    // 5 fps: 200 ms of clock, then a 51 ms send.
    assert.equal(
        run(w, [
            [5350, "clock"],
            [5400, "window"],
            [5450, "sent", 51],
        ]),
        null,
    );
    assert.equal(w.stats().stalls, 0);
});

test("a slow send is attributed to the send, not to whatever was in force", () => {
    const w = new StallWatch();
    w.sent(1, 51);
    const report = run(w, [
        [100, "clock"],
        [900, "sent", 780], // decide at ~120, the send ran 780 ms
    ]);
    assert.ok(report, "780 ms of send is a stall");
    assert.equal(Math.round(report.causes.send), 780);
    assert.ok(report.totalMs > STALL_MS);
});

test("a budget lockout after a slow send is its own stall, with its own cause", () => {
    const w = new StallWatch();
    w.sent(1, 51);
    // Frame goes out and completes at t=1000 after a 800 ms send...
    const first = run(w, [[1000, "sent", 800]]);
    assert.ok(first && first.causes.send >= 799);
    // ...then the pacer holds frames back for ~800 ms on the budget.
    const second = run(w, [
        [1020, "budget"],
        [1500, "budget"],
        [1800, "sent", 51],
    ]);
    assert.ok(second, "an 800 ms lockout is a stall");
    assert.ok(second.causes.budget >= 700, `budget cause was ${second.causes.budget}`);
    assert.equal(w.stats().stalls, 2);
    assert.ok(w.stats().worstStallMs >= 800);
});

test("the pause after a failed frame is counted, and reported by the frame that gets through", () => {
    const w = new StallWatch();
    w.sent(1, 51);
    const report = run(w, [
        [300, "failed", 0], // 300 ms inside the failing send
        // backoff: tick returns early, nothing observes until the pause ends
        [1300, "clock"],
        [1350, "sent", 51],
    ]);
    assert.ok(report);
    assert.ok(report.causes.send >= 299, "the failed send itself");
    assert.ok(report.causes.backoff >= 999, `backoff cause was ${report.causes.backoff}`);
});

test("time before a failed send keeps its own cause", () => {
    const w = new StallWatch();
    w.sent(1, 51);
    // 500 ms held by the budget, then a send that started at 500 and failed at 600.
    const report = run(w, [
        [100, "budget"],
        [500, "budget"],
        [600, "failed", 500],
        [1700, "clock"],
        [1750, "sent", 51],
    ]);
    assert.ok(report.causes.budget >= 399, `budget cause was ${report.causes.budget}`);
    assert.ok(report.causes.send >= 99 && report.causes.send <= 151, `send cause was ${report.causes.send}`);
    assert.equal(w.stats().sendFailures, 1);
});

test("reset forgets the gap: a TV that was off for an hour is not a stall", () => {
    const w = new StallWatch();
    w.sent(1, 51);
    w.observe(100, "budget");
    w.reset();
    // First frame after the reset has nothing to measure from.
    assert.equal(w.sent(3_600_000, 51), null);
    assert.equal(w.stats().stalls, 0);
});

test("Throttle: first at once, then one per window, with the count left out", () => {
    const th = new Throttle(10_000);
    assert.deepEqual(th.hit(0), { held: 0 });
    assert.equal(th.hit(1), null);
    assert.deepEqual(th.hit(10_000), { held: 1 });
});

test("Pacer: lastSkip says why a frame was held back", () => {
    const pacer = new Pacer({ fps: 5 });
    const still = Array(7).fill({ r: 20, g: 20, b: 20 });
    const lit = Array(7).fill({ r: 250, g: 20, b: 20 });
    // Visible, but under the scene-cut threshold: it must wait for the clock.
    const nudge = Array(7).fill({ r: 50, g: 50, b: 50 });

    const first = pacer.decide(still, 1000);
    assert.ok(first);
    assert.equal(pacer.lastSkip, null);
    pacer.noteSent(first.perceptual, 51, 1000);

    assert.equal(pacer.decide(nudge, 1050), null);
    assert.equal(pacer.lastSkip, "clock");

    // Past the clock, with an unchanged picture: delta suppression.
    assert.equal(pacer.decide(still, 1300), null);
    assert.equal(pacer.lastSkip, "delta");

    // A budget this small is full after one capped send; a changed picture waits.
    const pacer2 = new Pacer({ fps: 5, occupancyBudget: 0.2 });
    const f = pacer2.decide(still, 1000);
    pacer2.noteSent(f.perceptual, 800, 1000);
    assert.equal(pacer2.decide(lit, 1300), null);
    assert.equal(pacer2.lastSkip, "budget");

    const s = pacer2.stats(1300);
    assert.equal(s.skippedBudget, 1);
    assert.equal(s.skippedDuty, s.skippedWindow + s.skippedBudget);
});

test("Pacer: one send is charged at most MAX_CHARGE_MS, but worstSendMs stays real", () => {
    const still = Array(7).fill({ r: 20, g: 20, b: 20 });

    const pacer = new Pacer({ fps: 5 });
    const f = pacer.decide(still, 1000);
    pacer.noteSent(f.perceptual, 6000, 7000); // a 6 s SRSP stall
    const s = pacer.stats(7000);
    assert.equal(s.worstSendMs, 6000);
    assert.equal(s.occupancyPct, (MAX_CHARGE_MS / 1000) * 100, "charged like a capped send");
    assert.equal(pacer.sendPrice, MAX_CHARGE_MS, "price is capped too");

    // At the cap and below, sends are charged in full.
    const p2 = new Pacer({ fps: 5 });
    const g = p2.decide(still, 1000);
    p2.noteSent(g.perceptual, 200, 1200);
    assert.equal(p2.sendPrice, 200);
    assert.equal(p2.stats(1200).occupancyPct, 20);
});
