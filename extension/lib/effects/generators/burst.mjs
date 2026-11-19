/**
 * burst - short flashes at random places that fade out. Fireworks.
 *
 * Each burst is a point on the strip with falloff onto its neighbours and an
 * exponential decay; overlapping ones add up, so a dense volley reads as a
 * white flare, exactly like the real thing.
 *
 * Only the flash is modelled, not the flight: on 7 segments a rocket's arc is
 * invisible, all the eye gets is "something suddenly got bright over there".
 * Parameters: docs/EFFECTS.md.
 */

import { add, clamp, hex2rgb, hsv, makeRng, round8, scale } from "../util.mjs";

export function create(p, segments, seed) {
    const rate = p.rateHz ?? 2.5;
    const decay = p.decaySeconds ?? 0.45;
    const rise = p.riseSeconds ?? 0.05;
    const spread = p.spread ?? 1.2;
    const peak = p.peak ?? 1.6;
    const hues = Array.isArray(p.hues) ? p.hues : [];
    const sat = p.saturation ?? 0.9;
    const base = hex2rgb(p.base ?? "#000000");

    const rng = makeRng(seed);
    let live = [];
    let last = 0;

    const spawn = (t) => ({
        at: t,
        center: rng() * (segments - 1),
        color: hsv(hues.length ? hues[Math.floor(rng() * hues.length)] : rng() * 360, sat, 1),
        gain: 0.6 + rng() * 0.4,
    });

    return (t) => {
        const dt = clamp(t - last, 0, 0.5);
        last = t;

        // Poisson arrivals: `rate` events per second on average, but irregular.
        let expect = rate * dt;
        while (expect > 0) {
            if (rng() < Math.min(expect, 1)) live.push(spawn(t));
            expect -= 1;
        }
        // After 6 half-lives it is invisible; keeping it on the list is waste.
        live = live.filter((b) => t - b.at < decay * 6 + rise);

        return Array.from({ length: segments }, (_, i) => {
            let c = base;
            for (const b of live) {
                const age = t - b.at;
                const env = age < rise ? age / Math.max(rise, 1e-6) : Math.exp(-(age - rise) / decay);
                const d = Math.abs(i - b.center);
                const fall = spread <= 0 ? (d < 0.5 ? 1 : 0) : Math.exp(-(d * d) / (2 * spread * spread));
                c = add(c, scale(b.color, env * fall * peak * b.gain));
            }
            return round8(c);
        });
    };
}
