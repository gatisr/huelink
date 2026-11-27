/**
 * custom - the one user-made effect, and the small file that remembers what
 * the user chose in Home Assistant across a restart.
 *
 * The custom effect is built from what the catalogue already loaded: a style
 * is one of its generators, colours are either the user's own list or the
 * palette of an existing effect. No generator and no palette is defined here.
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { CONFIG_FILE } from "./config.mjs";
import { t } from "./i18n/index.mjs";

/** Generators that take a palette and run for ever. `ramp` ends and `burst` has no palette. */
export const CUSTOM_STYLES = ["wave", "breathe", "flame", "chase", "pulse", "twinkle", "strobe", "solid"];

/** Most colours the own list holds: 8 fit the HA text field and are more than 7 segments can show. */
export const MAX_OWN_COLOURS = 8;

const HEX_COLOUR = /^#[0-9a-f]{6}$/;

/** "#ff0000 #00FF88, #fff000" -> lower-case hex list; `null` if anything in it is not a colour or it is too long. */
export function parseColours(text) {
    const list = String(text ?? "")
        .toLowerCase()
        .split(/[\s,;]+/)
        .filter(Boolean);
    return list.length <= MAX_OWN_COLOURS && list.every((c) => HEX_COLOUR.test(c)) ? list : null;
}

export class CustomEffect {
    /** @param {Array} effects  what `loadEffects` returned */
    constructor(effects) {
        // Each style's `create` comes from a catalogue effect of that kind, so only kinds that loaded are offered.
        this.styles = CUSTOM_STYLES.map((kind) => ({
            kind,
            label: t(`style.${kind}`),
            create: effects.find((e) => e.kind === kind)?.create,
        })).filter((s) => s.create);
        this.sources = effects.filter((e) => Array.isArray(e.params?.palette)).map((e) => ({ id: e.id, name: e.name, palette: e.params.palette }));
        this.ownLabel = t("custom.own");
        this.style = this.styles[0]?.kind ?? null;
        /** `null` = the own list, otherwise the id of the effect whose palette is borrowed. */
        this.source = this.sources[0]?.id ?? null;
        this.own = [];
        /** The catalogue entry the engine selects like any other; rebuilt in place on every change. */
        this.entry = { id: "custom", name: t("custom.effect"), kind: this.style, params: {}, create: null, preview: null, proof: null };
        this.#rebuild();
    }

    get available() {
        return this.styles.length > 0;
    }

    get styleOptions() {
        return this.styles.map((s) => s.label);
    }

    get colourOptions() {
        return [this.ownLabel, ...this.sources.map((s) => s.name)];
    }

    get styleLabel() {
        return this.styles.find((s) => s.kind === this.style)?.label ?? null;
    }

    get colourLabel() {
        return this.sources.find((s) => s.id === this.source)?.name ?? this.ownLabel;
    }

    /** By label (HA) or kind (saved state). Returns whether it was known. */
    setStyle(value) {
        const found = this.styles.find((s) => s.label === value || s.kind === value);
        if (!found) return false;
        this.style = found.kind;
        this.#rebuild();
        return true;
    }

    /** By label (HA), effect id (saved state) or `null` for the own list. */
    setColours(value) {
        if (value === null || value === this.ownLabel) this.source = null;
        else {
            const found = this.sources.find((s) => s.name === value || s.id === value);
            if (!found) return false;
            this.source = found.id;
        }
        this.#rebuild();
        return true;
    }

    /** Replace the own list from text. An empty list is allowed: the style then shows its own default colours. */
    setOwn(text) {
        const list = parseColours(text);
        if (!list) return false;
        this.own = list;
        this.#rebuild();
        return true;
    }

    /** Append one colour and switch to the own list, so the press is visible. `false` when the list is full. */
    addOwn(hex) {
        if (this.own.length >= MAX_OWN_COLOURS) return false;
        this.own = [...this.own, hex];
        this.source = null;
        this.#rebuild();
        return true;
    }

    snapshot() {
        return { style: this.style, source: this.source, own: this.own.join(" ") };
    }

    /** From a saved snapshot; anything unreadable in it is skipped, not thrown. */
    restore(saved) {
        if (saved === null || typeof saved !== "object") return;
        this.setOwn(saved.own);
        this.setStyle(saved.style);
        this.setColours(saved.source ?? null);
    }

    #rebuild() {
        const style = this.styles.find((s) => s.kind === this.style);
        const palette = this.sources.find((s) => s.id === this.source)?.palette ?? this.own;
        this.entry.kind = this.style;
        this.entry.create = style?.create ?? null;
        // An empty palette is left out, so the generator falls back to its own default.
        this.entry.params = palette.length ? { palette } : {};
    }
}

/**
 * Where the saved state lives: next to the config file. With `HUELINK_CONFIG`
 * set (tools and tests) there is none unless `HUELINK_STATE` names one, so a
 * test run never leaves a file behind or reads the previous run's choices.
 * Read at call time, not at import.
 */
export function stateFile() {
    if (process.env.HUELINK_STATE !== undefined) return process.env.HUELINK_STATE || null;
    return process.env.HUELINK_CONFIG ? null : join(dirname(CONFIG_FILE), "huelink.state.json");
}

/** The saved object, or `null` when there is no file or it cannot be read (said once, never thrown). */
export function loadState(file, logger) {
    if (!file) return null;
    try {
        const doc = JSON.parse(readFileSync(file, "utf8"));
        if (doc === null || typeof doc !== "object" || Array.isArray(doc)) throw new Error("not an object");
        return doc;
    } catch (e) {
        if (e.code !== "ENOENT") logger.error(`[huelink] ${t("log.stateUnreadable", { file, error: e.message })}`);
        return null;
    }
}

/** Write through a temp file and a rename, so a crash never leaves half a file. A failure is logged, never thrown. */
export function saveState(file, json, logger) {
    if (!file) return;
    try {
        writeFileSync(`${file}.tmp`, json);
        renameSync(`${file}.tmp`, file);
    } catch (e) {
        logger.error(`[huelink] ${t("log.stateWriteFailed", { file, error: e.message })}`);
    }
}
