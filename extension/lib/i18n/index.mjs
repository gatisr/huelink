/**
 * i18n - every human-visible string in one place.
 *
 * `en.json` is the base and must contain every key; other locales are laid
 * over it, so a missing translation shows English rather than a blank or a key
 * name. A new language is a new file plus an entry in `LOCALES`
 * (`lib/config.mjs`), with no code change.
 *
 * Keys are flat (`"status.off"`) so "where does this text come from" is one
 * grep. Parameters are `{name}`; an unsupplied one stays visible as `{name}`,
 * because a blank space looks like finished text and goes unnoticed.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CONFIG, LOCALES } from "../config.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

function read(locale) {
    return JSON.parse(readFileSync(join(HERE, `${locale}.json`), "utf8"));
}

/** The base table. Every key used in the code MUST exist here. */
const BASE = read("en");

/** Report a missing key once, not on every frame. */
const reported = new Set();

function format(table, key, params) {
    const template = table[key];
    if (template === undefined) {
        if (!reported.has(key)) {
            reported.add(key);
            console.error(`[huelink] i18n: no string for '${key}'`);
        }
        return key;
    }
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (whole, name) => (name in params ? String(params[name]) : whole));
}

/**
 * A translator for one locale. Separate from `t` so tests can compare two
 * languages in one process regardless of what the configuration says.
 */
export function makeTranslator(locale) {
    const table = locale === "en" ? BASE : { ...BASE, ...read(locale) };
    return (key, params) => format(table, key, params);
}

/** The locale actually in use (an invalid one already fell back to "en"). */
export const LOCALE = LOCALES.includes(CONFIG.locale) ? CONFIG.locale : "en";

/** The process translator. Everything else imports this. */
export const t = makeTranslator(LOCALE);
