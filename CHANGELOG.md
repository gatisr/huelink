# Changelog

All notable changes to HueLink are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

`VERSION` in `extension/huelink.mjs` and `version` in `package.json` are the same number and are bumped together.

## 1.4.0

Your own preset and your own effect, set up in Home Assistant and kept across a restart. One brightness for every mode.

### Added

- **Custom preset.** Moving any picture slider makes the selection Custom; choosing Custom later brings those values back. Nothing to save.
- **Custom effect**, last in the effect list. Pick a style (Wave, Breathe, Flame, Chase, Pulse, Twinkle, Strobe, Solid) and colours: those of a built-in effect, or your own (up to 8).
- **Own colours from the phone:** pick a colour on the strip's light card, press "Add the strip's colour". Or type them: `#ff0000 #00ff88`.
- **Choices survive a restart:** selected preset and effect, effect speed, Custom preset, custom effect. Kept in `huelink.state.json` next to the config file.
- **Brightness on the HueLink device.** The same value as the light card, but it does not interrupt a stream (frames are dimmed, the strip gets no command) and does not switch a dark strip on.

### Changed

- **The strip's own brightness now dims effects and sync too.** The light card's slider is the one brightness.
- "Effect brightness" is removed (HA entity and `effect_brightness` command key).
- The preset select shows Custom instead of nothing when no preset matches.
- **Three HA devices instead of one:** HueLink (mode, brightness, status), HueLink Sync (preset and picture tuning), HueLink Effects (effect and the custom effect). Entity ids are unchanged.
- Saturation and the custom effect entities are controls, not configuration.
- A saved preset wins over the config file's starting values at start. Delete `huelink.state.json` to go back to them.

### Notes

- Mode and power are not restored: after a restart the strip is off and waits for the TV, as before.
- If the strip was left dim as a light, effects and sync are dim too: raise the light's brightness.
- Changing brightness on the strip's **light card** while streaming also reaches the strip itself and may show its ordinary light for a moment; the next frame is sent at once to keep that short. HueLink's own Brightness does not. Not yet confirmed on a strip.
- Reload the MQTT integration after upgrading: HA reads an entity's category and device when it registers it.
- `huelink-lib/` changed: restart zigbee2mqtt. `huelink_version` shows 1.4.0 when it has.

## 1.3.4

The Home Assistant Mode select can now turn the strip off, and the light entity reads "on" while the strip streams. Its entities are also easier to build dashboards on.

### Fixed

- **A tap on the light card no longer flashes a streaming strip.** The entity read "off" during sync/effect (1.3.3), so the tap sent an "on", which the strip shows as its last ordinary colour.
- The entity now reads "on" while streaming. z2m/HA are told directly; the strip still gets no "on".
- One tap on the card turns a streaming strip off.

### Added

- **"Off" in the Mode select** (HA only): Off / Light / Effect / Sync in one control.
- Off sends the existing power off; the other options are unchanged.
- The select shows Off whenever the strip is off and not waiting for the TV. It used to show Light.
- **Activity sensor** (diagnostic): `off` / `light` / `effect` / `sync` / `waiting` / `tripped` / `gave_up`. The same fact as Status, as a fixed word for card conditions and automations.
- **Availability**: every entity reads "unavailable" while zigbee2mqtt is down.
- **Stable entity ids** on a new install (`select.huelink_mode`, ...), the same in every language.
- Version on the HA device page; long-term statistics for fps and coordinator load.
- README: a ready Lovelace example.

### Changed

- One command with `mode` and `effect` now selects the effect first, so the mode starts on it.
- **Normal is now Games at 3 fps**, and so are the shipped defaults: fps 3, fade 1.05, cut threshold 4, cut fade 20 ms, 4 cuts/s, saturation 105 %. Budget stays 0.35.
- Quicker on scene cuts, with the same or lower coordinator load (measured, docs/PACING.md "Default since 1.3.4").
- **Four presets instead of six**, each a visibly different behaviour: Normal, Calm (slow soft fades, lowest load), Dynamic (fastest, flashes come through, highest load), Vivid (Normal with saturation 150 %).
- Movies, Sports, Games and Music are gone: Calm replaces Movies, Dynamic the other three. No preset raises the air budget any more.
- English names of the two Latvian state holidays say so: "Latvian Remembrance Day", "Latvian Independence Day". Latvian names are unchanged.

### Notes

- Sync still shows while the strip waits for the TV, so capture automations on Mode = Sync are unaffected.
- An automation that expects Mode = Light on an off strip now sees Off.
- The z2m page and the `mode` field on the state topic are unchanged.
- An explicit "on" (voice, automation) to a streaming strip still flashes: z2m forwards it.
- Needs Home Assistant 2025.10 or newer (`default_entity_id`).
- The new defaults apply on restart unless `huelink.config.json` sets those fields. Pick Normal in HA to apply them without one.
- With `locale: "en"`, automations that select the two renamed effects by name need the new names.
- Automations that select Movies, Sports, Games or Music need the new preset names.
- Existing installs keep their entity ids. Delete the HueLink device in HA and restart zigbee2mqtt to get the new ones.
- `huelink-lib/` changed: restart zigbee2mqtt. `huelink_version` shows 1.3.4 when it has.

## 1.3.3

Sync and effects no longer flash the strip's ordinary light when they start, including after a trip in the middle of a film.

### Fixed

- **No "on" when entering sync/effect.** The strip obeys an "on" even while streaming and shows its last ordinary colour until the next frame. Tested on the strip: frames light an off strip by themselves, so the "on" was never needed. The light entity in z2m/HA now stays "off" while the strip streams.

### Upgrading

- Only `huelink.mjs` changed: saving the extension is enough. `huelink_version` shows 1.3.3 when it has loaded.

## 1.3.2

A strip that is really gone is no longer retried for ever. Endless retries against an unreachable strip can jam the whole Zigbee network.

### Changed

- **Auto-reopen stops after 3 trips in a row without a recovery** (`MAX_AUTO_TRIP_STREAK`), i.e. after two automatic retries. A retry is only used up when a source actually sends frames and they fail; a reopen with the TV off costs nothing. The breaker then stays shut until a person resumes it (power on or any mode command).
- **A recovery now takes 20 accepted frames in a row** (`RECOVERY_FRAMES`), not one. A strip that takes a single frame after each reopen and then fails again no longer resets the ladder and is no longer retried for ever.
- **A command (power on, any mode) no longer resets the retry ladder; only a recovery does.** An automation that re-sends the mode looks the same as a person, and re-sending it faster than the dwell must not keep a dead strip from ever giving up. After the give-up a command therefore buys one try, not a fresh ladder.
- **Power off while tripped closes the trip**: the status reads Off instead of "not responding" for as long as the strip stays off. The ladder is kept, so a still-dead strip gives up on its next trip.
- The 1 h dwell cap (`TRIP_DWELL_MAX_MS`) is gone: with the retries bounded it could no longer be reached.
- The give-up is logged once (`log.autoRetryGaveUp`) and shown in the HA status (`status.trippedManual`), instead of the ordinary "not responding" text.
- Internal: the breaker's trip and retry ladder moved to `huelink-lib/breaker.mjs`, the HA discovery entity table to `huelink-lib/discovery.mjs`. `huelink.mjs` keeps the orchestration and the publishing.

### Added

- `breaker` in the state (`closed` / `tripped` / `gave_up`) and an HA binary sensor "Strip needs attention" (`problem`, diagnostic) that is on after the give-up. Automations can use it instead of matching the translated status text. It stays on through a power off or a manual try and clears only after a proven recovery (20 accepted frames, or the strip acking a power on), so an "everything off" automation cannot hide a dead strip. It is not persisted: a z2m restart clears it.

### Notes

- `huelink-lib/` changed (i18n, two new modules): restart zigbee2mqtt. `huelink_version` shows 1.3.2 when it has.

## 1.3.1

A strip that freezes for a moment and then catches up now says so, and says why. The stall watch only observes and logs; the one behaviour change is the per-send charge cap under "Changed".

### Added

- **`the picture reached the strip N ms late`** log line, written by the next frame that gets through after a gap. It splits the lost time into `send`, `backoff` (pause after a failed frame), `budget` and `window` (the pacer's own limits, logged at info). The fps clock and an unchanged picture are never counted. See `huelink-lib/stallwatch.mjs`.
- **Failed frames below the breaker threshold are logged**, with the error text. They used to freeze the strip for 200 ms to 3 s each with nothing in the log.
- Stall lines are limited to one per kind per 10 s, with the number left out appended. `pacer.stalls`, `pacer.worstStallMs`, `pacer.sendFailures`, `pacer.skippedWindow` and `pacer.skippedBudget` are published (`pacer.skippedDuty` stays, as their sum).

### Changed

- **One send can no longer fill the occupancy meter.** A single send is charged at most 250 ms to the budget meter, the measured price and the burst bucket (`MAX_CHARGE_MS`). A 6 s `SRSP` stall used to hold every frame back for a second, make `avgSendMs` read 4x too high and fire a false "frame cap asks for N fps" warning. Ordinary sends (p90 238 ms) are charged in full. `worstSendMs` is still the real, uncapped time.

### Notes

- See `docs/PACING.md`, "Latency spikes and the occupancy meter".
- `huelink-lib/` changed: restart zigbee2mqtt, hot reload will not pick it up. `huelink_version` shows 1.3.1 when it has.

## 1.3.0

More controls in Home Assistant, picture presets, saturation, and a breaker that retries on its own. **Nothing moves on its own**: every default is the value it already was, saturation ships at 100 % (bit-identical to 1.2.0 output), and no preset is selected until someone picks one.

### Added

- **Five sliders**, live with no restart, on the z2m device page and on the HueLink device in HA: `huelink_budget` (air budget, 5-90 %), `huelink_smoothing`, `huelink_cut_threshold`, `huelink_cut_ms`, `huelink_cut_per_sec`. Each is also a config field, but the file now only sets the **starting** value (the sliders own it while running; a save that changes one is named in the log). The budget and the four reaction-time sliders (`cut_*`, smoothing) are disabled by default in HA (the budget takes coordinator time from other Zigbee devices); enable them on the entity page if you want them.
- **`huelink_saturation`** slider, 50-200 %, and `saturation` in the config. `c' = luma + (c - luma) * s` on sRGB bytes; grey and black stay put, and 100 % returns the input untouched. It costs the coordinator nothing.
- **`huelink_preset`**: Normal, Movies, Sports, Games, Music, Vivid. One pick sets the seven picture knobs; the sliders keep working afterwards. "Normal" equals the shipped defaults. When the live values match no preset the select shows no value (derived, never stored). Presets are data in `extension/huelink-lib/presets.json`; a bad entry is logged and skipped. A preset asking for more fps than `maxFps` allows is trimmed and the log says so. Presets never touch `dutyCap`. Preset names are fixed English (the same on every `locale`), so automations that select one by name keep working.
- **"Deliverable frame rate"** diagnostic sensor, and a log line when the frame cap asks for more than the duty cap or air budget can pay for. `maxFps` can be raised (e.g. 25) and the slider reaches it; raising it alone changes nothing.
- **Grouping.** Main view: Mode, Preset, Effect, Effect speed, Status. Pacing knobs are `config`, readings are `diagnostic`; one table in `huelink-lib/huelink-ui.mjs` serves both the z2m page and our discovery payloads, and an unclassified field throws at startup. `Effect brightness` is now `config`.
- **`via_device`** links the HueLink device to the strip's z2m device.

### Fixed

- **A tripped breaker no longer waits for ever.** A switched-off strip is silent, so a proof-of-life listener alone never reopened it (observed: tripped for 2 h). The 5 minute dwell is now a timer in `tick`, and the listener is gone: it waited on the same dwell, so it could never fire earlier. Each retry that trips again doubles the wait, up to an hour; one frame through resets it.
- A missing saturation value in an MQTT payload no longer desaturates the strip (`toFinite`, not `Number`).
- `huelink_status` was a diagnostic on one surface and a plain sensor on the other.

### Changed

- **`extension/lib/` is now `extension/huelink-lib/`.** z2m loads extensions from one shared directory, so a generic `lib/` could collide with another extension's. Imports, `deploy.sh`, tests, tools and docs follow.

### Upgrading

- **Remove the old `lib/`** from `external_extensions/` after deploying (`deploy.sh` copies, never deletes, because the directory may hold other extensions). Only do it if nothing else uses it. Restart z2m: hot reload does not re-read library files.
- `deploy.sh` copies, never mirrors: a file renamed or deleted in `huelink-lib/` stays on the target until you remove it.
- The presets and sliders can raise the air budget, which takes coordinator time from every other Zigbee device. Use them at your own risk and watch the Zigbee network closely.

Reload the MQTT integration once (or restart HA): HA reads `entity_category` only when it registers an entity.

## 1.2.0

The strip no longer strands itself dark, and follows a capture card that keeps sending black only as long as there is something to show.

### Added

- **A black gate on the sync source.** Some capture cards keep sending black frames after their input stops, so "the TV is off" never arrives. Frames whose every channel is at or below 16 are dropped once they have been unbroken for 20 seconds, and one lit frame ends the run. The source then ages out through the path it already had for a source that stopped.
- **A tripped breaker reopens by itself.** A trip clears the arming on purpose, but nothing used to restore it once the strip recovered. zigbee2mqtt already reports every Zigbee frame it hears from the strip, so that report now closes the breaker, and nothing extra is sent on the air. What returns is the waiting, not the light: the mode is re-armed and the strip comes back when frames do. A five minute floor limits a strip that answers but refuses frames to one re-trip per five minutes.

### Fixed

- **Our own `OFF` no longer cancels the arming it caused.** A source that goes quiet and returns within a second sends `OFF`, arms sync and is back `ON` before the `OFF` report arrives. The report was then read as a person pressing off, and the strip stayed dark with frames arriving. Power commands we send are now recorded and recognised when they are reported back; a report nobody here caused (wall switch, Home Assistant) still cancels the arming.
- **The two black-gate log lines are translated.** They need a full zigbee2mqtt restart to take effect, not an extension reload.

## 1.1.0

Tuning without editing code. Every pacing number that used to be a constant is now a field in `huelink.config.json`, most of them re-read while zigbee2mqtt runs. **Nothing changes for an installation that does not touch the file**: every default is the value the constant had, the new burst ships off, and `test/tuning.test.mjs` holds that line three independent ways.

### Added

- **Ten new settings**, all optional: `maxFps`, `dutyCap`, `smoothingFactor`, `bigChangeThreshold`, `fastSmoothingMs`, `maxFastPerSec`, `burstFps`, `burstMaxMs`, `burstCreditMs`, `burstRefill`. Documented field by field in the README and `huelink.config.example.json`, each with its default and its range.
- **Live reload.** The settings file is checked every two seconds and the pacer numbers in it are applied without a restart: save, wait, watch the strip. Only plain numbers with clamps are applied this way; anything needing a restart is **named** in the log instead of appearing to have been taken.
- **A configurable fps ceiling.** `maxFps` replaces the hardcoded 5, and the `huelink_fps` slider on the zigbee2mqtt device page is built from it, so the UI and the device can no longer disagree. The default is still 5. See "Separate coordinator" in the README before raising it.
- **An optional burst**, off by default. A token bucket measured in coordinator milliseconds lets a scene cut run faster for a moment, paid out of credit that quiet scenes earned, so the long-term average is still `occupancyBudget`. Measured rather than asserted: `tools/burstbench.mjs` reports what it costs a wall switch press, and the worst case does not move.
- **Startup consistency warnings.** Settings that are individually valid but contradict each other — `fps` above `maxFps`, above what `dutyCap` can pass, or above what the budget can pay for — are reported with the value that would carry them, instead of being silently trimmed.
- **`tools/burstbench.mjs`** and **`test/tuning.test.mjs`**, plus a "Separate coordinator" section in the README for anyone running the strip on a coordinator of its own.

### Fixed

- The burst credit bucket never accrued when the caller's clock started at zero, because `0` was both a valid timestamp and the "it has never run" sentinel.

## 1.0.0

First release: everything below is what the extension does, rather than a record of how it got there.

### Added

- **A zigbee2mqtt external extension.** No extra container and no extra service; it runs inside the zigbee2mqtt process, from the data directory that holds `configuration.yaml`.
- **Hue Entertainment frames over Zigbee** (cluster `0xFC01`), so the whole gradient is addressed at once instead of as a single colour, with **no Hue bridge, no Hue account and no cloud**. The encoder is verified byte for byte against a known-good implementation.
- **Sync from Hyperion.** Screen colours arrive as plain `udpraw` datagrams, three bytes per LED, and reach the strip at full gradient resolution.
- **26 local effects** travelling the same path. The catalogue is data: adding an effect means adding a JSON entry, not writing JavaScript.
- **An arbiter with exactly one active mode** — Light, Effect or Sync — so the strip always has a single owner and the published state cannot contradict itself.
- **Home Assistant discovery.** A separate "HueLink" device carrying mode, effect, speed, brightness, frame cap and status. Power stays on the strip's own light entity, so there is no second power switch to disagree with the first.
- **Eight `huelink_*` fields on the strip's zigbee2mqtt device page**, added by an external converter that extends the stock Philips definition rather than replacing it.
- **A pacer that budgets coordinator time, not air time.** Delta suppression, a per-100 ms burst cap, an adaptive occupancy budget and a fast path for scene cuts, so streaming does not crowd the rest of the Zigbee network off the coordinator.
- **A circuit breaker.** Consecutive send failures stop the stream with a backoff and say so in `huelink_status`, instead of retrying into a strip that is not answering.
- **English and Latvian**, selected with one `locale` setting. Only human-visible text is translated; MQTT keys, mode values and effect ids are fixed, so changing language cannot break an automation.
- **A JSON settings file with per-field validation.** A missing file or field falls back to its default; an invalid value is reported as an error naming the field, and only that field falls back.
- **Documentation and tests**: design, wire protocol, pacing measurements, the effect format, the bench tools, and a test suite that needs neither a Hue bridge nor a real strip to run.
