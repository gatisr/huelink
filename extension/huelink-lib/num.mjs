/**
 * num - one answer to "is this value a number", for everything arriving from
 * outside the process.
 *
 * MQTT payloads are JSON, and JSON carries whatever the sender felt like:
 * `{"effect_speed": "fast"}` is as valid a message as `{"effect_speed": 150}`.
 * `Number()` turns the first into `NaN`, and `NaN` walks straight through a
 * clamp, because every comparison with it is false. The bad value is then
 * stored, and from that point every frame throws - until the circuit breaker
 * decides the strip is broken and switches it off. One typo, lights out.
 *
 * `Number(x) || fallback` is not the fix either: it also swallows a legitimate
 * `0`, and the fallback is usually the most permissive setting, so bad input
 * ends up asking for MORE than good input ever could.
 *
 * Hence: parse first, decide second. The caller gets `null` and refuses the
 * value, instead of storing something that only fails later and elsewhere.
 */

/**
 * The number this value really is, or `null` if it is not one.
 *
 * Stricter than `Number()` on purpose: `null`, `true` and `""` all convert
 * without MEANING a number, and accepting them hides the mistake that sent
 * them. `0` and `"0"` are numbers and come back as `0`.
 *
 * @param {unknown} value
 * @returns {number|null}
 */
export function toFinite(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "string" && value.trim() !== "") {
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
    }
    return null;
}
