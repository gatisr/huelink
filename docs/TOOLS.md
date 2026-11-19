# Tools

`tools/` is the bench, not the product. Nothing here is loaded by the extension; these are the scripts that produced the numbers and the proofs quoted in `docs/PROTOCOL.md`, `docs/PACING.md` and `docs/EFFECTS.md`.

They were written against a synthetic rig (a fake z2m that records raw ZCL payloads, a Bifrost instance, a Hyperion instance). **No address of that rig is in the files.** Every host, port, credential and path a tool needs comes from the environment, and every default is localhost, so a forgotten variable fails on your own machine instead of reaching a stranger's.

| variable | used by | default |
| --- | --- | --- |
| `Z2M_WS` | `extsim`, `modesim`, `fpsrun` | `ws://127.0.0.1:8080/api` |
| `Z2M_DEVICE` | `extsim`, `modesim`, `fpsrun` | `lightstrip_test` |
| `BIFROST_HOST` / `BIFROST_PORT` | `bytediff` | `127.0.0.1` / `2100` |
| `BIFROST_AREA` | `bytediff` | none, required |
| `BIFROST_PSK_IDENTITY` / `BIFROST_PSK_KEY` | `bytediff` | the Bifrost constants |
| `Z2MFAKE_STATS` | `bytediff` | `stats.json` |
| `HYPERION_HOST` / `HYPERION_PASS` | `ledprobe` | `127.0.0.1:8090` / `hyperion` |
| `UDP_HOST` / `UDP_PORT` / `LEDS` | `setdevice.sh` | `127.0.0.1` / `19447` / `7` |
| `MQTT_URL` / `MQTT_USER` / `MQTT_PASS` | `hatest` | `mqtt://127.0.0.1:1883`, no login |
| `HA_URL` / `HA_TOKEN` | `hatest` | `http://127.0.0.1:8123`, token required |

The port huelink itself listens on is **not** in this table: the tools import `CONFIG` and read `CONFIG.udpPort`, `CONFIG.segments` and `CONFIG.name` from it, so a second copy of those numbers cannot drift away from the first.

Two tools need a package that the extension does not: `bytediff` needs `node-dtls-client` to speak DTLS-PSK, `hatest` needs `mqtt` to reach a broker. They are `devDependencies`, so `npm install` brings them and the extension itself still ships with nothing. If your shell sets `NODE_ENV=production` npm silently skips them; `npm install --include=dev` does not.

## `bytediff.mjs` — byte-for-byte against Bifrost

Proves our frame packer emits exactly the bytes a real Bifrost emits.

**Not through Hyperion.** The Hyperion `philipshue` driver transforms colour on its own (candy gamma, a brightness factor, black-level handling), so the bytes arriving at Bifrost are not the ones we asked for, and the comparison would measure Hyperion rather than our code. So the tool stands in for Hyperion and talks to Bifrost directly:

1. open a DTLS-PSK session to the Bifrost entertainment port (the same path Hyperion uses; the PSK is the Bifrost constant `BifrostHueTlsKey`);
2. send real Hue Entertainment v2 RGB frames with colours we chose;
3. Bifrost turns them into a `0xFC01` command and the fake z2m records the raw bytes (`last_frame_hex`);
4. feed the same RGB values to our packer and compare byte by byte. The counter and the smoothing value are taken from the Bifrost frame, because those are stream state, not colour maths.

Full result and layout: `docs/PROTOCOL.md`.

## `effectproof.mjs` — every effect really drives all 7 segments, and is visible

A generator returning 7 different colours is not proof: between it and the strip sits the packer, which converts to CIE xy and can flatten them. So the tool does not look at generator output. It runs the real `EffectEngine` on `effects.json` data, encodes a frame with the real `encodeFrame`, decodes those bytes back with an **independent** decoder written from the protocol description rather than by calling the encoder's own functions, and only then counts distinct segments. The measurement therefore happens on the same byte array that would reach the strip.

Random effects (fireworks, sparkle) can be nearly dark in any single frame, so one frame proves nothing about them. Two numbers are reported:

- *per-frame* — how many segments differ within one frame (best / mean);
- *per-segment* — whether each segment's time series differs from every other's.

The second is the real criterion for "all 7 segments are used independently": if two segments are identical across the whole window, one of them is not actually driven on its own.

Each effect is measured on **its own** time scale (`preview.seconds` in `effects.json`). An 8-second window on a 900-second sunrise would show seven identical segments and lie about the effect being broken. The engine clamps `dt` at 0.25 s, so time must not be skipped forward in large steps either; the tool walks real 1/FPS steps and samples every k-th frame.

A lower bar than 7 may be set per effect, but only with a stated reason in the data (`proof.why`), otherwise the criterion would quietly disappear and a broken effect would look green.

### Visible at all, and lit enough to look deliberate

Segment independence says nothing about brightness, and that turned out to be the gap that let a genuinely broken effect pass. The strip is a bias light **behind a television**: seven different shades of near-black are seven independent segments and also an effect that looks switched off from the sofa. The old sunrise passed every criterion above while being literally dark for the first two minutes.

So two more numbers are measured, both on the **decoded brightness field** (0..2047) rather than on generator output, because the 8-bit rounding that destroys a very dim colour happens in the packer, before that field:

- **`visible in`** — the first moment any one segment reaches 64/2047 (an 8/255 channel: the dimmest level that still carries a colour rather than a rounding artefact). Must be within 2 s of selection. The *brightest* segment is the right measure here, because one lit segment is already a visible strip.
- **`dim run`** — the longest unbroken stretch where the **mean** over the 7 segments stays under 160/2047 (20/255). Default budget 30 s. The mean is the right measure for this one: a single spark on an otherwise black strip is not a bias light.

Both thresholds were picked by measuring the catalogue, not by taste. At 160 every effect measures a 0.0 s dim run except the two ramps that are dark **on purpose**, while the dimmest legitimate moods (`calm`, `fairies`, `birthday`) stay clear of the floor until 256.

Deliberate darkness is declared in the data, with `proof.maxDimRunSeconds` and a `why`, exactly like `minDistinct` — never as a branch in the tool that knows an effect by name. `wakeup` is allowed 240 s because an alarm ramp that starts bright is not an alarm; `sleep` is allowed 620 s because it ends at zero and you are asleep. Neither is exempt from `visible in`: a slow start still has to start.

## `preview.mjs` — what the effects look like

`effectproof` proves the segments differ. It says nothing about whether an effect looks good. This renders real engine frames into two artefacts:

- `preview.html` — a live 7-segment strip per effect plus a filmstrip (time downwards, 7 segments to the right), grouped like the HA list;
- `preview.png` — a contact sheet, no browser required.

The PNG is the one that lets an effect be approved or dropped without standing in the living room, which is why it has to be self-contained: 26 colourful columns mean nothing without labels. Hence `font5x7.mjs`.

Only the PNG is checked in. The HTML embeds every rendered frame as JSON, which is half a megabyte rewritten from end to end whenever `effects.json` is touched: a diff nobody can read, for a file one command rebuilds.

Effect names follow `locale`, so the committed PNG is regenerated with the defaults rather than with whatever language you run at home:

```sh
HUELINK_CONFIG=huelink.config.example.json node tools/preview.mjs
```

Without that variable the tool previews your own catalogue in your own language, which is what you want while designing an effect and not what belongs in a repository.

## `font5x7.mjs` — a 5x7 bitmap font

Drawing a label into a PNG needs either a font library or a browser. A browser does not start in this container (missing system libraries, no root), and depending on one would mean the tool works on a handful of machines only. Sixty lines of letter data is cheaper than that dependency.

Uppercase only. Diacritics are not separate glyphs: they are composed from a base letter plus a mark above or below, so the Latvian letters cost no new glyphs. The cell is 5x7 for the letter plus 2 rows above (macron, caron) and 2 below (comma), 5x11 in total.

## `extsim.mjs` and `modesim.mjs` — the real extension, a fake z2m

Both run the **real** extension class with a fake z2m environment, so only what comes from z2m (zigbee, mqtt, eventBus, settings, logger) is substituted; the extension, the arbiter, the stream and the packer are real. Zigbee commands go to the synthetic z2m over the same WebSocket API Bifrost uses, so they can be inspected there.

- `extsim.mjs` checks sync: UDP frames start it, UDP silence ends it with a `CMD_RESET`, and `{"power":"OFF"}` holds the strip dark even while Hyperion keeps sending, until sync is chosen again.
- `modesim.mjs` checks effects and precedence: choosing an effect overrides a running Hyperion sync, and choosing sync again lets Hyperion resume without the stream ever breaking. Its step 7 matters most: when no source is sending, a `CMD_RESET` must go out, after which an ordinary z2m command reaches the strip with no frames competing for the air.

Neither file spells out an effect name or a mode name. Effects come from the published discovery payload and modes from `MODE_LABEL`, so both tools check **behaviour**: they keep passing in any locale and after any edit to `effects.json`, where a hardcoded list would test last year's names instead.

What the two read off the extension is `output` (what is going out right now) and `armed` (what it is waiting for while dark). There is no `mode` field to read: `mode` is what is asked for over MQTT, `output` is what came of it.

## `hatest.mjs` — a real Home Assistant sees the entities

`modesim.mjs` checks that we emit the right discovery payloads, but that is our own opinion. The only thing that answers "does HA understand this" is a real HA.

What it does **not** touch:

- production z2m. The stub's `settings.get()` returns the base topic `huelink_hatest`, so every state and command topic sits beside the production tree rather than in it. z2m is not subscribed to those and never sees them.
- the strip. The Zigbee endpoint is fake; commands are counted in memory.
- the production `unique_id` space. The discovery payload is the real one, but the harness rewrites `huelink_huelink` to `huelink_hatest` in the identifiers so the test does not squat on ids the real extension will want later.

It finishes by deleting every retained topic (an empty payload on a config topic removes the HA entity), so HA is left as it was found. The topics it deletes are the ones it recorded publishing, not a list written out by hand, so an entity added to the extension later is cleaned up too.

Entity ids are never written down either. HA builds the friendly name of an MQTT entity as `"<device name> <entity name>"`, and both halves are in the payload the tool just published, so it **looks the id up** in `/api/states` instead of guessing a slug. A slug only holds in one language; a hardcoded `select.huelink_efekts` would make the tool a tool for one house.

## `fpsrun.mjs` — frames per second our path actually sustains

Measures what reaches the synthetic z2m. The transport is identical to the Bifrost measurement (same WebSocket `/api`, same `{"topic","payload"}` protocol), so the numbers are comparable.

Honest about its limits: it measures whether our encoding and sending can hold a target frame rate. It does **not** measure Zigbee radio throughput — there is no radio and no real strip in the synthetic z2m, and the real ceiling will be the radio, not this. See `docs/PACING.md`.

## `burstbench.mjs` — what the token bucket costs the rest of the house

```sh
node tools/burstbench.mjs [seconds] [burstFps]
SEND_MS=51 TICK_MS=20 CUT_S=4 DRIFT=60 node tools/burstbench.mjs 300 12
```

The question the burst raises is not "is the strip smoother", which anyone can see, but "does pressing a wall switch get slower while it happens". This answers that: the same synthetic film is fed to the same real `Pacer` twice, once with `burstFps: 0` and once with the burst on, so the two printed columns differ by one setting and nothing else. It imports the production `Pacer`, not a copy of its arithmetic.

It is a **simulation and says so**. The coordinator is modelled as what ZNP actually is, a single server with one outstanding request, each frame occupying it for `SEND_MS`. The model is worth something because its one input is measured (51.2 ms median over 135 samples, `docs/PACING.md`) and because the quantity it produces, how long a foreign command waits for our frame to finish, is bounded by that same number. It is worth nothing as a claim about radio behaviour, retries or a congested mesh; for those, run `fpsrun.mjs` against the real rig.

The press-wait distribution is sampled every millisecond across each tick, not once per tick, which is the same thing as a uniformly arriving press and contains no RNG noise. Sampling on the tick grid alone understates the worst case by a whole tick, which is how an early version of this bench reported a 31 ms worst wait for a 51 ms frame.

The film is a knob rather than a buried constant because the result is more sensitive to it than to anything else. Shots **travel** (`DRIFT` colour units per second, held for the length of a shot) instead of random-walking, because steps that cancel leave the colour where it started, delta suppression then eats every frame, and the stream idles at 1 fps whatever the limiter is set to. It is also deliberately not a strobe: a limiter looks free on content that changes completely every tick, because there is nothing left to suppress.

| variable | meaning | default |
| --- | --- | --- |
| `SEND_MS` | measured cost of one frame on the coordinator | `51` |
| `TICK_MS` | loop period, i.e. how often a frame is offered | `20` |
| `CUT_S` | mean seconds between scene cuts (film averages 4–6) | `4` |
| `DRIFT` | colour units per second within a shot, out of 255 | `60` |

## `ledprobe.mjs`, `udpdump.py`, `setdevice.sh` — rig plumbing

- `ledprobe.mjs` checks whether Hyperion emits `ledcolors-ledstream-update` at all. Written to find out why `bytediff` was hanging waiting for a frame.
- `udpdump.py` prints the raw bytes of a few UDP packets, used to work out how the Hyperion `udpraw`/`udpddp` output packs 7 LEDs (header? byte order?).
- `setdevice.sh` switches the test Hyperion's LED device between `philipshue` and `udpraw`/`udpddp` by writing its sqlite database directly, because that is the only way without the web UI.

## What still needs a rig

Nothing here is broken, but most of it needs something to talk to, and that is worth knowing before running a tool and reading a connection error as a bug.

- `preview.mjs`, `effectproof.mjs`, `font5x7.mjs` and `burstbench.mjs` run on their own. They need only Node, and the effect data or the pacer.
- `extsim.mjs`, `modesim.mjs` and `fpsrun.mjs` need the synthetic z2m at `Z2M_WS`. The extension logic is exercised either way, but the Zigbee commands have to land somewhere to be inspected.
- `bytediff.mjs` needs a Bifrost instance **and** the synthetic z2m behind it, plus `BIFROST_AREA`; it exits with a message rather than streaming to a default when that id is missing.
- `hatest.mjs` needs a reachable MQTT broker and a Home Assistant with a long-lived token in `HA_TOKEN`.
- `ledprobe.mjs`, `udpdump.py` and `setdevice.sh` need a Hyperion instance; `setdevice.sh` runs inside its container, because it edits its sqlite database.

These tools are not part of `npm test`. That suite is pure Node with no rig and no network, which is why it can be the gate (`docs/TESTING.md`); the bench is what you reach for when a number or a byte layout is in question.

The one rule they are all held to: a tool must not go stale again. Each imports the real `extension/` code and `CONFIG` rather than copies, so a rename breaks it loudly at import time instead of silently testing something that no longer exists.
