# Testing

`npm test` runs `node --test test/*.test.mjs`. No test framework and no dependencies beyond Node itself. The `devDependencies` in `package.json` belong to two bench tools, not to this suite: `npm test` passes on a checkout where `npm install` was never run (`docs/TOOLS.md`).

| file | what it holds the line on |
| --- | --- |
| `test/breaker.test.mjs` | the circuit breaker, and "an implicit end means a dark strip" |
| `test/i18n-parity.test.mjs` | a locale change must not rewrite the MQTT/HA surface |
| `test/input.test.mjs` | what the extension does with values it did not choose |
| `test/deploy.test.mjs` | which deploy settings file wins, and where the secrets are not |
| `test/version.test.mjs` | `VERSION` and `package.json` cannot drift apart |
| `test/tuning.test.mjs` | the defaults did not move, and the burst cannot overspend |
| `test/stall.test.mjs` | the stall watch attributes late frames to the right cause on a fake clock; the pacer's skip reason and send-charge cap |
| `test/saturation.test.mjs` | 100 % saturation is a no-op down to the encoded bytes |
| `test/presets.test.mjs` | "Normal" is still the defaults, and presets read back as themselves until a knob moves |

No test needs Zigbee, a bridge, a strip, a broker or a network. A strip that does not answer is just a transport that throws; a TV that switches off is just a source that stops feeding frames.

## `breaker.test.mjs`

It is not written against `node:test`: it is a plain script with its own runner that reports through `console.log` and exits non-zero on failure. Under `node --test` the whole file counts as one test. The reason is the harness — every case needs timers, a UDP port and an orderly teardown, and a bare loop with a `finally` that stops every live extension was less machinery than wrapping each case.

### Nothing is hardcoded

The device name comes from the test config, mode names from `MODE_LABEL`, log lines from the i18n table (see `logLine()`, which turns a translation template into a regex by escaping it and widening the `{placeholder}` slots).

That is not tidiness. A behaviour test that fails because somebody translated a word gets "fixed" next time by rewriting the expected string, and at that moment it stops testing behaviour.

### The test config

`fixtures/breaker.config.json` sets:

- a made-up device name, so the test never asks for anyone's real house;
- a UDP port different from the default, so the test does not bind to the port a real deployment listens on;
- `startSettleMs: 0` instead of 2000. The settle window exists so MQTT echoes from a previous life can die down before the extension believes anything it hears. A test has no previous life, and two seconds of silence per case would mean every case measures the settle window rather than the behaviour.

### What each case pins down

- **into the stream without an ON** — the strip obeys an `ON` even mid-stream and flashes its ordinary colour until the next frame, while frames light an off strip by themselves (both seen on the real strip). So the way from off into sync sends no `ON` at all.
- **trips and then goes quiet** — the attempt count is bounded, the log gets **one** line, and then nothing. The error-line count is checked against the number of *sends*, not against a constant: proportionality between errors and frames is exactly the spam the breaker was built to stop.
- **a trip switches the strip off, it does not light it** — only frames fail here, the reset still answers. That is the only case where switching off means anything: a strip that does not answer a reset either is stuck in entertainment mode, where ordinary commands are ignored, so `onFailure` does not send to one (see `reachable` there).
- **a healthy stream is left alone** — the frame threshold comes from `CONFIG.fps`, not a literal. It used to read `10`, which was true at `fps: 12`; when the default dropped to `MAX_FPS` a healthy stream started looking broken purely because the expected number was written by hand.
- **the source went quiet** — the strip turns off with an ordinary `OFF` command, never a black frame, and it leaves the stream (`cmd:3`) before doing so. Silence is measured from the switch-off, not from the last frame: inside the TTL window frames may still legitimately go out, and that is what lets a single dropped Hyperion packet pass without a flicker. The published mode stays `Sync` while waiting. Expecting `Gaisma` here was a real bug: the HA side gates Hyperion capture on that field, so reporting "light" while waiting cut off the very source whose frames the strip was waiting for, and switching the TV on ate itself.
- **an armed strip lights itself back up** — frames alone bring it back, no click. No `ON` is sent: frames light an off strip by themselves, and an `ON` would flash the strip's ordinary colour first.
- **our own OFF echo does not disarm** — our `OFF` comes back over the eventBus looking exactly like a user pressing a button. If that cleared the armed state, the strip would never light itself again.
- **a direct action beats arming** — a user switching the strip on while it waits for the TV gets light, and keeps it when frames return.
- **an explicit OFF cancels the waiting** — the same thing in the other direction, and the half that actually bit. While armed the strip is *already* dark, so `setPower(false)` had nothing to send and returned early with the arming still standing: the user said off, the state still said "waiting for TV", and the next frame lit the strip back up in the dark. The case asserts the internal state, the published state **and** that the TV coming back sends the strip no command at all. The last of the three is the only one that describes what the user sees.
- **the backoff window holds commands back too** — `settle()` guarded on `tripped` alone, but the breaker spends most of a bad patch in the backoff window, where `tripped` is still `null`. `failures` and `retryAt` are set directly rather than raced through the 200/1000/3000 ms ladder: the subject is the guard, and a timing race would fail for reasons that have nothing to do with it. Both halves are asserted — nothing goes to the strip inside the window, and the decision is still *recorded* and published, so a later `settle()` lets it out. Holding it back and losing it look identical if you only check the first half.
- **light mode stays lit** — the control in the other direction. Switching off applies to a stream that ended, not to a strip somebody asked to be on. The last command to the strip must be `ON`: after a restart the strip starts dark (see the head of `huelink.mjs`), so the first `OFF` is the startup's own doing and without an `ON` the user's choice would produce no light. The check is on the *last* word to the strip, not the whole list: what matters is the state it is left in, not how many commands it took.
- **an expose echo does not flip power** — the listener is handed both halves z2m emits: `payload`, the delta, and `message`, the whole merged cache. A `huelink_*` delta beside a *stale* cached `state: "OFF"` must change nothing; a real `state` delta must still be obeyed. Both directions are asserted, because reading the delta would also be satisfied by a listener that simply went deaf.
- **OFF never publishes a lit output** — `power: "OFF"` next to `output: "sync"` is a state that contradicts itself. Checked three times: with the radio idle, with `sending` deliberately held for 120 ms, and with it held open indefinitely. The second half exists because an earlier `settle()` stood aside whenever a tick held the radio, which looked right in the harness and still produced the contradiction on a real coordinator. A third pass holds the radio and never lets go, which is the case a busy radio really produces: the hold lasts seconds, not milliseconds. There *both* halves are asserted: nothing lit goes on the wire, **and** `this.output` still reads `light`. Checking only the wire would also pass for a fix that simply forgot the strip was still lit.
- **a restart does not start a ping-pong** — the only case that runs the harness with `echo: true`, so a `/set` comes back as the state publish z2m would really send, 80 ms later. Without that return trip a feedback loop cannot be reproduced at all, which is why twelve cases lived beside this bug without seeing it. Two halves: z2m's startup cache replay (`stateChangeReason: "publishCached"`) must not be taken for a press, neither lighting the strip nor clearing the arming; and an off/on faster than one echo must settle rather than oscillate. Both assert a *bound on commands sent*, not just the end state — a runaway loop ends in a plausible state too, just a thousand commands later. Against the pre-fix code it reports 16 commands in 600 ms.
- **commands are invisible to the core router** — every discovery `command_topic` is matched against z2m's *own* routing regex and must not match it. That is the actual mechanism behind `Entity '<name>' is unknown`, so the test asserts the mechanism rather than the absence of a log line it cannot see. The retired `/set` topic is also fired at the extension and must do nothing, while `/command` must still work.

## `i18n-parity.test.mjs`

The strings here are not decoration. They are **values on the wire**: an effect name is the value of an HA `select` option, a mode name is a `huelink_mode` enum value, the status line is the content of `huelink_status`. Dashboards and automations compare them byte for byte, so one translated word means an automation that quietly stops firing — and nothing falls over to announce it.

`fixtures/live-lv.json` is a **frozen** print of everything the extension said before the strings were pulled out of the code. It was generated by running the old code and reading its strings, not retyped. That makes the test self-contained, with no device or broker of its own, while still proving the thing that needs proving: with `locale: "lv"` the extension says exactly what the hardcoded version said.

The locale is set through the same path a human uses — a config file — rather than a test-only back door, so if config loading breaks, this test breaks too.

### Adding an effect without unfreezing the snapshot

A frozen fixture and a growing catalogue look like a contradiction, and the tempting resolution is to paste the new output over the old one. That is exactly how a parity test quietly stops testing parity: every rename it was built to catch would be accepted on the way through.

So the fixture is never edited. New effect **ids** are listed in `ADDED_SINCE_SNAPSHOT` at the top of the test instead, and the comparisons skip them. The frozen names still have to be present, unchanged, and in the same order, so a rename or a reorder still fails. And a separate case asserts that every id on that list really is loaded, so the list cannot be used to smuggle a deletion past the test by naming something that no longer exists.

The imports are dynamic because `huelink-lib/i18n/index.mjs` picks its locale at **module load** and `huelink-ui.mjs` calls `t()` for its fields at that same moment. ESM static imports are hoisted to the top of the file, so setting the environment before them would be too late: the modules would already be loaded under the default locale.

### The Latvian that stays

`test/` is otherwise English, but three things in it are deliberately not:

- `fixtures/live-lv.json`, the frozen golden snapshot. Translating it would delete the very thing being compared against.
- the one `"Noskaņa: Fejas"` literal, which is a value asserted against that fixture, not prose.
- the `/[āčēģīķļņōŗšūž]/i` character class in the two cases below. The letters are the subject of the assertion.

The same applies in `tools/`: the effect names in `hatest.mjs` and the group prefixes in `modesim.mjs` are HA `select` option values, and `font5x7.mjs` keys its glyph table on the letters it draws.

### Hygiene

The last few cases are no longer parity but the hygiene without which parity would collapse silently. A missing key makes `t()` return the key itself, and that is exactly how `Gaisma` would one day become `mode.light` in production rather than in a test. The key list is scraped from the source rather than maintained by hand, because a hand-maintained list goes stale quietly.

## `input.test.mjs`

Everything the extension is told from outside arrives as JSON over MQTT, so anyone who can reach the broker can send `{"effect_speed": "fast"}` or `{"mode": "constructor"}`. Two whole classes of bug came out of that, and each gets a case that fails the moment the guard is removed: a value that is **converted instead of refused** (`Number("fast")` is `NaN`, every comparison with `NaN` is false so `clamp` passes it through, and from then on every frame throws until the breaker calls the strip broken), and a **lookup on a plain object** (`table["constructor"]` is a function, so "did we find it" says yes to a name nobody defined).

`effects.json` is an input too, for the same reason: it is data, and data gets copied from forum posts and written by tools. Four cases cover what one bad line may cost.

- **a `kind` that climbs out of the generator directory is never imported** — the entry names a module written into a temp directory that creates a marker file when it runs, so the assertion is on *execution*, not on a resolved path. The `..` prefix is built with `path.relative` rather than written out: a hardcoded one stops climbing far enough the moment a directory is added, and then the case passes for the wrong reason.
- **a `kind` that is not a plain generator name is refused before import** — the spellings that are not traversal but are still not a file in there: `Wave`, `wave.mjs`, `./wave`, `sub/wave`, the empty string, and the two prototype member names.
- **a malformed colour costs its own effect, not the extension** — the bad entries are deliberately *first* in the catalogue, because `start()` selects `effects[0]`: that is what turned one typo into an extension that did not come up. The survivor is then selected and rendered, which is what "skipped, not broken" has to mean.
- **an effect that will not start leaves nothing selected** — a generator that throws must leave "nothing selected, nothing rendering", not the new name on `selected` with the old effect still on `render`. Both are asserted, plus that the previous effect really was running, or the case would pass against an engine that never started anything.

## `deploy.test.mjs`

Two things in `scripts/deploy.sh` are only worth having if they are exactly right, and neither shows up in normal use.

The first is **precedence**. If the order is wrong, `.env.deploy` is read in full and changes nothing, and the deploy goes to the machine the operator was trying to avoid while reporting success. The three cases run the real script with `--dry-run` against a throwaway checkout, because anything less would be testing a copy of the logic rather than the logic. The environment handed to it is built by hand rather than inherited: a stray `HA_URL` in the shell running the tests would be a legitimate override and would quietly change the answer. Three more cases cover the duplicate warning, including that a key present in only one file is **not** named — a warning that fires on every run is one the operator learns to skip.

The second is that **no secret reaches a command line**. `ps` shows every argument of every process to every user on the machine. Those cases read the script as text, because the thing being forbidden is a spelling: `-H "Authorization: ..."`, `-P "$..."`, and any call to the mosquitto clients that bypasses the wrappers that set `XDG_CONFIG_HOME` (a direct call would connect anonymously with nothing to show that a rule had been skipped).

A last pair checks that `.env.example` and `.env.deploy.example` document only settings the script actually reads, with the list of real settings scraped from the script's own `KEY="${KEY:-...}"` lines.

## `tuning.test.mjs`

Making the pacer configurable added a lot of knobs, and the risk is not that one of them fails to work. It is that the file quietly changed what happens to somebody who never opened it, or that a burst turned out to be a polite name for ignoring the budget. Three classes of claim.

**The defaults did not move.** Pinned three independent ways, because any one of them could pass while the behaviour changed. The constants are asserted **literally** (`assert.equal(MAX_FPS, 5)`), since comparing `DEFAULTS.fps` to `DEFAULTS.fps` would pass however the file is edited. The config layer's defaults are then compared to the pacer's, so the two copies cannot drift. And a `Pacer` built from an empty config file is compared key by key to `new Pacer()`, which is the claim an upgrading user actually cares about: a file that sets nothing changes nothing. The burst specifically is held to shipping **off**, by driving 200 alternating black and white frames (nothing but cuts) past a default pacer and asserting it never started one.

**Ranges are enforced in one place.** `tune()` applies only `TUNABLE` keys, reports which ones changed, returns an empty list when asked twice, refuses `fps`, `maxFps`, `dutyCap` and `deltaScalePct` even when the file sets them, clamps what it does accept, and keeps the current value when handed a string or a `NaN`. The constructor and `tune()` are asserted to produce the same pacer from the same object, because two paths into the same state is exactly where a clamp gets forgotten on one of them. The `maxFps` cases cover the awkward one: Home Assistant restores a retained `number`, so a ceiling lowered in the file has to pull a stale higher value **down** rather than honour it.

**The burst cannot spend money it does not have.** The bucket is tested as a ledger: credit accrues from elapsed time and the budget, caps at `burstCreditMs`, scales with `burstRefill`, is debited by each send's real cost, floors rather than going arbitrarily negative, and refuses a burst when empty. Then the property that matters, over 600 simulated seconds: total coordinator time spent stays below `elapsed × budget + burstCreditMs`, **and** bursts actually fired. Without that second assertion the bound would also be satisfied by a burst that never happens, which is the way this test would most plausibly lie.

Two more hold the edges honest. `consistency()` is checked on three contradictory configurations and one coherent fast one, since a warning that fires when nothing is wrong gets ignored when something is. And the example config file is loaded and compared against the defaults field by field: every key documented, every description present, every value equal to the default, so the file shipped as "this changes nothing" is still true after someone edits a number in the code.
