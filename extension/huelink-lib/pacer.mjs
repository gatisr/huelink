/**
 * pacer - decides WHETHER and WHEN to send the next entertainment frame.
 *
 * The scarce resource is coordinator time, not air time: ZNP allows one
 * outstanding SREQ and each send costs ~51 ms. The three levers (smoothing,
 * perceptual delta suppression, duty cap) all ration that one number.
 *
 * The burst (`burstFps`, off by default) is the one thing here that does not
 * ration: it moves budget in time. Quiet scenes leave budget unspent, the
 * token bucket keeps it, and one loud scene may spend it. The total over a
 * long run is still `occupancyBudget`.
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
 * DEFAULT highest fps anyone may ask for, from the UI or over MQTT.
 * Derived from the measured 51 ms send cost on a coordinator the rest of the
 * house also uses, not from taste. See docs/PACING.md.
 *
 * It is a default rather than a law because the cost it comes from is a
 * property of one installation: a coordinator dedicated to the strip is a
 * different machine with a different price per frame. `maxFps` in
 * `huelink.config.json` moves the ceiling; this stays what you get for not
 * having an opinion.
 */
export const MAX_FPS = 5;

/**
 * Hard upper bound on `maxFps` itself, so the configurable ceiling is still a
 * ceiling. 50 is not taste either: the hard per-window cap allows at most
 * `LIMITS.dutyCap.max` frames per `windowMs`, i.e. 5 per 100 ms, and asking
 * for more than the other limiter can ever pass is asking for a number that
 * does nothing.
 */
export const FPS_CEILING = 50;

/**
 * Highest fps the BURST path may reach. A separate ceiling on purpose:
 * `MAX_FPS` is the rate the stream may hold INDEFINITELY, and raising it
 * quietly would undo the measurement it comes from. A burst is the other
 * question, "how fast may it go for a moment, having saved up for it", and it
 * is paid for out of the token bucket rather than out of the budget.
 *
 * 15, because above it the hard per-window cap (2 frames per `windowMs`, i.e.
 * 20 fps instantaneous) would start binding, and then two limiters would be
 * fighting over the same frames.
 */
export const BURST_MAX_FPS = 15;

/**
 * Price of one send before anything has been measured: the median of 135 real
 * `avgSendMs` samples. Used only as the opening estimate for the token bucket;
 * once frames have gone out, their own measured cost is used instead.
 */
export const NOMINAL_SEND_MS = 51;

/**
 * Most one send can add to the occupancy meter, the price and the burst bucket.
 * Above p90 (238 ms), so ordinary sends are charged in full; a 6 s stall is
 * charged like a 250 ms one instead of filling the meter for the next second.
 * The real duration still shows in `worstSendMs`. See docs/PACING.md.
 */
export const MAX_CHARGE_MS = 250;

/** Defaults when the caller passes nothing. */
export const DEFAULTS = {
    /**
     * Target frame rate: a ceiling, not a promise. Below `MAX_FPS` since 1.3.4:
     * responsiveness comes from the fast path below, and the slow tick pays
     * for it. See docs/PACING.md, "Default since 1.3.4".
     */
    fps: 3,
    /**
     * Highest fps `setFps` will accept. Set once, at construction: the z2m
     * device page builds its slider from this number when the converter
     * loads, so a value that moved while running would describe a slider
     * nobody is looking at.
     */
    maxFps: MAX_FPS,
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
    smoothingFactor: 1.05,
    /** How many thresholds a change must cross to count as a scene cut. See docs/PACING.md. */
    bigChangeThreshold: 4,
    /**
     * How often per second the fast path may skip the fps clock.
     * Rolling window, so the worst case stays `fps + maxFastPerSec`. See docs/PACING.md.
     */
    maxFastPerSec: 4,
    /** Fast path window. Same length as the occupancy window so the two add up. */
    fastWindowMs: 1000,
    /** Fade for a scene cut. Not zero: a jump reads as a click on a cheap strip. */
    fastSmoothingMs: 20,

    // --- Burst: the token bucket. Off by default, see docs/PACING.md. ---

    /**
     * Frame rate during a burst. 0 is OFF, and that is the default: a burst
     * deliberately spends more coordinator time than `fps` allows, so it is
     * something a person turns on for their own house, not something every
     * installation inherits.
     */
    burstFps: 0,
    /** Longest single burst. The bucket usually ends it sooner. */
    burstMaxMs: 1000,
    /**
     * Size of the bucket, in COORDINATOR milliseconds. This is the real
     * limiter: a burst may only spend what quiet scenes put in, so the
     * long-term average stays the occupancy budget whatever the burst fps is.
     */
    burstCreditMs: 500,
    /** Share of unspent budget that accrues as credit. 1 = all of it. */
    burstRefill: 1,
};

/**
 * Ranges for the adjustable knobs. They live here, not in the UI, because the
 * pacer clamps to them anyway and a separate copy would drift into showing
 * numbers the engine silently overrides. `huelink-lib/huelink-ui.mjs` imports these.
 */
export const LIMITS = {
    /**
     * Delta threshold as % of the measured defaults (100 % = the defaults).
     * Below 25 % the threshold sinks under rgbToXy rounding noise; above 400 %
     * even a scene cut is missed.
     */
    deltaScalePct: { min: 25, max: 400, step: 25 },
    /**
     * Frame quota per `windowMs`. 5 per 100 ms is 50 fps instantaneous, which
     * is `FPS_CEILING`: past that the window would be the only limiter left.
     */
    dutyCap: { min: 1, max: 5, step: 1 },
    /**
     * The fps ceiling itself, from `huelink.config.json`. Read at startup
     * only, so it is not in `TUNABLE`, but it is clamped like everything else.
     */
    maxFps: { min: 1, max: FPS_CEILING, step: 1 },

    // --- `TUNABLE`: set from huelink.config.json, re-read while running. ---

    /** Above 0.9 the stream owns the coordinator; below 0.05 it never sends. */
    occupancyBudget: { min: 0.05, max: 0.9, step: 0.05 },
    /**
     * The budget as a percent for the UI and MQTT (the engine keeps the
     * fraction). Written out because `0.05 * 100` is `5.000000000000001`.
     */
    occupancyBudgetPct: { min: 5, max: 90, step: 5 },
    /**
     * Fade = measured gap * this. Below 1 the colour comes to rest before the
     * next frame, which is the stutter the factor exists to remove; above 2 the
     * strip is always a frame and a half behind the picture.
     */
    smoothingFactor: { min: 1, max: 2, step: 0.05 },
    /**
     * Thresholds a change must cross to count as a scene cut. 1 means "every
     * visible change is a cut", which hands the fps clock to the fast path;
     * 40 is a full colour inversion, i.e. effectively off.
     */
    bigChangeThreshold: { min: 1, max: 40, step: 1 },
    /** Fade for a cut. 0 is allowed and reads as a click; 500 is no longer fast. */
    fastSmoothingMs: { min: 0, max: 500, step: 10 },
    /** Fast frames per `fastWindowMs`. 0 switches the fast path off entirely. */
    maxFastPerSec: { min: 0, max: 10, step: 1 },
    /**
     * Burst frame rate. 0 is off. The ceiling is `BURST_MAX_FPS`, or `maxFps`
     * where that was configured higher: a burst slower than the ordinary
     * stream would be a strange thing to own. See `Pacer#limit`.
     */
    burstFps: { min: 0, max: BURST_MAX_FPS, step: 1 },
    /** Longest single burst. 0 is the second way to switch bursting off. */
    burstMaxMs: { min: 0, max: 5000, step: 100 },
    /** Bucket size in coordinator ms. 0 means nothing can ever be saved up. */
    burstCreditMs: { min: 0, max: 5000, step: 50 },
    /** Share of unspent budget that accrues. 0 freezes the bucket. */
    burstRefill: { min: 0, max: 1, step: 0.05 },
};

/**
 * Knobs that may be set from `huelink.config.json` AND re-applied while the
 * extension runs, without a restart. The list is short for a reason: every
 * entry here is a plain number with a clamp in `LIMITS`, read fresh on the
 * next frame, so applying one mid-stream cannot leave anything half-changed.
 * `segments` or `udpPort` are not like that, and are not here.
 *
 * `fps`, `deltaScalePct` and `dutyCap` are missing on purpose as well: those
 * are live knobs in Home Assistant and on the z2m device page, so a file that
 * also set them would be a second owner quietly overwriting a person. The
 * file still gives them a STARTING value; it just stops setting them after.
 *
 * Five entries below also have a slider (`occupancyBudget`, `smoothingFactor`,
 * `bigChangeThreshold`, `fastSmoothingMs`, `maxFastPerSec`). `huelink.mjs`
 * leaves those out of the live file reload for the same reason.
 *
 * `maxFps` is missing for a different reason: the slider that has to respect
 * it is built once, when z2m loads the converter.
 */
export const TUNABLE = [
    "occupancyBudget",
    "smoothingFactor",
    "bigChangeThreshold",
    "fastSmoothingMs",
    "maxFastPerSec",
    "burstFps",
    "burstMaxMs",
    "burstCreditMs",
    "burstRefill",
];

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
        // The ceiling first: `setFps` below clamps against it.
        this.maxFps = clamp(toFinite(o.maxFps) ?? DEFAULTS.maxFps, LIMITS.maxFps.min, LIMITS.maxFps.max);
        // Through the setters, so a hand-edited file lands in exactly the same
        // clamps as a slider. Note what the default fps does NOT do: raising
        // `maxFps` leaves the stream at 5 until someone asks for more.
        this.fps = Math.min(this.maxFps, DEFAULTS.fps);
        this.setFps(o.fps);
        this.occupancyBudget = DEFAULTS.occupancyBudget;
        this.setOccupancyBudget(o.occupancyBudget);
        this.maxPerWindow = DEFAULTS.maxPerWindow;
        this.setDutyCap(o.maxPerWindow);
        this.windowMs = o.windowMs;
        this.keepaliveMs = o.keepaliveMs;
        this.smoothingFactor = o.smoothingFactor;
        this.bigChangeThreshold = o.bigChangeThreshold;
        this.maxFastPerSec = o.maxFastPerSec;
        this.fastWindowMs = o.fastWindowMs;
        this.fastSmoothingMs = o.fastSmoothingMs;
        this.burstFps = o.burstFps;
        this.burstMaxMs = o.burstMaxMs;
        this.burstCreditMs = o.burstCreditMs;
        this.burstRefill = o.burstRefill;
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
        /** Uncapped send times, for `worstSendMs` only. */
        this.rawDurations = new Ring(40);
        /** Real gaps between sent frames. */
        this.intervals = new Ring(40);
        /** Occupancy window: [time, duration] over the last second. */
        this.busy = [];
        /** Fast frame timestamps in the rolling `fastWindowMs` window. */
        this.fastTimes = [];
        /**
         * The token bucket, in COORDINATOR milliseconds: budget that wall
         * clock time has granted and no frame has spent. Quiet scenes fill it,
         * a burst empties it, and every send settles the account whether it
         * was a burst frame or not, so what the bucket buys is a rearrangement
         * of the budget in time, never more of it.
         */
        this.credit = 0;
        /**
         * When credit was last accrued, or `null` before the first
         * `decide()`. Deliberately not 0: `now` is supplied by the caller, and
         * a caller whose clock starts at zero (both benches and every test
         * here) hands us a real timestamp indistinguishable from an "it has
         * never run" sentinel of 0. The bucket would then re-arm on every
         * call and accrue nothing at all.
         */
        this.creditAt = null;
        /** A burst is running until this time, or 0 when none is. */
        this.burstUntil = 0;
        /** Why the last `decide()` returned null: "clock", "window", "budget" or "delta". Informational. */
        this.lastSkip = null;

        this.counters = {
            offered: 0,
            sent: 0,
            skippedDelta: 0,
            /** Held back by the per-window cap (burstiness). */
            skippedWindow: 0,
            /** Held back by the occupancy budget (cost of the last second). */
            skippedBudget: 0,
            keepalive: 0,
            /** Frames that took the fast path (scene cuts). */
            fast: 0,
            /**
             * Changes that were over the threshold but found the fast path
             * spent. Stays near 0 on film, climbs on a constant strobe.
             */
            fastCapped: 0,
            /** Bursts started. */
            bursts: 0,
            /** Frames sent inside a burst, i.e. paid for out of the bucket. */
            burstFrames: 0,
        };

        // The clamp, once, for whatever the caller passed. The constructor
        // used to take the numbers as given, which was fine while they came
        // from this file; they now come from a hand-edited JSON file.
        this.tune(opts);
    }

    /**
     * The range for one knob on THIS pacer. Almost always just `LIMITS[key]`;
     * the exception is `burstFps`, whose ceiling has to follow a `maxFps`
     * raised past `BURST_MAX_FPS`. Without this, a dedicated coordinator
     * running at 17 fps would have a "burst" pinned to 15, i.e. a brake
     * wearing a burst's name.
     *
     * A method rather than a second constant, because the answer depends on a
     * configured value and `LIMITS` is shared by every pacer in the process.
     */
    limit(key) {
        const { min, max, step } = LIMITS[key];
        if (key === "burstFps") return { min, max: Math.max(max, this.maxFps), step };
        return { min, max, step };
    }

    /**
     * Apply tuning knobs, each clamped to `LIMITS`. One path for the
     * constructor and for a re-read of `huelink.config.json`, so a value set
     * while running lands in exactly the same place as one set at startup.
     *
     * Values arrive already validated by `huelink-lib/config.mjs`; anything still
     * unreadable keeps the current value rather than falling back to a
     * default, the same answer every setter above gives.
     *
     * @param {object} values  any subset of `TUNABLE`
     * @returns {string[]} the keys whose value actually changed
     */
    tune(values = {}) {
        const changed = [];
        for (const key of TUNABLE) {
            if (!Object.hasOwn(values, key)) continue;
            const before = this[key];
            if (!this.setTunable(key, values[key])) continue;
            if (this[key] !== before) changed.push(key);
        }
        return changed;
    }

    /**
     * The single clamp per knob, shared by setters and preset matching.
     */
    static clampKnob(key, value, maxFps) {
        // Three knobs differ from plain min/max: fps (the configured ceiling),
        // dutyCap (integer) and burstFps (never below maxFps).
        if (key === "fps") return clamp(value, 1, maxFps);
        const { min, max } = LIMITS[key];
        if (key === "dutyCap") return clamp(Math.round(value), min, max);
        return clamp(value, min, key === "burstFps" ? Math.max(max, maxFps) : max);
    }

    /**
     * One tuning knob, clamped. Returns whether the value was readable (not
     * whether it changed, unlike `tune`): a command must say so if it was not.
     *
     * @param {string} key    a `TUNABLE` name
     * @returns {boolean}
     */
    setTunable(key, value) {
        if (!TUNABLE.includes(key)) return false;
        const v = toFinite(value);
        if (v === null) return false;
        this[key] = Pacer.clampKnob(key, v, this.maxFps);
        return true;
    }

    /**
     * Target fps from MQTT; everything else adapts. Clamped to `maxFps`, the
     * configured ceiling, which also catches an old 12 restored by HA from a
     * retained `number` state. Lowering the ceiling in the file is therefore
     * enough to pull a stale saved value back down on the next start, which
     * is the reason the clamp stayed when the number became configurable.
     *
     * Every setter below REFUSES a value that is not a number instead of
     * falling back to a default. The old `Number(x) || DEFAULTS.fps` had the
     * fallback pointing the wrong way: the default fps is the MAXIMUM, so
     * `null`, `"fast"` or a stray `0` asked the coordinator for the most air
     * time of all, which is the opposite of what an unreadable value deserves.
     * Keeping the current value is the safe answer, and the caller says so in
     * the log. See `huelink-lib/num.mjs`.
     *
     * @returns {boolean} whether the value was taken
     */
    setFps(fps) {
        const value = toFinite(fps);
        if (value === null) return false;
        this.fps = Pacer.clampKnob("fps", value, this.maxFps);
        return true;
    }

    /** Share of wall time the stream may keep the coordinator busy (0..1). */
    setOccupancyBudget(pct) {
        const value = toFinite(pct);
        if (value === null) return false;
        this.occupancyBudget = Pacer.clampKnob("occupancyBudget", value);
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
        this.maxPerWindow = Pacer.clampKnob("dutyCap", value);
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
     * What one send is expected to cost right now. Measured once frames have
     * gone out, since a slow coordinator makes every frame dearer and the
     * bucket has to know that; `NOMINAL_SEND_MS` only covers the first frames.
     */
    get sendPrice() {
        return this.durations.filled ? this.durations.mean : NOMINAL_SEND_MS;
    }

    /**
     * Grant the budget that wall clock time has earned since the last call.
     *
     * The bucket is filled by TIME, not by skipped frames: `occupancyBudget`
     * of every elapsed millisecond is budget we were entitled to spend, and
     * `noteSent` takes back every millisecond a frame actually cost. So the
     * balance IS "budget granted minus budget used", and capping it at
     * `burstCreditMs` is what stops an hour of darkness from buying a minute
     * of 15 fps.
     */
    #accrue(now) {
        if (this.creditAt === null) {
            this.creditAt = now;
            return;
        }
        const elapsed = now - this.creditAt;
        if (elapsed <= 0) return;
        this.creditAt = now;
        const earned = elapsed * this.occupancyBudget * this.burstRefill;
        this.credit = Math.min(this.credit + earned, this.burstCreditMs);
    }

    /**
     * Is a burst running, and may it continue.
     *
     * A burst starts on the same signal as the fast path, a change over
     * `bigChangeThreshold`, because that is the one moment the stream is
     * demonstrably behind the picture. The difference is duration: the fast
     * path moves ONE frame, a burst raises the clock for up to `burstMaxMs`.
     *
     * It ends on whichever comes first: the clock, or an empty bucket. The
     * bucket is the one that matters, and it is why a burst cannot be
     * re-armed indefinitely: each run spends more than it earns, so a second
     * run can only have what the first one left.
     */
    #bursting(now, over) {
        if (this.burstFps <= 0 || this.burstMaxMs <= 0) return false;
        const price = this.sendPrice;
        if (now < this.burstUntil) {
            if (this.credit >= price) return true;
            this.burstUntil = 0;
            return false;
        }
        // Never start a frame the bucket cannot pay for: the debt would be
        // settled out of the NEXT quiet scene, which is the one place the
        // budget is supposed to be a promise rather than an average.
        if (!over || this.credit < price) return false;
        this.burstUntil = now + this.burstMaxMs;
        this.counters.bursts++;
        return true;
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
        this.lastSkip = null;
        this.#trim(now);
        this.#accrue(now);

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
        // The burst reads the same signal but answers the other half of it:
        // the fast path rescues one frame, this raises the clock for a while.
        // Off unless `burstFps` was set, so by default nothing below changes.
        const burst = this.#bursting(now, over);

        // 1. Target fps. A scene cut does not wait for the clock: that is where
        //    latency is visible, and cuts are rare, so it costs almost nothing.
        const minGap = 1000 / (burst ? Math.max(this.fps, this.burstFps) : this.fps);
        if (!big && this.lastSendAt && now - this.lastSendAt < minGap) {
            this.lastSkip = "clock";
            return null; // not yet due; this is the clock, not a skip
        }

        // 2. Duty cap, hard part: frames per window. Applies to the fast path too.
        if (this.sendTimes.length >= this.maxPerWindow) {
            this.counters.skippedWindow++;
            this.lastSkip = "window";
            return null;
        }

        // 3. Duty cap, adaptive part: the occupancy budget. This is what
        //    actually protects the house, and it binds the fast path too, so
        //    the fast path cannot raise the worst case.
        //
        //    A burst is the one documented exception, and it is an exception
        //    to WHEN the budget is measured, not to how much there is: the
        //    bucket already holds budget that earlier seconds did not spend,
        //    and `#bursting` refused to start without enough of it. The hard
        //    per-window cap above still applies, so even mid-burst at most
        //    `maxPerWindow` of our frames can be queued ahead of the rest of
        //    the house at any instant.
        if (!burst && this.occupancy(now) >= this.occupancyBudget) {
            this.counters.skippedBudget++;
            this.lastSkip = "budget";
            return null;
        }

        // 4. Delta suppression. A frame with no visible change carries no
        //    information but costs the same ~27-46 ms of coordinator time.
        const stale = now - this.lastSendAt >= this.keepaliveMs;
        if (!stale && mag < 1) {
            this.counters.skippedDelta++;
            this.lastSkip = "delta";
            return null;
        }
        if (stale && this.lastPerceptual && mag < 1) {
            this.counters.keepalive++;
        }

        if (big) this.counters.fast++;
        if (burst) this.counters.burstFrames++;
        return {
            perceptual: next,
            // A burst frame is NOT a fast frame: it takes the ordinary fade,
            // computed from the gap the burst itself just shortened, so the
            // stream speeds up without every frame also turning into a cut.
            smoothingMs: big ? this.fastSmoothingMs : this.smoothingMs(),
            fast: big,
            burst,
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
        this.counters.sent++;
        this.rawDurations.push(durationMs);
        const charged = Math.min(durationMs, MAX_CHARGE_MS);
        this.durations.push(charged);
        this.busy.push([now, charged]);
        // Every send is paid out of the bucket, burst or not. That single line
        // is what makes the budget a long-term average rather than a hole: a
        // burst can only spend what quiet scenes put in, and the floor stops a
        // coordinator stall from inventing a debt that takes minutes of
        // darkness to work off.
        this.credit = Math.max(this.credit - charged, -this.burstCreditMs);
    }

    /** After a mode change the history no longer describes the new content. */
    /**
     * Let the next frame out now: no fps clock, no delta suppression. The
     * window and the budget still apply, which is why this is not `reset()`.
     */
    forceNext() {
        this.lastPerceptual = null;
        this.lastSendAt = 0;
    }

    reset() {
        this.lastPerceptual = null;
        this.lastSendAt = 0;
        this.sendTimes = [];
        this.busy = [];
        this.fastTimes = [];
        this.intervals = new Ring(40);
        this.durations = new Ring(40);
        this.rawDurations = new Ring(40);
        // The burst goes, the bucket stays. A mode change says nothing about
        // the coordinator: the budget those seconds earned was real, and
        // handing it back would make every mode change a free burst.
        this.burstUntil = 0;
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

    /**
     * What the frame cap can actually buy right now. Live counterpart of
     * `consistency()` in config.mjs, using the measured send price.
     *   duty:   maxPerWindow frames per windowMs
     *   budget: occupancyBudget of each second / price of one frame
     */
    ceiling() {
        const round = (n) => Math.round(n * 10) / 10;
        const duty = round((this.maxPerWindow * 1000) / this.windowMs);
        const budget = round((this.occupancyBudget * 1000) / this.sendPrice);
        return {
            asked: this.fps,
            duty,
            budget,
            sendMs: round(this.sendPrice),
            effective: Math.min(this.fps, duty, budget),
        };
    }

    /** Numbers for MQTT state and reporting. */
    stats(now = Date.now()) {
        const { offered, sent, skippedDelta, skippedWindow, skippedBudget, keepalive, fast, fastCapped, bursts, burstFrames } =
            this.counters;
        return {
            offered,
            sent,
            skippedDelta,
            skippedDuty: skippedWindow + skippedBudget,
            skippedWindow,
            skippedBudget,
            keepalive,
            fast,
            fastCapped,
            bursts,
            burstFrames,
            // The bucket, in coordinator ms. Next to its own counters for the
            // same reason as `deltaScalePct`: `bursts: 0` with an empty bucket
            // is the limiter working, with a full one it is the content never
            // asking, and from outside those look identical.
            creditMs: Math.round(this.credit),
            deltaHitPct: offered ? Math.round((skippedDelta / offered) * 1000) / 10 : 0,
            occupancyPct: Math.round(this.occupancy(now) * 1000) / 10,
            avgSendMs: Math.round(this.durations.mean * 10) / 10,
            worstSendMs: Math.round(this.rawDurations.max * 10) / 10,
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
            // Slider knobs: the UI reads their values back from here.
            occupancyBudgetPct: Math.round(this.occupancyBudget * 100),
            smoothingFactor: this.smoothingFactor,
            bigChangeThreshold: this.bigChangeThreshold,
            fastSmoothingMs: this.fastSmoothingMs,
            maxFastPerSec: this.maxFastPerSec,
            // Frame rate currently affordable (see `ceiling()`).
            fpsCeiling: this.ceiling().effective,
            // The configured ceiling, published because it is otherwise
            // invisible: a slider that refuses to go past 5 looks the same
            // whether the file was read or quietly ignored.
            maxFps: this.maxFps,
        };
    }
}
