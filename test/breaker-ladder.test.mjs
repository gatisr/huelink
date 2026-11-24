/**
 * The breaker's retry ladder as pure state: no radio, no clock, no harness.
 * The end-to-end behaviour (what a trip does to the strip) is in breaker.test.mjs.
 */

import { strict as assert } from "node:assert";
import test from "node:test";

import { Breaker, MAX_AUTO_TRIP_STREAK, RECOVERY_FRAMES, TRIP_DWELL_MS } from "../extension/huelink-lib/breaker.mjs";

/** A breaker that has tripped `n` times in a row, reopened by the timer in between. */
function trippedTimes(n) {
    const b = new Breaker();
    for (let i = 0; i < n; i++) {
        if (i) b.close();
        b.trip("Sync", "sync", 0);
    }
    return b;
}

test("each fruitless re-trip doubles the dwell, and the timer reopens only after it", () => {
    const b = trippedTimes(2);
    assert.equal(b.tripDwellMs, 2 * TRIP_DWELL_MS);
    assert.equal(b.dueForReopen(2 * TRIP_DWELL_MS - 1), false);
    assert.equal(b.dueForReopen(2 * TRIP_DWELL_MS), true);
    assert.equal(b.state, "tripped");
});

test("the third trip in a row gives up: no timer reopen, ever", () => {
    const b = trippedTimes(MAX_AUTO_TRIP_STREAK);
    assert.ok(b.needsManualResume);
    assert.equal(b.dueForReopen(Number.MAX_SAFE_INTEGER), false);
    assert.equal(b.state, "gave_up");
});

test("a command never resets the ladder, so after a give-up it buys one try only", () => {
    // An automation re-sending the mode faster than the dwell must not keep it below the give-up.
    const early = trippedTimes(1);
    early.close();
    assert.equal(early.tripStreak, 1);

    const gone = trippedTimes(MAX_AUTO_TRIP_STREAK);
    gone.close();
    assert.equal(gone.tripped, null);
    assert.equal(gone.state, "gave_up", "the alert holds through the manual try");
    gone.trip("Sync", "sync", 0);
    assert.ok(gone.needsManualResume, "a still-dead strip gives up at once");
});

test("close (power off) ends the trip but keeps the ladder and the alert", () => {
    const b = trippedTimes(MAX_AUTO_TRIP_STREAK);
    b.close();
    assert.equal(b.tripped, null);
    assert.equal(b.tripStreak, MAX_AUTO_TRIP_STREAK);
    assert.equal(b.state, "gave_up");
});

test("an acked ON lifts a give-up but buys one try, not a fresh ladder", () => {
    const b = trippedTimes(MAX_AUTO_TRIP_STREAK);
    b.close();
    b.ackedOn();
    assert.equal(b.state, "closed");
    b.trip("Sync", "sync", 0);
    assert.ok(b.needsManualResume, "a strip that acks commands but fails frames gives up at once");

    const fresh = trippedTimes(1);
    fresh.ackedOn();
    assert.equal(fresh.tripStreak, 1, "below the give-up it changes nothing");
});

test("only RECOVERY_FRAMES accepted frames in a row prove a recovery", () => {
    const b = trippedTimes(MAX_AUTO_TRIP_STREAK);
    b.close();
    for (let i = 1; i < RECOVERY_FRAMES; i++) assert.equal(b.frameOk(), false, `frame ${i}`);
    b.frameFailed();
    for (let i = 1; i < RECOVERY_FRAMES; i++) b.frameOk();
    assert.equal(b.tripStreak, MAX_AUTO_TRIP_STREAK, "a failure restarts the count");
    assert.equal(b.frameOk(), true, "the frame that clears a give-up says so, for a publish");
    assert.equal(b.state, "closed");
    assert.equal(b.tripDwellMs, TRIP_DWELL_MS);
    for (let i = 0; i < RECOVERY_FRAMES; i++) assert.equal(b.frameOk(), false, "and only that once");
});
