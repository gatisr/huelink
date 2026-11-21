/**
 * arbiter - the single place that decides what the strip should be doing now.
 *
 * One power flag plus exactly one requested mode, not three independent
 * switches. Light is not a source, and an empty stream is not light.
 * See docs/DESIGN.md.
 */

/** Requestable modes. Exactly one is active while power is on. */
export const MODE_LIGHT = "light";
export const MODE_EFFECT = "effect";
export const MODE_SYNC = "sync";

/** Output state that cannot be requested: power is off. */
export const MODE_OFF = "off";

export const MODES = [MODE_LIGHT, MODE_EFFECT, MODE_SYNC];

/** A source whose frames age out: no new frame within ttlMs and it is not live. */
export class FrameSource {
    constructor(ttlMs) {
        this.ttlMs = ttlMs;
        this.colors = null;
        this.at = 0;
    }

    put(colors) {
        this.colors = colors;
        this.at = Date.now();
    }

    clear() {
        this.colors = null;
        this.at = 0;
    }

    get live() {
        return this.colors !== null && Date.now() - this.at < this.ttlMs;
    }
}

export class Arbiter {
    /**
     * @param {object} sources  keys are the modes that HAVE a source
     * @param {FrameSource} sources.sync
     * @param {FrameSource} sources.effect
     */
    constructor({ sync, effect }) {
        this.sources = { [MODE_SYNC]: sync, [MODE_EFFECT]: effect };
        this.power = true;
        this.requested = MODE_LIGHT;
    }

    /**
     * Request a mode. An unknown name is rejected, not silently accepted: a
     * command that looks accepted but changes nothing is the dead end this
     * file was rebuilt to remove.
     * @returns {boolean} whether the name was valid
     */
    request(mode) {
        if (!MODES.includes(mode)) return false;
        this.requested = mode;
        return true;
    }

    /**
     * @returns {{mode:string, colors:?Array}} `colors` is `null` if and only if
     * no frame should be sent (`off` and `light`).
     */
    pick() {
        if (!this.power) return { mode: MODE_OFF, colors: null };
        if (this.requested === MODE_LIGHT) return { mode: MODE_LIGHT, colors: null };
        const source = this.sources[this.requested];
        if (source?.live) return { mode: this.requested, colors: source.colors };
        // A stream mode is selected but no frames are arriving. An empty
        // stream is not light: the user asked for the screen, not a lamp.
        return { mode: MODE_OFF, colors: null };
    }
}
