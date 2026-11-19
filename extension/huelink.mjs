/**
 * huelink - a zigbee2mqtt external extension that streams Philips Hue
 * entertainment frames (cluster 0xFC01) straight to a gradient strip, with no
 * bridge and no Bifrost in between.
 *
 * This file is the edge: the z2m transport, the UDP listener and the MQTT
 * state. The byte encoding is in lib/huepack.mjs, the stream lifecycle in
 * lib/huestream.mjs, the power/mode decision in lib/arbiter.mjs, the effect
 * catalogue in lib/effects/.
 *
 * Control is two things only: power, and exactly one mode (light / effect /
 * sync). "Off" is a RESET out of the stream and then a normal off, never a
 * black frame. Architecture and behaviour: docs/DESIGN.md. Wire format:
 * docs/PROTOCOL.md. Frame rate: docs/PACING.md.
 */

import dgram from "node:dgram";
import { statSync } from "node:fs";

import { HueStream } from "./lib/huestream.mjs";
import { Arbiter, FrameSource, MODE_EFFECT, MODE_LIGHT, MODE_OFF, MODE_SYNC, MODES } from "./lib/arbiter.mjs";
import { CONFIG, CONFIG_ERRORS, CONFIG_FILE, CONFIG_PATH, CONFIG_WARNINGS, loadConfig } from "./lib/config.mjs";
import { EffectEngine, loadEffects } from "./lib/effects/index.mjs";
import { t } from "./lib/i18n/index.mjs";
import { toFinite } from "./lib/num.mjs";
import { Pacer, TUNABLE } from "./lib/pacer.mjs";
import { MODE_BY_LABEL, MODE_LABEL, SETTABLE_KEYS } from "./lib/huelink-ui.mjs";

/**
 * One source, three consumers: the startup log line, the `huelink_version`
 * field on the z2m device page, and the retained `zigbee2mqtt/huelink` payload.
 *
 * It matters because `bridge/request/extension/save` reloads ONLY this file;
 * `lib/*.mjs` stays in Node's ESM cache until the container restarts. So "is my
 * change live" is a real question, and the only honest answer is a number the
 * loaded code prints itself. Bump it on every meaningful change here or under
 * `lib/`: a stale number is worse than none, it looks like an answer and lies.
 *
 * It is a literal rather than a read of `package.json` because z2m imports this
 * file from a temporary copy in its own data directory, where no `package.json`
 * of ours exists; any path we computed would be a guess that breaks on the one
 * machine that matters. Instead it is EXPORTED, and `test/version.test.mjs`
 * fails the build if it ever disagrees with `package.json`.
 */
export const VERSION = "1.1.0";

/**
 * When this Node process started, ISO-8601.
 *
 * `scripts/deploy.sh` needs to tell "z2m re-read the extension file" from "z2m
 * started fresh", because only the second reloads `lib/*.mjs`. The version
 * number cannot answer that: a cached `lib/` reports the same version as a new
 * one. Process uptime can, and nothing but a real restart can reset it.
 */
const STARTED_AT = new Date(Date.now() - Math.round(process.uptime() * 1000)).toISOString();

/*
 * Config comes from outside: fields, defaults and validation in lib/config.mjs,
 * values in `huelink.config.json` next to `configuration.yaml`. The `fps`
 * default is `maxFps`, itself derived from measured coordinator air time, not
 * chosen. See docs/PACING.md.
 *
 * Mode labels (`MODE_LABEL` / `MODE_BY_LABEL`) come from lib/huelink-ui.mjs, so
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
 * How long a command we published to the strip's own `/set` is recognised as
 * our own when z2m hands it straight back. See `#wasSelfSent`.
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
 * Entities that no longer exist in this model. An empty retained payload on the
 * discovery topic removes them from HA; without this the old standalone sync
 * switch would linger next to the mode select.
 */
const RETIRED = [
    ["switch", "sync"],
    ["sensor", "sync_status"],
    ["sensor", "source"],
    ["sensor", "mode"],
];

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
        /** `mtimeMs` of the config file when it was last read, or 0 for none. */
        this.configStamp = 0;
        /** Output state already APPLIED to the strip (off/light/effect/sync). */
        this.output = MODE_OFF;
        this.sending = false;
        // `CONFIG.fps` is only a target; how many frames the radio actually
        // carries depends on the air, so it is measured rather than assumed.
        this.sent = 0;
        this.fpsReal = 0;
        /** Consecutive failed frames; one success resets it. */
        this.failures = 0;
        /** `tick()` stays quiet until this time (backoff pause). */
        this.retryAt = 0;
        /** Mode the breaker tripped in, or `null`. While set, nothing is sent. */
        this.tripped = null;
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
         * Commands we published to the strip's own `/set`, waiting to be
         * recognised when z2m hands them back. See `#wasSelfSent`.
         */
        this.selfSent = [];
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
        // real frame. This deliberately does not read the TV state; HA already
        // owns that decision. See docs/DESIGN.md.
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
            if (leds) this.sources.sync.put(leds);
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
     * Re-read `huelink.config.json` and apply the pacer numbers from it.
     *
     * This exists because tuning is an experiment, and an experiment whose
     * every step costs a zigbee2mqtt restart is one nobody finishes. Save the
     * file, wait two seconds, watch the strip.
     *
     * ONLY `TUNABLE` is applied. That restriction is the whole safety
     * argument: those are plain numbers, each with a clamp, each read fresh on
     * the next frame, so swapping one mid-stream cannot leave anything half
     * changed. `segments` would resize a buffer the stream is writing into,
     * `udpPort` would need the socket rebound, `maxFps` would need the z2m
     * device definition rebuilt. Those are named in the log instead, which is
     * the honest version of applying them badly.
     *
     * The file is also the LOWER authority while running: `fps`, the delta
     * threshold and the duty cap belong to whoever last touched Home
     * Assistant, so the file sets them once at startup and is ignored here.
     * `occupancyBudget` is the exception in the other direction, because it
     * has no entity, only an MQTT command, and between a file a person edits
     * and a value sent by hand once, the file is the better owner.
     */
    reloadConfig() {
        const stamp = configMtime();
        if (stamp === this.configStamp) return;
        this.configStamp = stamp;
        // The file went away. Nothing to apply, and clearing the values back
        // to defaults would be a surprising reading of `rm`.
        if (!stamp) return;

        const { config, errors, warnings } = loadConfig();
        // A typo in a live edit is the most likely kind there is: this is the
        // path where someone is typing into a running system.
        for (const problem of errors) {
            this.logger.error(`[huelink] ${t("log.configProblem", { problem })}`);
        }
        for (const warning of warnings) {
            this.logger.warning(`[huelink] ${t("log.configWarning", { warning })}`);
        }

        const changed = this.pacer.tune(config);
        this.logger.info(
            `[huelink] ${
                changed.length
                    ? t("log.configApplied", {
                          fields: changed.map((key) => `${key}=${this.pacer[key]}`).join(", "),
                      })
                    : t("log.configSame")
            }`,
        );
        // Everything else that moved, named rather than silently ignored.
        // `CONFIG` is the snapshot this process started from, so this compares
        // the file against what is actually running. Stringified because
        // `udpAllowFrom` is an array and a fresh one is never `===` the old.
        const restart = Object.keys(CONFIG).filter(
            (key) => !TUNABLE.includes(key) && JSON.stringify(config[key]) !== JSON.stringify(CONFIG[key]),
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

    /** Effect names for the HA select. No "none": that is a mode, not an effect. */
    get effectOptions() {
        return this.effects.effects.map((e) => e.name);
    }

    /** One frame: the arbiter decides, the stream sends, a mode change starts/stops it. */
    async tick() {
        // Tripped breaker or backoff pause: the air stays free for the rest of
        // the house. Both checks come first so neither a frame nor a mode
        // change command leaves in those states.
        if (this.tripped || Date.now() < this.retryAt) return;
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
                this.pacer.reset();
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
                // Three levers in one call: pace, duty cap and delta
                // suppression. `null` means "do not send this frame" and is not
                // an error, so `failures` is left alone. See docs/PACING.md.
                const decision = this.pacer.decide(colors);
                if (decision) {
                    this.stream.setSmoothingMs(decision.smoothingMs);
                    const t0 = Date.now();
                    await this.stream.frame(colors);
                    // Send duration IS coordinator occupancy, which is what the
                    // budget measures, so it self-corrects as the coordinator
                    // slows. `decision.fast` is passed on because a scene cut
                    // runs off-beat: letting its short gap into the rhythm
                    // would shorten the fade of every ordinary frame after it.
                    this.pacer.noteSent(
                        decision.perceptual,
                        Date.now() - t0,
                        Date.now(),
                        decision.fast,
                    );
                    this.sent++;
                    // It went through: the strip answers, so earlier failures
                    // were transient and the counter starts from zero.
                    this.failures = 0;
                }
            } else {
                this.failures = 0;
            }
        } catch (e) {
            await this.onFailure(e);
        } finally {
            this.sending = false;
        }
    }

    /**
     * A failed Zigbee send. Two steps, not one: back off (200 ms -> 1 s -> 3 s)
     * because early failures are usually transient, then after `FAIL_LIMIT`
     * consecutive ones give up, stop the stream, turn the strip off and log a
     * single line. The strip goes OFF rather than to light, because the user
     * asked for sync and it ended; and `armed` is not set, because a failure is
     * not an idle source. See docs/DESIGN.md.
     */
    async onFailure(error) {
        this.failures++;
        if (this.failures < FAIL_LIMIT) {
            const i = Math.min(this.failures - 1, FAIL_BACKOFF_MS.length - 1);
            this.retryAt = Date.now() + FAIL_BACKOFF_MS[i];
            return;
        }

        const label = MODE_LABEL[this.arbiter.requested] ?? this.arbiter.requested;
        this.tripped = label;
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
        if (reachable) await this.light("OFF", true);
        this.output = MODE_OFF;

        this.logger.error(
            `[huelink] ${t("log.tripped", { mode: label, limit: FAIL_LIMIT, error: error.message })}`,
        );
        await this.publishState();
    }

    /**
     * Closes a tripped breaker. Called ONLY from an explicit command (power or
     * mode): that is the one moment someone demonstrably wants sending to
     * resume. A timer here would be wrong, it would start hammering an
     * unreachable strip by itself.
     */
    resume() {
        if (!this.tripped) return;
        this.logger.info(`[huelink] ${t("log.retrying", { mode: this.tripped })}`);
        this.tripped = null;
        this.failures = 0;
        this.retryAt = 0;
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
        this.selfSent.push({ payload, at: Date.now() });
        if (this.selfSent.length > SELF_ECHO_MAX) this.selfSent.shift();
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
            // Out of the dark back into the stream: power first, then the
            // stream. Frames go nowhere on an off strip, so a failed "on" must
            // stop here rather than start streaming into a dark strip.
            if (this.output === MODE_OFF && !(await this.light("ON"))) return false;
            await this.stream.start();
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
        if (this.tripped || Date.now() < this.retryAt) return;
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
        this.pacer.reset();
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
        // `MODE_BY_LABEL` is a Map on purpose; see lib/huelink-ui.mjs. With a
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
        this.pacer.reset();
        await this.settle();
        await this.publishState();
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
        if ("mode" in body) await this.setMode(body.mode);
        if ("effect" in body) {
            // Selecting an effect does NOT change the mode: it answers "which
            // effect", not "is an effect running". An unknown name is refused
            // rather than applied, because the engine would switch to "no
            // effect" and leave effect mode on but empty.
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
        // Every setter below REFUSES a value it cannot read, and a refusal is
        // said out loud. Silence would be the worst of both: the knob appears
        // to have been set, the published state disagrees with it, and nothing
        // anywhere says why. See lib/num.mjs for what counts as a number.
        if ("effect_brightness" in body) {
            this.#refused("effect_brightness", body.effect_brightness, this.effects.setBrightness(body.effect_brightness));
        }
        if ("effect_speed" in body) {
            this.#refused("effect_speed", body.effect_speed, this.effects.setSpeed(body.effect_speed));
        }
        // `fps` is adjustable from HA on purpose: only a person in front of the
        // TV can judge how smooth sync LOOKS, and what it COSTS is published
        // right next to it (`pacer.occupancyPct`). That trade is theirs.
        if ("fps" in body) this.#refused("fps", body.fps, this.pacer.setFps(body.fps));
        if ("occupancy_budget" in body) {
            // Percent on the wire, fraction inside. Parsed before the division
            // so `null` does not quietly become 0 %.
            const pct = toFinite(body.occupancy_budget);
            this.#refused(
                "occupancy_budget",
                body.occupancy_budget,
                pct !== null && this.pacer.setOccupancyBudget(pct / 100),
            );
        }
        await this.publishState();
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
        if ("huelink_fps" in body) {
            this.#refused("huelink_fps", body.huelink_fps, this.pacer.setFps(body.huelink_fps));
            touched = true;
        }
        if ("huelink_delta" in body) {
            this.#refused("huelink_delta", body.huelink_delta, this.pacer.setDeltaScale(body.huelink_delta));
            touched = true;
        }
        if ("huelink_duty" in body) {
            this.#refused("huelink_duty", body.huelink_duty, this.pacer.setDutyCap(body.huelink_duty));
            touched = true;
        }
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
        // The strip itself reporting, so this is the best answer there is to
        // "what power is it in", whoever caused it: us, HA, a wall switch.
        this.stripState = value;
        // A report that AGREES with the power already held is news about the
        // STRIP, not an instruction: most of them are the echo of our own last
        // command. Recorded above, because it is still the best answer to
        // "what power is the strip in", then dropped here. Until `setPower`
        // learned to cancel the arming on an unchanged power this made no
        // difference, as `setPower` returned immediately on the same
        // comparison; now the difference is whether our own OFF can cancel an
        // arming nobody asked it to.
        if ((value === "ON") === this.arbiter.power) return;
        await this.setPower(value === "ON");
    }

    /**
     * One human-readable line: what the strip is doing NOW. This used to be two
     * fields (`source` and `sync_status`) because there were two independent
     * switches; with one mode that question no longer exists.
     */
    status() {
        // Both reasons the strip went dark ON ITS OWN come first. Otherwise a
        // plain "off" would hide them, and the user would see a dark strip with
        // not a word about what happened.
        if (this.tripped) return t("status.tripped", { mode: this.tripped });
        if (this.armed === MODE_SYNC) return t("status.waitingTv");
        if (!this.arbiter.power) return t("status.off");
        if (this.output === MODE_EFFECT) return t("status.effect", { effect: this.effects.selected });
        if (this.output === MODE_SYNC) return t("status.sync");
        if (this.arbiter.requested === MODE_SYNC) return t("status.waitingTv");
        return MODE_LABEL.light;
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
    async publishExposes(stats = this.pacer.stats()) {
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
        const stats = this.pacer.stats();
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

    async #publishRetained(stats = this.pacer.stats()) {
        await this.mqtt.publish(
            CONFIG.name,
            JSON.stringify({
                /** See `VERSION`: the same number as in the log and the expose. */
                version: VERSION,
                /**
                 * When the Node process behind this code started. `version`
                 * cannot tell a re-read extension file from a fresh process,
                 * and only a fresh process reloads `lib/*.mjs`; this can, so
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
                effect: this.effects.selected,
                effect_brightness: Math.round(this.effects.brightness * 100),
                effect_speed: Math.round(this.effects.speed * 100),
                fps: this.pacer.fps,
                fps_real: this.fpsReal,
                // Pacer stats. Without them nobody can tell WHETHER
                // suppression is working: a drop in `fps_real` looks the same
                // whether frames are skipped on purpose or are failing.
                pacer: stats,
            }),
            { clientOptions: { retain: true } },
        );
    }

    /**
     * HA discovery: mode select, effect select, two knobs and the status. There
     * is deliberately NO power switch here: power is the strip's own HA `light`
     * entity, and a second switch beside it would mean two places to turn the
     * thing off.
     *
     * Discovery rather than hand-written HA entities, because every other
     * Zigbee device already arrives that way, and because the effect list comes
     * from `effects.json`: a manual entity would make each new effect an edit
     * in two places, and the HA half would fall behind.
     */
    async publishDiscovery() {
        const base = this.settings.get().mqtt.base_topic;
        const prefix = this.settings.get().homeassistant?.discovery_topic ?? "homeassistant";
        const device = {
            identifiers: [`huelink_${CONFIG.name}`],
            name: "HueLink",
            manufacturer: "gatisr/huelink",
            model: "Hue entertainment sender",
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
        const entities = [
            [
                "select",
                "mode",
                {
                    name: t("ha.mode"),
                    unique_id: `huelink_${CONFIG.name}_mode_select`,
                    state_topic: stateTopic,
                    value_template: "{{ value_json.mode }}",
                    command_topic: commandTopic,
                    command_template: '{"mode": {{ value | tojson }}}',
                    options: MODES.map((m) => MODE_LABEL[m]),
                    icon: "mdi:tune-variant",
                    device,
                },
            ],
            [
                "select",
                "effect",
                {
                    name: t("ha.effect"),
                    unique_id: `huelink_${CONFIG.name}_effect`,
                    state_topic: stateTopic,
                    value_template: "{{ value_json.effect }}",
                    command_topic: commandTopic,
                    command_template: '{"effect": {{ value | tojson }}}',
                    options: this.effectOptions,
                    icon: "mdi:auto-fix",
                    device,
                },
            ],
            [
                "number",
                "effect_brightness",
                {
                    name: t("ha.effectBrightness"),
                    unique_id: `huelink_${CONFIG.name}_effect_brightness`,
                    state_topic: stateTopic,
                    value_template: "{{ value_json.effect_brightness }}",
                    command_topic: commandTopic,
                    command_template: '{"effect_brightness": {{ value | int }}}',
                    min: 1,
                    max: 100,
                    step: 1,
                    unit_of_measurement: "%",
                    mode: "slider",
                    icon: "mdi:brightness-6",
                    device,
                },
            ],
            [
                "number",
                "effect_speed",
                {
                    name: t("ha.effectSpeed"),
                    unique_id: `huelink_${CONFIG.name}_effect_speed`,
                    state_topic: stateTopic,
                    value_template: "{{ value_json.effect_speed }}",
                    command_topic: commandTopic,
                    command_template: '{"effect_speed": {{ value | int }}}',
                    // 10-300 stays, and that is measured rather than assumed.
                    // Speed drives the effect's phase, not the send rate, so
                    // once the pace binds it saturates there: the bench shows
                    // the same 23.3 % occupancy at 50 % and at 300 % speed.
                    // Above ~50 % it buys no air time, only a different look.
                    min: 10,
                    max: 300,
                    step: 5,
                    unit_of_measurement: "%",
                    mode: "slider",
                    icon: "mdi:speedometer",
                    device,
                },
            ],
            [
                "sensor",
                "status",
                {
                    name: t("ha.status"),
                    unique_id: `huelink_${CONFIG.name}_status`,
                    state_topic: stateTopic,
                    value_template: "{{ value_json.status }}",
                    icon: "mdi:information-outline",
                    device,
                },
            ],
            [
                "sensor",
                "fps_real",
                {
                    name: t("ha.fpsReal"),
                    unique_id: `huelink_${CONFIG.name}_fps_real`,
                    state_topic: stateTopic,
                    value_template: "{{ value_json.fps_real }}",
                    unit_of_measurement: "fps",
                    icon: "mdi:speedometer-medium",
                    device,
                },
            ],
            [
                "number",
                "fps",
                {
                    name: t("ha.fps"),
                    unique_id: `huelink_${CONFIG.name}_fps`,
                    state_topic: stateTopic,
                    value_template: "{{ value_json.fps }}",
                    command_topic: commandTopic,
                    command_template: '{"fps": {{ value | int }}}',
                    // Was 5-25. Anything above ~6 was decoration: at the measured
                    // 51 ms per send even 7 fps needs 29 % occupancy, and 25 fps
                    // would need 128 %, which cannot happen. The slider showed
                    // numbers the hardware silently clipped; now it only shows
                    // reachable ones. The floor of 2 is a deliberate way to hand
                    // the coordinator back to the rest of the house. docs/PACING.md.
                    //
                    // The ceiling follows `maxFps` from the config rather than
                    // the built-in 5, for the same reason the number was 5 in
                    // the first place: a slider should only offer what this
                    // installation can actually deliver, and on a dedicated
                    // coordinator that is a different number. Read once, so a
                    // change to it needs a z2m restart like the z2m-side
                    // slider in lib/huelink-ui.mjs.
                    min: Math.min(2, CONFIG.maxFps),
                    max: CONFIG.maxFps,
                    step: 1,
                    unit_of_measurement: "fps",
                    mode: "slider",
                    icon: "mdi:filmstrip",
                    device,
                },
            ],
            [
                "sensor",
                "occupancy",
                {
                    // The one number that says whether Sync is hurting the rest
                    // of the house: the share of time the coordinator spends on
                    // strip frames. Above ~40 % other commands start queueing.
                    name: t("ha.occupancy"),
                    unique_id: `huelink_${CONFIG.name}_occupancy`,
                    state_topic: stateTopic,
                    value_template: "{{ value_json.pacer.occupancyPct }}",
                    unit_of_measurement: "%",
                    icon: "mdi:gauge",
                    device,
                },
            ],
        ];

        // With no effects loaded, a `select` with an empty option list is just
        // an error in the HA log, so the entity is simply not published.
        if (!this.effectOptions.length) {
            entities.splice(entities.findIndex(([kind, id]) => kind === "select" && id === "effect"), 1);
        }

        for (const [kind, id] of RETIRED) {
            await this.mqtt.publish(`${kind}/huelink_${CONFIG.name}/${id}/config`, "", {
                baseTopic: prefix,
                clientOptions: { retain: true },
            });
        }

        for (const [kind, id, cfg] of entities) {
            await this.mqtt.publish(
                `${kind}/huelink_${CONFIG.name}/${id}/config`,
                JSON.stringify(cfg),
                { baseTopic: prefix, clientOptions: { retain: true } },
            );
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
