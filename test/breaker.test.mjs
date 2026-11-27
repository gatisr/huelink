/**
 * Circuit breaker, and "an implicit end means a dark strip".
 * No Zigbee needed: a strip that does not answer is a transport that throws,
 * a TV that switches off is a source that stops feeding frames.
 *
 * Nothing here is hardcoded: device name from the test config, mode names from
 * `MODE_LABEL`, log lines from the i18n table. Rationale and the per-case
 * reasoning: `docs/TESTING.md`.
 *
 * Run: `npm test` or `node --test test/breaker.test.mjs`.
 */
import assert from "node:assert";
import { afterEach, test } from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// Must be set BEFORE the extension loads: it picks locale and device at module
// load, so static imports would be too late (they are hoisted to the top).
process.env.HUELINK_CONFIG = join(HERE, "fixtures", "breaker.config.json");

const { default: HueLink } = await import("../extension/huelink.mjs");
const { CMD_FRAME } = await import("../extension/huelink-lib/huepack.mjs");
const { CONFIG } = await import("../extension/huelink-lib/config.mjs");
const { t } = await import("../extension/huelink-lib/i18n/index.mjs");
const { MODE_LABEL } = await import("../extension/huelink-lib/huelink-ui.mjs");
const { MAX_AUTO_TRIP_STREAK } = await import("../extension/huelink-lib/breaker.mjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A log line as a regex, built from the SAME i18n template the code uses.
 * Without params `t()` returns the template with `{name}` placeholders; those
 * become `.+`, everything else is escaped.
 */
const logLine = (key) =>
    new RegExp(
        t(key)
            .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
            .replace(/\\\{\w+\\\}/g, ".+"),
    );

/** Waits for the breaker to trip (the backoff ladder is ~7 s), or gives up. */
async function waitForTrip(link, limitMs = 20000) {
    const until = Date.now() + limitMs;
    while (Date.now() < until) {
        if (link.breaker.tripped) return true;
        await sleep(100);
    }
    return false;
}

/**
 * Hyperion stand-in. The colours CHANGE on purpose: pacing suppresses an
 * unchanging scene (that is part of its job), and the throughput check would
 * then measure suppression rather than throughput.
 */
function feed(link, periodMs = 20) {
    let i = 0;
    return setInterval(() => {
        const v = i++ % 2 ? 240 : 10;
        link.sources.sync.put(Array(7).fill({ r: v, g: 20, b: 30 }));
    }, periodMs);
}

/**
 * Started extensions, to be stopped after each case whatever the outcome.
 * Without this one failed case leaves timers and a bound UDP port behind, and
 * the NEXT case fails with EADDRINUSE - reporting the consequence, not the cause.
 */
const live = [];

/**
 * @param {boolean} failing   the strip does not answer Zigbee
 * @param {boolean} echo      z2m answers every `/set` with the matching state
 *                            publish, like the real broker does. OFF by
 *                            default: most cases do not need the round trip,
 *                            and it would make their command lists noisier.
 * @param {number}  echoMs    how long that round trip takes
 */
function harness({ failing, echo = false, echoMs = 80 }) {
    const log = { info: [], error: [], warning: [], debug: [] };
    const sends = [];
    const published = [];
    /** What went to z2m's state cache directly, with no command to the strip. */
    const entityStates = [];
    let dead = failing;
    // Set below, but needed inside `publish`, which runs only after `start()`.
    let self;

    const fail = () => dead;
    const endpoint = {
        async zclCommand(cluster, command) {
            sends.push(`cmd:${command}`);
            await sleep(5); // deliberately slow, like a real timeout, only shorter
            if (fail()) throw new Error("Timeout - 0x00178801aabbccdd/11 ... (Status 'TIMEOUT')");
        },
        async write(cluster, attrs) {
            sends.push("write");
            await sleep(5);
            if (fail()) throw new Error("Timeout");
        },
    };
    // `options` is a GETTER returning a fresh object, exactly like z2m's own
    // `Device.get options()`. The extension takes before/after snapshots of it
    // around `changeEntityOptions`, and a shared reference would make both
    // snapshots the same object, so a test on a plain field would pass while
    // the real thing broke.
    const deviceOptions = { ID: "0x00178801aabbccdd", friendly_name: CONFIG.device };
    const device = {
        zh: { networkAddress: 0x1234 },
        endpoint: () => endpoint,
        name: CONFIG.device,
        get options() {
            return { ...deviceOptions };
        },
    };

    const link = new HueLink(
        { resolveEntity: () => device },
        {
            publish: async (topic, payload) => {
                published.push({ topic, payload });
                if (!echo || topic !== `${CONFIG.device}/set`) return;
                // What z2m really does with a `/set`: it carries the command
                // out and then publishes the resulting entity state, whose
                // `payload` is the delta and therefore carries `state`. That
                // return trip is the whole point of this harness: without it
                // a feedback loop cannot be reproduced in a test at all.
                const state = JSON.parse(payload).state;
                if (state !== "ON" && state !== "OFF") return;
                setTimeout(() => {
                    void self.onEntityState({
                        entity: { name: CONFIG.device },
                        message: { state, brightness: 120 },
                        payload: { state },
                    });
                }, echoMs);
            },
        },
        { get: () => ({ state: "ON" }) },
        // `publishEntityState`. Real z2m passes it fourth; `null` here would
        // mean an error on EVERY `publishExposes` call, and that would look
        // like an extension fault rather than a missing test harness.
        async (entity, payload) => {
            entityStates.push(payload);
        },
        {
            onMQTTMessage() {},
            onPublishEntityState() {},
            removeListeners() {},
            // z2m's HA extension listens on this one and re-runs discovery.
            // Nothing here needs the effect, but the call must not throw.
            emitEntityOptionsChanged() {},
        },
        null,
        null,
        null,
        {
            get: () => ({ mqtt: { base_topic: "zigbee2mqtt" }, homeassistant: {} }),
            // Shallow on purpose: the only thing the extension writes through
            // it is the flat `homeassistant: {<key>: null}` map.
            changeEntityOptions: (id, patch) => Object.assign(deviceOptions, patch),
        },
        {
            info: (m) => log.info.push(m),
            error: (m) => log.error.push(m),
            warning: (m) => log.warning.push(m),
            debug: (m) => log.debug.push(m),
        },
    );
    self = link;
    live.push(link);
    return { link, log, sends, published, entityStates, deviceOptions, revive: () => (dead = false) };
}

/** The last published huelink state. */
const lastState = (published) =>
    JSON.parse([...published].reverse().find((p) => p.topic === CONFIG.name).payload);

/** The power commands the extension sent to the strip itself. */
const lightCommands = (published) =>
    published.filter((p) => p.topic === `${CONFIG.device}/set`).map((p) => JSON.parse(p.payload).state);

async function testTripsAndGoesQuiet() {
    const h = harness({ failing: true });
    await h.link.start();
    await h.link.setMode(MODE_LABEL.sync);
    // Hyperion keeps sending frames, including while the strip does not answer.
    const fed = feed(h.link);

    const did = await waitForTrip(h.link);
    clearInterval(fed);
    assert.ok(did, "the breaker should have tripped");
    await h.link.stop();

    const stopLines = h.log.error.filter((m) => logLine("log.tripped").test(m));
    assert.strictEqual(stopLines.length, 1, `expected 1 stop line, got ${stopLines.length}`);
    assert.ok(stopLines[0].includes(MODE_LABEL.sync), `the stop line must name the mode: ${stopLines[0]}`);

    // Frame errors are not logged one by one. Measured against the number of
    // SENDS rather than a constant: proportionality between errors and frames
    // is exactly the spam the breaker exists to stop.
    assert.ok(
        h.log.error.length < h.sends.length,
        `error lines (${h.log.error.length}) must not track frames (${h.sends.length})`,
    );

    const st = lastState(h.published);
    assert.strictEqual(st.power, "OFF", `power should be OFF, was ${st.power}`);
    assert.strictEqual(st.mode, MODE_LABEL.light, `mode should be light, was ${st.mode}`);
    assert.strictEqual(st.armed, null, "a trip is not idling: nothing gets armed");
    assert.strictEqual(st.status, t("status.tripped", { mode: MODE_LABEL.sync }));

    // SILENCE: sends are bounded and stop completely once stopped.
    const before = h.sends.length;
    await sleep(1000);
    assert.strictEqual(h.sends.length, before, `${h.sends.length - before} more sends after the stop`);
    console.log(`  sends total: ${h.sends.length} (hundreds without the breaker), error lines: ${h.log.error.length}`);
}

async function testTripDoesNotLightTheStrip() {
    // Only frames fail here, the reset still answers. That is the only case
    // where switching off means anything: a strip that does not answer a reset
    // either stays in entertainment mode, where ordinary commands are ignored,
    // so `onFailure` does not send to one (see `reachable` there).
    const h = harness({ failing: false });
    await h.link.start();
    h.link.stream.transport.zclCommand = async (c) => {
        h.sends.push(`cmd:${c.command}`);
        await sleep(5);
        if (c.command === CMD_FRAME) throw new Error("Timeout - 0x00178801aabbccdd/11 ... (Status 'TIMEOUT')");
    };
    await h.link.setMode(MODE_LABEL.sync);
    const fed = feed(h.link);
    assert.ok(await waitForTrip(h.link), "the breaker should have tripped");
    clearInterval(fed);
    await h.link.stop();

    assert.strictEqual(h.link.output, "off", `output should be off, was ${h.link.output}`);
    assert.strictEqual(h.link.arbiter.power, false, "power should be off, not light");
    assert.strictEqual(h.link.armed, null, "a trip does not arm: an unreachable strip does not light itself");
    assert.strictEqual(lastState(h.published).mode, MODE_LABEL.light, "the mode must not hang on Sync");
    assert.strictEqual(lastState(h.published).activity, "tripped");
    // AN ORDINARY OFF COMMAND, NOT A BLACK FRAME, and it is the last word.
    assert.strictEqual(
        lightCommands(h.published).at(-1),
        "OFF",
        `the last command to the strip should be OFF, was ${lightCommands(h.published).at(-1)}`,
    );
    console.log(`  after the trip: output=off, commands to the strip: ${lightCommands(h.published).join(",")}`);
}

async function testHealthyStreamUnaffected() {
    const h = harness({ failing: false });
    await h.link.start();
    await h.link.setMode(MODE_LABEL.sync);
    const fed = feed(h.link);
    await sleep(1500);
    clearInterval(fed);
    await h.link.stop();

    assert.strictEqual(h.link.breaker.tripped, null, "a healthy stream must not trip the breaker");
    assert.strictEqual(h.log.error.length, 0, `a healthy stream logs no errors, got: ${h.log.error[0]}`);
    // The new warnings must not cry wolf: no stall, slow-send or failure lines.
    assert.deepStrictEqual(stallWarnings(h.log), [], "a healthy stream must not log stall warnings");
    // The threshold comes from the config, not a constant. It used to read
    // "10", true at `fps: 12`; when the default dropped to `MAX_FPS`, a healthy
    // stream started looking broken purely because the expected number was
    // written by hand.
    const frames = h.sends.filter((s) => s === "cmd:1").length;
    assert.ok(frames >= CONFIG.fps, `expected at least ${CONFIG.fps} frames in 1.5 s, got ${frames}`);
    console.log(`  ${frames} frames sent in 1.5 s, breaker intact`);
}

/** The "a frame was late" warnings. */
const stallWarnings = (log) =>
    log.warning.filter((m) => ["log.frameFailed", "log.stalled"].some((k) => logLine(k).test(m)));

async function testAFailedFrameIsNotSilent() {
    // One frame fails, the next goes through. `failures` resets, so the
    // breaker never trips and, before this line existed, the log said nothing
    // while the strip froze for the backoff.
    const h = harness({ failing: false });
    await h.link.start();
    let thrown = false;
    h.link.stream.transport.zclCommand = async (c) => {
        h.sends.push(`cmd:${c.command}`);
        await sleep(5);
        if (c.command === CMD_FRAME && !thrown) {
            thrown = true;
            throw new Error("MAC_NO_ACK test-marker");
        }
    };
    await h.link.setMode(MODE_LABEL.sync);
    const fed = feed(h.link);
    await sleep(1500);
    clearInterval(fed);
    await h.link.stop();

    assert.strictEqual(h.link.breaker.tripped, null, "one failed frame must not trip the breaker");
    const lines = h.log.warning.filter((m) => logLine("log.frameFailed").test(m));
    assert.strictEqual(lines.length, 1, `expected exactly one failed-frame warning, got ${lines.length}`);
    assert.ok(lines[0].includes("MAC_NO_ACK test-marker"), `the line must carry the error text: ${lines[0]}`);
        await h.link.publishState();
    assert.strictEqual(lastState(h.published).pacer.sendFailures, 1, "the count is published");
    console.log(`  ${lines[0]}`);
}

async function testASlowFrameIsReported() {
    const h = harness({ failing: false });
    await h.link.start();
    let frames = 0;
    h.link.stream.transport.zclCommand = async (c) => {
        h.sends.push(`cmd:${c.command}`);
        // The fourth frame is the slow one; the first three give the watch a
        // previous frame to measure from.
        const slow = c.command === CMD_FRAME && ++frames === 4;
        await sleep(slow ? 700 : 5);
    };
    await h.link.setMode(MODE_LABEL.sync);
    const fed = feed(h.link);
    await sleep(2500);
    clearInterval(fed);
    await h.link.stop();

    assert.strictEqual(h.link.breaker.tripped, null);
    // Throttled: one line even though the lockout after the slow send is a second stall.
    const stalled = h.log.warning.filter((m) => logLine("log.stalled").test(m));
    assert.strictEqual(stalled.length, 1, `expected one stall line, got ${stalled.length}`);
    assert.ok(logLine("log.stallCause.send").test(stalled[0]), `the line must name the send: ${stalled[0]}`);
    console.log(`  ${stalled[0]}`);
}

async function testResumeOnExplicitCommand() {
    const h = harness({ failing: true });
    await h.link.start();
    await h.link.setMode(MODE_LABEL.sync);
    const fed = feed(h.link);
    assert.ok(await waitForTrip(h.link), "the breaker should have tripped");

    // Measure from before the command, not after it. The restart (power on
    // plus stream start) now happens inside `setMode`, because a command
    // settles the arbiter's decision immediately instead of waiting for the
    // next tick. A window opened after `setMode` returned would therefore miss
    // the very burst it is meant to observe. Spanning the whole resume
    // measures the intent -- "frames flow again" -- without caring which of
    // the two carries them.
    const before = h.sends.length;
    h.revive(); // the strip comes back on the network
    await h.link.setMode(MODE_LABEL.sync); // the user picks it again
    assert.strictEqual(h.link.breaker.tripped, null, "an explicit command must close the breaker");
    await sleep(800);
    clearInterval(fed);
    await h.link.stop();
    assert.ok(h.sends.length > before + 5, "frames must flow again after resuming");
    console.log(`  ${h.sends.length - before} more sends after resuming`);
}

async function testSilentStripStillRecovers() {
    // A switched-off strip sends nothing, so only the clock can reopen the breaker.
    const h = harness({ failing: true });
    await h.link.start();
    await h.link.setMode(MODE_LABEL.sync);
    let fed = feed(h.link);
    assert.ok(await waitForTrip(h.link), "the breaker should have tripped");
    clearInterval(fed);

    h.revive();
    // Inside the dwell nothing may happen by itself: that floor is what keeps
    // a strip which answers pings while refusing frames out of a tight loop.
    const before = h.sends.length;
    fed = feed(h.link);
    await sleep(300);
    clearInterval(fed);
    assert.ok(h.link.breaker.tripped, "inside the dwell the breaker stays shut");
    assert.strictEqual(h.sends.length, before, "and nothing goes out on the air");

    // Past the dwell.
    h.link.breaker.trippedAt -= h.link.breaker.tripDwellMs + 1000;
    fed = feed(h.link);
    await sleep(1200);
    clearInterval(fed);
    await h.link.stop();
    assert.strictEqual(h.link.breaker.tripped, null, "past the dwell the breaker must reopen on its own");
    assert.ok(
        h.sends.length > before + 3,
        `frames must flow again without the strip ever speaking, got ${h.sends.length - before}`,
    );
    console.log(`  silent strip -> reopened by the clock, ${h.sends.length - before} sends`);
}

async function testASilentDeadStripIsNotHammered() {
    // The other half of the same change. Reopening on a clock is exactly what
    // `huelink.mjs` warns about: a strip that is really gone would be retried
    // for ever, and every retry costs FAIL_LIMIT failed frames at ~6 s of
    // coordinator time each. So each reopen that leads straight back to a trip
    // must cost LESS often than the last one.
    const h = harness({ failing: true });
    await h.link.start();
    await h.link.setMode(MODE_LABEL.sync);
    const fed = feed(h.link);
    assert.ok(await waitForTrip(h.link), "the breaker should have tripped");
    const first = h.link.breaker.tripDwellMs;

    // Still dead, still silent. Jump the dwell: it reopens, tries, and trips
    // again - and the next wait has to be longer than the one before it.
    // `tripped` itself never looks cleared from out here, so the RE-trip is
    // recognised by a fresh timestamp rather than by the flag.
    const mark = Date.now();
    h.link.breaker.trippedAt -= first + 1000;
    const until = mark + 25000;
    while (Date.now() < until && !(h.link.breaker.tripped && h.link.breaker.trippedAt >= mark)) await sleep(100);
    assert.ok(h.link.breaker.tripped && h.link.breaker.trippedAt >= mark, "it must trip again on a dead strip");
    clearInterval(fed);
    await h.link.stop();
    assert.ok(
        h.link.breaker.tripDwellMs > first,
        `a fruitless retry must widen the wait, got ${h.link.breaker.tripDwellMs} after ${first}`,
    );
    console.log(`  dead strip -> dwell grows ${first} ms -> ${h.link.breaker.tripDwellMs} ms`);
}

/** A dead strip in sync, driven to the third trip in a row: auto-retry has given up. */
async function gaveUp() {
    const h = harness({ failing: true });
    await h.link.start();
    await h.link.setMode(MODE_LABEL.sync);
    // Two fruitless trips already behind it; the next one is the third.
    h.link.breaker.tripStreak = MAX_AUTO_TRIP_STREAK - 1;
    const fed = feed(h.link);
    assert.ok(await waitForTrip(h.link), "the breaker should have tripped");
    clearInterval(fed);
    assert.ok(h.link.breaker.needsManualResume, "the third trip in a row must end the auto-retries");
    return h;
}

async function testAutoRetryGivesUpOnAGoneStrip() {
    // A strip that is really gone must not be retried on a timer for ever:
    // after MAX_AUTO_TRIP_STREAK fruitless trips only a person reopens it.
    const h = await gaveUp();
    let fed;
    const lines = h.log.error.filter((m) => logLine("log.autoRetryGaveUp").test(m));
    assert.strictEqual(lines.length, 1, `expected 1 give-up line, got ${lines.length}`);
    assert.strictEqual(
        lastState(h.published).status,
        t("status.trippedManual", { mode: MODE_LABEL.sync }),
        "the status must say a person has to act",
    );
    assert.strictEqual(lastState(h.published).breaker, "gave_up", "and the fixed word automations read");
    assert.strictEqual(lastState(h.published).activity, "gave_up");

    // Far past any dwell, with the strip back and frames on offer: still shut.
    h.revive();
    h.link.breaker.trippedAt -= 10 * 3_600_000;
    const before = h.sends.length;
    fed = feed(h.link);
    await sleep(500);
    clearInterval(fed);
    assert.ok(h.link.breaker.tripped, "no timer may reopen it any more");
    assert.strictEqual(h.sends.length, before, "and nothing goes out on the air");
    assert.strictEqual(
        h.log.error.filter((m) => logLine("log.autoRetryGaveUp").test(m)).length,
        1,
        "the give-up line is written once, not on every tick",
    );

    // A person asks: one more try, not the whole ladder; frames flow.
    await h.link.setMode(MODE_LABEL.sync);
    assert.strictEqual(h.link.breaker.tripped, null, "a demanded resume reopens it");
    assert.strictEqual(h.link.breaker.tripStreak, MAX_AUTO_TRIP_STREAK, "with one try left, not a fresh ladder");
    assert.strictEqual(lastState(h.published).breaker, "gave_up", "the alert holds until a recovery is proven");
    fed = feed(h.link);
    // A run of accepted frames is the proof of recovery that resets the ladder.
    const until = Date.now() + 10000;
    while (Date.now() < until && h.link.breaker.tripStreak !== 0) await sleep(50);
    clearInterval(fed);
    await h.link.stop();
    assert.ok(h.sends.length > before + 3, "frames must flow again after the manual resume");
    assert.strictEqual(h.link.breaker.tripStreak, 0, "a sustained recovery puts the ladder back to the start");
    assert.strictEqual(lastState(h.published).breaker, "closed", "and clears the alert");
    console.log("  gone strip -> auto-retry stops, manual resume works");
}

async function testAManualResumeOnAStillDeadStripGivesUpAtOnce() {
    // An automation re-sending the mode every few minutes looks exactly like a
    // person. After a give-up it must buy ONE try, or it restarts the hammering.
    const h = await gaveUp();

    // Starting the stream on a dead strip throws; that is the try being spent.
    await h.link.setMode(MODE_LABEL.sync).catch(() => {});
    const fed = feed(h.link);
    assert.ok(await waitForTrip(h.link), "a still-dead strip trips again");
    clearInterval(fed);
    await h.link.stop();
    assert.ok(h.link.breaker.needsManualResume, "and gives up straight away, without a fresh ladder");
    console.log("  manual resume on a dead strip -> one try, then give-up again");
}

async function testOffClosesTheTripButKeepsTheGiveUp() {
    // "Off" from a person means "stop telling me it is broken". The status must
    // read Off, but the ladder stays: a still-dead strip gives up on its next
    // trip, and the "needs attention" alert stays on until it really recovers.
    const h = await gaveUp();

    await h.link.setPower(false);
    await h.link.stop();
    assert.strictEqual(h.link.breaker.tripped, null, "off closes the trip");
    const state = lastState(h.published);
    assert.strictEqual(state.status, t("status.off"), "and the status says Off");
    assert.strictEqual(state.breaker, "gave_up", "but the alert stays: the strip is still dead");
    assert.strictEqual(h.link.breaker.tripStreak, MAX_AUTO_TRIP_STREAK, "and the ladder is not reset by an off");
    console.log("  off after a give-up -> status Off, alert and ladder kept");
}

async function testAnOffFromTheLightEntityClosesTheTrip() {
    // Power is the strip's own HA light: its "off" arrives as a state report,
    // not a HueLink command, and power is already false after a trip. With
    // the echo: z2m reports the trip's own OFF first, as it really does.
    const h = harness({ failing: true, echo: true });
    await h.link.start();
    await h.link.setMode(MODE_LABEL.sync);
    const fed = feed(h.link);
    assert.ok(await waitForTrip(h.link), "the breaker should have tripped");
    clearInterval(fed);
    await sleep(2100); // past SELF_ECHO_MS: this OFF is a person, not the trip's own echo

    await h.link.onEntityState({ entity: { name: CONFIG.device }, message: { state: "OFF" }, payload: { state: "OFF" } });
    await h.link.stop();
    assert.strictEqual(h.link.breaker.tripped, null, "an off from the light entity closes the trip");
    assert.strictEqual(lastState(h.published).status, t("status.off"), "and the status says Off");
    console.log("  tripped -> off from the HA light -> trip closed, no re-arm");
}

async function testAnAckedOnClearsAGiveUp() {
    // After a give-up the user turns the strip on as a light: no frames ever
    // flow, but z2m's state report is the strip's ack, and that is proof of life.
    const h = await gaveUp();
    const report = (state) =>
        h.link.onEntityState({ entity: { name: CONFIG.device }, message: { state }, payload: { state } });

    await report("OFF"); // the trip's own forced off, acked: the strip may still fail frames
    assert.strictEqual(h.link.breaker.state, "gave_up", "an acked OFF is no recovery");

    await report("ON");
    await h.link.stop();
    assert.strictEqual(h.link.breaker.state, "closed", "an acked ON clears the give-up");
    assert.strictEqual(lastState(h.published).breaker, "closed", "and clears the alert");
    assert.strictEqual(h.link.breaker.tripStreak, MAX_AUTO_TRIP_STREAK - 1, "but buys one try, not a fresh ladder");
    console.log("  give-up -> strip acks ON -> alert cleared, one try left");
}

async function testALateTripOffEchoKeepsTheTrip() {
    // A trip means a jammed coordinator, so the report of the trip's own
    // forced OFF can come back after SELF_ECHO_MS. It is still our echo.
    const h = harness({ failing: true });
    await h.link.start();
    h.link.stream.stop = async () => {}; // the strip answers the RESET, so the trip sends its OFF
    await h.link.setMode(MODE_LABEL.sync);
    const fed = feed(h.link);
    assert.ok(await waitForTrip(h.link), "the breaker should have tripped");
    clearInterval(fed);
    await sleep(2100);
    const report = () =>
        h.link.onEntityState({ entity: { name: CONFIG.device }, message: { state: "OFF" }, payload: { state: "OFF" } });

    await report(); // late echo of the trip's OFF
    assert.ok(h.link.breaker.tripped, "a late echo of the trip's own OFF must not close the trip");
    await report(); // now a person
    await h.link.stop();
    assert.strictEqual(h.link.breaker.tripped, null, "a person's OFF after it still closes the trip");
    console.log("  tripped -> late echo of own OFF ignored -> person's OFF closes the trip");
}

async function testBackoffRecovers() {
    // Two failures in a row, then the strip answers: the counter must reset and
    // the breaker must stay closed.
    const h = harness({ failing: false });
    await h.link.start();
    h.link.stream.transport.zclCommand = (() => {
        let n = 0;
        return async () => {
            n++;
            if (n <= 2) throw new Error("TIMEOUT");
        };
    })();
    await h.link.setMode(MODE_LABEL.sync);
    const fed = feed(h.link);
    await sleep(2000);
    clearInterval(fed);
    await h.link.stop();
    assert.strictEqual(h.link.breaker.tripped, null, "two failures must not trip the breaker");
    assert.strictEqual(h.link.failures, 0, "a successful frame must reset the counter");
    console.log("  2 failures -> backoff -> recovery, breaker intact");
}

async function testSourceSilenceTurnsStripOff() {
    // The TV switches off. In practice the most common path.
    const h = harness({ failing: false });
    await h.link.start();
    await h.link.setMode(MODE_LABEL.sync);
    const fed = feed(h.link);
    await sleep(600);
    assert.strictEqual(h.link.output, "sync", "sync really is running first");

    clearInterval(fed); // the TV switches off
    const sendsAtSilence = h.sends.length;
    await sleep(1400); // longer than sourceTtlMs

    assert.strictEqual(h.link.output, "off", `the strip should be off, was ${h.link.output}`);
    assert.strictEqual(h.link.arbiter.power, false, "power should be off, not light");
    assert.strictEqual(h.link.armed, "sync", "the choice must stay armed");

    const st = lastState(h.published);
    assert.strictEqual(st.power, "OFF", `power on the HA side should be OFF, was ${st.power}`);
    // WAITING DOES NOT CHANGE THE CHOICE. Expecting light here was the bug:
    // the HA side gates Hyperion capture on this field, so "light" while
    // waiting cut off the very source whose frames the strip waits for.
    assert.strictEqual(st.mode, MODE_LABEL.sync, `the choice must not vanish while waiting, was ${st.mode}`);
    assert.strictEqual(st.armed, MODE_LABEL.sync, "the state must show that the strip is waiting");
    assert.strictEqual(st.status, t("status.waitingTv"), `status was ${st.status}`);
    assert.strictEqual(st.activity, "waiting");

    // AN ORDINARY OFF COMMAND, NOT A BLACK FRAME.
    assert.strictEqual(lightCommands(h.published).at(-1), "OFF", "the last command to the strip should be OFF");
    assert.ok(h.sends.slice(sendsAtSilence).includes("cmd:3"), "it must leave the stream (reset) before switching off");
    // After the switch-off the air stays quiet. Measured from the switch-off,
    // not from the silence: inside the TTL window frames may still go out, and
    // that is what lets one dropped Hyperion packet pass without a flicker.
    const sendsAtOff = h.sends.length;
    await sleep(500);
    assert.strictEqual(h.sends.length, sendsAtOff, `${h.sends.length - sendsAtOff} more sends after switching off`);

    // ONE line, with the reason.
    const lines = h.log.info.filter((m) => logLine("log.sourceEndedArmed").test(m));
    assert.strictEqual(lines.length, 1, `expected 1 line about the end, got ${lines.length}`);
    assert.ok(lines[0].includes(MODE_LABEL.sync), `the end line must name the mode: ${lines[0]}`);

    await h.link.stop();
    console.log(`  TV off -> strip OFF, armed; log: "${lines[0].replace("[huelink] ", "")}"`);
}

async function testArmedRelightsItself() {
    // Armed stays armed, and frames alone bring it back.
    const h = harness({ failing: false });
    await h.link.start();
    await h.link.setMode(MODE_LABEL.sync);
    let fed = feed(h.link);
    await sleep(600);
    clearInterval(fed);
    await sleep(1400); // TV off, the strip goes dark
    assert.strictEqual(h.link.armed, "sync", "it should be armed");

    const before = h.sends.length;
    fed = feed(h.link); // TV back on
    await sleep(900);
    clearInterval(fed);

    assert.strictEqual(h.link.armed, null, "once it is back, the waiting is over");
    assert.strictEqual(h.link.output, "sync", `the strip should sync again, was ${h.link.output}`);
    assert.strictEqual(h.link.arbiter.power, true, "power should be back");
    assert.strictEqual(lastState(h.published).mode, MODE_LABEL.sync, "the mode should return to Sync");
    // No ON: frames light an off strip by themselves (tested on the strip),
    // and an ON would flash its ordinary colour first.
    assert.notStrictEqual(lightCommands(h.published).at(-1), "ON", "no ON on the way back into the stream");
    const frames = h.sends.slice(before).filter((s) => s === "cmd:1").length;
    assert.ok(frames > 3, `frames must flow once it is back, got ${frames}`);

    await h.link.stop();
    console.log(`  TV back -> the strip lights itself, ${frames} frames without a single click`);
}

async function testOwnOffEchoDoesNotDisarm() {
    // Our own `OFF` comes back over the eventBus looking exactly like a user
    // pressing a button. If that cleared the waiting, the strip would never
    // light itself again.
    const h = harness({ failing: false });
    await h.link.start();
    await h.link.setMode(MODE_LABEL.sync);
    const fed = feed(h.link);
    await sleep(600);
    clearInterval(fed);
    await sleep(1400);
    assert.strictEqual(h.link.armed, "sync", "it should be armed");

    // Through `onCommand`, which is what z2m's event bus really calls for an
    // MQTT message, rather than the inner handler. The outer one is where our
    // own command is recognised on its way back (`#wasSelfSent`), and that
    // recognition is the whole thing being tested here: skipping it would
    // prove only that the inner handler was never reached.
    await h.link.onCommand({
        topic: `zigbee2mqtt/${CONFIG.device}/set`,
        message: JSON.stringify({ state: "OFF" }),
    });
    // Both halves, as real z2m sends them: `message` is the merged cache,
    // `payload` the delta. Passing only `message` would now prove nothing,
    // because the listener deliberately ignores it.
    await h.link.onEntityState({
        entity: { name: CONFIG.device },
        message: { state: "OFF" },
        payload: { state: "OFF" },
    });
    assert.strictEqual(h.link.armed, "sync", "an echo must not clear the waiting");

    await h.link.stop();
    console.log("  our own OFF echo clears nothing");
}

async function testUserActionWinsOverArming() {
    // A DIRECT action is obeyed literally. A user switching the strip on while
    // it waits for the TV gets light, and keeps it when frames return.
    const h = harness({ failing: false });
    await h.link.start();
    await h.link.setMode(MODE_LABEL.sync);
    const fed = feed(h.link);
    await sleep(600);
    clearInterval(fed);
    await sleep(1400);
    assert.strictEqual(h.link.armed, "sync", "it should be armed");

    await h.link.setPower(true); // the user presses on
    assert.strictEqual(h.link.armed, null, "a direct action cancels the waiting");

    const fed2 = feed(h.link); // the TV comes on
    await sleep(600);
    clearInterval(fed2);
    assert.strictEqual(h.link.output, "light", `it should stay light, was ${h.link.output}`);
    assert.strictEqual(lastState(h.published).mode, MODE_LABEL.light);

    await h.link.stop();
    console.log("  the user's 'on' stays light even when the TV comes back");
}

async function testUserOffCancelsTheWaiting() {
    // The other half of the previous case, and the one that actually bit. While
    // armed the strip is ALREADY dark, so an OFF asks for nothing the strip has
    // not already done, and the early return skipped the rest of the function
    // with `armed` left standing. The intent was lost silently: the user said
    // off, the state still said "waiting for TV", and the next frame lit the
    // strip back up in the dark.
    const h = harness({ failing: false });
    await h.link.start();
    await h.link.setMode(MODE_LABEL.sync);
    const fed = feed(h.link);
    await sleep(600);
    clearInterval(fed);
    await sleep(1400);
    assert.strictEqual(h.link.armed, "sync", "it should be armed");
    assert.strictEqual(h.link.arbiter.power, false, "the strip is already dark, which is the point");

    await h.link.setPower(false); // the user presses off on a strip that is dark
    assert.strictEqual(h.link.armed, null, "an explicit OFF cancels the waiting");

    // The intent has to reach the outside too, or Home Assistant keeps showing
    // "waiting for TV" for a strip nobody is waiting on any more.
    const st = lastState(h.published);
    assert.strictEqual(st.armed, null, `the published state must not still be armed, was ${st.armed}`);
    assert.strictEqual(st.status, t("status.off"), `status was ${st.status}`);

    // AND THE TV COMING BACK MUST NOT UNDO IT.
    const lightsBefore = lightCommands(h.published).length;
    const fed2 = feed(h.link);
    await sleep(800);
    clearInterval(fed2);

    assert.strictEqual(h.link.output, "off", `the strip must stay off, was ${h.link.output}`);
    assert.strictEqual(h.link.arbiter.power, false, "frames must not restore power after an explicit OFF");
    assert.strictEqual(
        lightCommands(h.published).length,
        lightsBefore,
        `the strip was commanded again: ${lightCommands(h.published).slice(lightsBefore).join(",")}`,
    );

    await h.link.stop();
    console.log("  the user's 'off' survives the TV coming back");
}

async function testBackoffHoldsOffCommandsToo() {
    // `settle` guarded on `tripped` alone, but the breaker spends most of a bad
    // patch in the backoff window, where `tripped` is still null. A command
    // arriving there walked straight into the strip that had just failed to
    // answer and spent up to ~6 s per attempt holding the coordinator, which is
    // exactly what the backoff exists to prevent.
    const h = harness({ failing: false });
    await h.link.start();
    await h.link.setMode(MODE_LABEL.light);
    await sleep(200);
    assert.strictEqual(h.link.arbiter.power, true, "light mode means power on");

    // Set straight rather than raced through the 200/1000/3000 ms ladder: the
    // thing under test is the guard, and a timing race would make the case fail
    // for reasons that have nothing to do with it.
    h.link.failures = 1;
    h.link.retryAt = Date.now() + 5000;
    assert.strictEqual(h.link.breaker.tripped, null, "the backoff window is NOT a trip, which is the whole point");

    const sendsBefore = h.sends.length;
    const lightsBefore = lightCommands(h.published).length;
    await h.link.setPower(false);

    assert.strictEqual(h.sends.length, sendsBefore, `${h.sends.length - sendsBefore} sends inside the backoff window`);
    assert.strictEqual(
        lightCommands(h.published).length,
        lightsBefore,
        `the strip was commanded inside the backoff window: ${lightCommands(h.published).slice(lightsBefore).join(",")}`,
    );
    // Held back, not thrown away: the decision is recorded and still published.
    assert.strictEqual(h.link.arbiter.power, false, "the intent must be recorded even while held back");
    assert.strictEqual(lastState(h.published).power, "OFF", "the outside must be told what was asked for");

    // Once the window closes the held-back work goes out.
    h.link.retryAt = 0;
    await h.link.settle();
    assert.strictEqual(
        lightCommands(h.published).at(-1),
        "OFF",
        `after the backoff the OFF must land, commands were ${lightCommands(h.published).join(",")}`,
    );

    await h.link.stop();
    console.log("  backoff holds a command back, then lets it through");
}

async function testUserLightModeStaysLit() {
    // The control in the other direction: light mode must NOT switch itself
    // off. Switching off applies to a stream that ended, not to a lit strip.
    const h = harness({ failing: false });
    await h.link.start();
    await h.link.setMode(MODE_LABEL.light);
    await sleep(800);
    assert.strictEqual(h.link.output, "light", `light should stay, was ${h.link.output}`);
    assert.strictEqual(h.link.arbiter.power, true, "power must not disappear");
    assert.strictEqual(h.link.armed, null, "light is not waiting");
    // AFTER A RESTART THE STRIP IS DARK, so light mode now LIGHTS IT. The check
    // is on the LAST word to the strip, not the whole list: what matters is the
    // state it is left in, not how many commands it took. See docs/TESTING.md.
    assert.strictEqual(
        lightCommands(h.published).at(-1),
        "ON",
        `in light mode the strip must stay lit, commands were ${lightCommands(h.published).join(",")}`,
    );
    const frames = h.sends.filter((s) => s === "cmd:1").length;
    assert.strictEqual(frames, 0, `no stream frames in light mode, got ${frames}`);
    await h.link.stop();
    console.log("  light mode keeps burning, nothing switches it off");
}

async function testExposesEchoDoesNotFlipPower() {
    // 1.0.0 read `state` from the sibling `message`, which is z2m's WHOLE
    // merged state cache and therefore always carries a `state`. Every
    // `huelink_*` expose we published came straight back looking like a power
    // press carrying the strip's stale cached power, the wrong power flipped
    // the output, the next tick sent the opposite light command, and its echo
    // flipped it back: ON/OFF oscillation at several hertz.
    //
    // An ECHOING harness, and a pause before the press. Our own commands are
    // recognised on the way back from a record of what we sent
    // (`#wasSelfState`), so a press landing INSIDE our own command's round
    // trip is genuinely indistinguishable from its echo and is meant to be
    // dropped. Letting the round trips finish first is what makes the press
    // below a press rather than a coincidence.
    const h = harness({ failing: false, echo: true });
    await h.link.start();
    await h.link.setMode(MODE_LABEL.light);
    assert.strictEqual(h.link.arbiter.power, true, "light mode means power on");
    await sleep(200);

    // Exactly the shape z2m emits: `payload` is the delta, `message` the cache.
    // The cache still says OFF because the strip has not reported its new state
    // yet - that lag is what made the echo so destructive.
    await h.link.onEntityState({
        entity: { name: CONFIG.device },
        message: { state: "OFF", brightness: 254, huelink_mode: MODE_LABEL.light },
        payload: { huelink_mode: MODE_LABEL.light },
    });
    assert.strictEqual(h.link.arbiter.power, true, "an expose echo must not flip power");
    assert.strictEqual(h.link.output, "light", `output must not move, was ${h.link.output}`);

    // The converse: a REAL press still arrives, so the fix did not simply
    // deafen the listener.
    await h.link.onEntityState({
        entity: { name: CONFIG.device },
        message: { state: "OFF", brightness: 254 },
        payload: { state: "OFF" },
    });
    assert.strictEqual(h.link.arbiter.power, false, "a real OFF must still be obeyed");

    await h.link.stop();
    console.log("  expose echo ignored, a real press still lands");
}

async function testBlackFlashDoesNotStrandTheStrip() {
    // THE DEADLOCK THE BLACK GATE OPENED. The gate drops black frames, so a
    // dark moment on screen looks to the rest of the extension exactly like the
    // TV switching off: the source goes quiet, the strip is switched off, and
    // sync is armed. When the picture comes back a fraction of a second later,
    // the next tick lights the strip again - all of it before the strip has
    // reported the OFF.
    //
    // That report then arrived at `#entityState` with power already back ON,
    // disagreed with it, and was therefore read as somebody pressing off: it
    // cleared the arming, dropped the power and put the mode back to light.
    // Nothing lights an unarmed strip, so it stayed dark with
    // Hyperion sending the whole time. The
    // extension's own counters stood still, which is how it was found.
    //
    // ECHO ON, and SLOW: the whole fault lives in the gap between the command
    // and its report, so a harness that answers instantly cannot reproduce it.
    const h = harness({ failing: false, echo: true, echoMs: 400 });
    await h.link.start();
    // Let the startup OFF finish its round trip before anything else happens.
    // Not politeness: that command is the SAME race in miniature, and leaving
    // it in flight would fail this case before the flash it is about.
    await sleep(600);
    await h.link.setMode(MODE_LABEL.sync);
    let fed = feed(h.link);
    await sleep(600);
    assert.strictEqual(h.link.output, "sync", "sync really is running first");

    // The screen goes black: the gate stops passing frames on, so the source
    // ages out exactly as a switched-off TV would.
    clearInterval(fed);
    await sleep(1200); // longer than sourceTtlMs
    assert.strictEqual(h.link.armed, "sync", "a quiet source arms sync");
    assert.strictEqual(h.link.arbiter.power, false, "and switches the strip off");

    // The picture is back, well inside the OFF's round trip.
    fed = feed(h.link);
    await sleep(1200); // long enough for both echoes to land
    clearInterval(fed);

    assert.strictEqual(h.link.arbiter.power, true, "the strip must light itself again");
    assert.strictEqual(h.link.armed, null, "once it is back, the waiting is over");
    assert.strictEqual(h.link.output, "sync", `the strip should sync again, was ${h.link.output}`);
    const st = lastState(h.published);
    assert.strictEqual(st.power, "ON", `power should be ON, was ${st.power}`);
    // THE SIGNATURE OF THE BUG, and the thing to grep the live log for: mode
    // back on light with nothing armed, moments after "sync resumes".
    assert.strictEqual(st.mode, MODE_LABEL.sync, `our own OFF must not put the mode back to light, was ${st.mode}`);
    assert.strictEqual(st.output, "sync", `the strip must actually be streaming, was ${st.output}`);

    // And it is not stranded afterwards either: frames keep flowing.
    const before = h.sends.filter((s) => s === "cmd:1").length;
    fed = feed(h.link);
    await sleep(900);
    clearInterval(fed);
    const frames = h.sends.filter((s) => s === "cmd:1").length - before;
    assert.ok(frames > 3, `frames must keep flowing after the flash, got ${frames}`);

    // THE CONVERSE, on the same run: a report nobody here caused is still
    // obeyed. Without this the fix would just be a deafer listener, and the
    // wall switch would stop working.
    await h.link.onEntityState({
        entity: { name: CONFIG.device },
        message: { state: "OFF", brightness: 254 },
        payload: { state: "OFF" },
    });
    assert.strictEqual(h.link.arbiter.power, false, "a wall switch OFF must still be obeyed");
    assert.strictEqual(h.link.armed, null, "and must still cancel the waiting");

    await h.link.stop();
    console.log(`  black flash -> sync resumes and keeps streaming (${frames} frames); a real OFF still lands`);
}

async function testOffNeverPublishesALitOutput() {
    // `power: "OFF"` next to `output: "sync"` is a state that contradicts
    // itself. 1.0.0 published it because the command handler ran before the
    // next tick had recalculated the output.
    const h = harness({ failing: false });
    await h.link.start();
    await h.link.setMode(MODE_LABEL.sync);
    const fed = feed(h.link);
    await sleep(400);
    assert.strictEqual(h.link.output, "sync", "sync really is running first");

    const mark = h.published.length;
    await h.link.setPower(false); // the user switches it off
    clearInterval(fed);
    await sleep(200);

    const contradicts = (from) =>
        h.published
            .slice(from)
            .filter((p) => p.topic === CONFIG.name)
            .map((p) => JSON.parse(p.payload))
            .filter((s) => s.power === "OFF" && s.output !== "off");
    assert.strictEqual(
        contradicts(mark).length,
        0,
        `OFF must never go out with a lit output, got ${JSON.stringify(contradicts(mark).map((s) => s.output))}`,
    );

    // The same thing again, but with the radio already busy. A first attempt
    // simply skipped the recalculation whenever a tick held it, and the live
    // log then showed `power: "OFF"` beside `output: "effect"`: in effect mode
    // the strip sends often enough that an off command regularly lands
    // mid-frame. `sending` is the flag that tick takes, so holding it here is
    // exactly what the real race does, minus the timing luck.
    await h.link.setMode(MODE_LABEL.light);
    assert.strictEqual(h.link.output, "light", "light mode really is lit first");
    const busy = h.published.length;
    h.link.sending = true;
    setTimeout(() => (h.link.sending = false), 120);
    await h.link.setPower(false);
    assert.strictEqual(h.link.output, "off", "the handler must wait for the radio, not give up");
    await sleep(100);
    assert.strictEqual(
        contradicts(busy).length,
        0,
        `a busy radio must not excuse a lit output, got ${JSON.stringify(contradicts(busy).map((s) => s.output))}`,
    );

    // And once more with the radio held far longer than any wait. This is the
    // case the live log actually hit: nine seconds between the off command and
    // the reset reaching the strip, because a busy coordinator was still
    // draining the frames already in flight. No bounded wait covers that, so
    // the published `output` must not be read off `this.output` at all. The two
    // are different facts: `this.output` is what the strip has been TOLD, which
    // the retry path needs, while the published field means "what is being
    // sent" -- and nothing is, the moment power goes false. Both halves are
    // asserted, because publishing `off` would also be satisfied by a fix that
    // simply forgot the strip was still lit.
    await h.link.setMode(MODE_LABEL.light);
    assert.strictEqual(h.link.output, "light", "light mode really is lit first");
    const stuck = h.published.length;
    h.link.sending = true;
    await h.link.setPower(false);
    assert.strictEqual(h.link.output, "light", "the record must still say what the strip was told");
    assert.strictEqual(
        contradicts(stuck).length,
        0,
        `a stuck radio must not excuse a lit output, got ${JSON.stringify(contradicts(stuck).map((s) => s.output))}`,
    );
    h.link.sending = false;
    await sleep(100);
    await h.link.stop();
    console.log("  every OFF publish is internally consistent: idle radio, busy, and stuck");
}

async function testRestartDoesNotStartAPingPong() {
    // THE RESTART STORM. Restart zigbee2mqtt while the strip is lit and it
    // flickers ON/OFF at ~15 Hz for a minute: over a thousand `/set` commands
    // where a quiet start sends 1-3.
    //
    // Two faults, one log line apart, and each needs its own fix.
    //
    // (1) THE TRIGGER. z2m ends `start()` with `cache_state_send_on_startup`,
    //     which republishes EVERY device's whole cached state through
    //     `publishEntityState(entity, state, "publishCached")`. For the strip
    //     that cache still held the pre-restart `state: "ON"`, and because the
    //     replayed payload IS the whole state, the "read the delta, not the
    //     cache" rule cannot filter it. `onEntityState` read it as somebody
    //     pressing ON, which both lit the strip and cleared the arming that
    //     `start()` had just set, so the strip could no longer light itself
    //     when the TV came back.
    //
    // (2) THE AMPLIFIER. `light()` publishes to the strip's `/set` on purpose
    //     (`skipReceive: false`), so z2m's resulting state publish comes back
    //     into `onEntityState`. That was called harmless because `setPower`
    //     would see a state it already held - true only while exactly ONE of
    //     our commands is in flight. The replayed ON made it two: `start()`'s
    //     own OFF was still travelling. From then on every echo described a
    //     PAST command, therefore always disagreed with the current power,
    //     flipped it, and the flip emitted the opposite command, whose echo
    //     flipped it back. Self-sustaining at the MQTT round trip.
    //
    // Hence an echoing harness: with `publish` as a dead letter box there is
    // no loop to catch, which is why the earlier cases passed throughout.
    const h = harness({ failing: false, echo: true });
    await h.link.start();
    // `start()` found the strip lit (the harness state cache says ON) and
    // switched it off. That command is now in flight, exactly as live.
    assert.deepStrictEqual(lightCommands(h.published), ["OFF"], "a restart switches a lit strip off, once");
    assert.strictEqual(h.link.armed, "sync", "a restart arms sync");

    // z2m's startup cache replay, with the field that says what it is.
    await h.link.onEntityState({
        entity: { name: CONFIG.device },
        message: { state: "ON", brightness: 120 },
        payload: { state: "ON", brightness: 120, color_temp: 500 },
        stateChangeReason: "publishCached",
    });
    await sleep(600); // several echo round trips

    const cmds = lightCommands(h.published);
    assert.ok(cmds.length <= 2, `a restart must not flood the strip, sent ${cmds.length}: ${cmds.join(",")}`);
    assert.strictEqual(cmds.at(-1), "OFF", `the strip must end up off, commands were ${cmds.join(",")}`);
    assert.strictEqual(h.link.arbiter.power, false, "a cache replay is not a power press");
    assert.strictEqual(h.link.armed, "sync", "a cache replay must not clear the arming");
    assert.strictEqual(lastState(h.published).status, t("status.waitingTv"), "the strip should be waiting for the TV");

    // (2) ON ITS OWN, with no cache replay in sight: two of our own commands
    // in flight at once is enough, and a user pressing on right after off does
    // exactly that. Without the fix the pair of stale echoes starts the same
    // ping-pong; the point is that it settles on the LAST thing asked for.
    await h.link.setMode(MODE_LABEL.light);
    const mark = h.published.length;
    await h.link.setPower(false); // off...
    await h.link.onStripCommand(JSON.stringify({ state: "ON" })); // ...and on again, before the echo lands
    await sleep(600);

    const race = lightCommands(h.published.slice(mark));
    assert.ok(race.length <= 2, `a quick off/on must not oscillate, sent ${race.length}: ${race.join(",")}`);
    assert.strictEqual(h.link.arbiter.power, true, "the last press was ON, so ON it stays");
    assert.strictEqual(race.at(-1), "ON", `the strip must end up on, commands were ${race.join(",")}`);

    await h.link.stop();
    console.log(`  restart: ${cmds.join(",")} and still armed; off/on race: ${race.join(",")}`);
}

async function testCommandTopicIsInvisibleToTheCore() {
    // z2m's own publish extension routes EVERY topic matching this and looks
    // the captured id up as a Zigbee entity. `huelink` is a virtual topic this
    // extension serves itself, so `<base>/huelink/set` made the core log
    // `error: Entity 'huelink' is unknown` on every single command.
    const coreRouter = /^zigbee2mqtt\/(?!bridge)(.+?)\/(get|set)(?:\/(.+))?$/;

    const h = harness({ failing: false });
    await h.link.start();
    // Discovery topics carry their own base (`homeassistant`) in the publish
    // options, so the topic recorded here is the bare `<kind>/<id>/config`.
    // Retired entities are published as an EMPTY payload to remove them.
    const configs = h.published
        .filter((p) => p.topic.endsWith("/config") && p.payload)
        .map((p) => JSON.parse(p.payload))
        .filter((c) => c.command_topic);
    assert.ok(configs.length > 0, "discovery must publish commandable entities");
    for (const c of configs) {
        assert.strictEqual(c.command_topic, `zigbee2mqtt/${CONFIG.name}/command`);
        assert.ok(!coreRouter.test(c.command_topic), `the core would resolve an entity for ${c.command_topic}`);
    }

    // And the old topic really is dead, so nothing keeps the error alive.
    const before = h.link.arbiter.requested;
    assert.notStrictEqual(before, "sync", "the probe below has to be able to change something");
    await h.link.onCommand({
        topic: `zigbee2mqtt/${CONFIG.name}/set`,
        message: JSON.stringify({ mode: MODE_LABEL.sync }),
    });
    assert.strictEqual(h.link.arbiter.requested, before, "the retired /set topic must do nothing");
    await h.link.onCommand({
        topic: `zigbee2mqtt/${CONFIG.name}/command`,
        message: JSON.stringify({ mode: MODE_LABEL.sync }),
    });
    assert.strictEqual(h.link.arbiter.requested, "sync", "the new topic must still work");

    await h.link.stop();
    console.log(`  ${configs.length} discovery entities command on /command, invisible to the core router`);
}

async function testIntoTheStreamWithoutAnOn() {
    const h = harness({ failing: false });
    await h.link.start();
    await h.link.applyOutput("off");
    h.published.length = 0;

    assert.ok(await h.link.applyOutput("sync"));
    assert.ok(h.link.stream.running, "the stream must be started");
    assert.deepStrictEqual(lightCommands(h.published), [], "an ON flashes the strip's ordinary colour");
    await h.link.stop();
}

async function testAStreamingStripReadsOn() {
    // Left reading "off", the HA light card's tap sends an "on" to a lit,
    // streaming strip, and that "on" is what flashes its ordinary colour.
    const h = harness({ failing: false });
    await h.link.start();
    await h.link.setMode(MODE_LABEL.sync);
    const fed = feed(h.link);
    await sleep(600);
    assert.strictEqual(h.link.output, "sync");
    assert.ok(h.entityStates.some((p) => p.state === "ON"), "z2m/HA must be told the strip is on");
    assert.ok(!lightCommands(h.published).includes("ON"), "the strip itself must not be: that is the flash");

    // The echo of that display-only ON is not an ack and not a press.
    await h.link.onEntityState({ entity: { name: CONFIG.device }, payload: { state: "ON" } });
    assert.strictEqual(h.link.stripState, "OFF", "the strip's own on/off is still off");
    assert.strictEqual(h.link.output, "sync", "and the stream goes on");

    // The card now reads on, so one tap is an OFF, and it ends the stream.
    await h.link.onStripCommand(JSON.stringify({ state: "OFF" }));
    clearInterval(fed);
    await sleep(200);
    assert.strictEqual(h.link.arbiter.power, false);
    assert.strictEqual(h.link.output, "off");
    assert.strictEqual(lightCommands(h.published).at(-1), "OFF", "a real OFF, so the entity reads off again");
    await h.link.stop();
}

async function testEffectAndModeInOneCommand() {
    // A one-tap dashboard button sends both keys. The effect has to land
    // first: with none selected, `setMode` would refuse effect mode.
    const h = harness({ failing: false });
    await h.link.start();
    h.link.effects.select(null);
    assert.ok(!h.link.effects.active, "precondition: no effect selected");
    const wanted = h.link.effectOptions[1];
    await h.link.onCommand({
        topic: `zigbee2mqtt/${CONFIG.name}/command`,
        message: JSON.stringify({ mode: "effect", effect: wanted }),
    });
    assert.strictEqual(h.link.effects.selected, wanted);
    assert.strictEqual(h.link.arbiter.requested, "effect", "one command enters effect mode on it");
    await sleep(300);
    assert.strictEqual(h.link.output, "effect");
    assert.strictEqual(lastState(h.published).activity, "effect");
    await h.link.stop();
}

const tests = [
    ["into the stream without an ON, so the strip does not flash", testIntoTheStreamWithoutAnOn],
    ["a streaming strip reads on, and one tap turns it off", testAStreamingStripReadsOn],
    ["effect and mode in one command", testEffectAndModeInOneCommand],
    ["trips and then goes quiet", testTripsAndGoesQuiet],
    ["a trip switches off, it does not light up", testTripDoesNotLightTheStrip],
    ["a healthy stream is left alone", testHealthyStreamUnaffected],
    ["a failed frame is not silent", testAFailedFrameIsNotSilent],
    ["a slow frame is reported once, with its causes", testASlowFrameIsReported],
    ["an explicit command resumes", testResumeOnExplicitCommand],
    ["a silent strip still recovers", testSilentStripStillRecovers],
    ["a silent dead strip is not hammered", testASilentDeadStripIsNotHammered],
    ["auto-retry gives up on a gone strip", testAutoRetryGivesUpOnAGoneStrip],
    ["a manual resume on a still-dead strip gives up at once", testAManualResumeOnAStillDeadStripGivesUpAtOnce],
    ["off closes the trip, the give-up stays", testOffClosesTheTripButKeepsTheGiveUp],
    ["an off from the light entity closes the trip", testAnOffFromTheLightEntityClosesTheTrip],
    ["an acked ON clears a give-up", testAnAckedOnClearsAGiveUp],
    ["a late echo of the trip's own OFF keeps the trip", testALateTripOffEchoKeepsTheTrip],
    ["backoff recovers", testBackoffRecovers],
    ["source went quiet -> strip switches off", testSourceSilenceTurnsStripOff],
    ["an armed strip lights itself", testArmedRelightsItself],
    ["our own OFF echo does not disarm", testOwnOffEchoDoesNotDisarm],
    ["a direct action beats waiting", testUserActionWinsOverArming],
    ["an explicit OFF cancels the waiting", testUserOffCancelsTheWaiting],
    ["the backoff window holds commands back too", testBackoffHoldsOffCommandsToo],
    ["light mode stays lit", testUserLightModeStaysLit],
    ["an expose echo does not flip power", testExposesEchoDoesNotFlipPower],
    ["a black flash does not strand the strip", testBlackFlashDoesNotStrandTheStrip],
    ["OFF never publishes a lit output", testOffNeverPublishesALitOutput],
    ["a restart does not start a ping-pong", testRestartDoesNotStartAPingPong],
    ["commands are invisible to the core router", testCommandTopicIsInvisibleToTheCore],
];

// node:test, not a hand-rolled loop: `node --test` then reports which case failed and why.
afterEach(async () => {
    for (const l of live.splice(0)) await l.stop().catch(() => {});
});
for (const [name, fn] of tests) test(name, fn);
