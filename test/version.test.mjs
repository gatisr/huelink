/**
 * VERSION PARITY: `extension/huelink.mjs` and `package.json` must agree.
 *
 * The extension cannot read `package.json`: zigbee2mqtt imports it from a
 * temporary copy inside its own data directory, where that file does not
 * exist. So the number is written twice, and two numbers that must match are
 * two numbers that eventually will not. This test is the thing that notices.
 *
 * It matters more here than in most projects, because the version IS the
 * diagnostic: a hot reload replaces the top-level file and leaves `huelink-lib/`
 * cached, so "which code is actually running" is answered by nothing else.
 * A version that lies looks like an answer.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8"));
// Imported, not grepped: a regex over the source would still pass if the
// constant were moved somewhere the extension never reads.
const { VERSION } = await import(join(REPO, "extension/huelink.mjs"));

test("VERSION in huelink.mjs matches version in package.json", () => {
    assert.equal(VERSION, pkg.version);
});

test("the version is a plain semver, not a placeholder", () => {
    assert.match(VERSION, /^\d+\.\d+\.\d+$/);
});

test("the extension exports VERSION, so this test cannot be bypassed", () => {
    // If someone un-exports it the import above yields `undefined`, which the
    // equality test would catch; this one says why in one line.
    assert.equal(typeof VERSION, "string");
});
