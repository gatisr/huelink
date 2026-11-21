/**
 * pulse - a heartbeat: sharp hit, soft decay, pause. Also "goal scored".
 *
 * `breathe` is a symmetric cosine, which is a breath, not a beat. A heart has
 * another shape: fast up, slower down, and TWO hits in a row ("lub-dub") before
 * the silence. The double hit is what makes it read as a heart rather than a
 * blinking light, so it is a parameter, not randomness.
 *
 * `beats` are the hit amplitudes and `beatGap` the time between them: `[1, 0.6]`
 * at 0.16 s is a human heart, `[1]` turns it into a plain impulse. `spread`
 * offsets the segments so the hit runs across the strip instead of landing
 * everywhere at once. Parameters: docs/EFFECTS.md.
 */

import { clamp, gradient, parsePalette, round8, scale } from "../util.mjs";

export function create(p, segments) {
    const palette = parsePalette(p.palette, ["#ff0a3c", "#ff5c8a"]);
    const bpm = p.bpm ?? 62;
    const beats = Array.isArray(p.beats) && p.beats.length ? p.beats : [1, 0.6];
    const gap = p.beatGap ?? 0.16;
    const rise = Math.max(p.riseSeconds ?? 0.06, 1e-3);
    const decay = Math.max(p.decaySeconds ?? 0.22, 1e-3);
    const min = p.min ?? 0.12;
    const spread = p.spread ?? 0.12;
    const bri = p.brightness ?? 1;

    const period = 60 / bpm;

    /** One hit's envelope: linear rise, exponential fall. */
    const hit = (age) => {
        if (age < 0) return 0;
        return age < rise ? age / rise : Math.exp(-(age - rise) / decay);
    };

    return (t) => {
        return Array.from({ length: segments }, (_, i) => {
            const u = segments === 1 ? 0 : i / (segments - 1);
            const local = t - u * spread;
            const phase = ((local % period) + period) % period;

            // Look at the PREVIOUS beat too, or its tail would be cut off
            // exactly at the period boundary and the hit would look cheap.
            let env = 0;
            for (const cycle of [0, -period]) {
                beats.forEach((amp, n) => {
                    env = Math.max(env, amp * hit(phase - cycle - n * gap));
                });
            }
            const level = clamp(min + (1 - min) * env, 0, 1);
            return round8(scale(gradient(palette, u), level * bri));
        });
    };
}
