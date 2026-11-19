/**
 * pacer - decides WHETHER and WHEN to send the next entertainment frame.
 *
 * The scarce resource is coordinator time, not air time: ZNP allows one
 * outstanding SREQ and each send costs ~51 ms. The three levers (smoothing,
 * perceptual delta suppression, duty cap) all ration that one number.
 *
 * Every constant here was measured. The measurements, the rejected
 * alternatives and the bench results are in docs/PACING.md.
 */

import { rgbToXy } from "./huepack.mjs";
import { toFinite } from "./num.mjs";

/**
 * Perceptual thresholds: below these a frame carries no visible information.
 * From MacAdam ellipses and the Weber fraction. See docs/PACING.md.
 */
export const XY_THRESHOLD = 0.01;
export const BRI_THRESHOLD = 0.025;

/** Window the occupancy budget is measured over. */
const BUSY_WINDOW_MS = 1000;

/**
 * Highest fps anyone may ask for, from the UI or over MQTT.
 * Derived from the measured 51 ms send cost, not from taste. See docs/PACING.md.
 */
export const MAX_FPS = 5;

/** Defaults when the caller passes nothing. */
export const DEFAULTS = {
    /** Target frame rate: a ceiling, not a promise. */
    fps: MAX_FPS,
    /**
     * Share of wall time the stream may keep the coordinator busy.
     * 0.35 is a reviewed decision, not an untouched leftover. See docs/PACING.md.
     */
    occupancyBudget: 0.35,
    /** Hard ceiling: frames allowed in one window. */
    maxPerWindow: 2,
    /** Length of that window (ms). */
    windowMs: 100,
    /** Refresh at least this often even with no colour change. */
    keepaliveMs: 1000,
    /** Fade = measured gap * this (>1 so the colour never comes to rest). */
    smoothingFactor: 1.15,
    /**
     * How many thresholds a change must cross to count as a scene cut.
     * 6 gives ~0.3 fast frames/s on real films. See docs/PACING.md.
     */
    bigChangeThreshold: 6,
    /**
     * How often per second the fast path may skip the fps clock.
     * Rolling window, so the worst case stays `fps + maxFastPerSec`. See docs/PACING.md.
     */
    maxFastPerSec: 1,
    /** Fast path window. Same length as the occupancy window so the two add up. */
    fastWindowMs: 1000,
    /** Fade for a scene cut. Not zero: a jump reads as a click on a cheap strip. */
    fastSmoothingMs: 50,
};

/**
 * Ranges for the adjustable knobs. They live here, not in the UI, because the
 * pacer clamps to them anyway and a separate copy would drift into showing
 * numbers the engine silently overrides. `lib/huelink-ui.mjs` imports these.
 */
export const LIMITS = {
    /**
     * Delta threshold as % of the measured defaults (100 % = the defaults).
     * Below 25 % the threshold sinks under rgbToXy rounding noise; above 400 %
     * even a scene cut is missed.
     */
    deltaScalePct: { min: 25, max: 400, step: 25 },
    /**
     * Frame quota per `windowMs`. Above 5 the window constrains nothing, since
     * `MAX_FPS` never reaches it, and a ceiling that never fires is decoration.
     */
    dutyCap: { min: 1, max: 5, step: 1 },
};

const clamp = (v, min, max) => Math.min(Math.max(v, min), max);

/** Mean of the last `n` values without growing an array. */
class Ring {
    constructor(n) {
        this.buf = new Array(n).fill(0);
        this.n = n;
        this.i = 0;
        this.filled = 0;
    }
    push(v) {
        this.buf[this.i] = v;
        this.i = (this.i + 1) % this.n;
        if (this.filled < this.n) this.filled++;
    }
    get mean() {
        if (!this.filled) return 0;
        let s = 0;
        for (let k = 0; k < this.filled; k++) s += this.buf[k];
        return s / this.filled;
    }
    get max() {
        if (!this.filled) return 0;
        let m = -Infinity;
        for (let k = 0; k < this.filled; k++) if (this.buf[k] > m) m = this.buf[k];
        return m;
    }

    /**
     * Median. Reporting only, never a decision input (fades follow the mean,
     * see `smoothingMs`). Sorts on `stats()`, not per frame.
     */
    get median() {
        if (!this.filled) return 0;
        const s = this.buf.slice(0, this.filled).sort((a, b) => a - b);
        const mid = s.length >> 1;
        return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
    }
}

export class Pacer {
    constructor(opts = {}) {
        const o = { ...DEFAULTS, ...opts };
        this.fps = o.fps;
        this.occupancyBudget = o.occupancyBudget;
        this.maxPerWindow = o.maxPerWindow;
        this.windowMs = o.windowMs;
        this.keepaliveMs = o.keepaliveMs;
        this.smoothingFactor = o.smoothingFactor;
        this.bigChangeThreshold = o.bigChangeThreshold;
        this.maxFastPerSec = o.maxFastPerSec;
        this.fastWindowMs = o.fastWindowMs;
        this.fastSmoothingMs = o.fastSmoothingMs;
        this.xyThreshold = o.xyThreshold ?? XY_THRESHOLD;
        this.briThreshold = o.briThreshold ?? BRI_THRESHOLD;
        /**
         * One knob, not two. The xy and brightness thresholds are different
         * units but answer the same question, so only a scale against the
         * measured defaults is exposed (100 % = the defaults).
         */
        this.deltaScale = this.xyThreshold / XY_THRESHOLD;

        /** Last frame actually sent, in perceptual space. */
        this.lastPerceptual = null;
        /** Send timestamps, for counting frames in the window. */
        this.sendTimes = [];
        this.lastSendAt = 0;
        /** How long the coordinator was busy with our recent frames. */
        this.durations = new Ring(40);
        /** Real gaps between sent frames. */
        this.intervals = new Ring(40);
        /** Occupancy window: [time, duration] over the last second. */
        this.busy = [];
        /** Fast frame timestamps in the rolling `fastWindowMs` window. */
        this.fastTimes = [];

        this.counters = {
            offered: 0,
            sent: 0,
            skippedDelta: 0,
            skippedDuty: 0,
            keepalive: 0,
            /** Frames that took the fast path (scene cuts). */
            fast: 0,
            /**
             * Changes that were over the threshold but found the fast path
             * spent. Stays near 0 on film, climbs on a constant strobe.
             */
            fastCapped: 0,
        };
    }

    /**
     * Target fps from MQTT; everything else adapts. Clamped to MAX_FPS, which
     * also catches an old 12 restored by HA from a retained `number` state.
     *
     * Every setter below REFUSES a value that is not a number instead of
     * falling back to a default. The old `Number(x) || DEFAULTS.fps` had the
     * fallback pointing the wrong way: the default fps is the MAXIMUM, so
     * `null`, `"fast"` or a stray `0` asked the coordinator for the most air
     * time of all, which is the opposite of what an unreadable value deserves.
     * Keeping the current value is the safe answer, and the caller says so in
     * the log. See `lib/num.mjs`.
     *
     * @returns {boolean} whether the value was taken
     */
    setFps(fps) {
        const value = toFinite(fps);
        if (value === null) return false;
        this.fps = clamp(value, 1, MAX_FPS);
        return true;
    }

    /** Share of wall time the stream may keep the coordinator busy (0..1). */
    setOccupancyBudget(pct) {
        const value = toFinite(pct);
        if (value === null) return false;
        this.occupancyBudget = clamp(value, 0.05, 0.9);
        return true;
    }

    /**
     * Delta threshold as % of default (100 = `XY_THRESHOLD`/`BRI_THRESHOLD`).
     * Higher = more frames suppressed, quieter air, more stepping in slow fades.
     */
    setDeltaScale(pct) {
        const value = toFinite(pct);
        if (value === null) return false;
        const { min, max } = LIMITS.deltaScalePct;
        this.deltaScale = clamp(value, min, max) / 100;
        this.xyThreshold = XY_THRESHOLD * this.deltaScale;
        this.briThreshold = BRI_THRESHOLD * this.deltaScale;
        return true;
    }

    /**
     * Frames allowed per `windowMs`. The short-term ceiling, unlike
     * `occupancyBudget`: it stops a burst from locking out the rest of the house.
     */
    setDutyCap(n) {
        const value = toFinite(n);
        if (value === null) return false;
        const { min, max } = LIMITS.dutyCap;
        this.maxPerWindow = clamp(Math.round(value), min, max);
        return true;
    }

    /** Colours -> perceptual description. Computed once per frame; rgbToXy is not free. */
    static perceptual(colors) {
        return colors.map((c) => {
            const { x, y, brightness } = rgbToXy(c.r, c.g, c.b);
            return { x, y, b: brightness / 255 };
        });
    }

    /**
     * HOW FAR this frame is from the last sent one, measured in thresholds.
     * 1.0 is exactly at the threshold, 40 is a full colour flip. The fast path
     * needs a magnitude, not a yes/no, so `differs()` is just `>= 1` of this.
     *
     * Worst segment wins, not the mean: seven segments are seven lights. Below
     * the brightness threshold hue is invisible, so only brightness counts there.
     */
    magnitude(prev, next) {
        if (!prev || prev.length !== next.length) return Infinity;
        let worst = 0;
        for (let i = 0; i < next.length; i++) {
            const a = prev[i];
            const b = next[i];
            const mb = Math.abs(a.b - b.b) / this.briThreshold;
            if (mb > worst) worst = mb;
            // Too dark for hue to register, however far xy wandered.
            if (a.b < this.briThreshold && b.b < this.briThreshold) continue;
            const dx = a.x - b.x;
            const dy = a.y - b.y;
            const mxy = Math.sqrt(dx * dx + dy * dy) / this.xyThreshold;
            if (mxy > worst) worst = mxy;
        }
        return worst;
    }

    /** Is this frame visibly different from the last one sent. */
    differs(prev, next) {
        return this.magnitude(prev, next) >= 1;
    }

    /** Drop entries that fell out of their window. */
    #trim(now) {
        while (this.sendTimes.length && now - this.sendTimes[0] > this.windowMs) this.sendTimes.shift();
        while (this.fastTimes.length && now - this.fastTimes[0] > this.fastWindowMs) this.fastTimes.shift();
        while (this.busy.length && now - this.busy[0][0] > BUSY_WINDOW_MS) this.busy.shift();
    }

    /**
     * Share of the last second the coordinator spent on OUR frames.
     * The divisor is the fixed window, not time since the first entry: a
     * shrinking divisor reads absurdly high right after a send and would
     * deadlock the stream.
     */
    occupancy(now) {
        this.#trim(now);
        if (!this.busy.length) return 0;
        let sum = 0;
        for (const [, d] of this.busy) sum += d;
        return sum / BUSY_WINDOW_MS;
    }

    /**
     * The decision. Returns `null` for "do not send", or a descriptor. No side
     * effects: the caller calls `noteSent` once the send actually happened,
     * because only then is its cost known.
     *
     * @param {Array<{r:number,g:number,b:number}>} colors
     * @param {number} now
     */
    decide(colors, now = Date.now()) {
        this.counters.offered++;
        this.#trim(now);

        // Perceptual space is computed BEFORE the gates, not after: the clock
        // decision now depends on the magnitude of the change. Measured at
        // 1.2 us per frame, 0.006 % CPU at 50 tick/s.
        const next = Pacer.perceptual(colors);
        const mag = this.magnitude(this.lastPerceptual, next);
        // The fast path is a rationed resource, not a mode. If every frame is a
        // "cut" then none is, and the fps slider would control nothing.
        const over = mag >= this.bigChangeThreshold;
        const big = over && this.fastTimes.length < this.maxFastPerSec;
        if (over && !big) this.counters.fastCapped++;

        // 1. Target fps. A scene cut does not wait for the clock: that is where
        //    latency is visible, and cuts are rare, so it costs almost nothing.
        const minGap = 1000 / this.fps;
        if (!big && this.lastSendAt && now - this.lastSendAt < minGap) {
            return null; // not yet due; this is the clock, not a skip
        }

        // 2. Duty cap, hard part: frames per window. Applies to the fast path too.
        if (this.sendTimes.length >= this.maxPerWindow) {
            this.counters.skippedDuty++;
            return null;
        }

        // 3. Duty cap, adaptive part: the occupancy budget. This is what
        //    actually protects the house, and it binds the fast path too, so
        //    the fast path cannot raise the worst case.
        if (this.occupancy(now) >= this.occupancyBudget) {
            this.counters.skippedDuty++;
            return null;
        }

        // 4. Delta suppression. A frame with no visible change carries no
        //    information but costs the same ~27-46 ms of coordinator time.
        const stale = now - this.lastSendAt >= this.keepaliveMs;
        if (!stale && mag < 1) {
            this.counters.skippedDelta++;
            return null;
        }
        if (stale && this.lastPerceptual && mag < 1) {
            this.counters.keepalive++;
        }

        if (big) this.counters.fast++;
        return {
            perceptual: next,
            smoothingMs: big ? this.fastSmoothingMs : this.smoothingMs(),
            fast: big,
        };
    }

    /**
     * The frame went out. `durationMs` is the Zigbee send itself, which is
     * exactly the coordinator occupancy the budget counts.
     */
    noteSent(perceptual, durationMs, now = Date.now(), fast = false) {
        // A fast gap is shorter than the clock by definition, so it is not the
        // rhythm frames really flow at. Counting it would shorten the fade for
        // every ordinary frame after a cut.
        if (this.lastSendAt && !fast) this.intervals.push(now - this.lastSendAt);
        // Fast quota is spent per sent frame and only refills with time, so a
        // rare cut always gets through but a stream of them does not.
        if (fast) this.fastTimes.push(now);
        this.lastSendAt = now;
        this.lastPerceptual = perceptual;
        this.sendTimes.push(now);
        this.durations.push(durationMs);
        this.busy.push([now, durationMs]);
        this.counters.sent++;
    }

    /** After a mode change the history no longer describes the new content. */
    reset() {
        this.lastPerceptual = null;
        this.lastSendAt = 0;
        this.sendTimes = [];
        this.busy = [];
        this.fastTimes = [];
        this.intervals = new Ring(40);
        this.durations = new Ring(40);
    }

    /**
     * Fade time for the next ORDINARY frame (a cut uses `fastSmoothingMs`).
     *
     * Based on the measured gap, not the configured fps: if the coordinator
     * delays a frame the fade must delay with it. Mean, not median; the median
     * variant was built and measured and rejected. See docs/PACING.md.
     */
    smoothingMs() {
        const gap = this.intervals.filled ? this.intervals.mean : 1000 / this.fps;
        return Math.round(Math.min(Math.max(gap * this.smoothingFactor, 10), 2000));
    }

    /** Numbers for MQTT state and reporting. */
    stats(now = Date.now()) {
        const { offered, sent, skippedDelta, skippedDuty, keepalive, fast, fastCapped } =
            this.counters;
        return {
            offered,
            sent,
            skippedDelta,
            skippedDuty,
            keepalive,
            fast,
            fastCapped,
            deltaHitPct: offered ? Math.round((skippedDelta / offered) * 1000) / 10 : 0,
            occupancyPct: Math.round(this.occupancy(now) * 1000) / 10,
            avgSendMs: Math.round(this.durations.mean * 10) / 10,
            worstSendMs: Math.round(this.durations.max * 10) / 10,
            avgGapMs: Math.round(this.intervals.mean),
            // Median sits next to the mean on purpose: their difference is the
            // only number that shows how skewed the gap distribution is, and
            // hence why smoothingMs is about twice the typical gap.
            medGapMs: Math.round(this.intervals.median),
            smoothingMs: this.smoothingMs(),
            // Each adjustable threshold sits next to its own effect:
            // `skippedDelta` without `deltaScalePct` is a number without a scale.
            deltaScalePct: Math.round(this.deltaScale * 100),
            dutyCap: this.maxPerWindow,
        };
    }
}
