# Changelog

All notable changes to HueLink are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

`VERSION` in `extension/huelink.mjs` and `version` in `package.json` are the same number and are bumped together.

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
