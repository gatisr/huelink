/**
 * chase - a bright dot running along the strip with a tail behind it.
 *
 * Where `wave` is a continuous pattern that keeps the whole strip coloured,
 * this is a DARK strip with one or a few bright dots. On 7 segments the
 * difference is obvious: a wave is mood, a chase is motion the eye follows.
 *
 * The tail is exponential and measured in segments, not frames, so the HA speed
 * control changes how fast the dot runs, not how long its tail is. Each lap
 * takes the next palette colour. Parameters: docs/EFFECTS.md.
 */

import { add, hex2rgb, parsePalette, round8, scale } from "../util.mjs";

export function create(p, segments) {
    const palette = parsePalette(p.palette, ["#ffffff"]);
    const cycle = p.cycleSeconds ?? 2.2;
    const tail = Math.max(p.tail ?? 1.6, 0.05);
    const heads = Math.max(Math.round(p.heads ?? 1), 1);
    const dir = p.direction ?? 1;
    const bounce = Boolean(p.bounce);
    const base = hex2rgb(p.base ?? "#000000");
    const peak = p.peak ?? 1;
    const bri = p.brightness ?? 1;

    return (t) => {
        const laps = (dir * t) / cycle;
        const out = Array.from({ length: segments }, () => base);

        for (let h = 0; h < heads; h++) {
            const u = laps + h / heads;
            const frac = ((u % 1) + 1) % 1;
            // Bounce: 0..1 becomes 0..1..0, so the dot turns back at the end.
            const pos = (bounce ? 1 - Math.abs(2 * (((u / 2) % 1 + 1) % 1) - 1) : frac) * (segments - 1);
            const color = palette[Math.floor(((u % palette.length) + palette.length) % palette.length)];

            for (let i = 0; i < segments; i++) {
                // Distance BEHIND the dot: the tail trails the direction of travel.
                let d = (i - pos) * (dir >= 0 ? -1 : 1);
                if (!bounce) {
                    // When wrapping, the tail may cross the end of the strip.
                    if (d < 0) d += segments;
                    if (d > segments) d -= segments;
                }
                if (d < -0.5) continue;
                const env = Math.exp(-Math.max(d, 0) / tail);
                out[i] = add(out[i], scale(color, env * peak * bri));
            }
        }
        return out.map(round8);
    };
}
