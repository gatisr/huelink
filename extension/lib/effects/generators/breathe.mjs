/**
 * breathe - a slow swell, offset between segments.
 *
 * Colour is a fixed point of the palette gradient (so 7 distinct shades end to
 * end) and only brightness moves. `phaseSpread` keeps the segments slightly out
 * of sync, so the swell crosses the strip; without it this reads as one pulsing
 * lamp rather than a strip. Brightness never reaches zero (`min`): this is a
 * background mood, not a blink. Parameters: docs/EFFECTS.md.
 */

import { gradient, parsePalette, round8, scale } from "../util.mjs";

export function create(p, segments) {
    const palette = parsePalette(p.palette, ["#ff2a1a", "#ff5c8a", "#c81e5a"]);
    const period = p.periodSeconds ?? 9;
    const spread = p.phaseSpread ?? 0.35;
    const min = p.min ?? 0.35;
    const max = p.max ?? 1;
    const bri = p.brightness ?? 1;

    return (t) => {
        return Array.from({ length: segments }, (_, i) => {
            const u = segments === 1 ? 0 : i / (segments - 1);
            const phase = t / period - u * spread;
            const env = min + (max - min) * (0.5 - 0.5 * Math.cos(2 * Math.PI * phase));
            return round8(scale(gradient(palette, u), env * bri));
        });
    };
}
