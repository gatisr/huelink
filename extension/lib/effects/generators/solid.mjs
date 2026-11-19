/**
 * solid - a still gradient along the strip. Background light that stays out of
 * the way.
 *
 * It looks like an empty generator, and that is the point: for film and reading
 * light, motion is a DEFECT. The eye catches every change in the periphery, and
 * a slowly breathing strip during a film is more distracting than a bright
 * still one. So "Cinema" is not `breathe` at low amplitude, it is no motion.
 *
 * `driftSeconds` allows a very slow palette shift for when some life is wanted
 * anyway (colours flowing over minutes, not seconds). 0 means every frame is
 * identical to the last. Parameters: docs/EFFECTS.md.
 */

import { gradient, parsePalette, round8, scale } from "../util.mjs";

export function create(p, segments) {
    const palette = parsePalette(p.palette, ["#ffffff"]);
    const spread = p.spread ?? 1;
    const drift = p.driftSeconds ?? 0;
    const bri = p.brightness ?? 1;

    return (t) => {
        const shift = drift > 0 ? (t / drift) % 1 : 0;
        return Array.from({ length: segments }, (_, i) => {
            const u = segments === 1 ? 0 : i / (segments - 1);
            // Centred on 0.5 so that as `spread` shrinks the colour converges
            // on the middle of the palette rather than sliding to one end.
            const pos = 0.5 + (u - 0.5) * spread + shift;
            // Without drift the position must NOT wrap: u = 1 would jump back
            // to the palette start and the last segment would fall out of the
            // gradient.
            return round8(scale(gradient(palette, drift > 0 ? ((pos % 1) + 1) % 1 : pos), bri));
        });
    };
}
