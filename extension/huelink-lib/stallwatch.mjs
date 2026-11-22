/**
 * stallwatch - notices when the strip held an old picture for too long, and
 * says WHY. Four things can hold a frame back and look the same from outside:
 *
 *   send     the frame itself took long: a slow or queued Zigbee send
 *   backoff  the pause after a FAILED frame (200 / 1000 / 3000 ms)
 *   budget   the pacer refused: the last second of sends cost more than the
 *            occupancy budget, which one slow send is enough to cause
 *   window   the pacer refused: too many frames in the last 100 ms
 *
 * The fps clock (`clock`) and "nothing visibly changed" (`quiet`) are normal
 * and are never counted as a stall.
 *
 * Pure: the caller supplies every timestamp, so this runs against a fake clock
 * in tests and needs no zigbee2mqtt. It reports; it never decides, so nothing
 * it does can change what is sent.
 */

/** Unplanned waiting (send + backoff + budget + window) past which a gap is a stall. */
export const STALL_MS = 400;

/** Causes that count towards a stall. `clock` and `quiet` are deliberately absent. */
const COUNTED = ["send", "backoff", "budget", "window"];

const blank = () => ({ send: 0, backoff: 0, budget: 0, window: 0, clock: 0, quiet: 0 });

export class StallWatch {
    /** @param {{stallMs?: number}} [opts] */
    constructor({ stallMs = STALL_MS } = {}) {
        this.stallMs = stallMs;
        this.causes = blank();
        /** Time up to which waiting has been attributed, or 0 for "nothing running". */
        this.mark = 0;
        /** What was holding the frame back since `mark`. */
        this.cause = "clock";
        this.counters = { stalls: 0, worstStallMs: 0, sendFailures: 0 };
    }

    /**
     * Attribute the time since the last observation to the cause that was in
     * force, then make `cause` the one in force from now on.
     */
    observe(now, cause) {
        this.#attribute(now);
        this.cause = cause;
    }

    /**
     * Nothing is expected to flow (no live source, power off, mode change):
     * forget everything. A TV that was off for an hour must not turn into a
     * one-hour stall when it comes back.
     */
    reset() {
        this.causes = blank();
        this.mark = 0;
        this.cause = "clock";
    }

    /**
     * A frame went out; `sendMs` of the time since the last observation was
     * the send itself. Returns a report when the gap was a stall, else `null`.
     *
     * @returns {null | {totalMs: number, causes: Record<string, number>}}
     */
    sent(now, sendMs) {
        if (this.mark) {
            const elapsed = Math.max(now - this.mark, 0);
            const send = Math.min(Math.max(sendMs, 0), elapsed);
            // Before the send started, the cause in force still applies.
            this.causes[this.cause] += elapsed - send;
            this.causes.send += send;
        }
        const totalMs = COUNTED.reduce((sum, key) => sum + this.causes[key], 0);
        const causes = this.causes;
        this.causes = blank();
        this.mark = now;
        this.cause = "clock";
        if (totalMs <= this.stallMs) return null;
        this.counters.stalls++;
        this.counters.worstStallMs = Math.max(this.counters.worstStallMs, Math.round(totalMs));
        return { totalMs, causes };
    }

    /**
     * A frame failed after a send that began at `startedAt`. Time before it
     * keeps its cause; the send itself is `send`; the backoff pause follows.
     * No report here: the next frame that gets through reports the stall.
     */
    failed(now, startedAt = now) {
        this.counters.sendFailures++;
        this.#attribute(Math.min(Math.max(startedAt, this.mark), now));
        this.#attribute(now, "send");
        this.cause = "backoff";
    }

    #attribute(now, as = this.cause) {
        if (this.mark && now > this.mark) this.causes[as] += now - this.mark;
        this.mark = now;
    }

    stats() {
        return { ...this.counters };
    }
}

/**
 * At most one line per `everyMs`, counting what was left out. Same idea as
 * `noteUdpRejected` in huelink.mjs: a fault that repeats must cost a fixed
 * amount of log, not one line per frame.
 */
export class Throttle {
    constructor(everyMs = 10_000) {
        this.everyMs = everyMs;
        this.nextAt = 0;
        this.held = 0;
    }

    /**
     * @returns {{held: number} | null} `null` to stay quiet; otherwise how
     *   many occurrences were swallowed since the last line.
     */
    hit(now) {
        if (now < this.nextAt) {
            this.held++;
            return null;
        }
        const held = this.held;
        this.held = 0;
        this.nextAt = now + this.everyMs;
        return { held };
    }
}
