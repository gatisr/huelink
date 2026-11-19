# Design

How HueLink is put together and why it behaves the way it does.

## What this is

HueLink drives a Philips Hue gradient light strip directly from zigbee2mqtt, using the strip's own Entertainment streaming mode. No Hue bridge, no Hue account, no cloud.

The alternative was a bridge emulator. Bifrost is roughly 27k lines of Rust, and about 85% of that is emulating a bridge: DTLS handshakes, REST resources, user registration, discovery. HueLink skips all of it. zigbee2mqtt already has the Zigbee link to the strip; the only missing piece was the ~55-byte frame format the strip expects while streaming. That piece is `lib/huepack.mjs`, and it is small. See [PROTOCOL.md](PROTOCOL.md).

## Module split

| File | Responsibility |
| --- | --- |
| `extension/huelink.mjs` | The z2m extension: lifecycle, MQTT, HA discovery, the tick loop |
| `lib/huepack.mjs` | Pure frame encoding. No I/O, no state. See [PROTOCOL.md](PROTOCOL.md) |
| `lib/huestream.mjs` | Stream lifecycle: start, frame, reset. Owns the Zigbee send |
| `lib/arbiter.mjs` | Decides what the strip should be doing right now |
| `lib/pacer.mjs` | Decides whether this frame is worth sending. See [PACING.md](PACING.md) |
| `lib/huelink-ui.mjs` | Field names shared with the external converter |
| `lib/config.mjs` | `huelink.config.json` loading and validation |
| `lib/i18n/` | Every human-visible string |
| `lib/effects/` | Effect catalogue and generators. See [EFFECTS.md](EFFECTS.md) |
| `converter/huelink-exposes.mjs` | Adds the `huelink_*` fields to the z2m device page |

The split is along the axis of "can this be tested without a radio". `huepack` and `pacer` are pure functions over data and carry the two pieces of knowledge that were expensive to acquire. `huelink.mjs` is the only file that touches MQTT, UDP or the Zigbee stack.

## Two controls, not three

The strip is controlled by exactly two things:

- **Power** — the strip's own HA `light` entity. On or off.
- **Mode** — `select.huelink_mode`: Light, Effect or Sync. Exactly one at a time.

Choosing an effect is **not** a third switch. The effect list has no "None" option, because "no effect" is already a mode. A third independently switchable thing is how you end up with two of them on and one of them silent, with no way to tell which.

This logic lives here and in the arbiter, never in the Lovelace card. A card is one of several front ends; automations, voice and a wall switch must all get the same behaviour.

## The arbiter

`lib/arbiter.mjs` holds one power flag, one requested mode, and a set of frame sources. `pick()` returns what the strip should actually be doing.

The earlier model was a priority list: a `syncEnabled` switch plus a separately chosen effect, with sync winning. Priority answers "who transmits" but it does not answer "how do I get out of here". With three independently switchable things, two could be on with one silent, and the only way to find out which was to try them.

Two rules make the model work:

- **Light is not a source.** It is the name of the state where no stream source is writing. The strip is lit by its own normal Zigbee state, not by frames.
- **An empty stream is not light.** If Sync is selected but no UDP packets are arriving, `pick()` returns `off`, not `light`. The user asked for the screen, not for a lamp.

Source liveness is a TTL (`sourceTtlMs`, default 1000 ms). Hyperion's `udpraw` output has no "stream ended" signal, so silence is the only signal there is.

## "Off" means a dark strip, not a black frame

Sending `rgb(0,0,0)` at 12 fps is not an off strip. It is a lit light displaying black, and it keeps the strip in entertainment mode, where it ignores ordinary Zigbee commands — including HA's own off button.

So the transition to `off` is always two steps, in this order:

1. `CMD_RESET` — leave the stream.
2. `state: OFF` — a normal z2m command.

The reset is retried until it succeeds, and the state is not declared off any earlier. Doing it the other way round leaves a strip that HA thinks is off and that will not respond to anything.

## armed vs tripped

Two different kinds of "not transmitting right now", and conflating them was a real bug.

- **armed** — the source went quiet but the user's selection still stands. The strip is dark; incoming frames re-light it with no command. Example: Sync is selected, the TV is paused, Hyperion stops sending. Nothing is wrong.
- **tripped** — the strip itself stopped answering. The circuit breaker opened after `FAIL_LIMIT` consecutive send failures, with backoff `FAIL_BACKOFF_MS = [200, 1000, 3000]`. Only an explicit command resumes it; frames alone will not, because frames are exactly what was failing.

The distinction is visible from outside: `huelink_status` shows `"<mode> stopped: strip not answering"` when tripped. Without that line, a deliberately dark strip and an unreachable strip look identical.

The breaker exists because a failed Entertainment frame consumes the full coordinator SRSP window (up to 6 s). Five of those in a row and the whole Zigbee network stops responding, not just the strip.

## When the stream ends by itself, the strip turns off

Not "falls back to Light". A user who chose Sync ordered synchronisation with the screen. A lit strip is a different outcome, and it was not ordered.

The boundary is drawn between indirect and direct:

- **Indirect** stream end (source went quiet, TTL expired, breaker tripped) leads to `off`, delivered as a normal z2m command. A black frame would leave HA showing "on", which is a lie about the state.
- **Direct** user action (power button, mode choice) is executed literally and turns nothing extra off.

`armed` and `tripped` are what hold that boundary.

## Behaviour after a restart

On start the extension comes up **off, and armed on Sync** — never on Light:

```js
this.arbiter.power = false;
this.arbiter.requested = MODE_LIGHT;
this.armed = MODE_SYNC;
```

A container restart is not a user action, so it must not look like one.

This used to be `requested = MODE_LIGHT` with the mode published immediately. HA saw `Light`, concluded sync was off and cut Hyperion's capture. A restart in the middle of playback would then kill the very sync that was running, and an automation keyed on "TV turned on" never re-fires, because the TV is already on. The strip would stay dark until somebody picked Sync again by hand.

This file deliberately does **not** read TV state. HA already does: capture runs if and only if Sync is selected and the TV is on. A second reader would be a second source of truth, and they would disagree.

On start the extension also sends an unconditional `stream.reset()`. If the previous process died mid-stream, the strip is still in entertainment mode and would otherwise ignore everything.

## Startup settle window

After `start()` the extension waits `startSettleMs` (default 2000 ms) before the first tick, so that command echoes from its previous life have time to finish. That is about 10× the normal echo path, and it is invisible in practice: Hyperion's capture takes ~7 s to come up anyway.

## Reading the delta, not the cache

Strip state is written only through `publishEntityState`. The direct `state.set` + `mqtt.publish` path bypasses `adjustMessageBeforePublish` and `filtered_attributes`, which means the published state quietly stops matching what the rest of z2m believes.

But the extension also *listens* to entity state, to notice the user pressing the power button. Its own publish comes straight back. The event carries two things: `payload`, what changed in this publish, and `message`, the whole merged state cache. `onEntityState` reads **`payload.state`**. That is the only correct read, and it is what makes the listener safe:

- A `huelink_*` field update carries no `state` in its payload, so it cannot be mistaken for a power press. Reading `message.state` instead meant every field update replayed the strip's *cached* power as if it were a fresh command.
- A genuine press, from anywhere, always arrives as a delta containing `state`, so nothing real is missed.

An earlier design guarded this by identity instead: `publishExposes` parked its payload object in `this.echoPayload` and the listener muted that one object. It could not work. The slot is single and `publishExposes` overlaps itself (the 20 ms tick publishes while a command-path publish is still awaiting), so a second call overwrote the slot, and `finally` cleared it before the first echo came back at all. Both misses turned one `huelink_*` update into a power press carrying a stale `state`.

The consequence was not cosmetic. The wrong power flipped the output, the next tick sent the opposite light command to put it right, that command's echo flipped power back, and the strip oscillated ON/OFF indefinitely, at roughly two flips per second, until the mode was changed by hand. Reading the delta needs no bookkeeping and cannot race.

## A restart is not an event

Reading the delta is necessary and not sufficient. z2m's `advanced.cache_state_send_on_startup` (on by default) walks every device at startup and republishes its **whole** cached state, so for that one publish the delta *is* the cache, `state` and all. A strip that was lit before the restart therefore announces `state: "ON"` a moment after `start()` has decided the opposite, and nothing in the payload says it is old news.

The publish does carry a `stateChangeReason`, and for this one it is `publishCached`. `onEntityState` returns on it, before any bookkeeping: nothing changed, and what it replays is *older* than the `OFF` that `start()` already has in flight. Taken as a press it both lit the strip and cleared the `sync` arming, which is the worst of both — the strip is on for no reason and the television can no longer turn it on for a reason.

## Never say what the strip already knows

`light()` goes through z2m's `/set` so the state stays true everywhere, and the price is an echo back into `onEntityState`. That echo is harmless while exactly **one** command is in flight: it describes the state we already hold, and `setPower` does nothing.

With two in flight the arithmetic reverses. Every echo now describes a *past* command, so it always disagrees with the current power, flips it, and that flip sends the opposite command, whose echo flips it back. Nothing damps it, because each echo manufactures the next command. Live, after the restart above: 1213 commands in 65 s, about 15 a second.

So `light()` keeps `stripState` — the power the strip was last told to take, or last reported to be in — and refuses to send a command that matches it. The loop needs an echo to produce a new command; now it cannot, and an off/on race settles in two steps instead of running until something else interrupts it. This is a different question from `this.output`, which is the *mode*, and the two are kept separate on purpose: `applyOutput` may legitimately want the strip lit in three different modes.

## Settling before publishing

`this.output` is what has actually been applied to the strip, and `applyOutput` is the only place it changes. The arbiter's *decision* changes earlier, in `setPower` / `setMode`. If a command handler published between the two, it published a state that contradicted itself: `power: "OFF"` next to `output: "light"`, with the `status` line derived from the same stale output.

So both handlers call `settle()` first: carry out the decision, *then* publish. That is deliberately not "defer the publish to the next tick" — the point is that HA hears back immediately, and now the strip reacts to the command rather than to a timer.

A tick may be holding the radio, and the two must not send at once. `settle()` *waits* for it, briefly and with a bound; it does not stand aside. Standing aside was the first attempt, and it was not enough: eleven minutes of live switching still produced `power: "OFF"` next to `output: "effect"`, because effect mode sends often enough that an off command regularly lands mid-frame. The bound matters too — a strip that stopped answering must not hold a command handler open, and past it the tick publishes the correction anyway.

### What `output` on the wire means

Settling fixes the ordering, not the waiting. Live, the gap between an off command and the reset actually reaching the strip was **nine seconds**: the coordinator was still draining the entertainment frames already in flight, and no bound a command handler could sanely keep would cover that.

So the published `output` is not `this.output`. The two are different facts:

- `this.output` is what the strip has been **told**. `applyOutput` keeps it so it knows the reset still has to go out, and retries if a send threw.
- the published field means **what is being sent**, and the arbiter stops offering frames the instant power goes false.

`publishState` therefore publishes `arbiter.power ? output : off`. That is not an optimistic guess about the strip; it is the accurate answer to the question the field asks. The strip may still be lit for a moment, and `status` says so.

## The tick loop

`tickMs` (default 20 ms) is the loop period, not the frame rate. The loop runs faster than frames go out so that a fast scene change is noticed immediately rather than at the next frame boundary. How many frames actually leave is the pacer's decision — see [PACING.md](PACING.md).

Each tick:

1. Bail out if tripped or in backoff.
2. Bail out if a send is still in flight (`sending` reentrancy guard).
3. If armed and a source is live, resume.
4. In effect mode, pull a frame from the engine. Effects are pulled, not pushed, so a stalled loop cannot build a queue.
5. `arbiter.pick()`.
6. If the result is `off` while power is on, turn power off. The invariant is "dark strip ⟺ power off", with no third state.
7. On a mode transition, order matters:
   - into off: `stream.stop()` then `light("OFF")`
   - into light: `stream.stop()` then `light("ON")`
   - into streaming: `light("ON")` then `stream.start()`
8. `pacer.decide()`; if it says send, `setSmoothingMs()`, `frame()`, then `noteSent()`.

## Versioning

`VERSION` in `huelink.mjs` has one definition and three consumers: the startup log line, the `huelink_version` field on the z2m device page, and the retained `zigbee2mqtt/huelink` payload.

It matters more than usual here. z2m's `bridge/request/extension/save` reloads **only the top-level file**; everything under `lib/` stays in the Node ESM cache until the container restarts. So "I saved it and nothing changed" is a normal, expected outcome, and the version field is how you tell which code is really running. Bump it on every meaningful change.

## Configuration

Everything installation-specific lives in `huelink.config.json`, next to `configuration.yaml`. The code is identical for everyone; only that one JSON differs. `HUELINK_CONFIG` overrides the path, for tools and tests.

The path is resolved from the module's own location, not from `process.cwd()`: z2m loads external files by copying them to a temp file **in the same directory**, so relative paths survive while the working directory is z2m's.

A missing file means defaults, so the extension loads straight after install and you can see the UI you need in order to configure it. An invalid field is loud — it is a typo, and silently falling back to a default looks exactly like a working configuration. Errors collect in `CONFIG_ERRORS` and are printed with the field name at startup.

## Retired entities

`RETIRED` lists HA discovery entities from earlier versions (`switch.sync`, `sensor.sync_status`, `sensor.source`, `sensor.mode`). They are blanked with empty retained payloads on start. Without that, a stale retained discovery message leaves a dead entity in HA forever.

## MQTT surface

Three topics, all relative to the z2m base topic (`zigbee2mqtt` by default). `<name>` is `CONFIG.name`, `<strip>` is `CONFIG.device`.

**`<base>/<name>` — retained state, published by the extension.**

```json
{
  "version": "1.0.0",
  "power": "ON",
  "mode": "Sync",
  "output": "sync",
  "armed": null,
  "status": "Sync",
  "effect": "Mood: Bonfire",
  "effect_brightness": 100,
  "effect_speed": 100,
  "fps": 5,
  "fps_real": 4.8,
  "pacer": { "occupancyPct": 23.3, "skippedDelta": 0, "skippedDuty": 0, "...": "..." }
}
```

`mode` is what the user **chose**; `output` is what is actually being sent right now. In sync with no TV they differ, and that is the point: two fields, two questions. `armed` is what a dark strip is waiting for, `null` most of the time; without it, "off" and "off but armed" look identical from outside.

**`<base>/<name>/command` — commands, JSON body.** Recognised keys: `power` (`ON`/`OFF`/`TOGGLE`), `mode`, `effect`, `effect_brightness`, `effect_speed`, `fps`, `occupancy_budget`. Unknown keys are ignored; an unknown effect **name** is refused rather than applied, because the engine would otherwise switch to "no effect" and leave effect mode on but empty.

The suffix is `/command` and not the more obvious `/set` on purpose. z2m's own publish extension routes every topic matching `<base>/(?!bridge)(.+?)/(get|set)` and resolves the captured name as a Zigbee entity. `<name>` is a virtual topic served by this extension, with no device behind it, so the core found nothing and logged `error: Entity '<name>' is unknown` on every single command. Any suffix outside that pattern is ignored by the core and still reaches the extension, because the core subscribes to `<base>/#` and hands every message to the event bus.

**`<base>/<strip>/set` — the strip's own topic**, which the extension also listens on, for two reasons:

1. **Power.** The HA light button, an automation or a voice command lands here. Without interception the user hits a dead end: mid-stream a `state: OFF` does reach the strip, but the next frame ~70 ms later overwrites it, so the button "works" and the light stays on. Turning the light off is a command to the arbiter, not to the bulb.
2. **The `huelink_*` knobs** from the z2m device page, which z2m puts on this same `/set`.

The attribute form `<base>/<strip>/set/<field>` with a bare value is accepted too, for `huelink_*` keys only: that is the form the HA discovery z2m generates for the extension's own exposes uses. Without it the fields would work on the z2m page while the matching HA entities silently did nothing.

So the same knob can be turned from HA and from the z2m page and both reach the same call, rather than two copies free to drift apart.

HA discovery is published under `<discovery_topic>/<kind>/huelink_<name>/<id>/config`.

## The z2m device page

`converter/huelink-exposes.mjs` is an external converter that adds the `huelink_*` fields to the strip's own z2m device page, so the running version and the main settings are visible without opening Home Assistant.

What it must never do is replace the Philips definition. The stock `extend` (light, brightness, colour, colour temperature, gradient, effects, identify) is left untouched and our fields are appended **after** it. If light control broke, this would be worse than nothing — that is the one thing to check after any change in that file.

How it holds together:

- `zigbee-herdsman-converters`' `processExtensions` **concatenates** the `exposes` and `toZigbee` of every `extend` element rather than overwriting them. So we append one more modern-extend element at the **end** of the stock list, and our fields land after the light in the UI, not in front of it.
- `findDefinition` puts external candidates **before** built-in ones, so this definition wins the LCX002 lookup.
- No `version` field is set. Without one, `processExtensions` fills in `0.0.0`, which matches `meta.configured` in `database.db`, so z2m does **not** reconfigure the strip. Bumping a version here would mean a full `configure()` cycle over the air for no gain.
- The cross-folder import works because z2m loads external files by copying them to a temp file **in the same directory**, so relative paths survive. If it ever stopped working, z2m renames the file to `.invalid`, the strip falls back to the stock definition and light control stays intact — the safest possible failure mode.

The converter declares only the **shape** of the fields. Values are published by the extension (`publishExposes`), and writes are picked up over the eventBus from the same `/set` message. The field list itself lives in `lib/huelink-ui.mjs`, so names and ranges are written once and cannot drift.

`convertSet` deliberately returns nothing. If it returned `{state: ...}`, z2m would optimistically publish the strip's state by itself; the extension reads every published strip state as "someone just toggled power" (`onEntityState`), and exactly that kind of foreign echo once dropped the mode to light in the middle of a stream. Only the extension publishes, and only behind its own echo guard.

The entities are created **disabled** in HA on purpose: the strip already has a full HueLink control set there as its own device, and a second set next to the light would be two places to set the same thing differently. In the z2m UI they are always visible, which is the whole point of the file.

The z2m field list is deliberately shorter than the HA one. It answers "what version is running and what is it doing now", plus the four screws worth turning from there; the full diagnostic surface belongs in HA. `access` is written as plain numbers (`1` = read only, `3` = read/write) rather than zhc constants, because the same field list is imported by the extension, which must not depend on `zigbee-herdsman-converters` at all.

## i18n

Everything a human reads is a key, resolved through `lib/i18n/`: log lines, HA entity names, status strings, z2m field labels and descriptions, effect names.

`en.json` is the base and the only complete file. A locale file is an **overlay** on top of it, so a missing key falls back to English rather than rendering as a blank or a key name. `t(key, params)` does `{placeholder}` substitution only; no pluralisation rules, because no string here needs them.

Effect names are the one exception to the "strings live in i18n" rule: they stay in `effects.json` as `{ "en": ..., "lv": ... }` maps next to the effect they name. An effect is data, and a name you have to go and register in a second file is a reason not to add effects. The i18n parity test reads those maps directly.

Strings that go on the wire are **not** translated: MQTT keys, mode values, `ON`/`OFF`, effect ids. Translating those would make a locale change rewrite the API.
