# Pacing

Why HueLink sends roughly 5 frames per second and not 25, and why that looks better rather than worse.

Implemented in `extension/huelink-lib/pacer.mjs`. Every number here was measured, not guessed.

## The bottleneck is not the air

Sync at 25 fps made the whole Zigbee network slow. The obvious theory was "the radio is full". Measurement says no.

One frame on air, from a real `tcpdump`:

```
55 B ZCL payload + 5 ZCL + 8 APS + 26 NWK (+security+MIC) + 11 MAC = 101 B
101 B < the 127 B limit, so one fragment, no splitting
+6 B PHY = 107 B on air = 3.42 ms at 250 kbit/s
+ turnaround + MAC ACK  = 3.97 ms medium busy
```

Channel utilisation: 25 fps → 9.9 %, 10 fps → 4.0 %. Ten percent is not congestion; 802.15.4 CSMA only starts to suffer around 30–40 %.

**The real bottleneck is the coordinator's SREQ/SRSP window.** The ZNP serial protocol allows only **one** outstanding SREQ at a time, and the measured `AF_DATA_REQUEST` SRSP is **26.6 ms median (p99 49.6 ms)**. That gives the *entire network* about 37 commands per second, and at 25 fps Sync takes all of them. Every other device then queues behind video frames.

The TCP hop to a network-attached coordinator (SLZB-06) is not to blame: the same measurement across both relay legs gave 26.9 ms vs 26.6 ms, i.e. the network adds 0.3 ms (ping is 0.9 ms).

So this module does not conserve air time. It conserves **coordinator time**. All three levers measure the same thing: how much of the coordinator's throughput Sync is allowed to eat.

## Three levers

### (a) Smoothing

The frame format already carries a u16 field telling the lamp how long to fade into the new colour (see [PROTOCOL.md](PROTOCOL.md)).

If the fade is **shorter** than the gap between frames, the strip reaches the colour and then sits still — the eye reads that as stutter. If it is slightly **longer**, the colour is always still moving when the next frame arrives, and 10 fps looks nearly like 25.

So the fade is set from the **actually measured** gap, times `smoothingFactor` (1.15), not from the configured fps. If the coordinator delays a frame, the fade must stretch with it.

The gap uses the **mean, not the median**, even though the distribution is skewed (median 140–180 ms, mean 250–320 ms, because a keepalive every 1000 ms adds long tails). See "Two levers we deliberately did not pull" below for the measurement that settled it.

### (b) Delta suppression

A frame whose colour has not visibly changed carries no information but costs the same ~27–46 ms of coordinator time.

The threshold is **perceptual** (distance in the CIE xy plane plus relative brightness), not a byte comparison. In bytes nearly every frame differs by a unit, so byte-based suppression would never fire.

```
XY_THRESHOLD  = 0.010
BRI_THRESHOLD = 0.025
```

MacAdam ellipses — the just-noticeable colour difference under ideal conditions — are about 0.004 CIE xy units. The strip shines on a wall behind a TV, not on a laboratory test patch, so 0.010 is safely invisible. For brightness the Weber fraction for adjacent patches is 1–2 %; 2.5 % of full scale is used here.

`magnitude()` takes the **worst segment, not the mean**: seven segments are seven separate lights, and one of them changing is as visible as all of them. Where both frames are below the brightness threshold, only brightness is compared — at very low brightness hue is invisible however far xy has drifted, and scoring it would mean sending frames for changes nobody can see.

`magnitude()` returns a number rather than a yes/no because the fast path needs to tell a scene cut from a slow fade, and that is a question of *size*. 1.0 is exactly at the threshold, 40 is a complete colour inversion. `differs()` is simply `>= 1`, so the suppression boundary is literally the same value rather than a second copy of it.

### (c) Duty cap

A hard ceiling regardless of content, at two levels:

- **Frames per 100 ms window** (`maxPerWindow`, default 2) — the safety belt.
- **Occupancy budget** (`occupancyBudget`, default 0.35) — what fraction of wall time the stream may keep the coordinator busy. This is the important one, because it measures exactly the resource that is scarce, and it adapts: if the coordinator slows down (26 ms → 60 ms), Sync sends less often by itself rather than continuing to push and starving the rest of the network.

`occupancy()` divides by a **fixed** 1000 ms window, not by the time since the first entry. With a moving divisor the number right after a send is absurd (30 ms of busy time divided by 1 ms since the last frame = 3000 %) and the stream would block itself. Shortly after start there is less history in the window, so the number reads slightly low; the hard per-window cap covers that.

## MAX_FPS = 5

Not taste — arithmetic from the measured send cost. 135 real `avgSendMs` samples from z2m logs: **median 51.2 ms, p90 57.6 ms**. One frame is one `zclCommand`, and the coordinator has one SREQ/SRSP window, so N frames per second take N × 51 ms out of that second.

Bench (25 effects × speed 10–300), worst-case occupancy:

| fps | occupancy |
| --- | --- |
| 4 | 19.2 % |
| 5 | 23.3 % |
| 6 | 26.0 % |
| 7 | 28.9 % |

The criterion is ≤ 80 % of the 0.35 budget, i.e. 28.0 %. At the p90 cost, fps 5 gives 26.5 % and fps 6 gives 27.5 % — technically passing, but with no margin.

5 is chosen because it clears **both** cost figures with room to spare *and* matches what the system already achieved: Sync on real films was measured at 5.0–5.7 fps. The ceiling is placed where the work was already happening rather than below it, so Sync loses essentially nothing, and the 25 fps lie is gone.

The old default of 12 fps was never achievable: 12 × 51 ms = 61 % occupancy, so the budget cut it to about 6.7 fps anyway. The slider showed a number the device could not deliver, and the only thing it really controlled was how hard the stream slammed into its safety limits.

`setFps()` clamps to the ceiling rather than trusting the UI, because HA restores a `number` entity's last value — an old saved 12 would come back after a restart and walk straight past the new UI ceiling.

### 5 is a default, not a law

Every number above was measured on **one** coordinator: the one shared with the rest of this house. 51 ms is a property of that installation, not of Zigbee, so the ceiling it implies cannot be a law for installations that do not share it. `maxFps` in `huelink.config.json` moves it; 5 is what you get for not having an opinion.

Two things keep that from quietly undoing the measurement:

- Raising `maxFps` **permits** a higher `fps`, it does not set one. The stream still runs at whatever `fps` says, and the occupancy budget still trims it.
- Startup warns when the numbers disagree, so asking for 15 fps on a budget that can pay for 6.9 is said out loud instead of silently trimmed.

The arithmetic for deciding what a different coordinator can carry is in the README, under "Separate coordinator".

## The burst

Off by default (`burstFps: 0`). It is the one mechanism here that does not ration, so it gets the longest justification.

### What it is for

The fps clock is an average, and an average is the wrong answer at a scene cut. The fast path already rescues **one** frame there. The burst answers the other half of the same complaint: after a cut the picture keeps moving for a second or so, and that whole second is running at the ordinary rate.

### What it does not do

It does **not** raise the occupancy budget. It moves budget in time.

The bucket is measured in **coordinator milliseconds**. Every elapsed millisecond credits it with `occupancyBudget × burstRefill` ms, capped at `burstCreditMs`. Every send — burst frame or not — debits it by that frame's measured cost, with a floor at `-burstCreditMs` so a coordinator stall cannot invent an unbounded debt. A burst refuses to start unless the bucket can already pay for a frame.

That single ledger gives a bound you can check rather than a promise you have to trust:

```
spent <= earned + burstCreditMs = elapsed × occupancyBudget × burstRefill + burstCreditMs
```

so the long-run average occupancy is the budget plus a term that vanishes as the run gets longer. At the defaults that term is 500 ms: a burst can never put the stream more than half a second of coordinator time above budget, ever. `test/tuning.test.mjs` asserts this bound against ten simulated minutes of deliberately loud content.

The hard per-window cap (`dutyCap`, 2 frames per 100 ms) is **not** touched by a burst. That matters because it, not the budget, is what bounds how many of our frames can sit ahead of somebody else's command at any instant. So the worst case a burst can inflict on a wall switch press is unchanged; what changes is how *often* a press meets a busy coordinator.

### What it costs, measured

`tools/burstbench.mjs`, 300 s of synthetic film, a cut every ~4 s, 51 ms per send, 20 ms tick, budget 0.35. The same film is fed to the same real `Pacer` twice, so the two columns differ by `burstFps` and nothing else. Wall switch presses are sampled every 1 ms, which is the same thing as a uniformly arriving press.

```
                                        burst off   burst 12   burst 15
frames sent                                  1148       1275       1293
fps (whole run)                              3.83       4.25       4.31
bursts started                                  0         63         63
frames paid from the bucket                     0        400        422
occupancy mean %                             19.5       21.6       21.9
occupancy p95 %                              20.4       30.6       35.7
press wait mean, ms                           5.1        5.6        5.7
press wait p95, ms                             38         40         40
press wait WORST, ms                           51         51         51
press wait mean within 1 s of a cut, ms       5.3        8.3        8.8
```

Read it in this order:

1. **The worst case does not move.** 51 ms, which is one frame, in all three columns. That is the hard per-window cap doing its job, and it is the number that answers "can this make the house feel broken".
2. **The average barely moves.** Mean occupancy 19.5 → 21.6 %, mean press wait 5.1 → 5.6 ms. This is the ledger: the burst is spending credit that quiet scenes earned, not new budget.
3. **The peak moves a lot.** Occupancy p95 20.4 → 30.6 % at `burstFps: 12`, and 35.7 % at 15. Within one second of a cut the mean press wait goes 5.3 → 8.3 ms.

So "the rest of the house will not notice" is *nearly* true and worth stating precisely: nothing gets slower in the worst case, and a command arriving in the second after a scene cut waits about 3 ms longer on average. On a shared coordinator that is the trade being made. 15 fps buys 1.4 % more frames than 12 and costs another 5 points of p95 occupancy, which is a poor exchange; 12 is the better end of the range.

**This bench is a simulation and says so.** It models the coordinator as what ZNP is — a single server with one outstanding request, each frame occupying it for `SEND_MS`. Its one input is measured (51.2 ms median, 135 samples), and the quantity it reports is bounded by that same number. It is worth nothing as a claim about radio behaviour, retries or a congested mesh. For those, run `tools/fpsrun.mjs` against the real rig.

## The fast path for scene cuts

"It seems to lag a bit" at the TV. Measured on three real video clips, 10 minutes each. Offset from the scene cut to the strip *reaching* the new colour:

```
median 359-400 ms, of which the Zigbee send was only 46 ms
```

So ~310–355 ms was **fading**, not sending, and not the duty cap. On real content the duty cap held nothing back at all: median delay 0 ms, because at 2.6–3.9 real fps the tick is almost never tight.

**Two paths, not one.** Small changes are not noticed, so a long smooth fade is the right answer for them. Large changes (a scene cut, a flash, an explosion) are exactly where the lag is visible, and there the right answer is the opposite: straight through, with a short fade.

**What the fast path does not touch.** It bypasses only the fps tick. Both safety belts — the hard per-100 ms cap and the occupancy budget — still apply. That is deliberate: the budget is the only thing holding the coordinator load ceiling, so the fast path **cannot** raise the worst case. It only moves already-permitted frames to the moments where they are needed.

Result on the same three clips: cut latency **392 → 96 ms**. Cost: the fast path fires 0.21–0.33 times per second, coordinator occupancy 12.2 → 12.4 % (+0.2 points). Smoothness of the ordinary stream does not get worse: gap fraction 3.6/4.9/6.3 % → 3.4/4.1/6.2 %.

### bigChangeThreshold = 6

How many thresholds a change must exceed to count as a scene cut. Not a round number off the top of the head: at this value, on real clips, the fast path fires about 0.3 times per second — one cut per ~3 s, a typical shot length in cinema. Lower would start catching ordinary motion and break smoothness; higher would start missing real cuts.

### maxFastPerSec = 1

The fast path's justification was "a scene cut is rare by definition". On real cinema that holds: 0.21–0.33 firings per second. **On effects it is false.** The bench shows `Party: Disco` at default settings running **200 consecutive frames** through the fast path, i.e. 100 % of frames. The cause is a feedback loop: the less often we send, the larger the accumulated difference, so the more reliably the next frame looks like a "cut". At that point the fps slider controls nothing.

Why a rolling window rather than "how many in a row": a consecutive counter resets on every ordinary frame, so permanently high-contrast content would settle into a stable tick–fast–fast–tick pattern and send **three times** what the tick allows. A rolling window is a hard ceiling: the worst case is `fps + maxFastPerSec` sends per second, and that is a number you can put in the budget calculation. 1/s against the measured 0.21–0.33/s on real cinema is a 3–5× margin, so Sync does not lose a single real cut.

### fastSmoothingMs = 50

Not zero: a jump with no transition on a cheap LED strip looks like a click, and seven segments do not switch in the same instant. 50 ms is just enough to keep the transition continuous, and little enough that with a ~46 ms send the total offset stays under 100 ms.

## Decision order in `decide()`

The perceptual conversion runs **before** the gates, not after. It used to be last, justified as "rgbToXy is the most expensive line in the loop". Measured: 1.2 µs per frame, i.e. 0.006 % CPU at 50 ticks/s. That is not expensive by any measure, and the fast path cannot work without it, because the tick decision now depends on the size of the change.

1. **fps tick** — unless this is a fast-path frame.
2. **Hard duty cap** — frames in the 100 ms window. Applies to the fast path too.
3. **Occupancy budget** — applies to the fast path too.
4. **Delta suppression** — unless a keepalive is due (`keepaliveMs`, 1000 ms).

`decide()` has no side effects. The caller calls `noteSent()` once the send has actually gone out, because only then is its cost known.

In `noteSent()`, fast-path gaps are **excluded** from the interval statistics. A fast gap is by definition shorter than the tick — that is the whole point — and it is not the rhythm at which frames really flow. Counting it would drag the average down and shorten the fade for the following ordinary frames, so one fast frame would spoil smoothness for everything after it.

## Two levers we deliberately did not pull

Both looked like free latency, both were measured, both were **rejected**. Recorded here so nobody rediscovers them.

**(1) Fade from the median instead of the mean.** The gap distribution is skewed: median 140–180 ms, but 1000 ms keepalive tails pull the mean to 250–320 ms. The logic was sound — a keepalive frame does not change colour, so it lies about how often the strip has something to show. The measurement says no anyway: small-change latency 442 → 287 ms, but gap fraction 3.6 → 11.3 %, 4.9 → 15.4 %, 6.3 → 16.9 %. Three times more visible gaps, in exchange for latency where the eye by definition does not notice it. That is exactly the price you must not pay.

**(2) `smoothingFactor` 1.15 → 1.0.** The 1.15 "overshoot" looks like pure latency. It is not: cut latency would fall 392 → 352 ms (40 ms), but gap fraction would rise 3.6 → 5.5 %, 4.9 → 8.3 %, 6.3 → 11.4 %. The overshoot is precisely what keeps the colour in motion at the moment the next frame arrives. 1.15 stays.

Of three candidates, one worked. The fast path is the only one that removes latency where it is visible without taking anything back.

## Why the budget stays at 0.35

Reviewed rather than left alone. The objection was fair: `occupancy()` counts **only the stream's own coordinator time**, so 35 % sits on top of whatever the rest of the network is already doing. The numbers say the fault was not in the budget's *value*:

1. At 32.4 % occupancy, an unrelated Zigbee light on the same coordinator answered in 68.9 ms median against 69.9 ms with no stream at all. Average load at that level did no measurable harm.
2. The fault was that the budget was the **only** limiter. The tick never reached it (12 fps asked for 61 %), the fast path bypassed the tick, and effects lived permanently pressed against the ceiling: the bench shows 20 of 25 effects at 34.0 % with 112–172 hits against the 100 ms window in 30 seconds. That is **burstiness** (2 frames per 100 ms = 20 fps instantaneous), and burstiness is what makes a foreign command wait in the queue.
3. With the new UI ceiling the worst reachable figure is 23.3 % (26.5 % at p90 cost) and zero window hits. The budget is no longer the regulator, it is the net. Lowering it to 0.30 would mean the net starts catching ordinary cost variation (26.5 % vs 0.8 × 0.30 = 24 %), i.e. visible stutter for no gain in average load — the average is now set by the tick.
4. The actual crash cause (`SRSP - AF - dataRequest after 6000ms`) comes from the **tail**, not the average: `worstSendMs` p90 is 238 ms, maximum 5810 ms. An average-load budget does not address that; removing burstiness does.

## Latency spikes and the occupancy meter

`noteSent()` records the whole `await` of a frame as coordinator occupancy, including time the send spent queued in herdsman or retried in the adapter. One slow send therefore reads as a second of heavy load: `occupancy()` sums the last second and `decide()` refuses frames while it is at or above the budget.

- At 0.35 a lone 150 ms send next to four ordinary ones (4 × 51 + 150) reads 0.354 and holds frames back until the oldest entry ages out.
- A 6 s stall (`SRSP - AF - dataRequest after 6000ms`, seen on a real rig, which also failed other devices' commands) used to keep the meter full, inflate `avgSendMs` 4x for 40 frames and trigger a false "frame cap asks for N fps" warning.

**Since 1.3.1** one send adds at most `MAX_CHARGE_MS` (250 ms, just above the measured p90 of 238 ms) to the meter, the price and the burst bucket. Ordinary sends are charged in full; a stall is charged like a slow send, so the pacer still backs off for a moment but not for seconds. There is no cliff and no setting. `worstSendMs` stays uncapped, so the real stall time remains visible.

Diagnosis: `skippedWindow` and `skippedBudget` (their sum is `skippedDuty`), a `frame send failed` line for failures below the breaker threshold, and a `the picture reached the strip N ms late` line when a frame arrives more than 400 ms late, split into `send`, `backoff` (the 200 / 1000 / 3000 ms pause after a failure), `budget` and `window`. The fps clock and "nothing changed" are not counted. Budget and window waits log at info (throttling working); send and backoff log as warnings. Lines are limited to one per kind per 10 s; `stalls`, `worstStallMs` and `sendFailures` count all of them.

## Adjustable limits

`LIMITS` lives in `pacer.mjs`, not in the UI layer, on purpose: the pacer clamps anyway, and if the slider's ends lived separately the UI would sooner or later show numbers the device silently overwrites. That was the false 5–25 fps slider. `huelink-lib/huelink-ui.mjs` imports these rather than restating them.

There are two sets of bounds and they do different jobs, which is worth saying plainly because they look alike. `LIMITS` in `pacer.mjs` is the **real clamp**: whatever reaches the pacer comes out inside those ends, whether it arrived from a slider, from MQTT or from the file. `SPEC` in `config.mjs` is a **typo catcher**: it rejects `"fsp": 50` and a budget of `35` instead of `0.35` loudly, at startup, naming the field, rather than letting a clamp silently turn nonsense into something plausible. A value that passes `SPEC` is still clamped by `LIMITS`; the point of `SPEC` is that you find out.

### Who owns which number

| set from | knobs |
| --- | --- |
| Home Assistant / the z2m device page, at any time | `fps`, `deltaScalePct`, `dutyCap`, `occupancyBudget`, `smoothingFactor`, `bigChangeThreshold`, `fastSmoothingMs`, `maxFastPerSec`, saturation |
| `huelink.config.json`, re-read while running (`FILE_LIVE`) | `burstFps`, `burstMaxMs`, `burstCreditMs`, `burstRefill` |
| `huelink.config.json`, at startup only | `maxFps`, and everything outside the pacer (`device`, `segments`, `udpPort`, `tickMs`, …) |

The first row is not file-live deliberately. Those knobs have live controls in front of a person, and a file that also set them would be a second owner quietly overwriting that person mid-session. The file still gives them a **starting** value; it just stops setting them afterwards. `maxFps` is in the third row for an unrelated reason: the z2m device page builds the `huelink_fps` slider from it when the converter loads, so a `maxFps` that moved while running would be describing a slider nobody is looking at.

Everything in `TUNABLE` is a plain number with a clamp, read fresh on the next frame, which is why applying one mid-stream cannot leave anything half-changed. `segments` and `udpPort` are not like that and are not there.

### The ends, and why they are where they are

**`deltaScalePct`: 25–400, step 25, default 100.** Percent of the measured defaults. Below 25 % the threshold drops under `rgbToXy` rounding noise: every frame would count as changed and suppression would stop working entirely. Above 400 % even a scene cut goes unnoticed and the strip freezes.

**`dutyCap`: 1–5, step 1, default 2.** Frames per `windowMs`. 1 is the strictest meaningful value (one frame per 100 ms). 5 per 100 ms is 50 fps instantaneous, which is `FPS_CEILING`, so past it the window would be the only limiter left and would have nothing above it to catch. Note that this is also an fps ceiling in disguise: 2 per 100 ms is 20 fps, so an `fps` above 20 needs `dutyCap` 3 before it can mean anything. The startup consistency check says so out loud rather than making you work it out.

**`maxFps`: 1–50, step 1, default 5.** The ceiling `setFps()` clamps against. Its upper end is `FPS_CEILING`, which is `dutyCap.max × 1000 / windowMs`: asking for more than the other limiter can ever pass is asking for a number that does nothing. Raising `maxFps` does **not** raise `fps`, it only permits it. See "Separate coordinator" in the README before touching it.

**`occupancyBudget`: 0.05–0.9, step 0.05, default 0.35.** Above 0.9 the stream owns the coordinator; below 0.05 it never sends.

**`smoothingFactor`: 1–2, step 0.05, default 1.15.** Below 1 the colour comes to rest before the next frame, which is the stutter the factor exists to remove; above 2 the strip is always a frame and a half behind the picture.

**`bigChangeThreshold`: 1–40, step 1, default 6.** 1 means "every visible change is a cut", which hands the fps clock to the fast path; 40 is a full colour inversion, i.e. effectively off.

**`fastSmoothingMs`: 0–500, step 10, default 50.** 0 is allowed and reads as a click on a cheap strip; 500 is no longer fast.

**`maxFastPerSec`: 0–10, step 1, default 1.** Fast frames per `fastWindowMs`. 0 switches the fast path off entirely.

**`burstFps`: 0–15, step 1, default 0 (off).** The ceiling is `BURST_MAX_FPS` = 15, or `maxFps` where that was configured higher, since a burst slower than the ordinary stream would be a strange thing to own.

**`burstMaxMs`: 0–5000, step 100, default 1000.** Longest single burst. 0 is the second way to switch bursting off.

**`burstCreditMs`: 0–5000, step 50, default 500.** Bucket size in coordinator ms. 0 means nothing can ever be saved up.

**`burstRefill`: 0–1, step 0.05, default 1.** Share of unspent budget that accrues. 0 freezes the bucket.

The delta threshold is exposed as **one** number, not two. `xyThreshold` and `briThreshold` are in different units (CIE distance and 0..1 brightness) and there is never a reason to move them separately: both answer the same question, "how small a change is still worth sending". So the outside world sees only a scale against the measured defaults, where 100 % is those defaults.

### Settings that contradict each other

A number inside its own range can still be impossible next to another one. `consistency()` in `config.mjs` runs once at startup and logs a WARNING for each of three cases:

- `fps` above `maxFps`: the stream will simply run at `maxFps`.
- `fps` above what `dutyCap` per `windowMs` can pass, with the `dutyCap` value that would actually carry it.
- `fps` above roughly `occupancyBudget / NOMINAL_SEND_MS`, i.e. above what the budget can pay for at 51 ms a frame. The warning points at `avgSendMs` in the published pacer stats, because 51 ms is this coordinator's measured price and yours may differ.

These are warnings, not errors, and nothing is trimmed behind your back. The limiters would have produced exactly the same behaviour in silence; the point is that "I set 12 fps and got 5" has a reason printed in the log instead of being a mystery.

## Bench results

`before`: fps 5–25, speed 10–300, budget 0.35, fast path unlimited, cost 51 ms. `after`: fps 2–5, speed 10–300, budget 0.35, fast path 1/s, cost 51 ms.

Per-effect, `occ% / fps / window hits / longest fast streak`:

```
effect                     before                  after
                        occ%  fps  hits  streak   occ%  fps  hits  streak
Holiday: Christmas      34.0  6.7   169    200    23.3  4.6     0       1
Holiday: New Year's Eve 33.8  6.6   114    198    23.1  4.5     0       1
Holiday: Valentine's    34.0  6.7   112    198    23.1  4.5     0       1
Holiday: Easter         29.4  5.8     0      1    19.7  3.9     0       1
Holiday: Midsummer      34.0  6.7   168    200    23.3  4.6     0       1
Holiday: Remembrance    34.0  6.7    25    163    22.4  4.4     0       1
Holiday: Independence    4.9  1.0     0      1     4.9  1.0     0       1
Holiday: Halloween      34.0  6.7   172    200    23.3  4.6     0       1
Mood: Romance           34.0  6.7     0      5    19.7  3.9     0       1
Mood: Fairy Lights      34.0  6.7   171    200    23.3  4.6     0       1
Mood: Cinema             4.9  1.0     0      1     4.9  1.0     0       1
Mood: Reading            4.9  1.0     0      1     4.9  1.0     0       1
Mood: Calm              26.0  5.1     0      1    18.2  3.6     0       1
Mood: Sunset            33.0  6.5     0      1    19.7  3.9     0       1
Mood: Aurora            34.0  6.7     0      3    20.4  4.0     0       1
Mood: Bonfire           34.0  6.7   169    200    23.3  4.6     0       1
Mood: Candle            34.0  6.7    24    190    22.6  4.4     0       1
Mood: Ocean             34.0  6.7     0      1    19.7  3.9     0       1
Mood: Sunrise            4.9  1.0     0      1     4.9  1.0     0       1
Mood: Falling Asleep     4.9  1.0     0      1     4.9  1.0     0       1
Party: Fight Night      34.0  6.7   172    200    23.3  4.6     0       1
Party: Disco            34.0  6.7   172    200    23.3  4.6     0       1
Party: Hockey           34.0  6.7   172    200    23.3  4.6     0       1
Party: Goal!            34.0  6.7   172    200    23.3  4.6     0       1
Party: Birthday         34.0  6.7   172    200    23.3  4.6     0       1
```

Summary:

```
worst occupancy          34.0 %  ->  23.3 %   (limit 28.0 % = 80 % of 0.35)
frames hitting 100 ms    371287  ->  0        (criterion: 0)
longest fast streak      200     ->  1        (criterion: no runs)
UI points over the limit 5116/8250 -> 0/5900
```
