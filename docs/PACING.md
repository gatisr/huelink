# Pacing

Why HueLink sends roughly 5 frames per second and not 25, and why that looks better rather than worse.

Implemented in `extension/lib/pacer.mjs`. Every number here was measured, not guessed.

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

`setFps()` clamps to `MAX_FPS` rather than trusting the UI, because HA restores a `number` entity's last value — an old saved 12 would come back after a restart and walk straight past the new UI ceiling.

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

## Adjustable limits

`LIMITS` lives in `pacer.mjs`, not in the UI layer, on purpose: the pacer clamps anyway, and if the slider's ends lived separately the UI would sooner or later show numbers the device silently overwrites. That was the false 5–25 fps slider. `lib/huelink-ui.mjs` imports these rather than restating them.

**`deltaScalePct`: 25–400, step 25, default 100.** Percent of the measured defaults. Below 25 % the threshold drops under `rgbToXy` rounding noise: every frame would count as changed and suppression would stop working entirely. Above 400 % even a scene cut goes unnoticed and the strip freezes.

**`dutyCap`: 1–5, step 1, default 2.** Frames per `windowMs`. 1 is the strictest meaningful value (one frame per 100 ms); above 5 the window constrains nothing, because `MAX_FPS` cannot reach it anyway, and a ceiling that never fires is decoration.

The threshold is exposed as **one** number, not two. `xyThreshold` and `briThreshold` are in different units (CIE distance and 0..1 brightness) and there is never a reason to move them separately: both answer the same question, "how small a change is still worth sending". So the outside world sees only a scale against the measured defaults, where 100 % is those defaults.

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
