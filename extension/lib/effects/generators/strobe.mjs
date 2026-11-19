/**
 * strobe - hard pulses running along the strip.
 *
 * Every segment shares one rhythm, offset by `stagger` of a beat. So the pulse
 * does not flash everywhere at once (which on 7 segments looks like a cheap
 * disco light) but runs end to end, and at any instant neighbouring segments
 * sit at different points of the beat, hence in different colours.
 *
 * Each beat takes the next palette colour. Parameters: docs/EFFECTS.md.
 */

import { add, hex2rgb, parsePalette, round8, scale } from "../util.mjs";

export function create(p, segments) {
    const palette = parsePalette(p.palette, ["#ff0000", "#ffffff"]);
    const period = p.periodSeconds ?? 0.55;
    const duty = p.duty ?? 0.18;
    const tail = p.tailSeconds ?? 0.06;
    const stagger = p.stagger ?? 0.09;
    const base = hex2rgb(p.base ?? "#140000");
    const bri = p.brightness ?? 1;

    return (t) => {
        return Array.from({ length: segments }, (_, i) => {
            const phase = t / period - i * stagger;
            const beat = Math.floor(phase);
            const frac = phase - beat;
            let env;
            if (frac < duty) {
                env = 1;
            } else if (tail > 0) {
                env = Math.exp(-((frac - duty) * period) / tail);
            } else {
                env = 0;
            }
            const color = palette[((beat % palette.length) + palette.length) % palette.length];
            return round8(add(base, scale(color, env * bri)));
        });
    };
}
