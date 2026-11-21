/**
 * ramp - one slow transition from one state to another, then hold. Sunrise and
 * wind-down.
 *
 * The only generator that is NOT a loop. It has a start and an end: an alarm
 * must finish bright and stay bright, a wind-down must reach zero and stay
 * there. A cyclic breath cannot do that job.
 *
 * `t` starts at zero when the effect is selected, so "the start" is the moment
 * of selection, and the HA speed control still applies (200 % = half as long).
 * The palette is read as a TIME axis, not along the strip: first colour at the
 * start, last at the end. `segmentSpread` lags the segments so the light flows
 * in from one end instead of rising as one block. Parameters: docs/EFFECTS.md.
 */

import { clamp, gradient, parsePalette, round8, scale, smooth } from "../util.mjs";

export function create(p, segments) {
    const palette = parsePalette(p.palette, ["#1a0a14", "#ff8a3c", "#fff0d0"]);
    const duration = Math.max(p.durationSeconds ?? 900, 1e-3);
    const from = p.from ?? 0.02;
    const to = p.to ?? 1;
    const spread = p.segmentSpread ?? 0.12;
    const linear = p.curve === "linear";
    const bri = p.brightness ?? 1;

    return (t) => {
        return Array.from({ length: segments }, (_, i) => {
            const lag = segments === 1 ? 0 : (i / (segments - 1)) * spread;
            const u = clamp(t / duration - lag, 0, 1);
            const k = linear ? u : smooth(u);
            const level = from + (to - from) * k;
            return round8(scale(gradient(palette, k), level * bri));
        });
    };
}
