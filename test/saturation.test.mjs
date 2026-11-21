/**
 * Saturation: at 100 % the output must be byte-identical to pre-1.3.0 frames
 * (huepack's real-bridge proof depends on it); elsewhere, sane arithmetic.
 */

import { strict as assert } from "node:assert";
import test from "node:test";

import {
    MODE_SEGMENT,
    SATURATION,
    SATURATION_PCT,
    clampSaturationPct,
    encodeFrame,
    saturate,
} from "../extension/huelink-lib/huepack.mjs";

/** Primaries, greys, black, white and off-axis colours with non-round channels. */
const SAMPLE = [
    { r: 0, g: 0, b: 0 },
    { r: 255, g: 255, b: 255 },
    { r: 255, g: 0, b: 0 },
    { r: 0, g: 255, b: 0 },
    { r: 0, g: 0, b: 255 },
    { r: 128, g: 128, b: 128 },
    { r: 17, g: 17, b: 17 },
    { r: 203, g: 51, b: 97 },
    { r: 7, g: 199, b: 221 },
    { r: 240, g: 231, b: 109 },
    { r: 1, g: 2, b: 3 },
    { r: 254, g: 253, b: 1 },
];

const frameOf = (colors) =>
    encodeFrame(
        42,
        0x0400,
        colors.map((color, i) => ({ addr: 0x1000 + i, color, mode: MODE_SEGMENT })),
    );

// ------------------------------------------------ A: neutral is a no-op ----

test("at 100 % the colours are the same array and the frame is byte-identical", () => {
    assert.equal(saturate(SAMPLE, 1), SAMPLE, "neutral path must return the input untouched");
    assert.deepEqual(frameOf(saturate(SAMPLE, 1)), frameOf(SAMPLE));
});

// ------------------------------------------------- B: the arithmetic -----

test("grey stays grey at any saturation (the luma weights sum to 1)", () => {
    // Rec.709 weights must sum to exactly 1.
    for (const s of [0.5, 1.6, 2]) {
        for (const v of [0, 17, 128, 255]) {
            assert.deepEqual(
                saturate([{ r: v, g: v, b: v }], s),
                [{ r: v, g: v, b: v }],
                `grey ${v} at ${s}`,
            );
        }
    }
});

test("black stays black, so the black gate keeps meaning what it meant", () => {
    for (const s of [0.5, 1, 1.5, 2]) {
        assert.deepEqual(saturate([{ r: 0, g: 0, b: 0 }], s), [{ r: 0, g: 0, b: 0 }]);
    }
});

test("above 100 % colours move away from grey, below 100 % towards it", () => {
    const [up] = saturate([{ r: 203, g: 51, b: 97 }], 1.5);
    const [down] = saturate([{ r: 203, g: 51, b: 97 }], 0.5);
    const luma = 0.2126 * 203 + 0.7152 * 51 + 0.0722 * 97;

    assert.ok(up.r > 203, `${up.r} should be above 203`);
    assert.ok(down.r < 203 && down.r > luma, `${down.r} should sit between the luma and 203`);
    assert.ok(up.g < 51, `${up.g} should be below 51`);
    assert.ok(down.g > 51 && down.g < luma, `${down.g} should sit between 51 and the luma`);
});

test("output is one in-range integer colour per segment, in order, input untouched", () => {
    const before = structuredClone(SAMPLE);
    for (const s of [0.5, 1.1, 1.55, 1.8, 2]) {
        const out = saturate(SAMPLE, s);
        assert.equal(out.length, SAMPLE.length);
        for (const c of out) {
            for (const ch of ["r", "g", "b"]) {
                assert.ok(Number.isInteger(c[ch]) && c[ch] >= 0 && c[ch] <= 255, `${ch}=${c[ch]} at ${s}`);
            }
        }
    }
    assert.deepEqual(saturate(SAMPLE, 1.8)[0], { r: 0, g: 0, b: 0 }, "order kept: black first");
    assert.equal(saturate(SAMPLE, 1.8)[2].r, 255, "order kept: pure red third");
    assert.deepEqual(SAMPLE, before);
});

// ----------------------------------------------------- C: the clamp ------

test("the percent clamp: ends, step snapping (preset matching uses ===), nonsense refused", () => {
    const { min, max, step } = SATURATION_PCT;
    const cases = [[min, min], [max, max], [-400, min], [10_000, max], [102, 100], [103, 105], [154.9, 155]];
    for (const [input, want] of cases) assert.equal(clampSaturationPct(input), want, String(input));
    for (const v of [51, 77, 99, 123, 198]) assert.equal(clampSaturationPct(v) % step, 0, `${v} did not snap`);
    for (const bad of [undefined, null, "", "abc", NaN, Infinity, {}, []]) {
        assert.equal(clampSaturationPct(bad), null, JSON.stringify(bad) ?? String(bad));
    }
});
