/**
 * DEPLOY SETTINGS: which file wins, and where the secrets are not.
 *
 * Two things in `scripts/deploy.sh` are only worth having if they are exactly
 * right, and neither of them shows up in normal use.
 *
 * The first is precedence. `.env` describes the installation and `.env.deploy`
 * redirects one run somewhere else; if the order is wrong, `.env.deploy` is
 * read in full and changes nothing, and the deploy goes to the machine the
 * operator was trying to avoid while reporting success.
 *
 * The second is that no secret reaches a command line. `ps` shows every
 * argument of every process to every user on the machine, so `-P "$password"`
 * publishes the broker password to anyone who can log in.
 *
 * The precedence tests run the real script with `--dry-run`, which makes no
 * network calls at all, against a throwaway checkout: anything less would be
 * testing a copy of the logic rather than the logic.
 */

import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = readFileSync(join(REPO, "scripts/deploy.sh"), "utf8");

/**
 * A throwaway checkout with just enough in it for `--dry-run` to run: the real
 * script, a version to read, the files the preflight insists on, and a commit
 * so `git rev-parse` has something to say.
 */
function fakeRepo({ env = {}, deploy = {} } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "huelink-deploy-"));
    mkdirSync(join(dir, "scripts"));
    mkdirSync(join(dir, "extension/lib"), { recursive: true });
    mkdirSync(join(dir, "converter"));
    writeFileSync(join(dir, "scripts/deploy.sh"), SCRIPT);
    writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "9.9.9" }));
    writeFileSync(join(dir, "extension/huelink.mjs"), "");
    writeFileSync(join(dir, "extension/lib/thing.mjs"), "");
    writeFileSync(join(dir, "converter/huelink-exposes.mjs"), "");
    const write = (name, values) => {
        const body = Object.entries(values)
            .map(([k, v]) => `${k}=${v}\n`)
            .join("");
        if (body) writeFileSync(join(dir, name), body);
    };
    write(".env", env);
    write(".env.deploy", deploy);
    const git = (...args) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    git("init", "-q");
    git("-c", "user.email=t@example.invalid", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "x");
    return dir;
}

/** `--dry-run` in that checkout, with a deliberately bare environment. */
function dryRun(dir, extraEnv = {}) {
    const r = spawnSync("bash", [join(dir, "scripts/deploy.sh"), "--dry-run"], {
        encoding: "utf8",
        // Not `process.env`: a stray HA_URL in the shell running the tests
        // would be a legitimate override and would quietly change the answer.
        env: { PATH: process.env.PATH, HOME: dir, ...extraEnv },
    });
    return { out: r.stdout ?? "", err: r.stderr ?? "", code: r.status };
}

/** The minimum a dry run needs before it will get as far as printing a target. */
const SETTINGS = {
    HA_URL: "http://ha.invalid:8123",
    HA_TOKEN: "token-from-env-file",
    MQTT_HOST: "broker.invalid",
    Z2M_EXTENSIONS_DIR: "/from/env/external_extensions",
};

test(".env.deploy overrides the same key in .env", () => {
    const dir = fakeRepo({
        env: SETTINGS,
        deploy: { Z2M_EXTENSIONS_DIR: "/from/deploy/external_extensions" },
    });
    try {
        const { out, code } = dryRun(dir);
        assert.equal(code, 0, out);
        assert.match(out, /\/from\/deploy\/external_extensions/);
        assert.doesNotMatch(out, /\/from\/env\/external_extensions/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a key only in .env still applies", () => {
    const dir = fakeRepo({ env: SETTINGS, deploy: { HA_TOKEN: "token-from-deploy" } });
    try {
        const { out, code } = dryRun(dir);
        assert.equal(code, 0, out);
        assert.match(out, /\/from\/env\/external_extensions/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("an environment variable wins over both files", () => {
    const dir = fakeRepo({
        env: SETTINGS,
        deploy: { Z2M_EXTENSIONS_DIR: "/from/deploy/external_extensions" },
    });
    try {
        const { out, code } = dryRun(dir, { Z2M_EXTENSIONS_DIR: "/from/shell/external_extensions" });
        assert.equal(code, 0, out);
        assert.match(out, /\/from\/shell\/external_extensions/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a key set in both files is named, with the winner", () => {
    const dir = fakeRepo({
        env: SETTINGS,
        deploy: { Z2M_EXTENSIONS_DIR: "/from/deploy/external_extensions", HA_TOKEN: "t" },
    });
    try {
        const { err, code } = dryRun(dir);
        assert.equal(code, 0, err);
        assert.match(err, /Z2M_EXTENSIONS_DIR/);
        assert.match(err, /HA_TOKEN/);
        assert.match(err, /\.env\.deploy wins/);
        // MQTT_HOST is in one file only, so naming it would be noise and would
        // train the operator to ignore the warning.
        assert.doesNotMatch(err, /MQTT_HOST/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("no warning when the two files do not overlap", () => {
    const dir = fakeRepo({ env: SETTINGS, deploy: { HUELINK_NAME: "other" } });
    try {
        const { err, code } = dryRun(dir);
        assert.equal(code, 0, err);
        assert.doesNotMatch(err, /warning/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("no warning when there is no .env.deploy at all", () => {
    const dir = fakeRepo({ env: SETTINGS });
    try {
        const { err, code } = dryRun(dir);
        assert.equal(code, 0, err);
        assert.doesNotMatch(err, /warning/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("no secret is passed as a command line argument", () => {
    // The token and the password may be read, written to a 0600 file and named
    // in a variable; what they may never be is an argument, because argv is
    // world-readable through `ps`. These are the two spellings that regress.
    assert.doesNotMatch(SCRIPT, /-H[ \t]+["']?Authorization/);
    assert.doesNotMatch(SCRIPT, /(^|[ \t])(-P|--pw)[ \t]+["$]/m);
});

test("the mosquitto clients are only reached through the wrappers", () => {
    // The wrappers are what set XDG_CONFIG_HOME, which is what makes the
    // credentials file apply. A direct call would silently connect
    // anonymously, or not at all, with no sign that a rule had been skipped.
    const direct = SCRIPT.split("\n").filter(
        (line) =>
            /(^|[^_a-z])mosquitto_(pub|sub)\b/.test(line) &&
            !line.trim().startsWith("#") &&
            !/^(mqtt_pub|mqtt_sub)\(\)/.test(line.trim()) &&
            !/require_command|for client in/.test(line),
    );
    assert.deepEqual(direct, []);
});

test("the HA token reaches curl through --config", () => {
    assert.match(SCRIPT, /--config "\$HA_CURL_CONF"/);
    // Created by a subshell that sets umask first, so the file is never world
    // readable, not even for the instant between creation and chmod.
    assert.match(SCRIPT, /umask 077/);
});

/** Every `KEY="${KEY:-...}"` line, which is deploy.sh's own list of settings. */
function knownSettings() {
    const keys = new Set();
    for (const m of SCRIPT.matchAll(/^([A-Z][A-Z0-9_]*)="\$\{\1:-/gm)) keys.add(m[1]);
    return keys;
}

for (const file of [".env.example", ".env.deploy.example"]) {
    test(`${file} only lists settings deploy.sh understands`, () => {
        const known = knownSettings();
        assert.ok(known.size > 5, "no settings found in deploy.sh");
        const body = readFileSync(join(REPO, file), "utf8");
        const listed = [...body.matchAll(/^([A-Za-z_][A-Za-z0-9_]*)=/gm)].map((m) => m[1]);
        assert.ok(listed.length > 0, `${file} lists no settings`);
        const unknown = listed.filter((k) => !known.has(k));
        assert.deepEqual(unknown, [], `${file} documents settings deploy.sh never reads`);
    });
}
