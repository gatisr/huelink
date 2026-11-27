# Effects

Effects are **data, not code**. Adding an effect means adding an entry to a JSON file. It does not mean touching a single line of JavaScript.

```
huelink-lib/effects/effects.json          the catalogue: which effect, what it is called,
                                  which generator, which parameters
huelink-lib/effects/palettes.json         named colour palettes, kept separate because one
                                  palette suits several kinds of motion
huelink-lib/effects/generators/<kind>.mjs one kind of motion (wave, burst, strobe, ...).
                                  A new KIND OF MOTION is a new file here exporting
                                  create(params, segments, seed)
huelink-lib/effects/index.mjs             the engine
huelink-lib/effects/util.mjs              shared maths: palettes, gradients, rng, mixing
```

The engine knows nothing about any particular effect. All it can do is: take the selected entry, build its generator, advance time, and return one colour per segment.

## Time is accumulated, not read from the clock

```js
phase += dt * speed
```

So changing the speed in HA accelerates the effect **from where it is**, rather than jumping to a different point in the pattern. And if the process stalls for a moment, `dt` is clamped (to 0.25 s), so the effect does not leap five seconds forward.

## The catalogue: `effects.json`

Each entry:

| Field | Meaning |
| --- | --- |
| `id` | Stable, internal. Also the i18n key: the name HA shows is `effect.<id>` in `i18n/*.json` |
| `kind` | Which generator file: `huelink-lib/effects/generators/<kind>.mjs` |
| `params` | That generator's parameters; documented at the top of its file |
| `preview` | **Tools only.** How many seconds of the effect to render in the filmstrip |
| `proof` | **Tools only**, and only for exceptions. `{minDistinct, maxDimRunSeconds, why}` |

**The name lives in i18n, not here.** `effect.<id>` in `huelink-lib/i18n/en.json` (mandatory, unique) and any other locale file; a missing translation falls back to English. An effect with no `effect.<id>` key is skipped and logged. The prefixes `Holiday:` / `Mood:` / `Party:` are deliberate: the HA list sorts itself and you can find things on a phone.

The name is also the HA `select` **value**, which is why a missing translation falls back to English rather than to nothing — an empty value would be an effect you cannot select.

**`preview`** exists because a slow effect rendered over 20 s looks like a static block in `tools/preview.mjs`. The engine never reads this field. `tools/effectproof.mjs` uses the same number so it measures a slow effect over its full length rather than its first 8 seconds.

**`proof`** lowers the bar for `tools/effectproof.mjs`. Two bars can be lowered: `minDistinct` (default 7 — all segments differ) and `maxDimRunSeconds` (default 30 — how long the strip may sit near-dark). A lower bar is allowed only when less **is** correct (a flag is symmetric; a wake-up ramp has to start dim), and `why` is mandatory so nobody later assumes the test was simply relaxed.

The exception lives **in the data**, next to the effect it excuses, and not as a branch in the tool. An effect that needs a special case the tool knows about by name is an effect whose special case nobody can find later.

**Order in the file is the order in the HA Effect list.**

## The strip is behind a television

This is the one piece of physical context the numbers have to respect. The strip is a **bias light behind a TV**, not room lighting. So an effect that is black for minutes does not read as subtle from the sofa, it reads as broken, and no amount of segment independence fixes that: seven *different* shades of nothing still count as seven segments.

Two consequences for the parameters:

- **An effect must show something within a couple of seconds of being selected.** Picking an effect and watching nothing happen is a bug, whatever the effect does later. `tools/effectproof.mjs` gates this as `visible in`.
- **A `base`, `min` or `from` that rounds to zero is not "dark", it is off.** Brightness is encoded as `max(r,g,b) / 255 * 2047`, and the 8-bit rounding happens first, so "2 % of `#1a0a14`" is delivered as literally nothing. A background colour meant to be barely-there needs to be checked in decoded bytes, not judged by how dark the hex looks.

Deliberately dark is still allowed — `sleep` ends at zero because you are asleep by then — but it has to be declared with `proof.maxDimRunSeconds` and a reason.

## Palettes: `palettes.json`

Separate from `effects.json` because a colour set and a motion are two independent things. A national flag suits both a slow wave and a sharp pulse; `flame` suits both a bonfire and a candle. If palettes lived inside entries they would be copied into ten places, and a fix in one of them would quietly diverge from the rest.

**Keys are English and stable.** They are internal — neither HA nor z2m sees them — but they are exactly what a person adding an effect types.

Use in `effects.json`:

```json
"palette": "flame"                       a named palette
"palette": ["#ff0000", "#00ff00"]        inline hex
"palette": ["flag", "#000000"]           mixed: names expand in place
```

The third form is the reason palettes are a separate layer at all: "the flag plus black between the stripes" is not a new palette, it is two existing things combined.

An unknown palette name **throws** rather than quietly returning white. A silent white strip looks like a broken effect and the cause would be unfindable.

**Colours are `#rrggbb` and nothing else**, checked when the catalogue is read rather than when the effect is first created. `#fff`, `0000ff` and a number are all refused, and the entry that used them is skipped like any other bad entry. Checking it later would break the loader's promise that a bad entry costs one effect and no more: `start()` selects the first effect in the catalogue, so one malformed colour at the top of the file used to stop the extension coming up at all.

**Order within a palette matters.** Generators read it either as a gradient from start to end (`breathe`, `solid`) or as a cycle (`wave`, `chase`).

`flame` reads the palette as **temperature**: the first colour is the cold ember, the last is the hottest tongue. So a flame palette must start with a dark colour. Without it the flame has nowhere to fall to, and 7 segments look like an even orange blob rather than fire.

## Loading

`loadEffects()` reads the catalogue and imports the generator each entry needs.

An invalid entry is **skipped with a warning**, not fatal: `effects.json` is a human-edited file, and a typo in it must not leave the strip with no sync at all.

**`kind` is checked against the real contents of `generators/` before anything is imported.** It has to be a plain file name in that directory: `wave`, not `wave.mjs`, not `./wave`, not a path. `effects.json` is data, which means it can be copied from a forum post, written by a tool, or edited by anything with write access to the extension directory, and the name used to go straight into an `import()` specifier. `"kind": "../../../something"` would have executed an arbitrary module inside zigbee2mqtt's own process, with its broker credentials and its Zigbee adapter. An unrecognised `kind` is now logged by effect name and skipped.

Palette references are resolved **in the loader**, not in the generator. A generator only ever sees a list of hex colours and knows nothing about `palettes.json`, so a new palette can be added without touching any generator.

## The engine

`EffectEngine` exposes:

- `options` — the HA `select` list, with "None" always first
- `select(name)` — an unknown name means **off**, because a silent "carry on with the previous one" would be worse than a visibly dark strip
- `setSpeed(percent)` — clamped to 0.1–3
- `setBrightness(percent)` — clamped to 0.01–1
- `frame(now)` — the next frame, or `null` if no effect is selected

Effect frames are **pulled** by the tick loop, not pushed, so a stalled loop cannot build a queue.

## Generators

Each file exports `create(params, segments, seed)` and returns a function `phase -> Array<{r,g,b}>` of length `segments`. `seed` is fed to a seeded RNG (mulberry32) so the test bench is reproducible.

### `wave` — palette bands travelling evenly along the strip

The palette repeats `bands` times across the strip and slides at a constant speed. Every segment is always at a different point in the palette, so the strip is never one colour.

```
palette        colours; the last wraps back into the first
bands      1.0 how many palette repeats fit on the strip
cycleSeconds 12 seconds for one full palette cycle
softness  0.45 1 = smooth gradient, 0 = hard band edges
direction    1 1 = away from the start, -1 = towards it
brightness 1.0
```

### `burst` — short flashes in random places that die away. Fireworks

Each flash is a point on the strip with falloff onto its neighbours and exponential decay. Several at once sum, so a dense volley reads as a white flare, exactly like real fireworks.

A strip is not a matrix, it has 7 points. A pretty rocket trajectory is not visible there; what is visible is only "something suddenly got bright and went out". So only the flash is modelled, not the flight.

```
rateHz       2.5 average flashes per second
decaySeconds 0.45 how fast they die (less = sharper)
riseSeconds 0.05 attack time; 0 = instant
spread       1.2 how many segments the light falls across (0 = one only)
peak         1.6 flash peak (>1 saturates towards white)
hues          [] hue degrees to pick from; empty = fully random
saturation   0.9
base   "#000000" background between flashes
```

### `pulse` — a heartbeat: sharp attack, soft decay, pause. Also "goal"

`breathe` is a symmetric cosine — that is a breath, not a beat. A heart has a different shape: fast up, slower down, and **two** beats in a row ("lub-dub"), then silence. The double beat is what makes it read as a heart rather than a blinking light, so it is a parameter, not randomness.

`beats` holds the beat amplitudes and `beatGap` the time between them. `[1, 0.6]` with a 0.16 s gap is a human heart; `[1]` makes it a plain pulse (useful for a hockey goal).

Colour comes from a palette gradient along the strip, and `spread` gives the segments a small offset so the beat runs across the strip rather than striking everywhere at once.

```
palette           gradient along the strip
bpm            62 beat pairs per minute
beats    [1, 0.6] beat amplitudes within one pulse
beatGap      0.16 seconds between beats
riseSeconds  0.06
decaySeconds 0.22
min          0.12 floor between pulses (0 = fully dark)
spread       0.12 offset between first and last segment, in seconds
brightness    1.0
```

### `flame` — noise-driven warm flicker. Bonfire, candle, torch

Why noise rather than per-frame randomness: fire is not flicker, it is slow continuous motion with irregular peaks. A fresh random brightness every frame would give noise, not a flame. So each segment has its own value-noise curve: random control points at `rateHz`, smoothstep-interpolated between them.

**Two layers, deliberately:**

- per-segment noise, so the tongues move independently;
- one shared `gust` across the whole strip, so now and then the whole fire flares or settles together, as if from a draught.

Without the second layer, 7 segments look like 7 separate candles rather than one bonfire.

Colour is not fixed: the hotter the moment, the further along the palette (dark red → orange → pale yellow), so peaks are warmer as well as brighter.

Note on the two axes: the **colour** axis uses the raw noise while the **brightness** axis uses the `depth`-compressed heat. They used to both use the compressed value, which made the bottom `depth` percent of the palette unreachable — every flame came out the same orange.

```
palette          gradient from cold (ember) to hot (peak)
rateHz      2.6  flame change rate (control points per second)
gustHz     0.33  shared gust frequency; 0 = no shared layer
gustDepth  0.35  how strongly the gust moves the whole strip (0..1)
depth      0.55  how deep an individual segment's flame drops (0..1)
min        0.18  lowest brightness; 0 means the segment goes out
brightness  1.0
```

### `solid` — a motionless gradient. Background light that does not intrude

Looks like an empty generator, and that is exactly the point: for cinema background light and for reading, motion is a **defect**. The eye catches every change in the periphery, and a slowly breathing strip during a film is more distracting than a bright static one. So "Cinema" is not `breathe` with a small amplitude, it is no motion at all.

`driftSeconds` allows a very slow palette shift for cases where some life is wanted anyway (colours flowing over minutes, not seconds). 0 means completely still, and then every frame is identical to the last — which the pacer's delta suppression then turns into almost no traffic at all.

```
palette           gradient from the start of the strip to the end
spread       1.0  1 = whole palette across the strip, 0 = one colour
driftSeconds   0  >0: seconds for the palette to slide one strip length
brightness   1.0
```

### `breathe` — slow breathing, offset along the strip

Each segment's colour is a fixed point on the palette gradient (so 7 different tones from end to end) and only the brightness moves. `phaseSpread` de-synchronises the segments slightly, so the front of the wave drifts slowly along the strip. Without it the effect looks like one pulsing light rather than a strip.

Brightness never falls to zero (`min`): this is a background mood effect, not a blinker.

```
palette           gradient along the strip (not a cycle)
periodSeconds  9  one breath
phaseSpread 0.35  how far the last segment lags the first, in periods
min          0.35 brightness at the bottom
max           1.0 brightness at the top
brightness    1.0
```

### `twinkle` — each segment lives its own life: softly lights and fades

Unlike `burst` there are no "events" that sum; each segment has an independent timeline (light, burn, fade, wait). So the segments are practically never in sync and the strip is never one colour.

The envelope is **sin², not exponential**: a spark must rise as softly as it fades, otherwise it looks like fireworks rather than fairy lights.

The initial phases are scattered so they do not all light up in the first second.

```
palette           where spark colours are picked from (randomly)
onSeconds  [0.9, 2.2] how long one flare lasts
offSeconds [0.2, 2.0] pause between flares
base   "#02060f" background; must not be fully black, or during pauses
                  the strip looks switched off
peak          1.0
brightness    1.0
```

### `ramp` — one slow transition, then hold. Sunrise and falling asleep

The only generator that is **not** a cycle. It has a start and an end: an alarm must finish bright and stay bright, not start over; falling asleep must go to zero and stay there. A cyclic breath cannot do that job.

`t` comes from the engine and starts at zero the moment the effect is selected, so "the start" is the moment of selection. The HA speed control works here too: 200 % means a sunrise twice as short.

The palette is read as a **time** axis, not as strip length: the first colour is the beginning, the last is the end. So `["#3a0f06", "#ff8a3c", "#fff0d0"]` is a dark ember turning orange and then pale warm.

`segmentSpread` makes the segments lag one another, so light flows into the strip from one end. Without it the 7 segments would rise as one block.

```
palette               colour over time (not along the strip)
durationSeconds  900  how long the transition takes
from            0.02  brightness at the start
to               1.0  brightness at the end
segmentSpread   0.12  what fraction of the duration the last segment lags
curve       "smooth"  "smooth" = eased at both ends, "linear" = straight
brightness       1.0
```

**`from` multiplies the first palette colour, so the two set the first frame together.** This is the trap in this generator and it cost a real effect: the old sunrise asked for `from: 0.02` of `#1a0a14`, which is 0.5 of a channel, so the strip stayed literally off for about two minutes and only became visible after seven. Neither number looks wrong on its own. Check the product, or let `tools/effectproof.mjs` check it for you.

Because of that trap there are now two ramps where there was one sunrise, and the difference is intent, not taste:

- **`sunrise`** (`Mood: Sunrise`) is a 3-minute mood. It starts at a warm glow you can see immediately and climbs to a bright dawn, so it can be chosen at any moment of the evening like `sunset` or `ocean`.
- **`wakeup`** (`Mood: Sunrise Alarm`) is the 15-minute alarm for automations. Starting dim is the whole point here, but the floor is still lifted off zero, so the first minute is a weak ember rather than nothing at all.

### `strobe` — sharp pulses running along the strip

Every segment has the same rhythm, offset by `stagger` of a beat. So the pulse does not flash everywhere at once (which on 7 segments looks like a cheap strobe) but runs from one end to the other, and at any instant neighbouring segments are at different points in the beat, therefore in different colours.

Each successive beat takes the next palette colour, so red and white alternate.

```
palette              alternating per beat
periodSeconds  0.55  one beat
duty           0.18  what fraction of the beat is lit
tailSeconds    0.06  decay tail after the pulse; 0 = hard cut
stagger        0.09  offset between adjacent segments, in beats
base      "#140000"  background between pulses
brightness      1.0
```

### `chase` — a point of light running along the strip with a tail

The difference from `wave`: a wave is a continuous pattern where the whole strip is always coloured. Here the strip is **dark** with one (or a few) bright points. On 7 segments that difference is very visible: a wave is a mood, a chase is motion, and the eye follows it.

The tail is exponential and measured **in segments, not frames**, so changing the speed (the HA control) does not change the tail length — only how fast the point runs.

Each lap takes the next palette colour, so with a two-colour flag palette the laps alternate between the two.

```
palette              colour changes each lap
cycleSeconds   2.2   seconds for one pass along the strip
tail           1.6   tail length in segments (0.5 = nearly a point)
heads            1   how many points at once, evenly spaced
direction        1   1 = forward, -1 = back
bounce       false   true = reflect off the ends instead of wrapping
base      "#000000"  background
peak           1.0   point brightness
brightness     1.0
```

## The custom effect

One entry is not in `effects.json`: **Custom**, appended by `huelink.mjs` at start and configured from Home Assistant (`huelink-lib/custom.mjs`). It defines nothing new. Its style is the generator of a catalogue effect of that kind, so only kinds that loaded are offered, and every other parameter is the generator's own default. Its colours are either the resolved palette of a catalogue effect or the user's own list of up to 8, typed in or read back from the strip's light colour (`xyToHex`, at full brightness: how bright it is shown is the strip's brightness, not the colour's). `ramp` (it ends) and `burst` (no palette) are left out.

Changing it rebuilds the entry in place and, when it is the running effect, selects it again. It is saved in `huelink.state.json`. It has no `effect.<id>` key on purpose: those are the catalogue's, and a test holds that none is orphaned.

## Adding an effect

1. If an existing `kind` can do it, add one entry to `effects.json` with a unique `id`, a `kind` and `params`, plus an `effect.<id>` name in `en.json` and `lv.json`. Done — no code.
2. If you need a new **kind of motion**, add `huelink-lib/effects/generators/<kind>.mjs` exporting `create(params, segments, seed)`, document its parameters at the top of the file, and then do step 1.
3. If the colours repeat elsewhere, put them in `palettes.json` under an English key and reference them by name.

## Catalogue

26 effects, in HA list order:

| id | Name (en) | kind |
| --- | --- | --- |
| `christmas` | Holiday: Christmas | wave |
| `newyear` | Holiday: New Year's Eve | burst |
| `valentines` | Holiday: Valentine's Day | pulse |
| `easter` | Holiday: Easter | wave |
| `ligo` | Holiday: Midsummer | flame |
| `lacplesis` | Holiday: Latvian Remembrance Day | flame |
| `independence` | Holiday: Latvian Independence Day | solid |
| `halloween` | Holiday: Halloween | flame |
| `romance` | Mood: Romance | breathe |
| `fairies` | Mood: Fairy Lights | twinkle |
| `cinema` | Mood: Cinema | solid |
| `reading` | Mood: Reading | solid |
| `calm` | Mood: Calm | breathe |
| `sunset` | Mood: Sunset | wave |
| `aurora` | Mood: Aurora | wave |
| `bonfire` | Mood: Bonfire | flame |
| `candle` | Mood: Candle | flame |
| `ocean` | Mood: Ocean | wave |
| `sunrise` | Mood: Sunrise | ramp |
| `wakeup` | Mood: Sunrise Alarm | ramp |
| `sleep` | Mood: Falling Asleep | ramp |
| `boxing` | Party: Fight Night | strobe |
| `disco` | Party: Disco | chase |
| `hockey` | Party: Hockey | chase |
| `goal` | Party: Goal! | strobe |
| `birthday` | Party: Birthday | twinkle |

23 palettes: `christmas`, `valentines`, `easter`, `midsummer`, `autumn`, `flag`, `halloween`, `romance`, `fairies`, `sunset`, `aurora`, `ocean`, `flame`, `candle`, `sunrise`, `wakeup`, `warm_white`, `calm_blue`, `cinema`, `disco`, `birthday`, `boxing`, `hockey`.

Effects are bound by the same pacing rules as Sync — see [PACING.md](PACING.md) for why an effect runs at about 4.6 fps and why that is deliberate.
