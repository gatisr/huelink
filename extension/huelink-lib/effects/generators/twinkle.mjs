/**
 * twinkle - every segment lives its own life: fades up softly, fades out.
 *
 * Unlike `burst` there are no "events" that add up; each segment has its own
 * independent timeline (light, burn, fade, wait), so the segments are almost
 * never in sync and the strip is never one flat colour.
 *
 * The envelope is sin^2, not exponential: a spark must rise as softly as it
 * falls, otherwise it looks like a firework rather than a firefly.
 * Parameters: docs/EFFECTS.md.
 */

import { add, makeRng, parsePalette, round8, scale } from "../util.mjs";

const range = (v, lo, hi) => (Array.isArray(v) && v.length === 2 ? v : [lo, hi]);

export function create(p, segments, seed) {
    const palette = parsePalette(p.palette, ["#9fd8ff", "#ffffff", "#b79dff"]);
    const [onLo, onHi] = range(p.onSeconds, 0.9, 2.2);
    const [offLo, offHi] = range(p.offSeconds, 0.2, 2.0);
    const base = parsePalette([p.base ?? "#02060f"])[0];
    const peak = p.peak ?? 1;
    const bri = p.brightness ?? 1;

    const rng = makeRng(seed);
    const pick = (t) => ({
        at: t + offLo + rng() * (offHi - offLo),
        dur: onLo + rng() * (onHi - onLo),
        color: palette[Math.floor(rng() * palette.length)],
        gain: 0.55 + rng() * 0.45,
    });

    // Scatter the phases up front, so they do not all light in the first second.
    const slots = Array.from({ length: segments }, () => {
        const s = pick(0);
        s.at = -rng() * (s.dur + offHi);
        return s;
    });

    return (t) => {
        return slots.map((s, i) => {
            if (t > s.at + s.dur) slots[i] = s = pick(t);
            const age = t - s.at;
            if (age < 0) return round8(base);
            const env = Math.sin((Math.PI * age) / s.dur) ** 2;
            return round8(add(base, scale(s.color, env * s.gain * peak * bri)));
        });
    };
}
