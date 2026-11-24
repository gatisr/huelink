/**
 * The circuit breaker's trip and its retry ladder: pure state, no I/O. What a
 * trip DOES (leave the stream, switch off, log) is `HueLink.onFailure`; this
 * only decides when the breaker is open, when a timer may reopen it, and when
 * auto-retry has given up. See docs/DESIGN.md, "armed vs tripped".
 */

/**
 * How long a tripped breaker stays shut; then `tick` reopens it. A re-trip
 * with no recovery doubles the wait; `RECOVERY_FRAMES` in a row reset it.
 * No `lastSeenChanged` listener on purpose: a switched-off strip is silent, so
 * a strip that is merely asleep gets timed retries. A reopen only RE-ARMS
 * (see `HueLink.reopen`), so a retry is used up only when a source actually
 * sends frames and they fail; time alone, with the TV off, costs nothing. The
 * retries are bounded by `MAX_AUTO_TRIP_STREAK`, below.
 */
export const TRIP_DWELL_MS = 300_000;

/**
 * Accepted frames in a row that prove a recovery and put the trip ladder back
 * on its first rung. Not 1: a strip that takes one frame after each reopen and
 * then fails again would otherwise reset the ladder every time and be retried
 * for ever, which is what `MAX_AUTO_TRIP_STREAK` exists to stop. 20 is about
 * 3 s of sync at the default budget.
 */
export const RECOVERY_FRAMES = 20;

/**
 * A strip that is genuinely gone (unplugged, moved out of range, dead) would
 * otherwise be re-tried on a timer for ever, and every one of those retries
 * risks the coordinator-wide jam this breaker exists to prevent (hours of
 * retries against a dead strip can leave the whole Zigbee network BUFFER_FULL
 * until z2m is restarted). After this many consecutive trips without a
 * recovery between them, the timer stops re-arming and only a command
 * reopens it. A command never resets the ladder (see `close`): an automation
 * that re-sends the mode every few minutes cannot tell itself apart from a
 * person, and must not restart the hammering. After the give-up a command
 * is therefore ONE more try.
 */
export const MAX_AUTO_TRIP_STREAK = 3;

export class Breaker {
    /** Translated label of the mode it tripped in, or `null`. While set, nothing is sent. */
    tripped = null;
    /**
     * When it tripped, and the mode KEY it tripped in. `tripped` holds the
     * label, right to show a person and wrong to re-arm from. Both only mean
     * anything while `tripped` is set.
     */
    trippedAt = 0;
    trippedMode = null;
    /** Trips since the last proven recovery. */
    tripStreak = 0;
    /** Accepted frames since the last failure; see `RECOVERY_FRAMES`. */
    okFrames = 0;

    /** Opens the breaker and climbs one rung: each fruitless re-trip doubles the wait. */
    trip(label, mode, now) {
        this.tripped = label;
        this.trippedAt = now;
        this.trippedMode = mode;
        this.tripStreak++;
    }

    /** The dwell the latest trip waits. Bounded: past `MAX_AUTO_TRIP_STREAK` it is never consulted. */
    get tripDwellMs() {
        return TRIP_DWELL_MS * 2 ** Math.max(0, this.tripStreak - 1);
    }

    /**
     * Clears the trip itself and leaves the ladder alone, for a timer reopen
     * and a command alike: only `RECOVERY_FRAMES` reset it. A command resetting
     * it would let an automation that re-sends the mode faster than the dwell
     * keep the streak below `MAX_AUTO_TRIP_STREAK` for ever.
     */
    close() {
        this.tripped = null;
        this.trippedAt = 0;
        this.trippedMode = null;
    }

    /**
     * The strip acked a power on: proof it is on the network, not that frames
     * get through. Clears the give-up but keeps the top rung, so a strip that
     * acks commands and still fails frames gives up again on its next trip.
     */
    ackedOn() {
        this.tripStreak = Math.min(this.tripStreak, MAX_AUTO_TRIP_STREAK - 1);
    }

    /** A frame was accepted. True when it is the one that proves a recovery from a give-up. */
    frameOk() {
        if (++this.okFrames !== RECOVERY_FRAMES) return false;
        const cleared = this.autoRetryExhausted;
        // Back to the first rung: the next trip waits `TRIP_DWELL_MS` and auto-retry is open again.
        this.tripStreak = 0;
        return cleared;
    }

    frameFailed() {
        this.okFrames = 0;
    }

    /** Tripped, auto-retry still open, and the dwell is over: the timer may reopen it. */
    dueForReopen(now) {
        return Boolean(this.tripped) && !this.autoRetryExhausted && now - this.trippedAt >= this.tripDwellMs;
    }

    /**
     * Auto-retry has used up `MAX_AUTO_TRIP_STREAK` and no recovery has been
     * proven since. Outlives the trip itself (an off, a manual try), so the
     * "needs attention" alert clears only when the strip really works again
     * (`RECOVERY_FRAMES`, or an acked "ON": see `HueLink.#entityState`).
     */
    get autoRetryExhausted() {
        return this.tripStreak >= MAX_AUTO_TRIP_STREAK;
    }

    /** Tripped and auto-retry is exhausted: only a person can reopen it. */
    get needsManualResume() {
        return Boolean(this.tripped) && this.autoRetryExhausted;
    }

    /** The fixed word for automations; `HueLink.status` is the same fact translated. */
    get state() {
        if (this.autoRetryExhausted) return "gave_up";
        return this.tripped ? "tripped" : "closed";
    }
}
