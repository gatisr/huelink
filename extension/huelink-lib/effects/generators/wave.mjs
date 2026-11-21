/**
 * wave - palette bands travelling evenly along the strip.
 *
 * The palette repeats `bands` times over the strip and shifts at a constant
 * speed, so every segment always sits at a different point of the palette and
 * the strip is never one flat colour. Parameters: docs/EFFECTS.md.
 */

import { cyclic, parsePalette, round8, scale } from "../util.mjs";

export function create(p, segments) {
    const palette = parsePalette(p.palette, ["#ff1010", "#0b8a2a"]);
    const bands = p.bands ?? 1;
    const cycle = p.cycleSeconds ?? 12;
    const softness = p.softness ?? 0.45;
    const dir = p.direction ?? 1;
    const bri = p.brightness ?? 1;

    return (t) => {
        const shift = (dir * t) / cycle;
        return Array.from({ length: segments }, (_, i) =>
            round8(scale(cyclic(palette, (i / segments) * bands + shift, softness), bri)),
        );
    };
}
