/**
 * util - small helpers for the effect generators.
 *
 * Colour maths here is deliberately simple and works in RGB 0..255. The
 * correct colour space is `huepack.mjs`'s job; generators think in "red", not
 * in "x = 0.64".
 *
 * The RNG is seeded on purpose: without it the random effects (bursts,
 * sparkle) are not reproducible and the test bench can prove nothing. In
 * production the seed comes from `Date.now()`, in tests from a constant.
 */

/** mulberry32: four lines, good enough for flicker, reproducible. */
export function makeRng(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** "#ff1010" or "ff1010" -> {r,g,b} */
export function hex2rgb(h) {
    const s = String(h).replace(/^#/, "");
    if (!/^[0-9a-fA-F]{6}$/.test(s)) throw new RangeError(`colour '${h}' is not #rrggbb`);
    const n = parseInt(s, 16);
    return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

export const BLACK = { r: 0, g: 0, b: 0 };

/** Linear blend between two RGB colours; k = 0 -> a, 1 -> b. */
export function mix(a, b, k) {
    const t = clamp(k, 0, 1);
    return {
        r: a.r + (b.r - a.r) * t,
        g: a.g + (b.g - a.g) * t,
        b: a.b + (b.b - a.b) * t,
    };
}

/** Scale a colour's brightness by k (0..1+), clamped to 0..255. */
export function scale(c, k) {
    return { r: clamp(c.r * k, 0, 255), g: clamp(c.g * k, 0, 255), b: clamp(c.b * k, 0, 255) };
}

export function add(a, b) {
    return { r: clamp(a.r + b.r, 0, 255), g: clamp(a.g + b.g, 0, 255), b: clamp(a.b + b.b, 0, 255) };
}

/** Whole bytes; needed only on output, internally we stay in floats. */
export function round8(c) {
    return { r: Math.round(c.r), g: Math.round(c.g), b: Math.round(c.b) };
}

/**
 * Point at u (0..1) along the WHOLE palette read as one gradient:
 * [red, green, blue] -> u=0.5 is pure green, u=0.25 is red-green.
 */
export function gradient(palette, u) {
    if (palette.length === 1) return palette[0];
    const p = clamp(u, 0, 1) * (palette.length - 1);
    const i = Math.min(Math.floor(p), palette.length - 2);
    return mix(palette[i], palette[i + 1], p - i);
}

/**
 * Point in a cycling palette (last colour wraps back to the first), with edge
 * sharpness: softness 1 = smooth blend, 0 = hard threshold between bands.
 */
export function cyclic(palette, pos, softness) {
    const n = palette.length;
    const p = ((pos % 1) + 1) % 1;
    const q = p * n;
    const i = Math.floor(q) % n;
    const frac = q - Math.floor(q);
    const s = Math.max(softness, 1e-3);
    const w = clamp((frac - 0.5) / s + 0.5, 0, 1);
    return mix(palette[i], palette[(i + 1) % n], w);
}

/** Palette list from the catalogue (#rrggbb strings) -> RGB objects. */
export function parsePalette(list, fallback = ["#ffffff"]) {
    const src = Array.isArray(list) && list.length ? list : fallback;
    return src.map(hex2rgb);
}

/** HSV -> RGB, h in degrees. Needed by burst, where hue is random. */
export function hsv(h, s, v) {
    const hh = (((h % 360) + 360) % 360) / 60;
    const c = v * s;
    const x = c * (1 - Math.abs((hh % 2) - 1));
    const m = v - c;
    const t = [
        [c, x, 0],
        [x, c, 0],
        [0, c, x],
        [0, x, c],
        [x, 0, c],
        [c, 0, x],
    ][Math.floor(hh) % 6];
    return { r: (t[0] + m) * 255, g: (t[1] + m) * 255, b: (t[2] + m) * 255 };
}

/** 0..1 -> 0..1 with soft ends; the standard smoothstep. */
export const smooth = (t) => {
    const x = clamp(t, 0, 1);
    return x * x * (3 - 2 * x);
};
