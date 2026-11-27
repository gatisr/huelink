/**
 * huelink - a zigbee2mqtt external extension that streams Philips Hue
 * entertainment frames (cluster 0xFC01) straight to a gradient strip, with no
 * bridge and no Bifrost in between.
 *
 * This file is the edge: the z2m transport, the UDP listener and the MQTT
 * state. The byte encoding is in huelink-lib/huepack.mjs, the stream lifecycle in
 * huelink-lib/huestream.mjs, the power/mode decision in huelink-lib/arbiter.mjs, the
 * breaker's trip and retry ladder in huelink-lib/breaker.mjs, the HA entity table
 * in huelink-lib/discovery.mjs, the effect catalogue in huelink-lib/effects/.
 *
 * Control is two things only: power, and exactly one mode (light / effect /
 * sync). "Off" is a RESET out of the stream and then a normal off, never a
 * black frame. Architecture and behaviour: docs/DESIGN.md. Wire format:
 * docs/PROTOCOL.md. Frame rate: docs/PACING.md.
 */

import dgram from "node:dgram";
import { statSync } from "node:fs";

import { HueStream } from "./huelink-lib/huestream.mjs";
import { Arbiter, FrameSource, MODE_EFFECT, MODE_LIGHT, MODE_OFF, MODE_SYNC, MODES } from "./huelink-lib/arbiter.mjs";
import { Breaker } from "./huelink-lib/breaker.mjs";
import { RETIRED, discoveryEntities } from "./huelink-lib/discovery.mjs";
import { CONFIG, CONFIG_ERRORS, CONFIG_FILE, CONFIG_PATH, CONFIG_WARNINGS, loadConfig } from "./huelink-lib/config.mjs";
import { EffectEngine, loadEffects } from "./huelink-lib/effects/index.mjs";
import { clampSaturationPct, saturate } from "./huelink-lib/huepack.mjs";
import { t } from "./huelink-lib/i18n/index.mjs";
import { toFinite } from "./huelink-lib/num.mjs";
import { Pacer, TUNABLE } from "./huelink-lib/pacer.mjs";
import { KNOB_KEYS, landed, match } from "./huelink-lib/presets.mjs";
import { StallWatch, Throttle } from "./huelink-lib/stallwatch.mjs";
import {
    KNOBS,
    MODE_BY_LABEL,
    MODE_LABEL,
    PRESETS,
    PRESET_PROBLEMS,
    SETTABLE_KEYS,
} from "./huelink-lib/huelink-ui.mjs";

/**
 * One source, three consumers: the startup log line, the `huelink_version`
 * field on the z2m device page, and the retained `zigbee2mqtt/huelink` payload.
 *
 * It matters because `bridge/request/extension/save` reloads ONLY this file;
 * `huelink-lib/*.mjs` stays in Node's ESM cache until the container restarts. So "is my
 * change live" is a real question, and the only honest answer is a number the
 * loaded code prints itself. Bump it on every meaningful change here or under
 * `huelink-lib/`: a stale number is worse than none, it looks like an answer and lies.
 *
 * It is a literal rather than a read of `package.json` because z2m imports this
 * file from a temporary copy in its own data directory, where no `package.json`
 * of ours exists; any path we computed would be a guess that breaks on the one
 * machine that matters. Instead it is EXPORTED, and `test/version.test.mjs`
 * fails the build if it ever disagrees with `package.json`.
 */
export const VERSION = "1.3.4";

/** Knobs with a slider: the file only sets their startup value (a live reload would fight the slider). */
const SLIDER_OWNED = new Set(["occupancyBudget", ...KNOBS.map((k) => k.knob)]);

/** File keys re-read while running. */
const FILE_LIVE = TUNABLE.filter((key) => !SLIDER_OWNED.has(key));

/** Preset knobs set through `setTunable`; fps and saturation have their own setters. */
const PRESET_TUNABLES = KNOB_KEYS.filter((k) => !["fps", "saturationPct"].includes(k));

/**
 * When this Node process started, ISO-8601.
 *
 * `scripts/deploy.sh` needs to tell "z2m re-read the extension file" from "z2m
 * started fresh", because only the second reloads `huelink-lib/*.mjs`. The version
 * number cannot answer that: a cached `huelink-lib/` reports the same version as a new
 * one. Process uptime can, and nothing but a real restart can reset it.
 */
const STARTED_AT = new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString();

/*
 * Config comes from outside: fields, defaults and validation in huelink-lib/config.mjs,
 * values in `huelink.config.json` next to `configuration.yaml`. The `fps`
 * default is `maxFps`, itself derived from measured coordinator air time, not
 * chosen. See docs/PACING.md.
 *
 * Mode labels (`MODE_LABEL` / `MODE_BY_LABEL`) come from huelink-lib/huelink-ui.mjs, so
 * the HA select, the z2m enum and the `status()` line cannot drift apart.
 */

/** Window, in seconds, over which actually sent frames are counted. */
const FPS_WINDOW_S = 5;

/**
 * How often `huelink.config.json` is checked for a new modification time.
 *
 * A poll rather than `fs.watch`, which sounds backwards and is not: the file
 * lives in the z2m data directory, which is a bind mount, an SMB share or a
 * container volume often enough that inotify is simply not delivered. A stat
 * every two seconds costs nothing measurable and works on all of them. Two
 * seconds is also about as long as a person will wait after saving a file
 * before deciding nothing happened.
 */
const CONFIG_WATCH_MS = 2000;

/**
 * Circuit breaker. A failed frame holds the coordinator's SRSP window for ~6 s,
 * and zigbee-herdsman serialises every command through that same port, so one
 * unreachable strip slows the whole house down. Back off between attempts, and
 * after `FAIL_LIMIT` consecutive failures stop the stream outright: the air is
 * freed, the log gets one line instead of hundreds, and the state says why.
 */
const FAIL_LIMIT = 5;
/** Pause after the 1st, 2nd and subsequent failed frames (ms). */
const FAIL_BACKOFF_MS = [200, 1000, 3000];

/** Each kind of stall line is written at most this often; the rest are counted. Faults repeat per frame. */
const STALL_LOG_EVERY_MS = 10_000;

/**
 * How long a command handler waits for a tick to let go of the radio before it
 * carries out the new decision (see `settle`). Long enough to outlast an
 * ordinary frame, short enough that HA never notices: giving up here means
 * publishing an output from the previous decision.
 */
const SETTLE_WAIT_MS = 400;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Refused UDP senders are reported as ONE summary per window, never a line per
 * sender, and at most `UDP_REJECT_MAX_SENDERS` addresses are remembered inside
 * a window.
 *
 * A UDP source address is a claim, not a fact: anything on the network can put
 * a different one in every packet. Remembering each new sender in order to log
 * it once therefore grew without limit, and at a frame rate of 60 a second it
 * filled zigbee2mqtt's memory and its log with attacker-chosen text. Both the
 * set and the logging are now bounded, so a flood costs a fixed amount of
 * memory and one line a minute whatever the sender does.
 */
const UDP_REJECT_WINDOW_MS = 60_000;
const UDP_REJECT_MAX_SENDERS = 8;

/**
 * BLACK GATE. How long an unbroken run of black frames must last before those
 * frames stop counting as a live source, and the highest value a channel may
 * hold for a frame to be called black. See `#blackGated`.
 *
 * Here rather than in `huelink.config.json` on purpose, even though
 * `BLACK_LEVEL` does depend on the capture hardware. z2m reloads an extension
 * by re-importing THIS file from a temp copy; `huelink-lib/` keeps its place in the
 * module cache and is not re-read. A knob added to huelink-lib/config.mjs therefore
 * does not exist until zigbee2mqtt is restarted, which takes the whole Zigbee
 * network down, while a constant here is retuned by one more extension save.
 *
 * `BLACK_LEVEL` is not 0: a grabber handed limited-range video and reading it
 * as full range reports black as 16, and noise moves the last bits about
 * regardless. Being generous costs little, since a frame this dark lights the
 * strip barely at all.
 */
const BLACK_TIMEOUT_MS = 20_000;
const BLACK_LEVEL = 16;

/**
 * How long a command we published to the strip's own `/set` is recognised as
 * our own when it comes back. See `#wasSelfSent` and `#wasSelfState`.
 *
 * Generous against an MQTT round trip, which is tens of milliseconds, and
 * short against a person: the cost of being wrong is that one genuine press
 * arriving in the same breath as our own identical command is read as the
 * echo, and since the two ask for the SAME power the only thing lost is the
 * disarm it would have carried.
 */
const SELF_ECHO_MS = 2000;
/** Ceiling on that record, so a stuck broker cannot grow it without end. */
const SELF_ECHO_MAX = 16;

/**
 * Modification time of the config file, or 0 when there is none.
 *
 * Every failure is 0 on purpose, not just ENOENT: an unreadable file and a
 * missing one lead to the same action here, which is to keep running on the
 * values already loaded. A text editor that writes by renaming makes the file
 * briefly absent, and treating that half-second as an event would reload the
 * config twice for every save.
 */
function configMtime() {
    try {
        return statSync(CONFIG_FILE).mtimeMs;
    } catch {
        return 0;
    }
}

/** Hyperion udpddp starts with a 10-byte header; udpraw is colours only. */
function parseLeds(buf, segments) {
    let body = buf;
    if (buf.length === segments * 3 + 10 && (buf[0] & 0x40) !== 0) {
        body = buf.subarray(10);
    }
    if (body.length < segments * 3) return null;
    return Array.from({ length: segments }, (_, i) => ({
        r: body[i * 3],
        g: body[i * 3 + 1],
        b: body[i * 3 + 2],
    }));
}

export default class HueLink {
    constructor(
        zigbee,
        mqtt,
        state,
        publishEntityState,
        eventBus,
        enableDisableExtension,
        restartCallback,
        addExtension,
        settings,
        logger,
    ) {
        this.zigbee = zigbee;
        this.mqtt = mqtt;
        this.state = state;
        this.eventBus = eventBus;
        this.settings = settings;
        this.logger = logger;
        /**
         * The only correct way to write a value into the strip's state. The
         * direct route (`state.set` + `mqtt.publish`) looks simpler but skips
         * `adjustMessageBeforePublish` and `filtered_attributes`, producing a
         * payload unlike every other z2m publish.
         */
        this.publishEntityState = publishEntityState;

        this.sources = {
            sync: new FrameSource(CONFIG.sourceTtlMs),
            effect: new FrameSource(CONFIG.sourceTtlMs),
        };
        this.arbiter = new Arbiter(this.sources);
        this.effects = new EffectEngine({ effects: [], segments: CONFIG.segments, logger: this.logger });
        /**
         * Decides whether a frame is worth sending at all. See docs/PACING.md.
         *
         * Every knob comes from the config, and every one of them has a
         * default IN THE PACER, so a file that mentions none of them builds
         * exactly the pacer this extension has always built. `maxFps` and
         * `dutyCap` are passed too but are not re-read later: see `TUNABLE`.
         */
        this.pacer = new Pacer({
            fps: CONFIG.fps,
            maxFps: CONFIG.maxFps,
            maxPerWindow: CONFIG.dutyCap,
            ...Object.fromEntries(TUNABLE.map((key) => [key, CONFIG[key]])),
        });
        /**
         * Colour saturation, integer percent; 100 is neutral. Not a pacer knob:
         * it changes colours inside a frame, not the frame count. The config
         * validates 0.5-2, so the clamp only snaps to the slider step.
         */
        this.saturationPct = clampSaturationPct(CONFIG.saturation * 100);
        /** `mtimeMs` of the config file when it was last read, or 0 for none. */
        this.configStamp = 0;
        /** Output state already APPLIED to the strip (off/light/effect/sync). */
        this.output = MODE_OFF;
        this.sending = false;
        // `CONFIG.fps` is only a target; how many frames the radio actually
        // carries depends on the air, so it is measured rather than assumed.
        this.sent = 0;
        this.fpsReal = 0;
        /** Watches why frames arrive late and logs it; never decides what is sent. */
        this.stall = new StallWatch();
        this.stallLog = {
            failed: new Throttle(STALL_LOG_EVERY_MS),
            stalled: new Throttle(STALL_LOG_EVERY_MS),
        };
        /** Start of the frame send in flight, for failure timing. */
        this.sendStartedAt = 0;
        /** Consecutive failed frames; one success resets it. */
        this.failures = 0;
        /** Last verdict `reportCeiling` logged (null = none yet), so it logs on change only. */
        this.ceilingReport = null;
        /** `tick()` stays quiet until this time (backoff pause). */
        this.retryAt = 0;
        /** Trip and retry ladder; while `breaker.tripped` is set, nothing is sent. */
        this.breaker = new Breaker();
        /** The trip sent its forced OFF and its state report has not come back yet. */
        this.tripOffPending = false;
        /**
         * ARMED: the mode whose frames we are waiting for, or `null`. The strip
         * is off, but the choice still stands, so the first frame to arrive
         * lights it again. Only an external source (`sync`) can be armed, and
         * any direct user action clears it. See docs/DESIGN.md.
         */
        this.armed = null;
        /**
         * "ON"/"OFF": the power the strip was last TOLD to take, or last
         * REPORTED to be in. Not the same question as `this.output`, which is
         * the mode; this one exists so `light()` can refuse to send a command
         * the strip is already obeying. A redundant command is not free: z2m
         * answers every `/set` with a state publish, that publish re-enters
         * `onEntityState`, and an echo describing a PAST command is what turns
         * two commands in flight into an endless ping-pong. `null` until
         * `start()` reads the state cache.
         */
        this.stripState = null;
        /**
         * What `udpAllowFrom` has refused since the last summary. See
         * `UDP_REJECT_WINDOW_MS`: a count, a capped sample of the senders, and
         * when the next line may be written.
         */
        this.udpRejected = { packets: 0, senders: new Set(), truncated: false, reportAt: 0 };
        /**
         * BLACK GATE state. `since` is when the current unbroken run of black
         * frames began (0 for "the last frame had light in it"), `closed` is
         * whether that run has already passed `blackTimeoutMs` and is being
         * dropped. See `#blackGated`.
         */
        this.black = { since: 0, closed: false };
        /**
         * Commands we published to the strip's own `/set`, waiting to be
         * recognised when z2m hands them back. See `#wasSelfSent`.
         */
        this.selfSent = [];
        /**
         * The SAME commands again, as bare power states, for the second way
         * back: the strip's own state report on the event bus. A separate list
         * because the two arrive as separate events, so one entry cannot serve
         * both. See `#wasSelfState`.
         */
        this.selfState = [];
        /** When `showOn` last published its display-only "ON"; 0 once its echo is back. */
        this.shownOnAt = 0;
    }

    /** Transport: the real Zigbee endpoint. */
    zclTransport(endpoint) {
        return {
            zclCommand: (c) =>
                endpoint.zclCommand(c.cluster, c.command, c.payload, c.options, {}, false, 1),
            writeAttribute: (a) =>
                endpoint.write(a.cluster, { [a.attribute]: { type: a.type, value: a.value } }, a.options),
        };
    }

    async start() {
        // WHERE the settings came from. First question when someone says "my
        // setting did nothing", and not guessable from outside: the path is
        // derived from the module location and can be overridden by
        // `HUELINK_CONFIG`.
        this.logger.info(
            `[huelink] ${CONFIG_PATH ? t("log.configLoaded", { path: CONFIG_PATH }) : t("log.configDefaults")}`,
        );
        // Config typos, before anything else and loudly. They are detected at
        // module load, where there is no z2m logger yet, so this is the first
        // place a human can hear them. A silent fall back to a default looks
        // exactly like a working config.
        for (const problem of CONFIG_ERRORS) {
            this.logger.error(`[huelink] ${t("log.configProblem", { problem })}`);
        }
        // Fields that are each valid and jointly impossible. Not an error, so
        // not `error`, but said out loud all the same: the alternative is a
        // pacer that quietly delivers less than the file asked for, and a
        // number that does nothing is indistinguishable from a number that
        // does something until someone measures it. See `consistency()`.
        for (const warning of CONFIG_WARNINGS) {
            this.logger.warning(`[huelink] ${t("log.configWarning", { warning })}`);
        }

        const device = this.zigbee.resolveEntity(CONFIG.device);
        if (!device) {
            this.logger.error(`[huelink] ${t("log.deviceNotFound", { device: CONFIG.device })}`);
            return;
        }
        // Kept: `publishExposes` needs it on every state publish, and resolving
        // again in the hot path would look up the same unchanging device.
        this.device = device;
        const endpoint = device.endpoint();

        this.effects.effects = await loadEffects(this.logger);
        this.logger.info(
            `[huelink] ${t("log.effectsLoaded", {
                count: this.effects.effects.length,
                names: this.effectOptions.join(", "),
            })}`,
        );
        // There is ALWAYS a selected effect, even when the mode is not effect,
        // so the HA select always holds a valid option and effect mode never
        // has to start from nothing.
        if (this.effects.effects.length) this.effects.select(this.effects.effects[0].name);

        // Logged here: huelink-ui.mjs also loads in z2m's converter process, which has no logger of ours.
        for (const problem of PRESET_PROBLEMS) this.logger.error(problem);
        this.logger.info(
            `[huelink] ${t("log.presetsLoaded", {
                count: PRESETS.length,
                names: PRESETS.map((p) => p.name).join(", "),
            })}`,
        );

        this.stream = new HueStream({
            transport: this.zclTransport(endpoint),
            networkAddress: device.zh.networkAddress,
            segments: CONFIG.segments,
            smoothingMs: Math.round(1000 / CONFIG.fps),
        });

        // Recovery after an unexpected death. If the previous process ended
        // mid-stream, the strip is still in entertainment mode and ignores HA,
        // z2m and this extension alike. One reset at startup is the only place
        // that can notice and undo it.
        try {
            await this.stream.reset();
            this.logger.info(`[huelink] ${t("log.startReset")}`);
        } catch (e) {
            this.logger.error(`[huelink] ${t("log.startResetFailed", { error: e.message })}`);
        }

        // A restart is not a choice. After it the strip is OFF and armed on
        // sync, never light: the only thing that may light it by itself is a
        // real frame. This deliberately does not read the TV state, and does
        // not need to. Whether the TV is on is not a fact to be fetched from
        // some other system that may itself be restarting; it is the presence
        // of lit frames on the UDP port, which this process can see for
        // itself one tick from now. See docs/DESIGN.md.
        this.arbiter.power = false;
        this.arbiter.requested = MODE_LIGHT;
        this.armed = MODE_SYNC;

        // A strip that survived the restart lit has to be turned off for real,
        // not merely described as off. Here, before the listeners, not in the
        // first `tick`: our own `OFF` returns via `onEntityState`, and a strip
        // `ON` arriving in the gap would hit `setPower(true)` and clear the
        // arming we just set.
        this.stripState = String(this.state.get(device)?.state ?? "OFF").toUpperCase() === "ON" ? "ON" : "OFF";
        if (this.stripState === "ON") {
            this.logger.info(`[huelink] ${t("log.wasLit")}`);
            await this.light("OFF");
        }
        this.output = MODE_OFF;

        // The UDP listener is the one way into this extension that asks for no
        // credentials: a frame is 21 bytes with no header and no sender, so
        // whoever reaches the port drives the strip. `udpBind` decides which
        // interfaces the port exists on, `udpAllowFrom` which senders are read
        // at all. Both default to the open setting, because tightening them by
        // default would silently break every Hyperion already pointed here;
        // instead the exposure is stated in the log at every start.
        const allowed = new Set(CONFIG.udpAllowFrom);
        this.udp = dgram.createSocket("udp4");
        this.udp.on("message", (buf, rinfo) => {
            if (allowed.size > 0 && !allowed.has(rinfo.address)) {
                this.noteUdpRejected(rinfo.address);
                return;
            }
            const leds = parseLeds(buf, CONFIG.segments);
            if (!leds) return;
            // A black frame is still a frame, and that is the problem: see
            // `#blackGated`. Dropping it here rather than anywhere later is
            // what makes the rest of the extension need no new code at all.
            if (this.#blackGated(leds)) return;
            this.sources.sync.put(leds);
        });
        this.udp.on("error", (e) => this.logger.error(`[huelink] ${t("log.udpError", { error: e.message })}`));
        this.udp.bind(CONFIG.udpPort, CONFIG.udpBind);
        this.logger.info(
            `[huelink] ${
                allowed.size > 0
                    ? t("log.udpBoundAllow", {
                          bind: CONFIG.udpBind,
                          port: CONFIG.udpPort,
                          senders: [...allowed].join(", "),
                      })
                    : t("log.udpBoundOpen", { bind: CONFIG.udpBind, port: CONFIG.udpPort })
            }`,
        );

        this.eventBus.onMQTTMessage(this, (data) => this.onCommand(data));
        // Second path for power: not every off arrives over MQTT `/set`. A wall
        // switch, a Zigbee binding or the z2m web UI changes the state
        // directly, and the published state is where everyone sees it.
        this.eventBus.onPublishEntityState(this, (data) => this.onEntityState(data));

        // Settle window before the first decision: commands from the previous
        // life are still in flight (an extension reload calls `stop()` on the
        // old instance, whose `OFF` echo lands here ~100 ms later and would
        // look like a user press). Listeners are registered now on purpose:
        // with power off a stray `OFF` is a no-op, while a genuine `ON` is
        // still honoured. See docs/DESIGN.md.
        this.settleTimer = setTimeout(() => {
            this.settleTimer = null;
            this.timer = setInterval(() => void this.tick(), CONFIG.tickMs);
        }, CONFIG.startSettleMs);

        // Watch the config file from here on. The stamp is taken first so the
        // very first poll does not read a file nothing has touched.
        this.configStamp = configMtime();
        this.configTimer = setInterval(() => this.reloadConfig(), CONFIG_WATCH_MS);

        // Real frame rate is measured over a window, not per frame: 5 s is
        // short enough to notice a drop and long enough that one slow Zigbee
        // send does not make the number jump. This no longer drives fading;
        // the pacer does that per frame from the gap it just measured.
        this.fpsTimer = setInterval(() => {
            const measured = Math.round((this.sent / FPS_WINDOW_S) * 10) / 10;
            this.sent = 0;
            if (measured === this.fpsReal) return;
            this.fpsReal = measured;
            void this.publishState();
        }, FPS_WINDOW_S * 1000);

        await this.publishDiscovery();
        await this.publishState();
        this.logger.info(
            `[huelink] ${t("log.listening", {
                version: VERSION,
                port: CONFIG.udpPort,
                fps: CONFIG.fps,
                device: CONFIG.device,
            })}`,
        );
    }

    /**
     * Re-read `huelink.config.json` and apply `FILE_LIVE`. Everything else
     * (slider knobs, `saturation`, `maxFps`, ...) is startup-only and named in
     * the log if the file changed.
     */
    reloadConfig() {
        const stamp = configMtime();
        if (stamp === this.configStamp) return;
        this.configStamp = stamp;
        // File removed: keep what runs rather than reset to defaults.
        if (!stamp) return;

        const { config, errors, warnings, invalid } = loadConfig();
        // A typo in a live edit is the most likely kind there is: this is the
        // path where someone is typing into a running system.
        for (const problem of errors) {
            this.logger.error(`[huelink] ${t("log.configProblem", { problem })}`);
        }
        for (const warning of warnings) {
            this.logger.warning(`[huelink] ${t("log.configWarning", { warning })}`);
        }

        // A key the file could not supply keeps its running value, not the default.
        const live = Object.fromEntries(FILE_LIVE.filter((key) => !invalid.includes(key)).map((key) => [key, config[key]]));
        const changed = this.pacer.tune(live);
        this.logger.info(
            `[huelink] ${
                changed.length
                    ? t("log.configApplied", {
                          fields: changed.map((key) => `${key}=${this.pacer[key]}`).join(", "),
                      })
                    : t("log.configSame")
            }`,
        );
        // Anything else that moved is named, not silently ignored. Stringified: `udpAllowFrom` is an array.
        const restart = Object.keys(CONFIG).filter(
            (key) => !FILE_LIVE.includes(key) && JSON.stringify(config[key]) !== JSON.stringify(CONFIG[key]),
        );
        if (restart.length) {
            this.logger.warning(`[huelink] ${t("log.configRestartNeeded", { fields: restart.join(", ") })}`);
        }
    }

    /**
     * Record one packet refused by `udpAllowFrom`, and write a summary at most
     * once per `UDP_REJECT_WINDOW_MS`.
     *
     * Nothing here grows with the number of packets or the number of distinct
     * senders: the counter is a number, the sample stops at
     * `UDP_REJECT_MAX_SENDERS` addresses, and both are emptied when the summary
     * goes out. A sender that puts a fresh address in every packet therefore
     * costs the same as one that repeats itself, which is the whole point:
     * source addresses are not authenticated, so the defence must not assume
     * there is a bounded number of them.
     */
    noteUdpRejected(address) {
        const r = this.udpRejected;
        r.packets += 1;
        if (!r.senders.has(address)) {
            // Past the cap the address is NOT remembered, only the fact that
            // there were others. Counting the unsampled ones exactly would
            // need to remember them, which is the leak being fixed.
            if (r.senders.size < UDP_REJECT_MAX_SENDERS) r.senders.add(address);
            else r.truncated = true;
        }

        const now = Date.now();
        if (now < r.reportAt) return;
        // The first refused packet reports at once (`reportAt` starts at 0):
        // the whole reason to log this is someone wondering why their frames
        // do nothing, and making them wait a minute to find out is unkind.
        const sample = [...r.senders].join(", ");
        this.logger.error(
            `[huelink] ${t("log.udpRejected", {
                packets: r.packets,
                window: Math.round(UDP_REJECT_WINDOW_MS / 1000),
                senders: r.truncated ? t("log.udpRejectedMore", { senders: sample }) : sample,
            })}`,
        );
        r.packets = 0;
        r.senders.clear();
        r.truncated = false;
        r.reportAt = now + UDP_REJECT_WINDOW_MS;
    }

    /**
     * BLACK GATE: `true` when this frame must NOT count as a live source.
     *
     * The chain upstream is TV -> capture card -> Hyperion -> here, and a
     * capture card is under no obligation to stop when its input does. Many
     * keep sending flawless black frames forever, which `sourceTtlMs` cannot
     * tell apart from a film in a dark room: the source stays live, the strip
     * stays on, and "the TV is off" never reaches us. Externally arranging for
     * the stream to stop (switching the grabber off from elsewhere when the TV
     * goes off) is the obvious fix and the wrong one, because then the thing
     * deciding whether the strip follows the TV is some other process that can
     * be restarted, be wrong, or simply not be running.
     *
     * So the decision lives here, in the only component that sees the frames.
     * The rule is deliberately dull: a frame is black when no channel of any
     * segment is above `BLACK_LEVEL`, and black frames are only dropped once
     * they have been unbroken for `BLACK_TIMEOUT_MS`. One lit frame ends the
     * run immediately, in full, with no hysteresis to unwind. A timeout, not a
     * frame count: the grabber's frame rate is not ours to assume.
     *
     * Dropping is the entire action. The source then goes quiet on its own TTL
     * and `tick()` runs the path it has always run for a source that stopped:
     * strip off, armed on sync, lit again by the first frame that returns. No
     * second state machine, and nothing here that can leave the strip off
     * while frames are arriving.
     */
    #blackGated(colors) {
        const lit = colors.some((c) => c.r > BLACK_LEVEL || c.g > BLACK_LEVEL || c.b > BLACK_LEVEL);
        if (lit) {
            if (this.black.closed) {
                this.logger.info(`[huelink] ${t("log.blackEnded")}`);
            }
            this.black.since = 0;
            this.black.closed = false;
            return false;
        }

        const now = Date.now();
        // First black frame of a run: remember when, and pass it on. Until the
        // run is long enough the frames are ordinary frames, because a black
        // SCENE is a legitimate thing for the strip to show.
        if (!this.black.since) {
            this.black.since = now;
            return false;
        }
        if (now - this.black.since < BLACK_TIMEOUT_MS) return false;

        if (!this.black.closed) {
            this.black.closed = true;
            this.logger.info(`[huelink] ${t("log.blackGated", { seconds: Math.round(BLACK_TIMEOUT_MS / 1000) })}`);
        }
        return true;
    }

    /** Effect names for the HA select. No "none": that is a mode, not an effect. */
    get effectOptions() {
        return this.effects.effects.map((e) => e.name);
    }

    /** One frame: the arbiter decides, the stream sends, a mode change starts/stops it. */
    async tick() {
        // Tripped breaker or backoff pause: the air stays free for the rest of
        // the house. Both checks come first so neither a frame nor a mode
        // change command leaves in those states.
        // The dwell is checked on this tick rather than by a timer, which
        // would have to be cancelled in `resume`, `stop` and every reopen.
        // Once auto-retry has given up there is no dwell left to wait for.
        if (this.breaker.tripped) {
            if (this.breaker.dueForReopen(Date.now())) await this.reopen();
            return;
        }
        if (Date.now() < this.retryAt) return;
        if (this.sending) return; // do not overlap when Zigbee answers slowly
        this.sending = true;
        try {
            // Armed and content is back: the strip lights itself. Only the
            // source decides this, never a timer, so "TV on again" and "strip
            // on again" are one event with no second click.
            if (this.armed && !this.arbiter.power && this.sources[this.armed]?.live) {
                const mode = this.armed;
                this.armed = null;
                this.arbiter.power = true;
                this.arbiter.requested = mode;
                this.resetPacing();
                this.logger.info(`[huelink] ${t("log.resumed", { mode: MODE_LABEL[mode] })}`);
                await this.publishState();
            }

            // The effect source is pulled, not pushed: the generator is local
            // and synchronous, so the frame is taken right before the pick.
            // Pulled ONLY in effect mode, or a generator spinning in the
            // background would keep the source live in a mode meant to be quiet.
            if (this.arbiter.power && this.arbiter.requested === MODE_EFFECT) {
                const colors = this.effects.frame();
                if (colors) this.sources.effect.put(colors);
                else this.sources.effect.clear();
            } else {
                this.sources.effect.clear();
            }

            const { mode, colors } = this.arbiter.pick();

            // Indirect stream end: darkness while power is ON means the source
            // ran out, not the user's intent. The strip goes off and the choice
            // is armed. Deliberately outside the transition check, because the
            // same state arises when the strip was already dark; the invariant
            // it keeps is dark strip <=> power off. See docs/DESIGN.md.
            const idled = mode === MODE_OFF && this.arbiter.power;
            if (idled) {
                const ended = this.arbiter.requested;
                const wasStreaming = this.output === MODE_SYNC || this.output === MODE_EFFECT;
                // Power drops BEFORE the command, not after: our own `OFF`
                // comes back over the eventBus looking exactly like a user
                // press, and with power still `true` it would clear the arming.
                this.armed = ended === MODE_SYNC ? MODE_SYNC : null;
                this.arbiter.power = false;
                // Not "switch to light". With power off `pick()` returns `off`
                // whatever `requested` says, so the strip never lights from
                // here. All this line decides is what the NEXT power press
                // does, and that must be a plain light rather than a silent
                // resume. `off` cannot go here: it is a power state, not a
                // requestable mode (`MODES` excludes it on purpose).
                this.arbiter.requested = MODE_LIGHT;
                // One line, with the reason that actually applies. Three paths
                // reach this same state but are not the same event: the stream
                // ran and fell silent; the stream never started because there
                // is no source; or the strip was already dark, which is not
                // worth reporting at all.
                if (wasStreaming) {
                    this.logger.info(
                        `[huelink] ${t(this.armed ? "log.sourceEndedArmed" : "log.sourceEnded", {
                            mode: MODE_LABEL[ended],
                            ttl: CONFIG.sourceTtlMs,
                        })}`,
                    );
                } else if (this.output !== MODE_OFF) {
                    this.logger.info(
                        `[huelink] ${t(this.armed ? "log.sourceQuietArmed" : "log.sourceQuiet", {
                            mode: MODE_LABEL[ended],
                        })}`,
                    );
                }
            }

            if (await this.applyOutput(mode)) {
                await this.publishState();
            } else if (idled) {
                // Output did not change (already dark), but power, mode and
                // arming did. Without this HA would keep the stale mode.
                await this.publishState();
            }

            if (colors) {
                // Saturate before the pacer decides, so delta suppression
                // compares the colours that will actually be sent. At 100 %
                // `saturate` returns the same array untouched.
                // Allocates a new array unless neutral; negligible at <= 25 fps.
                const shown = saturate(colors, this.saturationPct / 100);
                // Three levers in one call: pace, duty cap and delta
                // suppression. `null` means "do not send this frame" and is not
                // an error, so `failures` is left alone. See docs/PACING.md.
                const decision = this.pacer.decide(shown);
                // "delta" means nothing visibly changed: that is not a late frame.
                if (!decision) this.stall.observe(Date.now(), this.pacer.lastSkip === "delta" ? "quiet" : this.pacer.lastSkip);
                if (decision) {
                    this.stream.setSmoothingMs(decision.smoothingMs);
                    const t0 = Date.now();
                    this.sendStartedAt = t0;
                    await this.stream.frame(shown);
                    const sendMs = Date.now() - t0;
                    this.sendStartedAt = 0;
                    // Send duration IS coordinator occupancy, which is what the
                    // budget measures, so it self-corrects as the coordinator
                    // slows. `decision.fast` is passed on because a scene cut
                    // runs off-beat: letting its short gap into the rhythm
                    // would shorten the fade of every ordinary frame after it.
                    this.pacer.noteSent(
                        decision.perceptual,
                        sendMs,
                        Date.now(),
                        decision.fast,
                    );
                    this.sent++;
                    this.noteFrameTimes(sendMs);
                    // It went through: the strip answers, so earlier failures
                    // were transient and the counter starts from zero. The
                    // dwell ladder resets fully here only, and only after a run
                    // of accepted frames: that is the proof that the last
                    // reopen was worth it (see `RECOVERY_FRAMES`). An acked ON
                    // only lifts a give-up (`Breaker.ackedOn`).
                    this.failures = 0;
                    // Clear the "needs attention" alert now, not on some later publish.
                    if (this.breaker.frameOk()) void this.publishState();
                }
            } else {
                // Nothing is expected to flow, so no frame is late.
                this.stall.reset();
                this.failures = 0;
            }
        } catch (e) {
            await this.onFailure(e);
        } finally {
            this.sending = false;
        }
    }

    /**
     * One log line of a kind, at most once per `STALL_LOG_EVERY_MS`, with the
     * number of occurrences swallowed since the previous one appended.
     */
    logStall(kind, key, params, level = "warning") {
        const hit = this.stallLog[kind].hit(Date.now());
        if (!hit) return;
        const more = hit.held ? ` ${t("log.stallMore", { count: hit.held })}` : "";
        this.logger[level](`[huelink] ${t(key, params)}${more}`);
    }

    /**
     * After a frame went out: did the gap since the previous one add up to a
     * stall. Reports only.
     */
    noteFrameTimes(sendMs) {
        const report = this.stall.sent(Date.now(), sendMs);
        if (!report) return;
        const round = (ms) => Math.round(ms);
        const parts = ["send", "backoff", "budget", "window"]
            .filter((key) => report.causes[key] >= 50)
            .sort((a, b) => report.causes[b] - report.causes[a])
            .map((key) => t(`log.stallCause.${key}`, { ms: round(report.causes[key]) }));
        // Pacer-only waits (budget, window) are throttling working, not a fault.
        const fault = report.causes.send + report.causes.backoff >= 50;
        this.logStall("stalled", "log.stalled", { total: round(report.totalMs), causes: parts.join(", ") }, fault ? "warning" : "info");
    }

    /** `pacer.stats()` plus stall counters. */
    stats() {
        return { ...this.pacer.stats(), ...this.stall.stats() };
    }

    /** Forget frame history (pacer and stall watch) when the content changes. */
    resetPacing() {
        this.pacer.reset();
        this.stall.reset();
    }

    /**
     * A failed Zigbee send. Two steps, not one: back off (200 ms -> 1 s -> 3 s)
     * because early failures are usually transient, then after `FAIL_LIMIT`
     * consecutive ones give up, stop the stream, turn the strip off and log a
     * single line. The strip goes OFF rather than to light, because the user
     * asked for sync and it ended; and `armed` is not set, because a failure is
     * not an idle source, and an armed mode would light the strip again on the
     * very next frame, which is the loop this exists to end. What the mode WAS
     * is remembered instead, for `reopen` to arm from. See docs/DESIGN.md.
     */
    async onFailure(error) {
        this.failures++;
        this.breaker.frameFailed();
        this.stall.failed(Date.now(), this.sendStartedAt || undefined);
        this.sendStartedAt = 0;
        if (this.failures < FAIL_LIMIT) {
            const i = Math.min(this.failures - 1, FAIL_BACKOFF_MS.length - 1);
            this.retryAt = Date.now() + FAIL_BACKOFF_MS[i];
            // Failures that never reach the breaker (a frame gets through
            // between them) would otherwise freeze the strip silently.
            this.logStall("failed", "log.frameFailed", {
                n: this.failures,
                limit: FAIL_LIMIT,
                pauseMs: FAIL_BACKOFF_MS[i],
                error: error.message,
            });
            return;
        }
        this.stall.reset();

        const mode = this.arbiter.requested;
        const label = MODE_LABEL[mode] ?? mode;
        this.breaker.trip(label, mode, Date.now());
        this.failures = 0;
        this.retryAt = 0;
        this.armed = null;
        // Power drops BEFORE the command, so our own `OFF` echo finds a state
        // `setPower` already agrees with and overwrites nothing.
        this.arbiter.power = false;
        this.arbiter.requested = MODE_LIGHT;
        this.sources.sync.clear();
        this.sources.effect.clear();

        // One attempt to pull the strip out of entertainment mode. If that
        // fails too it is NOT retried: retrying is the very loop this breaker
        // exists to end. An unreachable strip is sorted out by the next
        // explicit command (see `resume`).
        let reachable = true;
        try {
            await this.stream.stop();
        } catch {
            reachable = false;
        }
        // Only turn it off if the strip actually answered; otherwise this is
        // one more command to nobody with a 6 s timeout. An ordinary z2m
        // command, not a black frame, which would leave HA showing "on".
        // Forced: the breaker always trips out of a stream, so any `OFF` the
        // strip is already reported to be in was one it ignored. See `light`.
        // Set before the await: the echo can land while it is still pending.
        this.tripOffPending = reachable;
        if (reachable && !(await this.light("OFF", true))) this.tripOffPending = false;
        this.output = MODE_OFF;

        this.logger.error(
            `[huelink] ${t("log.tripped", { mode: label, limit: FAIL_LIMIT, error: error.message })}`,
        );
        // Written here, once per trip, rather than by `tick`, which would need
        // a flag to avoid repeating it on every call.
        if (this.breaker.needsManualResume) {
            this.logger.error(
                `[huelink] ${t("log.autoRetryGaveUp", { mode: label, streak: this.breaker.tripStreak })}`,
            );
        }
        await this.publishState();
    }

    /** Closes a tripped breaker, from an explicit command or from `reopen`. The ladder is kept: see `Breaker.close`. */
    resume() {
        if (!this.breaker.tripped) return;
        this.logger.info(`[huelink] ${t("log.retrying", { mode: this.breaker.tripped })}`);
        this.breaker.close();
        this.failures = 0;
        this.retryAt = 0;
    }

    /**
     * Reopen after the dwell (called from `tick`) and re-ARM, not relight. Only
     * sync/effect have a source to wait for; arming light mode would make a
     * dead strip switch itself on.
     *
     * Re-entrancy is decided before the first `await` because `tick` calls
     * this every few ms.
     */
    async reopen() {
        if (!this.breaker.tripped) return;
        // `resume()` clears `tripped` synchronously, so the repeated calls from
        // `tick` cannot overlap despite the `await` below.
        const { trippedMode } = this.breaker;
        const mode = trippedMode === MODE_SYNC || trippedMode === MODE_EFFECT ? trippedMode : null;
        this.resume();
        this.armed = mode;
        await this.publishState();
    }

    /**
     * Turn the strip on or off through the ordinary z2m path.
     *
     * Over MQTT rather than `endpoint.command('genOnOff','off')`: a direct ZCL
     * send would darken the strip while z2m and HA kept showing the old state.
     * Publishing to z2m's own command topic (`skipReceive: false`, or z2m
     * ignores its own message) takes exactly the path the HA button takes, so
     * the state stays true everywhere.
     *
     * The price of that path is an echo, and the echo is only harmless while
     * exactly ONE command is in flight: then it describes the state we already
     * hold and `setPower` does nothing. With two in flight every echo
     * describes a PAST command, so it always disagrees with the current power,
     * flips it, and the flip sends the opposite command, whose echo flips it
     * back. Left to run it settles at the MQTT round-trip rate, measured at
     * roughly 15 commands a second.
     *
     * Hence the guard: never tell the strip to be what it is already known to
     * be. It costs nothing when the states agree and it is what stops the
     * ping-pong, because a loop needs each echo to produce a new command.
     *
     * `force` is the one exception, and it exists because the guard trusts a
     * report the strip never acted on. A STREAMING strip ignores ordinary
     * commands, so an `OFF` that arrives mid-stream is obeyed by z2m, echoed as
     * `state: "OFF"`, recorded here, and ignored by the hardware. The stream is
     * then stopped, the real `OFF` is sent, the guard sees "already off" and
     * drops it, and the strip stays LIT while z2m, HA and this extension all
     * say it is off. Leaving a stream is therefore the one moment the guard
     * must be overruled: see `applyOutput`, `onFailure` and `stop`. It cannot
     * restart the ping-pong, because it is one command at the END of a stream
     * rather than one per echo.
     *
     * The return value is what makes a broker outage survivable. The publish
     * failure used to be logged and swallowed, and `applyOutput` then recorded
     * the new mode anyway: a dropped `OFF` left the strip LIT while the
     * extension, z2m and HA all reported it off, and because `this.output` had
     * already moved on, nothing ever tried again. Reporting the failure lets
     * the caller leave `this.output` alone, so the next tick repeats the
     * command. It is reported rather than thrown because the circuit breaker
     * is about the STRIP, and a broker that blinked says nothing about it.
     *
     * @param {"ON"|"OFF"} state
     * @param {boolean} [force]  send even if the strip is already reported so
     * @returns {boolean} whether the strip is now known to be in `state`
     */
    async light(state, force = false) {
        if (state === this.stripState && !force) return true;
        // Recorded BEFORE the publish, not after: the echo of this very
        // command can arrive while the `await` is still pending, and a guard
        // that is not yet armed guards nothing. On failure it goes back, or
        // the strip would be left stuck in a state it was never told about.
        const previous = this.stripState;
        this.stripState = state;
        const payload = JSON.stringify({ state });
        // Noted BEFORE the publish for the same reason as `stripState`: the
        // echo can be back before the `await` returns. An entry left behind by
        // a failed publish expires by itself.
        const at = Date.now();
        this.selfSent.push({ payload, at });
        if (this.selfSent.length > SELF_ECHO_MAX) this.selfSent.shift();
        // And once more for the other return path. `#wasSelfSent` cannot cover
        // it: that entry is consumed by the `/set` echo, which arrives first
        // and is a different event from the state report that follows it.
        this.selfState.push({ state, at });
        if (this.selfState.length > SELF_ECHO_MAX) this.selfState.shift();
        try {
            await this.mqtt.publish(`${CONFIG.device}/set`, payload, {
                skipReceive: false,
            });
            return true;
        } catch (e) {
            this.stripState = previous;
            this.logger.error(`[huelink] ${t("log.lightFailed", { state, error: e.message })}`);
            return false;
        }
    }

    /**
     * Make z2m/HA show the strip as on WITHOUT telling the strip. A stream
     * starts with no "on" (it flashes the strip), which left the light entity
     * reading "off" beside a lit strip, and a tap on a card that reads "off"
     * sends exactly that "on".
     *
     * `stripState` is deliberately untouched: the strip's own on/off is still
     * off, so `light("ON")` must still go out when the stream ends in light.
     * Every way out of a stream sends a real, forced "off" or a real "on", so
     * this never outlives the stream it describes.
     *
     * shortcut: a strip that trips while unreachable gets no "off" at all and
     * keeps reading "on"; publish a display-only "off" there if that matters.
     */
    async showOn() {
        if (this.stripState === "ON") return;
        this.shownOnAt = Date.now();
        try {
            await this.publishEntityState(this.device, { state: "ON" });
        } catch (e) {
            this.shownOnAt = 0;
            this.logger.error(`[huelink] ${t("log.exposesFailed", { error: e.message })}`);
        }
    }

    /**
     * Put the strip into `mode`. The ONLY place `this.output` changes, so the
     * published output and what the strip was actually told cannot drift.
     *
     * @returns {boolean} whether anything changed (nothing to publish if not)
     */
    async applyOutput(mode) {
        if (mode === this.output) return false;
        const wasStreaming = this.output === MODE_SYNC || this.output === MODE_EFFECT;
        if (mode === MODE_OFF) {
            // Order matters: leave entertainment mode first, only then send
            // "off". The other way round does nothing, because a streaming
            // strip ignores ordinary commands. If the reset throws,
            // `this.output` is unchanged and the next tick retries, so the
            // state never claims "off" too early.
            //
            // And for the same reason the "off" is FORCED when a stream is
            // being left: the one that made everyone believe the strip is
            // already off is precisely the one the streaming strip ignored.
            // See `light`.
            await this.stream.stop();
            // A publish that did not happen is not a state change. Leaving
            // `this.output` where it was means the next tick comes back here
            // and sends the "off" again, instead of reporting a dark strip
            // that is still lit. Same reasoning as the `stream.stop()` throw
            // above, now also covering the broker.
            if (!(await this.light("OFF", wasStreaming))) return false;
        } else if (mode === MODE_LIGHT) {
            // Same way back, but the light stays on. Only reached when the
            // user chose light themselves.
            await this.stream.stop();
            if (!(await this.light("ON"))) return false;
        } else if (!this.stream.running) {
            // Into the stream WITHOUT an "on". Tested on the strip: frames
            // light an off strip by themselves, and an "on" (before or after
            // the start) flashes its last ordinary colour, mid-film after
            // every trip. z2m/HA are told separately, without the strip
            // hearing of it: see `showOn`.
            await this.stream.start();
            await this.showOn();
        }
        this.output = mode;
        return true;
    }

    /**
     * Carry out the arbiter's decision NOW, so a command handler publishes a
     * state that is already true.
     *
     * Without it the handler published `this.output` from the PREVIOUS
     * decision, so turning off put `power: "OFF"` next to `output: "light"` on
     * the wire: a state that contradicts itself and that HA shows until the
     * next tick corrects it. Applying first rather than deferring the publish
     * to that tick also means the strip reacts to the command, not to a timer.
     *
     * A tick may be holding the radio, and the two must not send at once. It is
     * WAITED for, not skipped: skipping is what leaves `power: "OFF"` next to
     * `output: "effect"` on the wire, because effect mode sends often enough
     * that an off command regularly lands mid-frame. The wait is bounded,
     * because a strip that stopped answering must not hold a command handler
     * open; past the bound the tick publishes the correction.
     */
    async settle() {
        // The same two guards as `tick`, and for the same reason. Checking
        // only `tripped` let a command walk straight into the backoff window
        // and send stop/start/ON/OFF to a strip that has just failed to
        // answer, each attempt holding the coordinator for up to ~6 s. That is
        // exactly what the backoff exists to prevent, and a command is no more
        // entitled to the radio than a frame is. Giving up here is cheap: the
        // tick applies the decision and publishes the correction as soon as
        // the pause is over (at most `FAIL_BACKOFF_MS`).
        if (this.breaker.tripped || Date.now() < this.retryAt) return;
        const until = Date.now() + SETTLE_WAIT_MS;
        while (this.sending && Date.now() < until) await sleep(5);
        if (this.sending) return;
        const { mode } = this.arbiter.pick();
        // `off` while power is still ON is the one decision this must NOT
        // carry out: it means the chosen source has no frames YET. Switching
        // the strip off in the same breath as the user picked the mode would
        // beat the first frame to it, and the strip would blink off and back
        // on for every mode change made before the source wakes up. That case
        // belongs to the tick, which arms the choice, says why in the log and
        // only then drops power. The state published meanwhile does not
        // contradict itself: `mode: sync` beside `output: light` is the
        // two-fields design, what was chosen versus what is actually sent.
        if (mode === MODE_OFF && this.arbiter.power) return;
        this.sending = true;
        try {
            await this.applyOutput(mode);
        } finally {
            this.sending = false;
        }
    }

    /**
     * POWER. The only place that changes `power`, so switching on always means
     * the same thing whichever path the command arrived by.
     *
     * Turning off clears both sources at once rather than letting them age out,
     * or Hyperion's next packet would restart the stream and "off" would not be
     * off. The mode returns to light in both directions: off, so the published
     * mode stops claiming sync still runs (HA gates Hyperion capture on it); on,
     * so the old effect does not silently resume and the same button always
     * means the same thing. See docs/DESIGN.md.
     */
    async setPower(on) {
        if (on === this.arbiter.power) {
            // The strip needs no command, but the INTENT still has to land.
            // Switching off a strip that is already dark because it is ARMED
            // used to return here and leave the arming in place, so the "off"
            // appeared to work and the strip lit itself again the moment the
            // TV came back: the one thing the user had just said not to do.
            // Only the arming is touched, because that is the only part of the
            // decision the early exit was skipping.
            //
            // Reaching here from our own echo would clear the arming without
            // anyone asking; that is why the echo is filtered out one level up
            // (`#wasSelfSent`) and why a state report that AGREES with the
            // power we hold stops in `#entityState` instead of calling this.
            //
            // A tripped strip is already off, but "off" from a person means
            // "stop telling me it is broken": the trip is closed so the status
            // reads Off and no timer re-arms it. The ladder is left alone, so
            // a strip that is still dead climbs on from the same rung, and
            // `breaker` keeps saying `gave_up` until it really recovers.
            if (!on && this.breaker.tripped) {
                this.breaker.close();
                await this.publishState();
                return;
            }
            if (!this.armed) return;
            this.armed = null;
            await this.publishState();
            return;
        }
        this.resume();
        // A direct action cancels arming: what was just pressed outranks what
        // the strip was waiting for. Without this, "on as a light" would jump
        // back to sync a moment later when the TV resumed.
        this.armed = null;
        this.arbiter.power = on;
        this.arbiter.requested = MODE_LIGHT;
        this.sources.effect.clear();
        this.sources.sync.clear();
        // The previous content's last colour does not apply to the new one:
        // keeping it could let delta suppression swallow the first frame of the
        // new mode just because it happens to resemble the old one.
        this.resetPacing();
        await this.settle();
        await this.publishState();
    }

    /**
     * MODE. A choice, not a switch: the new mode stops the previous one simply
     * because the arbiter only looks at one source's frames.
     *
     * A command arriving while the strip is off also turns it ON. The card
     * hides mode selection when power is off, but automations and voice can
     * send anything, and a silently refused "turn on sync" would be the same
     * dead end this model exists to remove.
     */
    async setMode(value) {
        // `MODE_BY_LABEL` is a Map on purpose; see huelink-lib/huelink-ui.mjs. With a
        // plain object `{"mode":"constructor"}` would pass the `!mode` check
        // below and light the strip on a name nobody defined.
        const mode = MODE_BY_LABEL.get(value) ?? (MODES.includes(value) ? value : null);
        if (!mode) {
            this.logger.error(`[huelink] ${t("log.unknownMode", { value })}`);
            return;
        }
        if (mode === MODE_EFFECT) {
            if (!this.effects.active) {
                this.logger.error(`[huelink] ${t("log.effectModeEmpty")}`);
                return;
            }
            // Effects that END (a sunrise, a countdown) sit on their last frame
            // for ever once finished. Re-entering effect mode is a request to
            // SEE the effect, so it starts over rather than showing the still
            // frame it stopped on, which reads as a broken generator.
            this.effects.restart();
        }
        // Power is set directly rather than through `setPower`, which would
        // clear BOTH sources including the one we are switching to. Everything
        // else `setPower` does follows in the lines below anyway.
        this.arbiter.power = true;
        this.resume();
        this.armed = null; // see `setPower`: a choice outranks waiting
        this.arbiter.request(mode);
        // The previous mode's frames must not survive the switch even by one
        // TTL, or light would briefly still show the effect.
        //
        // But only the PREVIOUS one. Clearing the new mode's source too would
        // manufacture a "sync with no source": the next tick comes in 20 ms and
        // the next UDP frame only after 40 ms, so the arbiter would be
        // guaranteed to see an empty source once, drop power and arm, and the
        // resulting `OFF` echo would knock the mode back to light.
        for (const [name, source] of Object.entries(this.sources)) {
            if (name !== mode) source.clear();
        }
        this.resetPacing();
        await this.settle();
        await this.publishState();
    }

    /** The knobs a preset owns, read live so every route that moves one is reflected. */
    knobValues() {
        return { ...Object.fromEntries(PRESET_TUNABLES.concat("fps").map((key) => [key, this.pacer[key]])), saturationPct: this.saturationPct };
    }

    /** Name of the preset matching the live knobs, or `null` (no selection). */
    currentPreset() {
        return match(PRESETS, this.knobValues(), this.pacer.maxFps)?.name ?? null;
    }

    /** Apply a preset by name or id; sliders keep working afterwards. */
    applyPreset(value) {
        const wanted = String(value);
        const preset = PRESETS.find((p) => p.id === wanted || p.name === wanted);
        if (!preset) {
            this.logger.error(`[huelink] ${t("log.unknownPreset", { value: wanted.slice(0, 40).replace(/[\x00-\x1f\x7f]/g, "?") })}`);
            return;
        }

        // Some presets raise the budget past the HA "expert" gate: choosing one is the consent.
        const maxFps = this.pacer.maxFps;
        const got = landed(preset, maxFps);
        this.pacer.setFps(got.fps);
        for (const key of PRESET_TUNABLES) this.pacer.setTunable(key, got[key]);
        this.saturationPct = got.saturationPct;

        this.logger.info(
            `[huelink] ${t("log.presetApplied", {
                name: preset.name,
                knobs: KNOB_KEYS.map((key) => `${key}=${got[key]}`).join(", "),
            })}`,
        );
        if (got.fps < preset.knobs.fps) {
            this.logger.warning(
                `[huelink] ${t("log.presetFpsTrimmed", { name: preset.name, asked: preset.knobs.fps, max: maxFps })}`,
            );
        }
    }

    /** Saturation in percent, snapped to the slider step so it can equal a preset. Returns whether the value was usable. */
    setSaturationPct(value) {
        const pct = clampSaturationPct(value);
        if (pct === null) return false;
        this.saturationPct = pct;
        return true;
    }

    /**
     * Commands from HA (or any other MQTT client) on `huelink/command`. Mutual
     * exclusion is not handled here; the mode does it by construction.
     *
     * The whole handler is wrapped because of WHO calls it: z2m's event bus
     * invokes it without awaiting, so anything thrown in here is an unhandled
     * rejection, and an unhandled rejection ends the Node process by default -
     * taking every other device in zigbee2mqtt down with it. One MQTT payload
     * from anywhere on the network must not be able to do that. A failed
     * command is a log line; the extension stays up.
     */
    async onCommand(data) {
        try {
            await this.#command(data);
        } catch (e) {
            this.logger.error(`[huelink] ${t("log.commandFailed", { topic: data?.topic, error: e.message })}`);
        }
    }

    /**
     * Is this `/set` message one we published ourselves a moment ago?
     *
     * `light()` publishes with `skipReceive: false` on purpose (see there), so
     * z2m delivers our own command straight back to this handler, where it is
     * indistinguishable from a person pressing the same button. That was
     * harmless while the only answer to "already in that state" was to do
     * nothing; now that an OFF also cancels the arming, our own OFF would
     * cancel an arming it had just caused, and the strip would never light
     * itself again. Each entry is consumed once, so a real press arriving
     * after the echo is still a press.
     */
    #wasSelfSent(message) {
        const now = Date.now();
        while (this.selfSent.length > 0 && now - this.selfSent[0].at > SELF_ECHO_MS) this.selfSent.shift();
        const i = this.selfSent.findIndex((s) => s.payload === String(message));
        if (i < 0) return false;
        this.selfSent.splice(i, 1);
        return true;
    }

    /**
     * Is this STATE REPORT the strip repeating a power command we just sent?
     *
     * The same question as `#wasSelfSent`, asked of the other way back. A
     * `/set` we publish returns twice: once as the MQTT message itself, and
     * once as the strip's state on the event bus after z2m has carried it out.
     * `#wasSelfSent` only ever saw the first.
     *
     * `#entityState` used to tell the two apart by a single test - does the
     * report AGREE with the power we hold - and that test is only sound while
     * our own power cannot move between the command and its report. The black
     * gate made it move routinely: a source that falls silent and returns
     * inside one second sends `OFF`, arms sync, and is back ON two ticks
     * later, all before the `OFF` report lands. The report then disagreed with
     * the power, was read as a person pressing off, and cleared the arming it
     * had itself caused. Nothing lights the strip after that, so it stayed
     * dark with frames arriving the whole time. The question that survives a power change is not
     * "does this match what we hold" but "did we send this", and only a record
     * of what we sent can answer it.
     *
     * Each entry answers for ONE report and is then gone, so a second press of
     * the same button is still a press. Entries OLDER than the match go with
     * it: the strip reports in the order it was commanded, so an earlier one
     * still sitting there belongs to a report that never came, and leaving it
     * would let it swallow a real press later in the window.
     *
     * What this deliberately does NOT cover is a report nobody here caused: a
     * wall switch, HA, a person. Those leave no record, so they still reach
     * `setPower` and still clear the arming, which is the whole point of the
     * distinction.
     */
    #wasSelfState(state) {
        const now = Date.now();
        while (this.selfState.length > 0 && now - this.selfState[0].at > SELF_ECHO_MS) this.selfState.shift();
        const i = this.selfState.findIndex((s) => s.state === state);
        if (i < 0) return false;
        this.selfState.splice(0, i + 1);
        return true;
    }

    async #command({ topic, message }) {
        const base = this.settings.get().mqtt.base_topic;
        const stripSet = `${base}/${CONFIG.device}/set`;
        if (topic === stripSet) {
            if (this.#wasSelfSent(message)) return;
            return this.onStripCommand(message);
        }
        // Attribute form `.../set/<field>` with a bare value in the payload.
        // That is what the HA discovery z2m generated for our own exposes uses
        // (`command_topic: zigbee2mqtt/<strip>/set/huelink_mode`). Without this
        // the fields would work on the z2m page while the matching HA entities
        // silently did nothing. Only `huelink_*`: the strip's other attributes
        // in this form were already ignored.
        if (topic.startsWith(`${stripSet}/`)) {
            const key = topic.slice(stripSet.length + 1);
            if (SETTABLE_KEYS.includes(key)) return this.onStripCommand(JSON.stringify({ [key]: String(message) }));
            return;
        }
        if (topic !== `${base}/${CONFIG.name}/command`) return;
        let body;
        try {
            body = JSON.parse(message);
        } catch {
            return;
        }
        // `JSON.parse` succeeds on `null`, `5` and `"x"` too, and the `in`
        // checks below throw on all three. Valid JSON is not the same question
        // as a usable command.
        if (body === null || typeof body !== "object" || Array.isArray(body)) {
            this.logger.error(`[huelink] ${t("log.commandNotObject", { payload: String(message).slice(0, 80) })}`);
            return;
        }
        if ("power" in body) {
            const value = String(body.power).toUpperCase();
            await this.setPower(value === "TOGGLE" ? !this.arbiter.power : value === "ON");
        }
        if ("effect" in body) {
            // Selecting an effect does NOT change the mode: it answers "which
            // effect", not "is an effect running". An unknown name is refused
            // rather than applied, because the engine would switch to "no
            // effect" and leave effect mode on but empty.
            //
            // Before `mode`, so `{"mode": "effect", "effect": X}` (a one-tap
            // dashboard button) enters effect mode on X, and works even when
            // no effect was selected yet, where `setMode` would refuse.
            const wanted = String(body.effect);
            if (!this.effectOptions.includes(wanted)) {
                this.logger.error(`[huelink] ${t("log.unknownEffect", { effect: wanted })}`);
            } else if (!this.effects.select(wanted)) {
                // A known name whose generator threw on start. `select()` has
                // already gone back to "nothing selected", so saying so is all
                // that is left; silence would show an effect name beside a
                // dark strip with no reason anywhere.
                this.logger.error(`[huelink] ${t("log.effectSelectFailed", { effect: wanted })}`);
            }
        }
        if ("mode" in body) await this.setMode(body.mode);
        // Before the individual knobs: preset first, explicit values win.
        if ("preset" in body) this.applyPreset(body.preset);
        // Every setter below REFUSES a value it cannot read, and a refusal is
        // said out loud. Silence would be the worst of both: the knob appears
        // to have been set, the published state disagrees with it, and nothing
        // anywhere says why. See huelink-lib/num.mjs for what counts as a number.
        if ("effect_brightness" in body) {
            this.#refused("effect_brightness", body.effect_brightness, this.effects.setBrightness(body.effect_brightness));
        }
        if ("effect_speed" in body) {
            this.#refused("effect_speed", body.effect_speed, this.effects.setSpeed(body.effect_speed));
        }
        // `delta` and `duty` stay off `/command` (z2m page only), as before.
        this.#applyKnobs(body, (name) => (name === "delta" || name === "duty" ? null : name === "budget" ? "occupancy_budget" : name));
        await this.publishState();
    }

    /**
     * Apply every knob present in `body`. `keyOf` maps a knob name to its key in
     * this payload (`null` = not accepted here). Setters clamp and refuse
     * non-numbers; a refusal is logged. Returns whether any key was present.
     */
    #applyKnobs(body, keyOf) {
        const p = this.pacer;
        // Budget is a percent on the wire, a fraction inside; parsed first so `null` is not 0 %.
        const budget = (v) => {
            const pct = toFinite(v);
            return pct !== null && p.setOccupancyBudget(pct / 100);
        };
        const knobs = [
            ["fps", (v) => p.setFps(v)],
            ["delta", (v) => p.setDeltaScale(v)],
            ["duty", (v) => p.setDutyCap(v)],
            ["budget", budget],
            ...KNOBS.map(({ knob, command }) => [command, (v) => p.setTunable(knob, v)]),
            ["saturation", (v) => this.setSaturationPct(v)],
        ];
        let touched = false;
        for (const [name, set] of knobs) {
            const key = keyOf(name);
            if (key === null || !(key in body)) continue;
            this.#refused(key, body[key], set(body[key]));
            touched = true;
        }
        return touched;
    }

    /** Say so when a setter turned a value down. No-op when it took it. */
    #refused(field, value, accepted) {
        if (accepted) return;
        this.logger.error(`[huelink] ${t("log.badValue", { field, value: JSON.stringify(value) })}`);
    }

    /**
     * Commands on the strip's own topic. Two things, one path.
     *
     * (1) POWER (HA light button, automation, voice). Without this the user
     *     hits a dead end: mid-stream a `state: OFF` does reach the strip, but
     *     the next frame ~70 ms later overwrites it, so the button "works" and
     *     the light stays. Turning the light off is a command to the ARBITER.
     *
     * (2) The `huelink_*` knobs from the z2m device page. They arrive here
     *     because `external_converters/huelink-exposes.mjs` declared them as
     *     strip fields, and z2m puts all device commands on this same `/set`.
     *     Its `convertSet` deliberately does nothing; this is the only place
     *     the values mean anything.
     *
     * So the same knob can be turned from HA and from the z2m page, and both
     * reach the SAME call rather than two copies free to drift apart.
     */
    async onStripCommand(message) {
        let body;
        try {
            body = JSON.parse(message);
        } catch {
            // z2m also accepts plain text ("ON"/"OFF"/"toggle").
            body = { state: String(message) };
        }
        // `"ON"`, `5` and `null` are all valid JSON, so the parse succeeding
        // says nothing about the shape. A bare string is the plain-text form
        // and is treated as one; anything else has no reading at all, and
        // `"huelink_mode" in body` would throw on it.
        if (typeof body === "string" || typeof body === "number") body = { state: String(body) };
        if (body === null || typeof body !== "object" || Array.isArray(body)) {
            this.logger.error(`[huelink] ${t("log.commandNotObject", { payload: String(message).slice(0, 80) })}`);
            return;
        }

        // No range checks here: the pacer clamps them itself (`LIMITS`), and a
        // second set of bounds would be free to fall behind. It does refuse
        // values that are not numbers at all, and that refusal is logged.
        let touched = false;
        if ("huelink_mode" in body) {
            await this.setMode(body.huelink_mode);
            touched = true;
        }
        // Before the sliders below: preset first, explicit values win.
        if ("huelink_preset" in body) {
            this.applyPreset(body.huelink_preset);
            touched = true;
        }
        if (this.#applyKnobs(body, (name) => `huelink_${name}`)) touched = true;
        if (touched) await this.publishState();

        const value = String(body.state ?? "").toUpperCase();
        if (value === "TOGGLE") return this.setPower(!this.arbiter.power);
        if (value !== "ON" && value !== "OFF") return;
        return this.setPower(value === "ON");
    }

    /**
     * Strip state arriving by any other path, not just `/set`.
     *
     * Wrapped for the same reason as `onCommand`: the event bus does not await
     * it, so a throw here is an unhandled rejection and ends the process. This
     * one is on the hotter path of the two - every state publish of the strip
     * passes through it, including ours.
     */
    async onEntityState(data) {
        try {
            await this.#entityState(data);
        } catch (e) {
            this.logger.error(`[huelink] ${t("log.entityStateFailed", { error: e.message })}`);
        }
    }

    async #entityState({ entity, payload, stateChangeReason }) {
        if (entity?.name !== CONFIG.device) return;
        // z2m's own startup replay, not an event. With
        // `advanced.cache_state_send_on_startup` the controller walks every
        // device and republishes its WHOLE cached state, reason
        // `publishCached` (z2m 2.14.3, dist/controller.js). Nothing changed:
        // this is yesterday's state, including the `state: "ON"` from before
        // the restart, and it is OLDER than the `OFF` `start()` has in flight.
        // Taken for a press it both lit the strip and cleared the arming, so
        // the TV could never light it again; and it put a second command in
        // flight, which is what started the ping-pong (see `light`). Returning
        // before the bookkeeping is deliberate: `this.stripState` must keep
        // describing our own command, not the stale cache.
        if (stateChangeReason === "publishCached") return;
        // `payload` is what CHANGED in this publish; the sibling `message` is
        // the whole merged state cache, where `state` is therefore always
        // present. Reading `message` made every `huelink_*` field update look
        // like a power press carrying the strip's stale cached `state`, which
        // is what drove the ON/OFF oscillation: the wrong power flipped the
        // output, the next tick sent the opposite light command, and its echo
        // flipped it back. An identity guard on our own payload could not fix
        // that, because the guard is one slot and `publishExposes` runs
        // concurrently with the 20 ms tick: a second call overwrites the slot
        // while the first is still in flight, and `finally` clears it before
        // the echo arrives at all. Reading the delta needs no bookkeeping and
        // cannot race. See docs/DESIGN.md.
        const value = String(payload?.state ?? "").toUpperCase();
        if (value !== "ON" && value !== "OFF") return;
        // Our own display-only "ON" coming back (see `showOn`). No strip acked
        // it, so it is neither proof of life for the breaker below nor news
        // for `stripState`. One echo per publish, like `#wasSelfState`.
        if (value === "ON" && Date.now() - this.shownOnAt < SELF_ECHO_MS) {
            this.shownOnAt = 0;
            return;
        }
        // z2m reports a state only once the strip acked it, so an "ON" here,
        // even the echo of our own, proves the strip is back on the network:
        // that clears the give-up alert. It does not prove frames get through,
        // so it buys one more try, not a fresh ladder (`Breaker.ackedOn`): a
        // strip that acks an "on" but fails frames must not be handed three
        // more trips per "on". The "on" comes from light mode or the HA light
        // entity; sync/effect send none (it flashes the strip), so there
        // `RECOVERY_FRAMES` clears the give-up instead. Only
        // "ON": every trip sends a forced "OFF".
        if (value === "ON" && this.breaker.autoRetryExhausted) {
            this.breaker.ackedOn();
            await this.publishState();
        }
        // Our own command coming back. Dropped whole, before the bookkeeping:
        // `light()` already wrote this very state into `stripState` when it
        // published, so there is nothing to learn here, and by the time a
        // DELAYED echo arrives that record may already have moved on to a
        // newer command it would overwrite with the older one. See
        // `#wasSelfState` for why "we sent this" cannot be inferred from the
        // power we hold.
        if (this.#wasSelfState(value)) {
            if (value === "OFF") this.tripOffPending = false;
            return;
        }
        // The strip itself reporting, so this is the best answer there is to
        // "what power is it in", whoever caused it: HA, a wall switch.
        this.stripState = value;
        // A report that AGREES with the power already held is news about the
        // STRIP, not an instruction. Recorded above, because it is still the
        // best answer to "what power is the strip in", then dropped here.
        // Until `setPower` learned to cancel the arming on an unchanged power
        // this made no difference, as `setPower` returned immediately on the
        // same comparison.
        //
        // Except an "OFF" while tripped: a person (HA light, wall switch)
        // saying off. Left here, the dwell would re-arm and the TV would
        // relight a strip just switched off. Not the trip's own OFF, though:
        // a trip means a jammed coordinator, so its echo can come back after
        // SELF_ECHO_MS, and closing the trip on it would lose the re-arm.
        if (value === "OFF" && this.breaker.tripped) {
            if (this.tripOffPending) {
                this.tripOffPending = false;
                return;
            }
            return this.setPower(false);
        }
        if ((value === "ON") === this.arbiter.power) return;
        await this.setPower(value === "ON");
    }

    /**
     * One human-readable line: what the strip is doing NOW. This used to be two
     * fields (`source` and `sync_status`) because there were two independent
     * switches; with one mode that question no longer exists.
     */
    status() {
        const mode = this.breaker.tripped;
        switch (this.activity()) {
            case "gave_up":
                return t("status.trippedManual", { mode });
            case "tripped":
                return t("status.tripped", { mode });
            case "waiting":
                return t("status.waitingTv");
            case "off":
                return t("status.off");
            case "effect":
                return t("status.effect", { effect: this.effects.selected });
            case "sync":
                return t("status.sync");
            default:
                return MODE_LABEL.light;
        }
    }

    /**
     * The same decision as `status`, as a fixed word from `ACTIVITIES`
     * (`huelink-ui.mjs`), so card conditions and automations do not match
     * translated text. `status` is built from this, so the two cannot drift.
     */
    activity() {
        // Both reasons the strip went dark ON ITS OWN come first. Otherwise a
        // plain "off" would hide them, and the user would see a dark strip with
        // not a word about what happened.
        if (this.breaker.needsManualResume) return "gave_up";
        if (this.breaker.tripped) return "tripped";
        if (this.armed === MODE_SYNC) return "waiting";
        if (!this.arbiter.power) return "off";
        if (this.output === MODE_EFFECT) return "effect";
        if (this.output === MODE_SYNC) return "sync";
        if (this.arbiter.requested === MODE_SYNC) return "waiting";
        return "light";
    }

    /**
     * Logs once per change when the frame cap asks for more than the duty cap
     * and the air budget can pay for. Keyed on verdict and asked rate, not the
     * budget figure, which drifts with every send. A warning: nothing is broken.
     */
    reportCeiling() {
        const c = this.pacer.ceiling();
        const capped = c.effective < c.asked;
        const verdict = `${capped ? "capped" : "ok"}:${c.asked}:${c.effective}`;
        if (verdict === this.ceilingReport) return;
        const first = this.ceilingReport === null;
        this.ceilingReport = verdict;
        if (capped) this.logger.warning(`[huelink] ${t("log.fpsCapped", c)}`);
        // No all-clear unless a warning came first.
        else if (!first) this.logger.info(`[huelink] ${t("log.fpsUncapped", c)}`);
    }

    /**
     * The same numbers, but on the z2m device page itself (`huelink_*` fields
     * declared by `external_converters/huelink-exposes.mjs`).
     *
     * Alongside the `zigbee2mqtt/huelink` topic rather than instead of it: the
     * retained topic is the HA discovery source and has its own shape (a nested
     * `pacer` object, which would not work as an expose). This is a flat view of
     * the same truth for someone already on the z2m page.
     *
     * @param {object} [stats]  `pacer.stats()`, when the caller already has it
     */
    async publishExposes(stats = this.stats()) {
        // Before `start()` finishes there is no device yet; `publishState` is
        // also called by `setPower`, which can run before `resolveEntity`.
        if (!this.device) return;
        const payload = {
            huelink_version: VERSION,
            huelink_status: this.status(),
            huelink_mode: MODE_LABEL[this.armed ?? this.arbiter.requested],
            huelink_fps: this.pacer.fps,
            huelink_fps_real: this.fpsReal,
            // One number for deliberately unsent frames. Both reasons (change
            // too small, quota spent) are summed on purpose: the UI question is
            // "is suppression working", and which of the two doors a frame fell
            // through is answered by the nested `pacer` stats.
            huelink_dropped: stats.skippedDelta + stats.skippedDuty,
            huelink_delta: stats.deltaScalePct,
            huelink_duty: stats.dutyCap,
            // From `stats()`, so sliders show what the engine uses (the file can move them too).
            huelink_budget: stats.occupancyBudgetPct,
            huelink_smoothing: stats.smoothingFactor,
            huelink_cut_threshold: stats.bigChangeThreshold,
            huelink_cut_ms: stats.fastSmoothingMs,
            huelink_cut_per_sec: stats.maxFastPerSec,
            // Derived from the knobs above, not stored.
            huelink_preset: this.currentPreset(),
            huelink_saturation: this.saturationPct,
        };
        try {
            await this.publishEntityState(this.device, payload);
        } catch (e) {
            this.logger.error(`[huelink] ${t("log.exposesFailed", { error: e.message })}`);
        }
    }

    /**
     * The retained `<base>/<name>` topic: everything HA and `scripts/deploy.sh`
     * read.
     *
     * It never throws. `tick()` calls it from inside the try whose catch is
     * `onFailure`, the circuit breaker, and the breaker means one thing only:
     * the STRIP is not answering. A broker that drops the connection is a
     * different fault with a different cure, and letting it through here made
     * five unpublished states look like five dead frames, which switched off a
     * strip that was working perfectly. So the publish is contained: logged,
     * and the caller carries on.
     */
    async publishState() {
        // Once, then handed to both publishers. `stats()` sorts its window to
        // take a percentile, and this runs on every state change, several
        // times a second in effect mode. Taking it twice also meant the two
        // views could describe two different moments, which is exactly what
        // publishing them together is meant to prevent.
        const stats = this.stats();
        // Single convergence point for slider, MQTT command and config reload.
        this.reportCeiling();
        try {
            await this.#publishRetained(stats);
        } catch (e) {
            this.logger.error(`[huelink] ${t("log.publishFailed", { error: e.message })}`);
        }
        // One call, two interfaces, updated TOGETHER on purpose: if the z2m
        // page and HA showed different moments, "which of the two is lying"
        // would become a new question. Outside the try, so a broker that
        // refused the retained topic does not also cost the device page.
        await this.publishExposes(stats);
    }

    async #publishRetained(stats = this.stats()) {
        await this.mqtt.publish(
            CONFIG.name,
            JSON.stringify({
                /** See `VERSION`: the same number as in the log and the expose. */
                version: VERSION,
                /**
                 * When the Node process behind this code started. `version`
                 * cannot tell a re-read extension file from a fresh process,
                 * and only a fresh process reloads `huelink-lib/*.mjs`; this can, so
                 * `scripts/deploy.sh` can prove what it deployed is running.
                 */
                started: STARTED_AT,
                power: this.arbiter.power ? "ON" : "OFF",
                // `mode` is what the user CHOSE and is the HA select's state;
                // `output` is what is actually being sent now (in sync with no
                // TV they differ). Two fields, two questions.
                //
                // Waiting does not change the choice: while armed, the internal
                // `requested` is light only because the strip is dark, but the
                // CHOICE is still sync. Publishing light here would gate HA's
                // Hyperion capture off and starve the very source we wait for.
                mode: MODE_LABEL[this.armed ?? this.arbiter.requested],
                // Power off means nothing is being sent, so that is what gets
                // published, whatever `this.output` still says. The two are not
                // the same fact: `this.output` is the record of what the strip
                // has already been TOLD, kept so `applyOutput` knows the reset
                // still has to go out and retries if it threw. Publishing that
                // record put `power: "OFF"` next to `output: "effect"` for as
                // long as nine seconds, while a busy radio finished the frames
                // already in flight and only then carried the reset. The
                // arbiter stops offering frames the instant power goes false,
                // so `off` here is the truth, not an optimistic guess.
                output: this.arbiter.power ? this.output : MODE_OFF,
                // What the strip is waiting for while dark. `null` more often
                // than not; without it "off" and "off but armed" look identical
                // from outside.
                armed: this.armed ? MODE_LABEL[this.armed] : null,
                status: this.status(),
                // `status` as a fixed word, see `activity`.
                activity: this.activity(),
                // The breaker as a fixed word for automations; `status` is
                // the same fact translated for people. `gave_up` holds through
                // an off or a manual try until a recovery is proven.
                breaker: this.breaker.state,
                effect: this.effects.selected,
                effect_brightness: Math.round(this.effects.brightness * 100),
                effect_speed: Math.round(this.effects.speed * 100),
                fps: this.pacer.fps,
                fps_real: this.fpsReal,
                // Localised name: the HA select's state must equal one of its options.
                preset: this.currentPreset(),
                // Percent, unlike the budget's fraction in `pacer`.
                saturation: this.saturationPct,
                // Pacer stats. Without them nobody can tell WHETHER
                // suppression is working: a drop in `fps_real` looks the same
                // whether frames are skipped on purpose or are failing.
                pacer: stats,
            }),
            { clientOptions: { retain: true } },
        );
    }

    /** HA discovery: topics and device here, the entity table in huelink-lib/discovery.mjs. */
    async publishDiscovery() {
        const base = this.settings.get().mqtt.base_topic;
        const prefix = this.settings.get().homeassistant?.discovery_topic ?? "homeassistant";
        const device = {
            identifiers: [`huelink_${CONFIG.name}`],
            name: "HueLink",
            manufacturer: "gatisr/huelink",
            model: "Hue entertainment sender",
            sw_version: VERSION,
            // z2m device identifier is the literal `zigbee2mqtt_<ID>` (no base
            // topic). Read from the device so it survives a re-pair.
            ...(this.device ? { via_device: `zigbee2mqtt_${this.device.options.ID}` } : {}),
        };
        const stateTopic = `${base}/${CONFIG.name}`;
        // `/command`, NOT `/set`. z2m's own publish extension routes everything
        // matching `<base>/(?!bridge)(.+?)/(get|set)` and looks the name up as a
        // Zigbee entity, so `<base>/huelink/set` made the core log
        // `error: Entity 'huelink' is unknown` on every command: `huelink` is a
        // virtual topic this extension serves itself, with no device behind it.
        // Any suffix outside that pattern is ignored by the core and still
        // reaches us, because the core subscribes to `<base>/#` and hands every
        // message to the event bus. See docs/DESIGN.md.
        const commandTopic = `${base}/${CONFIG.name}/command`;

        for (const [kind, id] of RETIRED) {
            await this.mqtt.publish(`${kind}/huelink_${CONFIG.name}/${id}/config`, "", {
                baseTopic: prefix,
                clientOptions: { retain: true },
            });
        }

        const entities = discoveryEntities({
            stateTopic,
            commandTopic,
            availabilityTopic: `${base}/bridge/state`,
            device,
            effectOptions: this.effectOptions,
        });
        for (const [kind, id, cfg] of entities) {
            await this.mqtt.publish(`${kind}/huelink_${CONFIG.name}/${id}/config`, JSON.stringify(cfg), {
                baseTopic: prefix,
                clientOptions: { retain: true },
            });
        }
    }

    /**
     * Run one shutdown step, and carry on whatever it does.
     *
     * Shutdown is a LIST of independent repairs, not a sequence where each
     * depends on the one before: closing the socket, dropping the listeners,
     * leaving entertainment mode, darkening the strip. A plain `await` chain
     * made them depend on each other anyway, and the failure that proved it is
     * ordinary: after a reload the new instance binds the UDP port while the
     * old one still holds it, `bind` fails, and `close()` on the unbound
     * socket throws. That throw used to abandon every step after it, so the
     * strip stayed in entertainment mode, out of reach of HA, and the detached
     * instance kept its event listeners.
     */
    async #quietly(step, fn) {
        try {
            await fn();
        } catch (e) {
            this.logger.error(`[huelink] ${t("log.stopStepFailed", { step, error: e.message })}`);
        }
    }

    async stop() {
        // Including the loop that has not started yet: stopping during the
        // settle window would otherwise leave behind a timer that starts
        // sending frames on behalf of an already detached extension.
        if (this.settleTimer) clearTimeout(this.settleTimer);
        if (this.timer) clearInterval(this.timer);
        if (this.fpsTimer) clearInterval(this.fpsTimer);
        if (this.configTimer) clearInterval(this.configTimer);
        this.settleTimer = null;
        this.timer = null;
        this.fpsTimer = null;
        this.configTimer = null;

        // A tick already inside `stream.frame()` holds the radio and is about
        // to send ONE more frame. Stopping the stream underneath it put that
        // frame on the air AFTER `CMD_RESET`, which is how a strip ends up
        // frozen on a stray colour with nothing left to clear it. The timers
        // are gone by now, so this waits for the last one rather than for a
        // succession of them; past the bound we stop anyway, because a strip
        // that is not answering must not hold up the shutdown of every other
        // device in zigbee2mqtt.
        const until = Date.now() + SETTLE_WAIT_MS;
        while (this.sending && Date.now() < until) await sleep(5);

        const streaming = this.output === MODE_SYNC || this.output === MODE_EFFECT;
        await this.#quietly("udp", () => {
            // Cleared first: a second `stop()` (z2m calls it on both reload
            // and shutdown) would otherwise close a closed socket and report
            // a failure that is really just the first stop having worked.
            const udp = this.udp;
            this.udp = null;
            udp?.close();
        });
        await this.#quietly("listeners", () => this.eventBus.removeListeners(this));
        // The strip must not be left in entertainment mode, or HA can no
        // longer control it.
        await this.#quietly("stream", () => this.stream?.stop());
        // Shutting the extension down is the same kind of indirect stream end
        // as switching the TV off: nobody asked for the strip to stay lit on a
        // frozen last frame. So it goes dark and the next start begins clean.
        // Forced, like every other off that leaves a stream: see `light`.
        if (streaming) await this.#quietly("off", () => this.light("OFF", true));
    }
}
