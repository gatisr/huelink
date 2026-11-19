/**
 * flame - noise-driven warm flicker. Campfire, candle, torch.
 *
 * Noise rather than per-frame randomness: fire is not a blink, it is slow
 * continuous motion with irregular peaks. Fresh randomness every frame would
 * be noise, not a flame.
 *
 * Two layers on purpose: per-segment noise so the tongues move independently,
 * plus one shared `gust` so the whole fire swells and settles together. Without
 * the second layer 7 segments look like 7 separate candles.
 *
 * Colour is not fixed: a hotter moment sits further along the palette, so peaks
 * are warmer as well as brighter. Parameters: docs/EFFECTS.md.
 */

import { clamp, gradient, makeRng, parsePalette, round8, scale, smooth } from "../util.mjs";

/**
 * Value noise: random knots at `rate` per second, smoothly joined; returns
 * t -> 0..1. Knots are made on demand and forgotten, so memory does not grow,
 * and `t` may only move forward (which it does).
 */
function noise(rng, rate) {
    let i0 = -1;
    let v0 = rng();
    let v1 = rng();
    return (t) => {
        const x = t * rate;
        const i = Math.floor(x);
        while (i0 < i) {
            i0 += 1;
            v0 = v1;
            v1 = rng();
        }
        return v0 + (v1 - v0) * smooth(x - i);
    };
}

export function create(p, segments, seed) {
    const palette = parsePalette(p.palette, ["#ff2a00", "#ff6a00", "#ffa126", "#ffc866"]);
    const rate = p.rateHz ?? 2.6;
    const gustHz = p.gustHz ?? 0.33;
    const gustDepth = p.gustDepth ?? 0.35;
    const depth = p.depth ?? 0.55;
    const min = p.min ?? 0.18;
    const bri = p.brightness ?? 1;

    const rng = makeRng(seed);

    // Slightly different rates per segment, or they drift into step over time.
    const flames = Array.from({ length: segments }, () => noise(rng, rate * (0.8 + rng() * 0.45)));
    const gust = gustHz > 0 ? noise(rng, gustHz) : () => 0.5;

    return (t) => {
        const g = (gust(t) - 0.5) * 2 * gustDepth; // -gustDepth .. +gustDepth
        return flames.map((f) => {
            // Two axes out of the same noise. `raw` drives COLOUR and always
            // spans the whole palette, so its first colour is actually
            // reachable; `heat` drives BRIGHTNESS and is squeezed by `depth`,
            // because a flame never goes fully out. Using `heat` for both (as
            // this once did) made the bottom `depth` of every palette
            // unreachable and every flame the same orange.
            const raw = clamp(f(t) + g, 0, 1);
            const heat = 1 - depth + depth * raw;
            const level = min + (1 - min) * heat;
            return round8(scale(gradient(palette, raw), level * bri));
        });
    };
}
