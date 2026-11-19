# Protocol

The Philips Hue Entertainment streaming format, as spoken over Zigbee directly to the strip. Reverse engineered; reference implementation: [github.com/chrivers/bifrost](https://github.com/chrivers/bifrost).

Everything here is implemented by `extension/lib/huepack.mjs`, which is pure: colours in, bytes out. No I/O, no state.

## Cluster and commands

Manufacturer-specific ZCL cluster **`0xFC01`**, manufacturer code **`0x100B`** (Signify/Philips), ZCL frame type **SPECIFIC (1)**. `zigbee-herdsman-converters` knows it as `manuSpecificPhilips3` and defines commands 1, 2, 3, 4 and 7, each taking a single `data` buffer parameter.

| | Meaning |
| --- | --- |
| `cmd 1` | FRAME — one light frame |
| `cmd 3` | RESET — stream start / stream end |
| `cmd 7` | SEGMENT_MAP — tell the lamp how many addressable segments it has |
| `attr 5` | LIGHT_BALANCE — **not** a command; a uint8 attribute write |

`0xFC03` is a different thing (composite/effect commands, state restore) and is not involved in streaming.

### ZCL options

```
manufacturerCode: 0x100B
frametype: 1 (SPECIFIC)
disableDefaultResponse: true
disableResponse: true
disableRecovery: true
```

`disableDefaultResponse` because responses at streaming rates would drown the network.

`disableResponse` and `disableRecovery` matter more than they look. An entertainment frame is fire-and-forget. If we wait for a reply, herdsman queues every frame until its APS ack, the ZNP queue overflows, and you get `SRSP - AF - dataRequest after 6000ms` with the frame rate falling below one per second. The next frame overwrites the previous one anyway, so a dropped frame costs nothing — waiting costs everything.

## Frame payload (cmd 1)

```
[u32 LE counter][u16 LE smoothing]   then N x 7-byte light record:

  [u16 LE addr][u16 LE field][3 bytes colour]
                     ^
                     field = (brightness << 5) | mode
                     brightness: 11 bits, 1..2047
                     mode: 0b00000 = Segment, 0b01011 = Device
```

`addr` is the device's Zigbee network address plus the segment index. For a 7-segment strip at nwk `0x1001` that is `0x1001`..`0x1007`. Mode `Segment` is where the individually addressable segments live; with mode `Device` the whole strip becomes one colour.

The counter is monotonic and wraps at u32.

### Colour: 12+12 bits in 3 bytes

x and y are packed into three bytes rather than 16+16 = four, because the Zigbee payload is small and this way 7 segments fit in 49 bytes:

```
b0 = x & 0xFF
b1 = ((x >> 8) & 0x0F) | ((y & 0x0F) << 4)
b2 = (y >> 4) & 0xFF
```

x and y are CIE coordinates in the **wide** gamut, where the maxima are `0.7347` / `0.8264`, not `1.0`. The quantisation divides by those constants.

Brightness is `(bright / 255.0 * 2047.0).clamp(1.0, 2047.0)` — note the clamp floor of **1**, not 0. Black does not encode as brightness zero.

### Colour conversion

`rgbToXy()` uses the **same matrix and the same sRGB gamma decode** as `zigbee-herdsman-converters` `ColorRGB.toXY`, i.e. the path taken when Home Assistant sends the strip an ordinary `move_to_color`.

This was wrong once and worth recording. The first version used Bifrost's `colorspace::WIDE` (Adobe Wide Gamut, D50) with no gamma decode at all. Both errors pulled the blue end towards red, and the strip rendered blue and violet as fuchsia. Hyperion sends ordinary gamma-encoded sRGB bytes, not wide-gamut linear light, so they have to be interpreted the way the HA path interprets them — the only path known to produce the right colour.

Brightness is taken as the largest channel on the **gamma-encoded** scale, not the linear one. That is not physically correct, but it is what the code always did, and switching to linear Y would make mid-tones about 2.4× darker. For saturated colours the two agree, so the fixed blue loses nothing.

Black `(0,0,0)` has no defined xy, and falls back to the D65 white point with brightness 0 (which the record encoder then clamps to 1).

### Smoothing

The `smoothing` field is a fade time:

```
field = microseconds * 0x10000 / 2_560_000     max 0xFFFF = 2.56 s
```

Bifrost's default is `0x0400` = 40 ms.

HueLink does something a real bridge does not: it sets smoothing **equal to the measured frame gap**. The lamp then fades exactly until the next frame arrives, so even 12 fps looks continuous. Leaving it at 40 ms means the strip recolours in 40 ms and then sits still for the remaining 37 ms, which is visible as stutter. See [PACING.md](PACING.md) for how the gap is measured and why it is multiplied by 1.15.

## Reset payload (cmd 3)

```
[0x00][0x01][u32 LE counter]     6 bytes total
```

## Segment map payload (cmd 7)

```
[u16 BE count][u16 LE addr] x count
```

Yes: the count is big-endian and the addresses are little-endian. That is not a typo, that is the protocol.

## Light balance (attr 5)

Cluster `0xFC01`, attribute 5, type uint8 (`ZclDataType::ZclU8` = `0x20`), manufacturer code `0x100B`. Bifrost writes `0xFE` immediately before starting the stream.

## Stream lifecycle

The ordering observed from a real Bifrost, implemented in `lib/huestream.mjs`:

```
cmd 3   RESET             [0, 1, <counter LE>]
write   attr 0x0005 = 254 (light balance, mfc 0x100B)
cmd 7   SEGMENT_MAP       [0, 7, addr LE x7]
cmd 1   FRAME             x N
cmd 3   RESET             (at the end)
```

`RESET` must be sent on **every** mode change, not only on process exit. A strip left in entertainment mode stops obeying ordinary z2m commands, including "turn off".

Two details in `huestream.mjs` are there because of failure modes seen in practice:

- **`reset()` is unconditional.** After a z2m restart the new process has `running = false`, so `stop()` would do nothing, and a strip left streaming by the dead process would display its last frame forever and never come back under z2m control.
- **`stop()` clears `running` only after the RESET actually went out.** Under streaming load the Zigbee send can time out, and clearing the flag first would hide a failed reset: we would believe the stream had ended while the strip was still in entertainment mode. On error the flag stays set and the next tick tries again.

## Gradient profile

`GRADIENT_LCX002` (Hue Play gradient lightstrip 65) — copied from Bifrost, and the same 7 segments measured from a real bridge. These are data, not guesses:

```
pixelCount: 20, pointsCapable: 5
segments: (0,2) (2,2) (4,4) (8,4) (12,4) (16,2) (18,2)
```

---

# Byte-for-byte proof against Bifrost

The requirement was not "looks right" but **identical bytes**. This is the proof, and more importantly the description of how to reproduce it.

Harness: `tools/bytediff.mjs`.

## Why not through Hyperion

The obvious first attempt was to run Hyperion with its `philipshue` driver pointed at Bifrost, capture what Bifrost emitted, and compare it with what our packer produces from the same colour. It did not match:

```
ours    : a200000080020110 e0ff9f797a ...   bri=2047  xy~0.442/0.395
bifrost : a200000080020110 a0c0155d6e ...   bri=1541  xy~0.601/0.356
```

The cause was not a bug in the packer. Hyperion's `philipshue` driver applies its own colour processing before sending (`candyGamma: true`, a brightness factor, a black level), so the RGB that reaches Bifrost is **not** the RGB we asked Hyperion for. That comparison measures Hyperion, not our encoder.

The fix was to take Hyperion out of the test path and talk to Bifrost directly.

## Test path

```
bytediff.mjs --DTLS-PSK, Hue Entertainment v2--> bifrost-test --z2m WebSocket--> z2mfake
     |                                                                              |
     +-- same RGB -> lib/huepack.mjs -> bytes ----------------- compared -----------+
```

Both sides receive **exactly the same RGB**, so any difference in bytes can only come from the encoder.

### Connecting to Bifrost

- DTLS-PSK on port 2100 (`node-dtls-client`).
- The PSK is the ASCII string `BifrostHueTlsKey`, hardcoded at `src/routes/auth.rs:16`: `pub const STANDARD_CLIENT_KEY: HueStreamKey = HueStreamKey::new(*b"BifrostHueTlsKey");` The identity is ignored (`set_psk_server_callback` always returns the same key).
- The entertainment configuration **must** be started first, otherwise the handshake succeeds and the connection closes immediately: `PUT /clip/v2/resource/entertainment_configuration/<uuid>` with `{"action":"start"}`. Without it, Bifrost logs `Entertainment area ... is not streaming, closing`.

### Packet layout (from `crates/hue/src/stream.rs`)

```
16 B header : "HueStream" | ver 0x02 | x0 | seqnr | x1 u16 | color_mode | x2
36 B        : zone UUID in ASCII
 7 B x N    : channel u8 | r u16 BE | g u16 BE | b u16 BE
```

## Result: 4 of 4 match

```
=== all 7 identical (warm white)
  bifrost : 3f00000080020110e0ff9f797a0210e0ff9f797a...0710e0ff9f797a
  ours    : identical                                          MATCH

=== 7 DIFFERENT segments (rainbow)
  bifrost : 8200000080020110e0fffe2f520210e0ffcd3b880310e0ff9c79a4
            0410c0ff81f2ff0510e0ff1f83550610e0ffe285140710a0c8d3992c
  ours    : identical                                          MATCH

=== edges: black, white, pure primaries
  bifrost : c700000080020110200086076f0210e0ff86076f0310e0fffe2f52
            0410c0ff81f2ff0510e0ff6873050610000186076f0710c0fe9c79a4
  ours    : identical                                          MATCH

=== dark, nearly identical tones
  bifrost : 0d01000080020110000afe2f520210000a81f2ff0310000a68730504
            10000786076f0510000ceb57710610a0c8bd42f90710608089476f
  ours    : identical                                          MATCH

=== total: 4 match, 0 differ
```

Worth noting: black `(0,0,0)` encodes on both sides as field `0x0020` — brightness clamped to 1, not 0 — with the D50 white point xy `86 07 6f`. That is exactly the kind of thing "looks right" would never have caught.

## What this proves and what it does not

- **Proves:** our encoder produces exactly the bytes Bifrost produces, including edge cases and quantisation rounding.
- **Does not prove:** anything about a model other than LCX002. The comparison is of bytes, so a strip with a different segment count or pixel map needs its own gradient profile before the same confidence applies.

## Reproducing

```sh
npm install                       # once, for node-dtls-client
BIFROST_HOST=<bifrost> BIFROST_AREA=<area> node tools/bytediff.mjs
```

Requires a reachable Bifrost instance and a fake z2m that records the raw ZCL payloads. Both are addressed purely through environment variables, which default to localhost; see [TOOLS.md](TOOLS.md) for the full list.
