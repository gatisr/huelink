# Changelog

All notable changes to HueLink are recorded here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [semantic versioning](https://semver.org/spec/v2.0.0.html).

`VERSION` in `extension/huelink.mjs` and `version` in `package.json` are the same number and are bumped together.

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
