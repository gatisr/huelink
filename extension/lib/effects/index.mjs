/**
 * effects - the catalogue and the engine.
 *
 * Effects are DATA, not code: `effects.json` names them, `palettes.json` holds
 * the colours, `generators/<kind>.mjs` holds one kind of motion. A new effect
 * is a new catalogue entry, not a new branch in the sender. The engine knows
 * nothing about any particular effect.
 *
 * Time is accumulated (`phase += dt * speed`), not read from the clock, so a
 * speed change continues from where it was. See docs/EFFECTS.md.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { LOCALE, t } from "../i18n/index.mjs";
import { toFinite } from "../num.mjs";
import { clamp } from "./util.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Where generators live, and the only directory `kind` may name. */
const GENERATOR_DIR = join(HERE, "generators");

/** The only colour form the catalogue may use. */
const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/;

/** No effect selected. Also the first option in the HA `select`. */
export const EFFECT_NONE = t("effect.none");

/**
 * The generator names that really exist, read from the directory rather than
 * listed here, so adding a generator stays one new file.
 *
 * `kind` comes out of `effects.json` and used to be interpolated straight into
 * an `import()` specifier. That file is plain data: it can be shared, copied
 * from a forum post or edited by anything that can write to the extension
 * directory, and `kind: "../../../something"` would have executed an arbitrary
 * `.mjs` inside zigbee2mqtt's own process. Checking the name against this set
 * first means the only modules reachable from the catalogue are the ones
 * shipped beside this file.
 */
function generatorKinds(logger) {
    try {
        return new Set(
            readdirSync(GENERATOR_DIR)
                .filter((f) => f.endsWith(".mjs"))
                .map((f) => f.slice(0, -".mjs".length)),
        );
    } catch (e) {
        logger.error(`[huelink] ${t("log.generatorsUnreadable", { dir: GENERATOR_DIR, error: e.message })}`);
        return new Set();
    }
}

/**
 * Effect name in the chosen language.
 *
 * `name` is a language map (`{"en": ..., "lv": ...}`); a missing translation
 * falls back to "en" rather than to nothing, because the name is also the HA
 * `select` VALUE, and an empty value is an effect nobody can pick. A plain
 * string is accepted too, so a hand-written catalogue still works.
 */
function effectName(name, locale = LOCALE) {
    if (typeof name === "string") return name;
    if (name && typeof name === "object") return name[locale] ?? name.en ?? null;
    return null;
}

/**
 * Resolve a palette reference to a list of hex colours. Accepts a name, a hex
 * list, or a mix of the two ("the flag plus black between the stripes" is not
 * a new palette, it is two existing ones combined).
 *
 * An unknown name throws instead of quietly returning white: a silently white
 * strip looks like a broken effect and the cause would be unfindable.
 */
function resolvePalette(value, table, seen = new Set()) {
    if (typeof value === "string") {
        if (seen.has(value)) throw new RangeError(t("error.paletteCycle", { name: value }));
        // `table` comes from JSON.parse, so it still has Object.prototype
        // behind it: a palette called "constructor" or "toString" would
        // "resolve" to a function and the error below would never fire. Own
        // keys only, for the same reason `MODE_BY_LABEL` is a Map.
        const found = Object.hasOwn(table, value) ? table[value] : undefined;
        if (!found) throw new RangeError(t("error.paletteUnknown", { name: value }));
        return resolvePalette(found, table, new Set([...seen, value]));
    }
    if (!Array.isArray(value)) throw new RangeError(t("error.paletteNotNameOrList"));
    return value.flatMap((item) => {
        if (typeof item === "string" && !item.startsWith("#")) return resolvePalette(item, table, seen);
        // Colours are checked HERE, at load, rather than left to `hex2rgb`
        // when the effect is first created. By then the loader's promise that
        // a bad entry is merely skipped has already been broken: `start()`
        // selects `effects[0]`, so one malformed colour in the first effect
        // threw out of `start()` and the extension did not come up at all.
        if (typeof item !== "string" || !HEX_COLOUR.test(item)) {
            throw new RangeError(t("error.paletteBadColour", { value: JSON.stringify(item) ?? String(item) }));
        }
        return [item];
    });
}

/** Parse JSON, or return `null` and log why. */
function readJson(file, logger, what) {
    try {
        return JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
        logger.error(`[huelink] ${t("log.jsonUnreadable", { what, file, error: e.message })}`);
        return null;
    }
}

/**
 * Read the catalogue and import each entry's generator. A bad entry is skipped
 * with a warning rather than taking the extension down: `effects.json` is a
 * human-edited file, and a typo in it must not cost the user sync as well.
 *
 * @returns {Promise<Array<{id:string,name:string,kind:string,params:object,create:Function}>>}
 */
export async function loadEffects(
    logger = console,
    file = join(HERE, "effects.json"),
    paletteFile = join(HERE, "palettes.json"),
) {
    const doc = readJson(file, logger, t("label.effectCatalog"));
    if (!doc) return [];
    const table = readJson(paletteFile, logger, t("label.paletteList"))?.palettes ?? {};
    const kinds = generatorKinds(logger);

    const out = [];
    const seen = new Set();
    for (const entry of doc.effects ?? []) {
        const name = effectName(entry?.name);
        if (!name || !entry?.kind) {
            logger.error(`[huelink] ${t("log.effectMissingFields", { entry: JSON.stringify(entry) })}`);
            continue;
        }
        if (seen.has(name) || name === EFFECT_NONE) {
            logger.error(`[huelink] ${t("log.effectDuplicate", { name })}`);
            continue;
        }
        // Checked against the real directory listing BEFORE it can reach
        // `import()`; see `generatorKinds`. Skipped like every other bad
        // entry, so one unusable line in the catalogue costs that one effect.
        if (!kinds.has(entry.kind)) {
            logger.error(`[huelink] ${t("log.effectUnknownKind", { name, kind: String(entry.kind) })}`);
            continue;
        }
        let mod;
        try {
            mod = await import(`./generators/${entry.kind}.mjs`);
        } catch (e) {
            logger.error(`[huelink] ${t("log.effectNoGenerator", { name, kind: entry.kind, error: e.message })}`);
            continue;
        }
        // Palettes are resolved HERE, not in the generator: a generator only
        // ever sees a hex list and knows nothing about palettes.json, so a new
        // palette touches no generator at all.
        let params = entry.params ?? {};
        try {
            if (params.palette !== undefined) {
                params = { ...params, palette: resolvePalette(params.palette, table) };
            }
        } catch (e) {
            logger.error(`[huelink] ${t("log.effectBadPalette", { name, error: e.message })}`);
            continue;
        }
        seen.add(name);
        out.push({
            id: entry.id ?? name,
            name,
            kind: entry.kind,
            params,
            create: mod.create,
            // For `tools/preview.mjs` only: seconds of filmstrip to render.
            // Carried along so the tool need not parse effects.json again.
            preview: entry.preview ?? null,
            // For `tools/effectproof.mjs` only: what the effect must be judged
            // by when it deliberately is not 7 distinct segments (symmetric
            // palette, still background glow, very slow motion).
            proof: entry.proof ?? null,
        });
    }
    return out;
}

export class EffectEngine {
    /**
     * @param {object} opts
     * @param {Array} opts.effects  from `loadEffects()`
     * @param {number} opts.segments
     * @param {number} [opts.seed]  RNG seed; fix it in tests
     * @param {object} [opts.logger]  needs `.error`; a generator that throws
     *   on start is the one thing in here nobody could otherwise see
     */
    constructor({ effects, segments, seed = null, logger = console }) {
        this.effects = effects;
        this.segments = segments;
        this.seed = seed;
        this.logger = logger;
        this.selected = EFFECT_NONE;
        this.render = null;
        this.phase = 0;
        this.lastAt = null;
        this.speed = 1; // 1.0 = the effect's own speed
        this.brightness = 1; // 1.0 = the effect's own brightness
    }

    /** HA `select` options; "none" is always first. */
    get options() {
        return [EFFECT_NONE, ...this.effects.map((e) => e.name)];
    }

    get active() {
        return this.render !== null;
    }

    /**
     * Select by name. An unknown name means off: silently carrying on with the
     * previous effect would be worse than a visibly dark strip.
     *
     * Nothing moves until `create()` has returned. The name used to be stored
     * first, so a generator that threw left `selected` naming the new effect
     * while `render` still drew the old one: the MQTT state and the HA select
     * said one thing and the strip showed another, with no way to tell from
     * outside which was true. A failure now lands on "nothing selected,
     * nothing rendering", a state the rest of the code already handles.
     *
     * @returns {boolean} whether the name was valid AND could be started
     */
    select(name) {
        const wanted = name ?? EFFECT_NONE;
        const found = this.effects.find((e) => e.name === wanted);
        let render = null;
        if (found) {
            try {
                render = found.create(found.params, this.segments, this.seed ?? (Date.now() & 0xffffffff));
            } catch (e) {
                this.#clear();
                this.logger.error(`[huelink] ${t("log.effectCreateFailed", { name: wanted, error: e.message })}`);
                return false;
            }
        }
        this.selected = found ? found.name : EFFECT_NONE;
        this.render = render;
        this.phase = 0;
        this.lastAt = null;
        return wanted === EFFECT_NONE || Boolean(found);
    }

    /** Back to "nothing selected": the safe state after a failed start. */
    #clear() {
        this.selected = EFFECT_NONE;
        this.render = null;
        this.phase = 0;
        this.lastAt = null;
    }

    /**
     * Start the selected effect over.
     *
     * `select()` does this too, but re-entering effect mode is not a
     * selection, and some effects have an END: a sunrise that has finished
     * rising stays at full daylight for ever, so switching effect mode on
     * again showed a still frame and looked like a broken generator. The
     * effect is re-created rather than just rewound, because a generator may
     * hold state of its own (sparkle positions, flame seeds).
     */
    restart() {
        if (!this.active) return;
        this.select(this.selected);
    }

    /**
     * Speed as a percentage of the effect's own pace.
     *
     * A value that is not a number is REFUSED, not converted: `NaN` survives
     * `clamp` untouched, and a stored `NaN` makes every later frame throw,
     * which the circuit breaker reads as a broken strip and answers by
     * switching it off. See `lib/num.mjs`.
     *
     * @returns {boolean} whether the value was taken (a refusal changes nothing)
     */
    setSpeed(percent) {
        const value = toFinite(percent);
        if (value === null) return false;
        this.speed = clamp(value / 100, 0.1, 3);
        return true;
    }

    /** Brightness as a percentage of the effect's own. Refuses like `setSpeed`. */
    setBrightness(percent) {
        const value = toFinite(percent);
        if (value === null) return false;
        this.brightness = clamp(value / 100, 0.01, 1);
        return true;
    }

    /**
     * Next frame, or `null` if no effect is selected. `dt` is clamped so a
     * stalled process resumes instead of jumping seconds ahead.
     * @param {number} now  ms (Date.now()); tests pass synthetic time
     */
    frame(now = Date.now()) {
        if (!this.render) return null;
        const dt = this.lastAt === null ? 0 : clamp((now - this.lastAt) / 1000, 0, 0.25);
        this.lastAt = now;
        this.phase += dt * this.speed;

        const k = this.brightness;
        return this.render(this.phase).map((c) => ({
            r: Math.round(clamp(c.r * k, 0, 255)),
            g: Math.round(clamp(c.g * k, 0, 255)),
            b: Math.round(clamp(c.b * k, 0, 255)),
        }));
    }
}
