# HueLink

HueLink drives a Philips Hue gradient lightstrip from **zigbee2mqtt alone**, using the strip's own Entertainment streaming mode: screen colours from Hyperion land on the strip at full gradient resolution, with **no Hue bridge, no Hue account, no cloud and no bridge emulator**. It also ships **26 local effects** that travel the same path. There is no new container and no new service to run: HueLink is a zigbee2mqtt external extension, so it lives inside the zigbee2mqtt process you already have.

```
  Hyperion  --- UDP udpraw, 7 LEDs ---+
  (screen capture)                    |
                                      +--> arbiter --- ZCL 0xFC01 ---> gradient strip
  lib/effects (local generator) ------+      ^          (via z2m)
                                             |
  Home Assistant / MQTT ---------------------+   power, mode, effect, speed, brightness
```

The arbiter is the single place that decides what the strip is doing. Exactly one of three modes is active at a time: **Light** (ordinary Zigbee light, no streaming), **Effect** (frames from the local generator) or **Sync** (frames from Hyperion).

---

## Requirements

- **zigbee2mqtt 2.1.1 or newer.** Two separate reasons:
  - 2.0.0 is where `<data>/external_extensions/` and `<data>/external_converters/` became auto-loaded folders. On 1.x there is nowhere to put these files.
  - the Entertainment frames go out through `endpoint.zclCommand(...)`, which needs `zigbee-herdsman-converters` 23.0.0 or newer; that first shipped in zigbee2mqtt 2.1.1.
  - Developed and running on **zigbee2mqtt 2.14.3** (zigbee-herdsman-converters 26.125.0, zigbee-herdsman 11.2.0).
- **Node 20 or newer** (whatever your zigbee2mqtt image already uses).
- **A Hue gradient lightstrip paired directly with zigbee2mqtt.** Not with a Hue bridge. If the strip is joined to a bridge, HueLink cannot see it at all; re-pair it to your Zigbee coordinator first.
- **Tested model: LCX002** (Hue Play gradient lightstrip, 7 segments). The gradient profile for that model is built in. Other gradient models have a different segment count and a different pixel map: set `segments` to match, and expect to adjust `GRADIENT_LCX002` in `extension/lib/huepack.mjs` if the segment boundaries differ. Only LCX002 has been verified byte for byte.
- **Hyperion** on whatever machine does the screen capture, if you want Sync. Effects work without it.
- Home Assistant is optional. If zigbee2mqtt has `homeassistant:` enabled, HueLink publishes its own discovery entities; if not, the same controls are on MQTT.

---

## Install

Everything is copied into the zigbee2mqtt **data directory** - the one that holds `configuration.yaml`. Common locations:

- Docker: the host directory you bind-mount to `/app/data`.
- Home Assistant add-on: `/config/zigbee2mqtt` (older installs: `/share/zigbee2mqtt`).
- npm / bare install: the `data/` folder next to the installation.

```sh
# Point this at your own data directory, then run the rest verbatim.
Z2M_DATA=/path/to/zigbee2mqtt/data

mkdir -p "$Z2M_DATA/external_extensions" "$Z2M_DATA/external_converters"

# 1. The extension itself, including lib/ with the effects.
cp -r extension/huelink.mjs extension/lib "$Z2M_DATA/external_extensions/"

# 2. The external converter that adds the huelink_* fields to the z2m device page.
cp converter/huelink-exposes.mjs "$Z2M_DATA/external_converters/"

# 3. The settings file.
cp huelink.config.example.json "$Z2M_DATA/huelink.config.json"
```

The resulting layout, which the converter's relative import depends on:

```
<z2m data>/
  configuration.yaml
  huelink.config.json
  external_extensions/
    huelink.mjs
    lib/...
  external_converters/
    huelink-exposes.mjs
```

zigbee2mqtt only scans top-level `.js/.cjs/.mjs` files in `external_extensions/`, but it imports them with a real dynamic `import()`, so relative imports from `lib/` work and `lib/` itself is not mistaken for a second extension.

**Then edit `<z2m data>/huelink.config.json`.** At minimum set `device` to the `friendly_name` of your strip exactly as it appears in zigbee2mqtt; without that the extension refuses to run. The port in `udpPort` has to match what you configure in Hyperion later. Everything else has a sane default.

**Restart zigbee2mqtt.** A restart, not just "save extension": see [Versioning](#versioning) for why.

```sh
docker restart <your zigbee2mqtt container>
```

### Check the log

A healthy start prints four lines, in this order:

```
[huelink] settings read from /app/data/huelink.config.json
[huelink] loaded 26 effects: Holiday: Christmas, Holiday: New Year's Eve, ...
[huelink] startup reset sent, the strip is back under normal z2m control
[huelink] v1.0.0 listening on UDP 19447, 5 fps -> <your strip's friendly_name>
```

The last line is the one that matters: it names the running **version**, the UDP port it is actually listening on, the frame cap and the device it resolved. If you see `no settings file, running on the built-in defaults`, the config file is not where the extension looks for it. If you see `device '<name>' not found, the extension will not run`, `device` does not match a real `friendly_name`.

A bad value in the config is not silent: it is reported as an `ERROR` naming the field, and only that field falls back to its default.

### What appears where

**On the strip's own zigbee2mqtt device page** (this is the external converter's job). Eight fields, appended after the normal light controls, which are left untouched:

- `huelink_version` - the version actually loaded
- `huelink_status` - one line about what the strip is doing right now
- `huelink_fps_real` - frames really delivered in the last 5 s
- `huelink_dropped` - frames deliberately suppressed since startup
- `huelink_mode` - Light / Effect / Sync, writable
- `huelink_fps` - frame cap, writable
- `huelink_delta` - delta threshold, writable
- `huelink_duty` - frame quota per 100 ms window, writable

**In Home Assistant**, as a separate device called "HueLink" (MQTT discovery):

- `select` Mode, `select` Effect
- `number` Effect brightness, `number` Effect speed, `number` Sync frame cap
- `sensor` Status, `sensor` Frames per second, `sensor` Coordinator load

Power is the strip's own existing `light` entity. Turning that light off stops whatever HueLink was doing - there is no separate HueLink power switch, on purpose.

The `huelink_*` entities that zigbee2mqtt generates for the strip itself are created **disabled** in HA deliberately, so there is only one place to set each thing. In the zigbee2mqtt UI they are always visible, which is the whole point of them.

---

## Configuration

Every field in `huelink.config.json` is optional. A missing file, or a missing field, means the default. An invalid value is an `ERROR` in the log naming the field, and that one field falls back.

**`device`** (default `"Hue Gradient Strip"`) The zigbee2mqtt `friendly_name` of the gradient strip. This is also the **power switch**: turning this light off stops whatever HueLink was doing. The one field you must set.

**`segments`** (default `7`) How many gradient segments the strip addresses. LCX002 has 7. Changing this alone does not teach HueLink a different pixel map, see Requirements.

**`udpPort`** (default `19447`) UDP port HueLink listens on for raw RGB frames. Hyperion's `udpraw` output points here. Any free port works as long as both sides agree.

**`udpBind`** (default `"0.0.0.0"`) Which address the UDP listener binds to. `0.0.0.0` is every interface, which is what Hyperion on another machine needs. Set it to `"127.0.0.1"` if Hyperion runs on this same host and the port stops existing for the rest of the network.

**`udpAllowFrom`** (default `[]`) IP addresses allowed to send frames, for example `["192.168.1.50"]`. Empty means anyone who can reach the port. A `udpraw` frame is 21 bytes with no sender and no password, so whoever reaches the port drives the strip; listing your Hyperion host closes that. Frames from anyone else are dropped, and the drops are reported as **one summary line a minute** giving the count and a sample of the senders. Not one line per sender: a UDP source address is trivially forged, so a line per new address would let a single host on the LAN fill the log and grow the extension's memory at the same time. The sample is capped for the same reason, and says so when it is truncated.

**`tickMs`** (default `20`) Loop period in milliseconds. This is **not** the frame rate. The loop deliberately runs far more often than frames go out, so a sudden scene change is noticed immediately rather than at the next frame boundary. How many frames really leave is the pacer's decision.

**`startSettleMs`** (default `2000`) How long after startup HueLink makes no decisions, so that command echoes from its previous life can finish arriving.

**`fps`** (default `5`) Target frame rate for Sync and Effects. This field accepts 1 to 5; the Home Assistant slider offers 2 to 5, because 1 fps is a deliberate way to hand the radio back to the rest of the house rather than something to land on by dragging. Five is not a typo and not a limitation of the radio, see [docs/PACING.md](docs/PACING.md).

**`occupancyBudget`** (default `0.35`) Fraction of wall clock time, 0 to 1, that streaming is allowed to keep the Zigbee coordinator busy. Above roughly 0.4 the rest of the house starts queueing behind the strip.

**`sourceTtlMs`** (default `1000`) How long a frame source still counts as alive after its last frame. `udpraw` has no "stream ended" signal, so silence is the only signal there is. When the TTL expires the strip turns off and waits for frames to come back.

**`name`** (default `"huelink"`) Last part of the MQTT topic: `<base_topic>/<name>` for state, `<base_topic>/<name>/command` for commands. The command suffix is deliberately not `/set`; see docs/DESIGN.md.

**`locale`** (default `"en"`) Language of every human-visible string: `"en"` or `"lv"`. Strings that go on the wire (MQTT keys, mode values, `ON`/`OFF`, effect ids) are never translated, so switching language does not rewrite the API. See `extension/lib/i18n/`.

---

## Connecting Hyperion

### 1. LED layout: exactly 7 LEDs

In Hyperion, open **LED Hardware -> LED Layout** and build a layout whose **total LED count is exactly `segments`** (7 for LCX002). HueLink reads the datagram as a flat list and maps it positionally:

```
bytes  0..2   -> strip segment 1
bytes  3..5   -> strip segment 2
...
bytes 18..20  -> strip segment 7
```

So **the order of LEDs in Hyperion's layout is the order the segments light up**, and LED #1 must be the end of the strip you consider the first segment (in practice, the end the controller cable comes out of). If the gradient runs the wrong way along the wall, reverse the LED order in Hyperion's layout rather than changing anything here.

Nothing else about the layout matters to HueLink - whether the 7 LEDs are "bottom", "left" or a matrix row is purely a question of which part of the screen you want on which segment.

### 2. Output device

**LED Hardware -> LED Controller**:

- Controller type: **`udpraw`**
- Target IP: the IP of the machine running **zigbee2mqtt** (not Home Assistant, not the Zigbee coordinator)
- Port: the `udpPort` from your `huelink.config.json` (default **19447**)
- RGB byte order

`udpraw` sends plain gamma-encoded sRGB, three bytes per LED, **no header** - 21 bytes for 7 LEDs. That is what HueLink expects and what has been tested. `udpddp` also works (HueLink strips the 10-byte DDP header if it sees one), but DDP's offset and chunking buy nothing at 7 LEDs and only add a parser, so prefer raw.

Note that Hyperion applies its own colour correction **before** the output, so the bytes on the wire are not the bytes you asked for in a test pattern. That is Hyperion configuration, not a HueLink problem, but it will confuse you if you compare colours.

**That port is unauthenticated, and it is unauthenticated by design**: 21 bytes with no header, no sender and no password is exactly what makes `udpraw` cheap enough to run at frame rate. So anything that can reach the port can drive the strip. On an ordinary home LAN that is the same trust boundary zigbee2mqtt's own MQTT broker already sits behind, and the worst case is a prank. If you would rather not take even that, set `udpAllowFrom` to your Hyperion host, or `udpBind` to `127.0.0.1` when Hyperion runs on the same machine.

**If zigbee2mqtt runs in Docker, publish the UDP port.** This is the single most common reason Sync never starts:

```yaml
    ports:
      - "19447:19447/udp"
```

### 3. Check that frames arrive

Easiest: set Mode to **Sync**, start playing something, and look at **`huelink_fps_real`** on the strip's zigbee2mqtt device page. A number above zero means frames are arriving and reaching the strip. `huelink_status` tells you the rest.

If it stays at zero, look at the UDP side directly, on the zigbee2mqtt host:

```sh
python3 tools/udpdump.py 19447 5
```

It prints the source address, length and raw hex of the next 5 datagrams. You are looking for `length=21`. Note that only one process can bind the port, so either stop the extension first or point Hyperion at a spare port for the test.

### 4. Turning capture on and off automatically

Hyperion's `udpraw` output has no idea whether anyone is listening, and HueLink's Sync mode has no idea whether the TV is on. Leaving capture running permanently means the capture device and the network carry frames 24/7 for nothing.

The clean arrangement is one automation in your home automation system that enables Hyperion's capture **if and only if both** of the following hold:

- the HueLink **Mode** entity is set to `Sync`, and
- the TV (or whatever source you capture) is actually on.

and disables it otherwise. Hyperion exposes this over its JSON-RPC/REST API, and Home Assistant's Hyperion integration exposes it as an entity you can toggle directly.

**HueLink deliberately does not read TV state itself.** Your automation already knows it, and a second reader would be a second source of truth; sooner or later the two disagree. When capture stops, the frames stop, the TTL expires and the strip turns off and goes **armed**: the moment frames come back it re-lights with no command from anyone.

---

## Effects

26 effects in three groups - Holiday, Mood and Party - selected from a single `select` entity. There is no "None" option, because "no effect" is already a mode.

The strip is a bias light **behind a television**, and the effects are judged by that: every one of them has to be visible within two seconds of being chosen and must not sit near-black for long stretches. `tools/effectproof.mjs` measures both on the bytes that reach the strip. Two effects are allowed to be dark on purpose (a wake-up ramp and a wind-down), and each says so in its own catalogue entry rather than in the tool.

Effects are **data, not code**: adding one means adding an entry to `extension/lib/effects/effects.json` and, only if it needs a genuinely new kind of motion, one generator file. `effects.json` and `palettes.json` can be edited in place in the zigbee2mqtt data directory. See [docs/EFFECTS.md](docs/EFFECTS.md).

---

## Troubleshooting

**The `huelink_*` fields do not appear on the zigbee2mqtt device page.** The external converter is not loaded. Check that `huelink-exposes.mjs` is in `external_converters/` and not in `external_extensions/`, that `external_extensions/lib/` exists next to it (the converter imports `../external_extensions/lib/...`, so both folders must be in the same data directory), and look in the log for `huelink-exposes`. If zigbee2mqtt failed to load it, it renames the file to `.invalid` and the strip quietly falls back to the stock Philips definition - light control keeps working, only the extra fields disappear. The extension itself is unaffected; this file is cosmetic.

**The strip does not react at all, and there are no `[huelink]` log lines.** The extension did not start. Either the files are not in `external_extensions/`, or `device` does not match a `friendly_name` - the log says `device '<name>' not found, the extension will not run`.

**Mode is Sync but nothing happens.** Sync with no incoming frames is `off` **by design**: you asked for the screen, not for a lamp, so an empty stream does not become a lit strip. Work through it in this order: is Hyperion's capture running at all; is its LED controller `udpraw` pointed at the zigbee2mqtt host and the right port; is the UDP port published if zigbee2mqtt is in Docker; does `tools/udpdump.py` see 21-byte datagrams.

**The strip stays dark and I cannot tell whether that is normal.** Read `huelink_status`. There are two different darknesses:

- **armed** - the source went quiet but your selection still stands. The status line says it is waiting for frames. Nothing is wrong; incoming frames re-light the strip with no command.
- **tripped** - the strip itself stopped answering. The status line says `"<mode> stopped: strip not answering"`. The circuit breaker opened after several consecutive failed sends, and **only an explicit command resumes it** - frames alone will not, because frames are exactly what was failing. Pick a mode, or toggle power.

The breaker is not decoration: a failed Entertainment frame can hold the coordinator's send window for up to 6 seconds, so a few in a row stall the whole Zigbee network, not just the strip.

**`huelink_fps_real` is lower than `huelink_fps`.** That is the pacer working, and it is the normal state. Two things trim frames: the occupancy budget (streaming may use at most `occupancyBudget` of the coordinator's throughput) and delta suppression (a frame that barely differs from the last one is not worth a radio slot). `huelink_dropped` counts the suppressed frames - a high number there plus a low `fps_real` means suppression is doing its job, while a low number there plus a low `fps_real` means sends are actually failing. The cap is 5 fps on purpose; the measurements behind that are in [docs/PACING.md](docs/PACING.md).

**I edited a file under `lib/` and nothing changed.** Expected. zigbee2mqtt's "save extension" reloads **only the top-level file**; everything under `lib/` stays in the Node ESM module cache until the process restarts. Restart the container and confirm with `huelink_version`.

**Pressing the light's off button does nothing mid-stream.** It should not happen - HueLink intercepts power on the strip's own `/set` topic precisely because a raw `state: OFF` gets overwritten by the next frame milliseconds later. If you see this, the extension is not running; see the second entry above.

---

## Deploying

`scripts/deploy.sh` is the repeatable version of the install above: it copies `extension/` into your zigbee2mqtt `external_extensions/` directory and `converter/huelink-exposes.mjs` into `external_converters/`, makes zigbee2mqtt load the new code, waits until the live extension confirms it is running it, then publishes what was deployed to Home Assistant as `sensor.huelink_deployed_version` and reads it back.

Copy `.env.example` to `.env` and fill it in. It needs `HA_URL` and `HA_TOKEN` for the sensor, `Z2M_EXTENSIONS_DIR` for the copy, and `MQTT_HOST` plus any broker credentials for the rest. Both `.env` and `.env.deploy` are gitignored.

Settings are read from three places, and the first one that sets a key wins: an **environment variable**, then **`.env.deploy`**, then **`.env`**. `.env` describes your installation and is the one you fill in; `.env.deploy` is optional and exists to send one run somewhere else, so it only needs the keys it changes. See `.env.deploy.example`. A key set in both files is named on stderr when the script starts, with the one that won, because the alternative is a deploy quietly landing on the machine you were trying to avoid.

No secret ever reaches a command line. The Home Assistant token goes to `curl` through a `--config` file and the broker credentials go to the mosquitto clients through their own defaults file, both written with mode `0600` inside the run's temporary directory and removed with it. `ps` shows every argument of every process to every user on the machine, so a token or a password passed as an argument is a published one. One consequence: a broker password containing whitespace is refused rather than passed on the command line, because mosquitto's defaults file has no way to quote it.

```sh
scripts/deploy.sh --dry-run       # print every step, change nothing
scripts/deploy.sh                 # copy, load, verify, publish the version
scripts/deploy.sh --version-only  # publish the version sensor and nothing else
```

`--no-reload` copies the files and leaves zigbee2mqtt alone, `--force` deploys from a working tree with uncommitted changes, and `-h` lists everything. The script needs `mosquitto_pub` and `mosquitto_sub` on `PATH`, and says so plainly if they are missing rather than failing halfway.

**Set `Z2M_RESTART_CMD`, or changes under `lib/` will not go live.** zigbee2mqtt's hot reload re-imports the top-level file alone; everything it imports from `lib/` keeps its path and stays in the Node module cache for the life of the process, so only a new process picks it up. `bridge/request/restart` is not enough either: it restarts zigbee2mqtt inside the same process. Put whatever really restarts your installation in that setting, for example `docker restart zigbee2mqtt` or `sudo systemctl restart zigbee2mqtt`.

With it set, the script will not report success on anyone's word but the extension's own. It records the time the copy started, runs your restart command, and then waits for the retained state topic to report both the version being deployed **and** a process start time later than that copy. A version match alone proves nothing, because most deploys do not change the version. Without the setting, the script falls back to the hot reload and says in as many words that `lib/` is still the code the running process started with.

One caveat worth knowing: an entity created through the Home Assistant REST API is not persistent. It lives in the running state machine only, so the next Home Assistant restart forgets it until the next deploy recreates it. That is fine for a deploy marker, but do not build automations on it.

---

## Versioning

`VERSION` in `extension/huelink.mjs` and `version` in `package.json` **must be kept in step**. Bump both in the same commit.

This matters more than usual here, because zigbee2mqtt's extension reload only replaces the top-level file and leaves `lib/` cached. "I saved it and nothing changed" is a normal outcome, so `huelink_version` on the device page is how you tell which code is really running.

---

## Documentation

- [docs/DESIGN.md](docs/DESIGN.md) - how the pieces fit: the arbiter and the two-controls model, why an indirect stream end turns the strip off instead of falling back to Light, armed vs tripped, restart behaviour, why the state listener reads the delta, the full MQTT surface, and how the external converter extends the device page without replacing the Philips definition.
- [docs/PROTOCOL.md](docs/PROTOCOL.md) - the Hue Entertainment format as spoken over Zigbee: cluster `0xFC01`, the frame/reset/segment-map payloads, xy quantisation, stream lifecycle, the LCX002 gradient profile, and the byte-for-byte comparison against Bifrost.
- [docs/PACING.md](docs/PACING.md) - why 5 fps and not 25. The bottleneck is not the air but the coordinator's one-outstanding-request window (26.6 ms median). Delta threshold, duty cap, occupancy budget, the fast path for scene cuts, and the bench numbers.
- [docs/EFFECTS.md](docs/EFFECTS.md) - the effect catalogue format, palettes, the generators, how time is accumulated rather than read from the clock, and how to add an effect without writing JavaScript.
- [docs/TESTING.md](docs/TESTING.md) - what the two test files hold the line on, why neither needs a bridge or a strip, and what each breaker case pins down.
- [docs/TOOLS.md](docs/TOOLS.md) - the bench scripts that produced the numbers quoted above, what each one proves and what it deliberately does not touch.

---

## Credits and prior art

**[Bifrost](https://github.com/chrivers/bifrost)** by chrivers is the reference for the Entertainment protocol, and it deserves the credit plainly: the frame format is not publicly documented, and Bifrost is where the byte layout, the wide-gamut xy quantisation and the LCX002 gradient profile were read from. HueLink's output was then verified against it byte for byte, and the test cases match 4 of 4 - see the proof section in [docs/PROTOCOL.md](docs/PROTOCOL.md).

HueLink is an independent implementation, not derived code, and it solves a deliberately smaller problem. Bifrost emulates a Hue bridge (DTLS, REST resources, user registration, discovery) in roughly 27k lines of Rust. zigbee2mqtt already owns the Zigbee link to the strip, so the only missing piece was the ~55-byte frame format - which is why the encoder here is one small pure module.

Also: **[zigbee2mqtt](https://github.com/Koenkk/zigbee2mqtt)** and `zigbee-herdsman-converters`, which do all the actual Zigbee work, and **[Hyperion](https://github.com/hyperion-project/hyperion.ng)**, which produces the frames.

---

## License

MIT, © gatisr. See [LICENSE](LICENSE).
