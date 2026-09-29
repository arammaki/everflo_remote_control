# EverFlo fjärrkontroll — firmware

Remote control for the flow knob on a Philips EverFlo oxygen concentrator,
built so my mother (limited mobility) can adjust her oxygen flow from her
phone. A camera streams the flow meter; the phone page shows the image and
+/− buttons; an ESP32 drives a stepper that turns the knob via a 3D-printed
friction cup. **The camera image is the source of truth — the human always
verifies visually. Manual override must always work: the motor is
de-energized except during an actual press.**

From late September 2026 she moves to an **Invacare Platinum 9** (1–9 L/min,
a higher maximum than the EverFlo's 5). Same principle — a ball in a tube,
the knob on top — and the same cup fits. Everything tuned for one machine is a
**preset**, chosen when the firmware is built; see "Concentrator presets".
The EverFlo's is kept intact so the unit can go back to it.

This is assistive/medical-adjacent equipment intended for real daily use —
not yet deployed (as of Aug 2026). Correctness and predictability beat
cleverness. When in doubt: smaller change, bump version, let the user flash
and verify.

## Hardware

| Part | Details |
|---|---|
| MCU | Seeed XIAO ESP32-S3 **Sense** (OV3660 camera, PID 0x3660; OV2640 also supported by PID check) |
| Driver | TMC2209 clone breakout, standalone/legacy mode (no UART), unmarked — see pin map below |
| Motor | NEMA 17 pancake (17HE08-1004S), 0.9°... driven 1/8 microstep? — see stepsPerPress() in code; default 39°/press, adjustable via /api/steg |
| Motor PSU | MB102 breadboard supply, jumper 5V, barrel input **needs 7–12 V** (1117 regulators, ~1 V dropout) |
| Cup | 3D-printed conical cup on the D-shaft (Ø5.18 bore / flat 4.71), M3 set screw against the flat |
| Light | WS2812D-F5, **one** pixel, colour order **RGB** (not GRB). VCC→XIAO 5V, GND→GND, Din→D3. ~22 mA at the level used. Datasheet WS2812D-F5-1261: VIH 2.7 V, so 3.3 V data into a 5 V pixel is in spec |

### Wifi band (measured on site 2026-08-15)
The ESP32-S3 is **2.4 GHz only**. Put the viewing phone on **5 GHz**: when
both ends sit on 2.4 GHz every byte crosses the congested band twice
(phone → AP, AP → device), and the phone's radio is far worse than the
AP's. Symptom when they share the band: `/bild` trickles in like an old
modem, 6–7 s for a 30 kB frame, while a 5 GHz laptop stays fast at the
same moment. Moving the phone to 5 GHz fixed it outright.

Device-side RSSI is logged with every cloud upload, so the effect of
moving the unit or its antenna can be measured: press a button to force an
upload and compare. Seen so far: −55 to −68 dBm.

### Power architecture (post-mortem law — a XIAO died to teach us this)
- **Logic**: XIAO powered by its own USB-C. XIAO 3V3 → TMC VDD (logic only).
- **Motor power**: MB102 5V rail → TMC VM. **NEVER wire VM from the XIAO 5V pin.**
- **Common ground is mandatory**: XIAO GND + TMC GND + MB102 GND on one rail.
- Breadboard rails are **split in segments** — module, VM jumper and ground
  bridge must share the same segment.

### Pin map
XIAO (USB-C up): left edge top-down D0–D6; right edge top-down 5V, GND, 3V3, D10, D9, D8, D7.

| XIAO | Signal | TMC clone position |
|---|---|---|
| D0 | STEP | red row pos 2 |
| D1 | DIR | red row pos 1 |
| D2 | EN (active LOW) | red row pos 8 |
| 3V3 | VDD | black row pos 2 |
| GND | GND | black row pos 1 or 7 |
| D3 | WS2812 Din (the meter light) — see below | — |
| GPIO21 | onboard LED, **active LOW** (heartbeat 1 s on / 4 s off) | — |

TMC clone rows, position 1 = the "TMC2209 V2.0" text/big-capacitor end,
position 8 = the potentiometer/gold-hole end:
- **Black row (power) 1→8:** GND, VDD, 1B, 1A, 2A, 2B, GND, VM
- **Red row (logic) 1→8:** DIR, STEP, CLK, UART, UART, MS2, MS1, EN
- Motor coils: black+blue = coil A → 1A/1B; green+red = coil B → 2A/2B.
- VREF ≈ 0.6 V (pot center vs GND, measured with VM powered, motor unplugged).

### The meter light (v1.10.0)
One WS2812D-F5 pixel on **D3**, aimed at the flow meter. VCC→XIAO 5V,
GND→GND, Din→D3, ~22 mA at the level used. Dupont jumpers, like everything
else in the rig — nothing here is soldered — and the pixel's three are taped
down, so that end is the least likely in the build to work loose. That 5V pin is USB VBUS and 22 mA
is not what iron rule 1 is about — that rule is the motor rail, which is amps
and still comes from the MB102 alone.

**It replaces the desk lamp.** The unit stands in the kitchen (that is the
point of a remote control), and a small desk lamp has been burning on the
meter around the clock so the night picture is readable. So constant light is
already the accepted state of the room, and `LED_ALWAYS_ON 1` is the default
for the detector's sake, not for convenience: in daylight the ambient
dominates and the pixel is a small fixed addition, whereas a light that comes
and goes would put every frame in one of two lightings on top of an ambient
that already varies. One lighting is the only thing a calibration can be
bound to. Set `LED_ALWAYS_ON 0` if it turns out too bright for a kitchen at
night — the conditional path (lit 3 s after a capture, 60 s after a UI
heartbeat, `LED_SETTLE_MS` before a cold capture) is compiled in and tested.

- **One brightness, `LED_LEVEL 50`** (~20%, neutral white; 153 was the first
  guess, 50 was chosen on the rig 2026-08-22). A dim idle plus a
  bright flash per frame is the obvious design and the wrong one: the control
  panel polls `/bild` at 1 Hz, so it would strobe over the meter, and every
  analysed frame has to be lit identically anyway.
- **Colour order is RGB, not GRB** for this part (`LED_ORDER`). It is only
  observable through `/api/led-test` — the working light is white, where
  R=G=B. If the test shows green where the code says red, switch
  `LED_ORDER` to `LED_COLOR_ORDER_GRB`.
- **No library.** The ESP32 core 3.x ships `rgbLedWriteOrdered()`, which is
  the same RMT driver with the colour order as a parameter. Adafruit_NeoPixel
  would add a dependency the IDE and every build host has to have installed,
  for nothing. (`neopixelWrite()` also exists but is deprecated in core 3.3.11
  and logs a warning per call.)
- **The cloud upload is lit too**, not just `/bild`. `uploadFrame()` takes its
  own frame from `loop()`, with nobody watching. Leaving it dark would mean
  every periodic frame is captured in the wrong light and refused by the
  contrast gate — the archive going dark exactly where it is the only record.
- **The pixel is written from two FreeRTOS tasks** (the port-80 httpd task and
  `loop()`), so every write holds `ledMutex` — including the compare in
  `ledApply()`, which both tasks run. The pixel is also rewritten every
  `LED_REFRESH_MS`: a WS2812 latches what it was last sent with no readback,
  so a frame corrupted by the stepper switching a few centimetres away would
  otherwise stay wrong until a reboot while the firmware believed the meter
  was lit.
- **The colour test advances on loop time, not on the clock.** `loop()` blocks
  for seconds inside `uploadFrame()`'s TLS POST and up to a minute inside
  `checkFirmware()`, so a step derived from `millis() - start` skips colours —
  or finds the test already over on its first pass and logs "done" having
  shown nothing. Tapping the button five seconds after a press, while the
  press upload is going out, is the way to hit it. Running long is harmless;
  a skipped green reads as "the batch is GRB" and costs a reflash and a drive.
- **`LED_ALWAYS_ON 0` does not light the port-81 stream.** `h_stream` captures
  without stamping `lastCaptureAt`, so a direct viewer of `:81/stream` sees a
  dark meter unless something else is lighting it. No shipped UI uses the
  stream, so this is left alone rather than given the LED a third writing
  task — but know it before debugging over that port with the flag flipped.
- **`/api/led-test` does not block.** All port-80 handlers share one task, so
  a four-second colour cycle inside the handler would freeze the +/− buttons
  with it. It sets a flag, answers `{"ok":true}` at once, and `ledTestUpdate()`
  in `loop()` runs the sequence.
- Endpoints, all CORS: `GET /api/ui-pulse` → `{"ok":true}`, no PIN (passive,
  and the cross-origin control panel cannot know a PIN — same reasoning as
  `/api/status`); `GET /api/led-test` → `{"ok":true}`, PIN-checked;
  `GET /api/light` → `{"on":,"level":,"rgb":,"standard":,"always":}`,
  PIN-checked. Both UIs call `/api/ui-pulse` every 20 s while visible.
- **`/api/light` is RAM only, same contract as `/api/steg`** — `?on=0|1`,
  `?level=0..255`, `?rgb=RRGGBB`, and every restart puts `LED_LEVEL` and white
  back. That revert is the whole safety model: a level is picked by watching
  contrast and ambiguity move on the control panel, not by taste, so the
  slider has to be free — but the calibration is bound to one lighting, so a
  unit left in a half-finished experiment reads wrong. Here the way out is a
  power blip rather than a trip. The panel says "AVVIKER från det
  inkompilerade ljuset" in red whenever the values differ, and every change is
  written to `/log`, because a non-default light is what explains a week of
  odd readings. **What a session finds gets baked into `LED_LEVEL` and
  reflashed** — it is not left living in RAM.

**The light invalidates the calibration.** A new labelled sweep is required,
and it must be taken in exactly the lighting the system will then run in — so
if the desk lamp is going away, the sweep happens with the lamp off and the
pixel on. Sweeping with both and running with one bakes in a lamp that is not
there any more.

### Iron rules (never violate, never "optimize away")
1. VM never from the XIAO. 2. Beep-test the EN wire (D2 ↔ red pos 8) after any
   rewiring, before power. 3. Never plug/unplug motor or any wire under power.
4. EN idles HIGH (motor free) — that IS the manual override; never hold the
   motor energized outside an actual movement.

## Firmware architecture (v1.9.0)

Single sketch `everflo_remote_control.ino`. Key pieces:
- **WiFiManager**: portal SSID "Syrgas-setup", 15 s × 3 connect attempts,
  120 s portal timeout, restart on failure. `wifiWatchdog()` in `loop()`
  heals runtime drops (3 × 15 s reconnects → `ESP.restart()`).
- **mDNS**: `syrgas.local`.
- **Device page** (v1.8.4): the only technician link left is "Starta om
  enheten", the documented remote-recovery path. Zeroing the counter moved
  to the control panel: the patient never needs it, it sat behind a confirm
  dialog on the page she uses daily, and the counter it resets is
  informational — the cloud log now carries the actual signed turn of every
  press, which is a better record than a count of presses of unknown size.
- **Device page** (v1.8.0): picture, the reading, then MINDRE and MER side
  by side. The reading is computed **in the phone**: the device serves the
  detection engine at `/motor.js` straight from flash, and the page draws
  `/bild` into a canvas, orients it the same way the control panel does,
  and runs `analyze()`/`judge()` once a second. Nothing to transfer to a
  phone — she just opens `syrgas.local`. The engine is a separate asset on
  purpose: `h_index` copies the page into a String per request, and ~90 kB
  of engine would not fit in heap, and it is requested as
  `/motor.js?v=<FW_VERSION>` so a version bump busts its year-long immutable
  cache. When the engine refuses, the page shows
  its Swedish reason instead of a number, and a stale frame clears the
  number as well as dimming the picture — a number that outlives the frame
  it came from is the one thing this page must never show.
- **Device page** (v1.7.4): picture, then MINDRE and MER side by side
  (minus left, plus right). No position counter — it is informational only,
  drifts as soon as the knob is turned by hand, and a number that looks
  authoritative next to the picture invites trusting it over the picture.
  The page therefore no longer polls `/api/status` at all.
- **Web server port 80**: `/` (UI), `/api/plus`, `/api/minus`,
  `/api/nollstall`, `/api/omstart`, `/api/status`, `/api/steg`,
  `/api/ui-pulse`, `/api/led-test`, `/api/light`, `/log`,
  `/bild`. All JSON APIs and `/bild` send `Access-Control-Allow-Origin: *`
  (since v1.7.1) — the companion `everflo_control_panel.html` runs from a
  different origin and depends on it. See the Web UI section.
- **`/api/steg`**: GET returns `{"steg":N,"min":4,"max":180,"standard":39}`
  (degrees per press); `?v=N` sets it, clamped to compiled 4..180, RAM only
  (reboot = compiled default `DEG_PER_PRESS`). Invalid/negative/empty `v`
  is ignored.
- **Stream server port 81**: `/stream` MJPEG, viewer-kickout via
  `stream_gen` (newest viewer wins), `lru_purge_enable`, 5 s send/recv
  timeouts. The main page does NOT use it — it polls `/bild` (relative URL)
  ~4 Hz, chained via `onload` with 1 s error backoff. Keep it that way:
  Safari+mDNS on port 81 is flaky and a wedged stream must never take down
  the UI.
- **Stale-image warning** (v1.7.1): the device page dims the picture and
  covers it with a red banner after 5 s without a fresh frame. The +/−
  buttons stay enabled on purpose (decided 2026-08-15): locking them would
  remove the remote control exactly when something is wrong, and the
  physical knob is at the patient's home, not the operator's. Warn hard,
  do not lock.
- **Camera**: `CAMERA_GRAB_WHEN_EMPTY`; `KAMERA_VFLIP`/`KAMERA_HMIRROR`
  defines exist; display rotation is done in the page CSS
  (`rotate(90deg) scaleX(-1)`), not in the sensor.
- **Position counter** `position` persisted via Preferences; survives power
  loss (verified). Informational only since v1.7.0 — MIN_LAGE/MAX_LAGE
  removed (manual knob turns / cup slip made them unreliable; the camera
  is the source of truth).
- **`DIRECTION -1`** (verified on-site): flips motor direction for both
  buttons; never "fix" direction by swapping button handlers — that inverts
  counter semantics.
- `FB-OVF` log lines from cam_hal are harmless (frame buffer overflow when
  frames outpace the viewer).

## Conventions

- **Language split** (since 2026-08-15, was all-Swedish before):
  - **English**: identifiers, comments, serial/`/log` messages, commit
    messages (the last of these since 2026-08-17).
  - **Swedish**: every string the operator or patient reads — the device
    page, the control panel UI, the `judge()` reason texts. She does not
    read English. Never translate these.
  - **English**: file names, the sketch directory, and cloud resource
    names (D1 `everflo`, R2 `everflo-images`). Arduino constraint: the
    sketch folder and the `.ino` must share a name, so renaming one means
    renaming both — and IntelliJ then has to reopen the project.
  - **Unchanged, in either language**: wire formats. URL paths
    (`/bild`, `/api/nollstall`, `/api/omstart`, `/api/steg`), JSON field
    names (`lage`, `steg`), the NVS key `"lage"`, and the localStorage
    keys (`ev_logg`, `ev_host`, `ev_rot`, `ev_spegel`). Renaming the NVS
    key loses the stored position; renaming the rest breaks the control
    panel or the user's saved settings.
  - **Still Swedish, deliberately**: the saved calibration image prefix
    `bild_<flow>L_<timestamp>.jpg`. The existing labelled dataset and the
    (external) test suite parse it. Change it only together with a fresh
    labelled sweep, and say so out loud when you do.
- **Bump `FW_VERSION` on every behavioral change, including engine-only
  changes** — the page footer shows it, it is how the user verifies a flash
  actually took, and it is also the cache key for the engine: the page loads
  `/motor.js?v=<FW_VERSION>`, which is served immutable for a year. Forget the
  bump after an engine change and a phone that cached the old engine keeps
  running it after a correct flash. That happened on 2026-08-16 — three
  recalibrations landed while the version stayed 1.8.9.
- **Minor vs patch** (rule adopted 2026-08-22, because there had not been
  one): **minor** when flashing is not the whole job — new hardware, a new
  library, or a recalibration is required. **Patch** when flashing is all
  there is to do. 1.7.0 and 1.8.0 fit it in hindsight (new API contract; the
  page began computing a reading); 1.9.0 did not — it was a bug fix, and the
  only thing pushing it over was habit, since 1.8.10 was available. These
  fields are numbers, not digits, which is also what makes 1.10.0 a step up
  from 1.9.7 rather than a step back. Nothing sorts them anyway: the
  firmware, the Worker and `publish_firmware.mjs` all compare for equality
  only — so the rule is for humans reading the log, and its only real duty is
  to say "this one needs more than a flash".
- One focused change per commit; commit message style for firmware changes:
  `v1.7.x: short description`. No wholesale refactors.
  **Commit messages are English** (since 2026-08-17; earlier history is
  Swedish and stays that way). They sit with the code, not with the patient.
- `loop()` must stay non-blocking (heartbeat + wifiWatchdog + button debounce
  live there). No `delay()` in handlers beyond the existing brief ones.
  Two deliberate exceptions, both updates: `ArduinoOTA.handle()` blocks for the
  whole transfer once one starts, and `checkFirmware()` blocks for the whole
  download. The heartbeat freezes and the watchdog pauses for that minute. It
  is accepted because an update is a bounded, human-initiated act and the
  device has nothing better to do — see the OTA sections. Do not copy the
  pattern for anything periodic.
- Backward compatibility: `/bild`, `/api/plus`, `/api/minus` are consumed
  by the companion `everflo_control_panel.html` (fire-and-forget no-cors)
  — do not rename or change semantics.
- Safety in code: never move the motor without an explicit user action;
  never leave EN low after a movement.

## Build & flash

Arduino IDE (or arduino-cli): board **XIAO_ESP32S3**, **PSRAM: OPI PSRAM**
(camera requires it). Libraries: WiFiManager (tzapu), ESP32 core (camera,
Preferences, Ticker, ESPmDNS bundled).

Post-flash checklist (serial 115200):
`=== EverFlo remote control v1.7.x starting ===` → `Camera OK` (PID logged) →
`Connected! IP: ...` → `Stream server: port 81 OK` → `=== Ready ===`;
LED heartbeat 1 s/4 s; page loads, footer shows the new version; `/bild`
returns a JPEG; +/− move the motor and `Position:` logs tick.

Since v1.10.0 also: `Light: WS2812 on D3, constant` in the boot log and the
pixel actually lit, then the control panel's "Färgtest" (with CONTROL_AUTH 1
a plain browser visit to `/api/led-test` is refused: it must be signed) —
red, green, blue, white, one second each. **Green where the code says red means
the batch is GRB**: switch `LED_ORDER` to `LED_COLOR_ORDER_GRB` and reflash.

Claude Code can compile-check, but **every change must be flashed and
verified by the user before it reaches the unit at my mother's** — it will
run unattended there. Remote recovery exists (the "Starta om enheten" link on
her page, which signs the request; `/api/omstart` typed into a browser is
refused under CONTROL_AUTH 1), USB power-cycle is the manual fallback.

## Web UI (balldetector.js, build_webui.mjs, two HTML pages)

Architecture: the firmware serves its own minimal control page
(camera picture + buttons) at syrgas.local. The HTML files in this
repo are NOT served by the device — they are companion pages opened
directly in a phone/desktop browser, talking to the device cross-
origin. `everflo_control_panel.html` polls `http://<host>/bild`,
analyzes frames in JS, shows flow, drives the knob motor via
`/api/plus|minus`, logs data, and saves labeled calibration images
(`bild_<flow>L_<timestamp>.jpg`). `everflo_image_diagnostics.html`
analyzes saved images offline with per-gate diagnostics.

Two shell invariants (both are bug fixes — do not "simplify" them away):
`saveImage()` repaints the canvas from the last clean frame before
export, because the green detection marker is drawn inside the ball
band and would otherwise be burned into the calibration images. Any
path that fails to produce a fresh valid reading (lost contact, failed
analysis) must clear the big number and `lastFlow` — a stale value
left on screen reads as current and would also be logged with a fresh
timestamp.

CORS is load-bearing: because the pages run from a different origin,
`/bild` must keep sending CORS headers (Access-Control-Allow-Origin)
or canvas getImageData is blocked and all flow analysis silently
breaks. Any new endpoints the pages read need the same headers —
`/api/steg` already sends them (v1.7.0). Motor calls use no-cors and
are fire-and-forget by design.

### Calibration is baked in — do not regenerate casually
Both files embed a reference image (median of the 23 labelled frames of the
2026-08-22 sweep, 20:06-20:14, taken under the WS2812 at level 50 in a dark
kitchen, 8-bit grayscale — the engine converts to gray as its
first step, so color would only triple the file for data it discards) and
a quadratic y->flow calibration bound to the exact camera pose and 4:3
aspect ratio at calibration time. A physical camera move, refocus, or
aspect change invalidates it: a new labeled sweep ("Spara bild") and
regenerated constants are required. Rotation/mirror changes are
lossless and compensated by the UI rotation control instead — never
change firmware camera settings (resolution, hmirror, vflip, format).
The camera was moved and everything regenerated on 2026-08-16; the
earlier sweep and its `0.1L` mislabel no longer apply.

**A lighting change invalidates it too.** Done for the WS2812 on 2026-08-22:
new sweep, new reference, new bands, new curve. Take any future sweep in
exactly the lighting the unit will then run in — a reference that averages two
lightings bakes in one that is about to go away.

Measured over that sweep: mean error 0.030 L/min, worst 0.110 — and that worst
is a single frame whose label disagrees with its own neighbours by 0.1
(y=316.8 interpolates to 2.40 between its 2.0 and 2.5 neighbours; the engine
says 2.41 and the label says 2.3), so worst against the rest is 0.059.
Margins: contrast 0.173 (gate 0.10), ambiguity 15.9x (3.0), registration
**0.982** (0.75), spread 38 (75). Registration is the one to note — the
previous calibration's worst frame sat at 0.783 against a 0.75 gate, i.e. on
the edge, and CLAUDE.md said so as "where this will break next". The new
camera pose with its own light is nowhere near it, and every frame reports
zero tilt deviation and under a pixel of dx/dy.

The bands moved with the camera: ball 246..278 -> **253..285**, anchor
222..250 -> **233..261**, window 120..455 -> **125..445** (YBOT was 466 for
one night — see "Daylight is a second lighting regime"), BASE_TILT
-0.0209 -> **+0.066** (3.78 degrees, confirmed against a line drawn along the
tube by hand: 3.7). Each was measured over the sweep, not carried over — see
the comments at each constant for what was tried and what it cost.

### Daylight is a second lighting regime, and the night reference refuses it
Discovered the first morning after the WS2812 calibration (2026-08-23).
As daylight grows, auto-exposure rebalances and the scene stops matching the
night reference two ways, on different schedules:

- **At dawn (~06:15-06:50)** the LED's glow at the tube's foot goes darker
  relative to the reference and reads as a rival blob ramping through
  y 446..465 — through the resting ball's rows. Fixed in v1.10.9: YBOT
  466 -> 445 evicts the ramp, costs nothing measurable (sweep identical down
  to YBOT 440; the clipped resting ball still reads 0.20 -> "Under 0,3"; the
  patient's flows are 1.5+ by decision 2026-08-23). Buys ~45 min at dawn and
  the mirror of it at dusk.
- **In full daylight (from ~07:00)** registration itself collapses, 0.98 ->
  0.60, because the whole scene is lit differently. No peak window fixes
  that, and the reg gate is RIGHT to refuse: at reg 0.6 dy cannot be
  trusted, and a plausible number with an untrustworthy dy is the one output
  this engine must never produce. Do NOT lower the gate — it was chosen by
  the negative suite (occlusions must be refused), not by the sweep.

**The fix for daytime is a second reference, not a lower gate.** Nearly all
of a calibration is geometry — CAL, bands, tilt, window are bound to the
camera pose, which did not move (dx=0.0 all morning). Only REF_PNG is bound
to the lighting. So REF_NIGHT and REF_DAY share every constant; the engine
tries both and keeps the one that registers best. Hypothesis tested
2026-08-23 against the morning's own frames: a pseudo-reference built from
eight bright frames took registration from 0.60 to 0.98-0.996 and dissolved
the rival entirely (it is a night-reference artefact, not a thing in the
scene). The residual failures were contrast 0.08-0.09 — a ghost ball baked
into the pseudo-reference because the bright frames all had the ball at one
position, which is precisely what a real REF_DAY must avoid.

**Done the same day, in v1.10.9** — the 2-3 days of collection turned out
unnecessary because the morning's own press window (06:51-07:16) had the knob
being turned through half the scale: fifteen uploaded frames with the ball at
varied positions, median-erased exactly like a sweep. REF_PNG_DAY sits next
to REF_PNG in `balldetector.js`; analyze() runs both and keeps the better
registration; the result carries `ref:'natt'|'dag'`. Measured on all 57
frames then available: the night sweep picks night 23/23 with readings
unchanged to the last digit, and the morning corpus reads 34/34 with a
seamless handover — night takes pre-dawn, day takes the rest, the known
1.75-span reads 1.72-1.75 across the boundary. `validate_engine.mjs` loads
BOTH references now, so a day reference that out-registered night on night
frames would surface as reading drift rather than hide behind the harness.

**Validation debt, still open:** afternoon and evening sun angles are
untested (the corpus ends 09:00), and the 2026-08-16/17 history says low sun
is exactly when artefacts appear. Frames accumulate every 15 minutes; score
them offline before trusting a full day. Failure looks like refusals, not
wrong numbers — the gates are unchanged. Building a REF_DAY from uploads
needs the ball at VARIED positions in the stack: a cluster at one position
leaves a ghost ball that eats contrast at exactly that row (measured:
0.08-0.09 against the 0.10 gate).

### Evening is a third regime (v1.10.11)
Late afternoon and dusk are neither day nor night: low sun through the window,
and the LED's share of the light rising as it fades. Against REF_DAY the
evening frames read HIGH as registration slid toward 0.8, and the gates began
taking frames by fractions — id 1519 missed registration by 0.014 with a
hidden 4.75 against its neighbour's 4.74, id 1521 missed contrast by 0.008
with a hidden 4.05 against 4.03. Seven of the eight refusals were confirmed
against the pictures by the user before this went in.

It is not only availability: id 1516 put the ball at y=337 where its span
neighbours sat at y=342. A five-pixel POSITION error, not a calibration
offset — that is what a reference from the wrong regime does once
registration is poor enough, and it is why the fix is a reference rather than
a looser gate.

`analyze()` now walks a list of references (`refList()`) instead of a pair, so
a fourth costs one line. Selection is by best registration, and the result
carries `ref:'natt'|'dag'|'kväll'` — with one exception added in v1.10.12,
see "When the best-registering reference refuses, ask the next" below. Cost is one registration search
per reference; the flatfield, which dominates, is computed once and shared.

Measured over 482 frames — the 23-frame night sweep and both upload corpora:
night sweep unchanged (mean 0.029, worst 0.110, 0 refused, night wins 23/23),
23-24 Aug 135 -> 137 of 140 read, 24-26 Aug 313 -> 319 of 321. No frame lost
anywhere, no reading moved.

**A caution about span "truth", learned here.** A claim like "the neighbours
say 2.02" is worthless if the neighbours came from the candidate engine — that
is circular. When a whole span shifts together the span cannot say whether the
shift is right; only the tube can. The user caught exactly this mistake in a
draft of this note.

### When the best-registering reference refuses, ask the next (v1.10.12)
`analyze()` sorts the references by registration and takes the best, exactly as
before. What is new is one branch: if `judge()` refuses that one, the next best
is tried, then the third, and the first that passes EVERY gate on its own
answers instead. The result carries `fallback:true` when that happened.

**Why registration alone is not enough to pick a reference.** It is measured on
the ANCHOR band, the scale ticks at x 233-261. The ball band is at x 253-285,
and the artefact that actually decides these frames sits at the foot of the
tube where the LED is. The two are decoupled: a reference can match the ticks
best by a thousandth and still be wrong about the foot. At dawn on 2026-08-30,
frame 2386 had night 0.901 against day 0.897 and read 1.61; frame 2387,
fifteen minutes later and 1.4% brighter, had night 0.899 against day 0.900 and
was refused. Day refused every frame in that window; night read all of them.
A thousandth decided between a reading and a refusal, and the losing reference
had the answer.

**It cannot change a reading, only produce one that was missing.** The best
registration still answers whenever it can, so no accepted frame is affected —
verified on 1013 frames, largest movement 0.00005 L/min, which is rounding.
The night sweep is unchanged to the last digit and night still wins 23/23.

**What it spends is the protection of being asked once.** A frame that must be
refused now has to be refused by all three references instead of one, so the
false-accept surface is three references wide rather than one.

The 78 wrong-pose frames in `test/negative-old-poses/` DO exercise that, which
is worth stating precisely because an earlier draft of this section claimed the
opposite. Instrumented 2026-09-11: all 78 enter the fallback loop, none is
rescued, and the highest registration any non-top reference reaches is **0.664
against the 0.75 gate** — 0.086 of headroom. Two of the 78 have a top
reference above the reg gate (refused by ambiguity and by spread, as the
per-gate table above says), so for those the other two references are judged
on all five gates and still refuse. What the set cannot speak for is an
occlusion, a garbage frame or a wrong rotation; those are not built yet, and
`--expect-rejected` takes unlabelled images precisely so they can be.

Measured: 2026-08-22..09-05, 40 refusals of 1431 -> 7; 09-05..09-11, 26 of
1053 -> 9. No new refusals in either. The 9 that remain are one hour on
2026-09-07 with a second lamp lit — see the note above about what an
invalidated lighting looks like. Every rescued reading was checked against its
press span or against the signed turn the device logged: 17 of 17 agree, and
the 2026-09-09 evening sequence reproduces nine consecutive logged turns with
the right sign and magnitude.

**The rejected alternative, and why.** The other candidate was to measure
ambiguity and spread on the ball rather than on the whole profile — a rival
counts only if it is narrow enough to be a ball. It scored slightly better on
the older corpus (4 refusals against 7) and slightly worse on the newer (11
against 9), and it moves no reading at all, which is its real attraction. It
was not taken because it loosens the ambiguity gate, and measuring each gate
independently over the 78 wrong-pose frames shows ambiguity is never the only
gate refusing any of them: the set cannot say whether loosening it is safe.
Revisit once the occlusion cases exist.

### The engine has one source: `balldetector.js`
Edit the detection engine **only** in `balldetector.js`, then run
`node build_webui.mjs`. The script inlines it verbatim into both HTML
pages between the `ENGINE:BEGIN`/`ENGINE:END` markers, generates
`balldetector_js.h` for the sketch to serve at `/motor.js`, and verifies
the two page copies came out byte-identical. The header is generated too,
so an engine change reaches the device page only after a reflash. `node build_webui.mjs --check` exits
non-zero when a page is out of date — run it before committing.

Everything between the markers is generated and will be overwritten
without warning. Do not hand-edit it.

The pages remain self-contained single files on purpose (the engine and
the ~100 kB `REF_PNG` are inlined, not linked): they are opened straight
from the filesystem on a phone, where a relative `<script src>` does not
load reliably. Duplication is therefore deliberate — but generated.

Why this matters: when the engine was hand-maintained in two places, a
partial rename left `judge()` reading `T.kontrast` while `T` defined
`contrast`. The comparison became `value < undefined` — always false —
and that quality gate silently stopped rejecting anything (2026-08-15).

### Concentrator presets (v1.10.13)
Everything bound to ONE machine seen from ONE camera pose is a preset:
`PRESETS` in `balldetector.js` holds the bands, peak window, `BASE_TILT`, the
y→flow curve, the Max and bottom states with their Swedish texts, the device
page's display crop (`VIEW_X/VIEW_W`) and the lighting references. The sketch
holds the rest of it: `DEG_PER_PRESS`, `STEP_MEDIUM`, `STEP_LARGE` (her three
button sizes), `DIRECTION` and `LED_LEVEL`, in one block per machine. The light
level belongs there because the references were built under it: switching back
to the EverFlo must bring back the 50 its references were taken at.

A calibrated preset must be complete. `usePreset()` refuses one with a curve
and any field left null (only the display crop may be null) or no references —
null compares as 0, so a null `LOW_FLOW` would silently stop the bottom state.

**Chosen in the build, and only there**: `#define CONCENTRATOR` in the sketch.
Not on the page, not over the API — she cannot switch it, and neither can a
stray request. A machine swap is a visit anyway (cup, mount, camera, light),
and a build is the one place a wrong choice cannot quietly persist. Switching
back is that line, a `FW_VERSION` bump, and a flash.

How each consumer learns the preset — and none of them has a default:
- **Device page**: the firmware writes it into the page (`%PRESET%`).
- **Control panel**: asks `/api/status`, which carries `"preset"` and her three
  button sizes (`"buttons"`) since 1.10.13; the panel fills its step fields from
  them. Firmware that does not say is older, and every older build drove an
  EverFlo — history, not a guess. The panel asks again whenever contact drops,
  because a reflash onto another machine is exactly when it does.
- **Admin page**: per row, from `readings.preset`, which the device sends with
  every upload. NULL is EverFlo only when the row's `fw` predates 1.10.13 (the
  rule is `tools/preset_of.mjs`, imported by the Worker and both tools); a
  NULL from newer firmware (an ingest Worker deployed out of order) names no
  machine and is refused, like a malformed report, which ingest stores as `?`.
  Not backfilled. The engine's preset is one global, so `analyse()` selects it
  again with nothing awaited before `analyze()` — a sweep and a row click run
  concurrently.
- **Diagnostics page**: a select, since it reads saved files with no device. It
  opens on the last choice (EverFlo the first time) — the one place with a
  starting value, and it is on screen.
- **Harnesses**: a `PRESET` file in the test directory (`validate_engine.mjs`),
  or the per-row preset in `meta.json` (`score_uploads.mjs`, one machine per run).
- **`publish_firmware.mjs`** reads the preset out of the `.bin` (its boot-log
  string) and records it. `arm` compares it with the machine the unit last
  reported and refuses a mismatch without `--switch-machine`: switching back
  over the air is legitimate, a rollback that happens to pick the other
  machine's build is not. `publish` refuses a second machine under one version
  (the R2 key has no machine in it). `ota_flash.sh` shows both and warns.

**NOT in a preset**: the algorithm and the quality gates — `T`, `TILTS`,
`SEARCH`, the flatfield. A gate per machine would be a place to lower a
threshold until a new calibration "works".

**An uncalibrated preset refuses, it does not guess.** `platinum9` is empty
(nulls, no references) until its sweep exists. `analyze()` returns
`uncalibrated:true`; `judge()` says "inte kalibrerad för den här
koncentratorn". The device page shows the whole frame with the buttons and no
number, which is what aiming a camera at a new machine needs. The admin page
does not store those refusals — they say nothing about the frames.

**How the move was verified**: the functions that do the work were not touched.
`usePreset()` assigns the same names (`XL`, `CAL`, …) the constants had, so on
413 frames — the sweep, the 78 negatives and 312 uploads covering all three
references and two fallbacks — every field of `analyze()` and `judge()` came
out bit-identical to v1.10.12. The engine hash changed anyway, so the admin
page will offer to re-analyse everything once.

**Deploy order, because the ingest INSERT names the new column**: run both
`ALTER TABLE`s in `cloud/schema.sql` first, then deploy ingest and admin, and
only then flash 1.10.13. Ingest before the ALTER fails every upload; firmware
before the new ingest stores NULL presets, which the admin page then refuses.

### Calibrating a new concentrator
The EverFlo calibration of 2026-08-22 is the template; its notes above say why
each number is what it is. In order:

1. **Firmware.** Set `CONCENTRATOR`, bump the MINOR version (a recalibration is
   part of the job) and flash — the unit has to be on the machine before its
   knob can be measured. Then check that + turns the flow UP, measure the step
   sizes against the ball as was done 2026-08-16, write them into the
   machine's block, bump and reflash. Until then the buttons turn by EverFlo's
   sizes on a knob of another pitch, so watch the picture on every press.
2. **Camera and light.** Aim with the device page, which shows the whole frame
   until a preset has a crop. Settle the LED position and level BEFORE the
   sweep, and write the level into the machine's `LED_LEVEL` — the light is part
   of the calibration.
3. **Sweep.** With the control panel's "Spara bild", in the lighting it will run
   in: the resting stop (`0_min`), every half L/min from the lowest mark to the
   top, the top mark (`<n>_max`) and one past the red line (`over_max`). Put the
   frames in `test/<preset>-sweep-<date>/` with a `PRESET` file.
4. **`node tools/calibrate.mjs <dir> --geometry g.json`** builds the reference
   (per-pixel median of the gray frames — it reproduced EverFlo's `REF_PNG`
   bit for bit) and fits the curve (within 0.0005 L/min of EverFlo's). The
   geometry it SUGGESTS is approximate and says so — on EverFlo it put the ball
   band 13 px too narrow on the left and the lean at 0.075 against 0.066 — so
   measure the bands and the tilt the way the EverFlo notes describe.
5. **Fill in the preset**, including what the Platinum's own label implies: it
   alarms below 1.0 L/min and loses concentration above the red line at 9, so
   `LOW_*` and `MAX_REASON` should say that rather than copy EverFlo's texts.
6. **Validate**: `node tools/validate_engine.mjs test/<dir>`, and the old
   suites still green. (`--expect-rejected` refuses to run against an
   uncalibrated preset: it would pass without a single gate running.)
7. **Ship it**: `node build_webui.mjs`, bump `FW_VERSION`, flash, and deploy the
   admin Worker — until it carries the new engine it reads the machine's frames
   as uncalibrated.
8. **Day and evening references** come afterwards from a day or two of
   uploads, ball positions spread (see "Daylight is a second lighting regime").

### The Platinum 9 calibration (v1.12.1, 2026-09-29)
Everything is in the `platinum9` preset with a comment per number; the short
version, and what to watch. The first calibration (v1.11.2, 2026-09-26, night
with the ceiling lamp) died when the camera was moved: it refused all 21
frames of the new sweep at registration 0.31-0.46. Its sweep is now
`test/negative-platinum9-2026-09-26/`, refused 21/21. **The unit is to be
moved again** (as of 2026-09-29), which will mean a third sweep.

- **One reference, and it is DAYLIGHT** ('dag', WS2812 on). Night — lamp off
  or on — is a different lighting and is refused until it has its own
  reference: a short sweep, or uploads with the ball at varied positions.
  The old 'kväll' reference went with the old pose; a reference is bound to
  the camera as well as the light.
- **The ball in daylight is a dark ring with a bright highlight on its
  left.** A band that takes in the highlight cancels against it (contrast
  0.08). The band sits on the dark part, x 327..337.
- **Margins are thin**: contrast 0.118 (gate 0.10), ambiguity 3.4x (3.0),
  registration 0.968, spread 38. Daylight lays a bright streak down the lower
  tube through the ball's own columns; YBOT 392 keeps it out (398 refuses
  the 4 frame, 405 the 3.5 and 4). Against the straight-on labels: mean 0.10, worst 0.29.
- **The camera moves with the knob**: dx runs smoothly from -3 px at the
  bottom of the scale to +6 at the red line — the mount twists. Registration
  absorbs it.
- **The tilt**: the gates choose 0.065 (3.7 degrees); a line drawn along the
  tube says 5.4. Last time 3.3 against 1.7. The hand line sits consistently
  ~1.7 degrees steeper — it follows the tube's edge, the engine the ball and
  the ticks. Trust the search, and re-measure rather than nudge.
- **The curve is fitted to the printed scale, not to the labels.** Labels
  read from the side (above 7.5 in this sweep; above 5 in the first, before
  the motor mount was made smaller) carry parallax, and half marks are a
  midpoint judged by eye — in this sweep they drift with height, 5-6 px off
  at 1.5/2.5 and 13-14 at 5.5/6.5, while the whole marks 1..7 all sit within
  9-12 px of their ticks. The method: find the ticks as dark rows
  in the reference INSIDE THE BALL BAND (sheared by BASE_TILT — measuring them
  in a band 20 px to the left puts them 1-4 px off under a 3.7 degree tilt), number
  them against the printed digits, fit the offset between the engine's y and
  the tick against the straight-on frames only, leaving out 1.5 and 2.5 (10.1
  px — the float is read at its top, y is its centre), and fit the quadratic
  through the ticks 1..9 (within 0.1 of each). Frames read at an angle are
  named `<n>_approx`: held to label − 1 .. label + TOLERANCE, never fitted
  to. The whole marks give an offset of 9.9 against the 10.1 used (0.01
  L/min, not re-baked). TOLERANCE is 0.35 for the half marks (2.5 reads
  +0.29, 6.5 −0.25). calibrate.mjs does
  not do the tick fit, and warns rather than let its label-fitted snippet be
  pasted over this preset.
- **Below 1 L/min there is no number**, only "Under 1": the scale is
  stretched there and the tick-fitted curve reads low. The boundary sits at
  0.8 on the curve (~0.9 on the scale) so a clean 1.0 (reads 1.00) does not
  flip. **Max starts at the red line** (tick-space 168, engine y 178); the
  sweep's `max` frame was judged from the side and reads 9.23, at the 9 mark.
- Her page crops to the meter (`VIEW_*`), moved with the camera.
- Buttons 40/60/120 degrees, chosen on the unit "for now".
- **Open risks, measured nowhere yet:** the engine's pixel constants (the
  60-row ambiguity exclusion, spread 75, the ±35 centroid window, 20 px
  shift) were set for EverFlo's ~50 rows per L/min; on the Platinum's ~21
  the exclusion spans ~2.9 L/min, so a rival that close is invisible to the
  ambiguity gate. The `max` frame asserts only "a number", and no frame
  exercises Max above the red line. Afternoon and evening sun are untested:
  the sweep is 14:39-14:45.

### Engine invariants
Grayscale -> flatfield (3-pass box blur ~ sigma 41) -> horizontal
registration (column profile of rows 100-460) -> vertical registration
against scale ticks (anchor band x 296-320, sampled at the shifted x) -> clipped
difference vs reference in ball band (x 252-292) -> smoothed profile ->
peak + centroid -> quadratic calibration. Never remove the quality
gates (registration >=0.75, contrast >=0.10, ambiguity >=3.0x,
|dx| and |dy| <=20 px, extent <=75 rows): the engine must say "no reading"
rather than output a plausible wrong number — it reads oxygen flow for
a patient. Two states besides a number, and both are measured against the
checked-in sweep rather than asserted (2026-09-05):

- `y < Y_MAX_STATE` (150) -> **"Max"**, a sanity guard only. The frame taken
  deliberately past the printed scale sits at y=146.7 and returns Max; the top
  mark sits at y=154.4 and returns 5.76 as a number. The boundary is about
  5.86 L/min, so nothing the knob can reach is extrapolated — but only just:
  the top mark is 4 px above the Max boundary and 2 px above `Y_CAL_MIN-2`,
  where `judge()` would start calling a reading extrapolated. A camera nudge
  of a few pixels moves the sweep's top frame across one of those lines, and
  `validate_engine.mjs` prints `ok (extrapolated)` or fails on `Max` when it
  does. That is the intended alarm, not a spurious failure.
- `flow < 0.3` -> **"Under 0,3"**. The test is on the FLOW, not on y, so it
  follows the calibration instead of needing a second constant kept in step by
  hand. With today's `CAL` it lands at y=434.7, and the resting stop measures
  y=440.7 reading 0.20 — comfortably inside it.

**The peak search window is the ball's physical range, not the picture's.**
`YTOP=125, YBOT=445` (reference rows; dy is already removed when the difference
profile is built, so the window does not move with the camera). The ball cannot
leave y 154 (5.8 L/min, the top mark) .. 441 (its resting stop) and its blob
is about 20 rows
wide, so everything outside is by construction not the ball. Letting it compete
cost two whole afternoons: from 2026-08-16 13:09 and 2026-08-17 12:51 UTC low
sun put a bright edge just under the old `YTOP=60`, and its clipped tail beat
the real ball. 40 of 164 uploaded frames were refused as "two equally strong
candidates" while the ball sat in plain sight, correctly found, at the right y.
The mirror image of that is the chrome nut below the tube (y 465-495), whose
specular highlight is blown out in the reference and dull in flat light — it was
`min`'s nearest rival in the sweep all along (ambiguity 17.2x -> 36.6x once
excluded). Measured: YTOP 100..125 and YBOT 445..460 are one flat plateau, all
164 uploads read, worst ambiguity 4.1x. Outside it the failure is immediate —
YBOT 470 loses 8 frames, YTOP 90 loses 3, YTOP 130 clips the 6 L/min frame.
YTOP must stay under Y_MAX_STATE (150) and YBOT below the row where the
calibration crosses 0.3 L/min (y=434.7 today) or
those two states become unreachable.

**Registration is where this will break next.** Once the window stopped
manufacturing false ambiguity, `reg` became the tightest gate: 0.783 on the
worst afternoon frame against a 0.75 threshold. All ten frames at the bottom of
that list are glare frames, and on ten of them the tilt search sits pinned at
the -3 degree edge of its range — it is absorbing a lighting gradient, not
measuring a camera tip. The readings there are still right (1.91-1.96 where the
same knob position reads 1.965), so nothing is broken; but a brighter afternoon
takes `reg` under the gate and the frames go back to being refused, this time
for a different reason. Widening `TILTS` is NOT the obvious fix — see the
warning above about what a wider tilt search buys. Re-measure before touching.

**`BASE_TILT` is negative, and the sign is the whole trap.** The tube leans
about 1.2 degrees anticlockwise in the upright picture, but analysis runs on
a MIRRORED canvas — the control panel applies `scale(-1,1)` before handing
pixels over — and a mirror flips the sign of a tilt. So the constant carries
the opposite sign to the angle anyone measures on screen. Entering the
measured sign directly tilts the bands the wrong way and doubles the
misalignment: that was done on 2026-08-16, and the mistake read as "tilt does
not help" because a sweep that only tried the positive side saw the whole
range fall away from the optimum.

Measured with the real engine over the labelled sweep at 0.1-degree steps,
-1.2 degrees against 0: worst error 0.082 -> 0.078, lowest contrast
0.193 -> 0.198, lowest ambiguity 9.7x -> 14.1x. Accuracy hardly moves; the
margin to the quality gates is what improves, which is the point.

**The optimum is narrow — do not nudge this constant by eye.** Past it the
ambiguity margin falls off a cliff: 14.1x at -1.2, 6.5x at -1.5, 3.9x at -1.8,
against a gate that rejects below 3.0. Re-measure across the sweep instead.
The apparent lean also varies across the tube (0.6 degrees at its left, 1.7 at
its right — perspective on a round glass cylinder), so no single number is
"correct" by measurement alone; the sweep picks it.

Tilt is still searched per frame over roughly +/-3 degrees AROUND that base,
so the search finds how far the camera has tipped SINCE calibration. `analyze()`
reports that deviation, not the absolute angle, and `opts.tilt` overrides the
deviation too — 0 means "as calibrated" everywhere a tilt is shown or entered.
The objective is
registration quality — not peak cleanliness. An objective the ball detector
influences could be optimised into a confident wrong answer. Measured
2026-08-16: with the camera tipped 1 degree, compensating raised ambiguity
from 2.2x to 3.6x and dropped extent from 73 to 33.

**The magnitude gates stay even when every quality gate passes.** After a
34 px slide the engine finds the ball confidently — all gates green — and
still reads 1.73 where the truth is 2.0. The gates measure how well the
ball is *found*; the y->flow curve is bound to the camera pose and degrades
with it in a way no gate can see. Confidence is not accuracy.

**Order matters**: dx is computed first, because the camera slides sideways
and every band below is at a fixed x — measured 34 px on 2026-08-16. Sample
the anchor band at its old x after a sideways slip and dy is meaningless.
The search runs to +/-40 px while the gate rejects beyond 20: a big shift
should be measured and named in the Swedish reason, not silently saturate
at the edge of the search and look like noise.

`buildRef()` is the one place that knows what REF contains — `loadRef()`
uses it in the browser, `validate_engine.mjs` in Node. Add a field there,
never in the callers.

All of those numbers come from the sweep, not from taste: the bands were
measured as the columns where the ball actually moves and where the
printed scale actually is, and each threshold sits well below the worst
value the 27 labelled frames produced.

### Testing
Validated headless (Playwright) against the FIRST sweep: 20 labeled
images (LOO MAE 0.05), a negative suite (garbage frames, occlusions,
large shifts, wrong rotation must be REJECTED), and a tolerance suite
(15 px shift, blur, thin occluder must still read ~correctly). That
suite has NOT been rerun against the 2026-08-16 calibration — the
negative and tolerance cases are the part `validate_engine.mjs` does not
cover, and `reg >= 0.75` in particular was chosen by that negative
suite, not by the sweep.

**In this repo, with its images** (added 2026-09-05): `test/sweep-2026-08-22/`
holds the 23 labelled frames the current calibration is built from, and
`node tools/validate_engine.mjs test/sweep-2026-08-22` runs the real
`balldetector.js` against them, failing (non-zero) on any rejection or a
reading more than 0.2 L/min off its label. The repo had contained everything
DERIVED from that sweep — `REF_PNG`, the bands, `BASE_TILT`, `CAL` — and
nothing to derive it from, so the harness had no data and a recalibration had
nothing to be compared against.

`test/negative-old-poses/` is the same harness pointed the other way:
`--expect-rejected` fails when any frame produces a reading. It holds the 78
frames of the 2026-08-13/15/16 sweeps, from three camera poses that no longer
exist. Their labels are worthless now, which is what makes them useful — a
frame from the wrong pose must be REFUSED. All 78 are. Registration runs
0.224 to 0.785 across the set, median 0.589, and two frames clear the 0.75
gate — but they are caught by dy saturating at -40 and by spread at 159 rows,
so nothing gets through.

**Measure each gate separately; `judge()`'s text cannot tell you which one
matters.** It returns on the first gate that fires and tests margin before
dx/dy, so a frame that fails BOTH prints "två lika starka kandidater" and
reads as an ambiguity catch. Evaluating all five gates independently over the
78 (2026-09-05):

| gate | refuses | is the ONLY gate refusing |
|---|---|---|
| registration | 76 | **8** |
| ambiguity | 49 | 0 |
| shift | 24 | 0 |
| spread | 24 | 0 |
| contrast | 0 | 0 |

So this set constrains registration, and nothing else: remove the ambiguity
gate entirely and it still leaks none of the 78. Which means it is NOT
evidence about a change to ambiguity — the two candidates of 2026-09-05, a
ball-shaped-rival criterion and a next-reference fallback, both leak zero
here, and that says almost nothing about the first of them. The occlusion and
garbage cases are what would.

That covers ONE case of the Playwright negative suite below; garbage,
occlusions, shifts, rotation and the whole tolerance suite are still
uncovered, and are now constructible from the sweep.

**A filter that silently drops what it does not recognise.** Until 2026-09-05
the file filter was `bild_([0-9.]+|min)(max)?L_`, which matched neither
`bild_0_minL_`, `bild_5.7_maxL_` nor `bild_over_maxL_` — the three frames of
the 2026-08-22 sweep that carry a STATE rather than a value. So the two
states this engine can reach besides a number, `Max` and "Under 0,3", were the
only two nothing tested, on a harness whose summary said "20 read" without
saying that 3 were skipped. They pass: the resting stop reads 0.20 -> "Under
0,3", the top mark 5.76 against a 5.7 label, and the past-the-end frame `Max`
at y=146.7. Mean over the 21 frames with a numeric label is 0.030, worst
0.110 — the same numbers as before plus `5.7_max`'s +0.06.

No npm packages, no browser — it decodes with macOS `sips`. Run it after every
engine change. The 2026-08-16 figures this paragraph used to quote (mean
0.031, worst 0.078, 24 read) were the SECOND sweep against the calibration of
its day; that sweep now lives in `test/negative-old-poses/` and is refused in
full, which is correct — it is a different camera pose.

The sips decoder and the browser's now have a much stronger result behind
them than "lands on the labels": run over the same 124 uploaded frames the
admin page had already analysed in Chrome, the offline harness reproduced
every reading to 0.000 L/min with no state disagreement. So an engine change
can be scored offline against real traffic and the answer is what the phone
will show. That is not proof the decoders agree on every possible JPEG, but
it does mean a server-side reading is a decoding question already answered
for this camera.

**The uploaded frames are a second, unlabelled test set — and the device
labels them for free.** Between two `press` rows the knob has not moved, so
every frame in that span shows the same flow (the user's observation,
2026-08-17). That gives three checks no sweep can give: a rejected frame
whose neighbours in the same span DID read has a known truth; every accepted
frame in a span must agree with the others; and a span where the value jumps
without a press means someone turned the knob by hand. All three were used to
choose YTOP/YBOT. Tolerance is about 0.05 L/min, not zero — the ball floats
and genuinely bobs that much (seen as 4.95 / 5.00 / 4.97 in one still span).

Two "Osäker" rows on the first REF_DAY afternoon (ids 1323/1324, 15:26-27
local) taught a lesson about jumping to stories. The obvious explanations —
a float still bobbing 5 s after its -90 step, or the photo catching the NEXT
press (nothing blocks the motor during capture, deliberately, and the 6 s row
gap proves a press landed ~1 s after 1324's photo) — are both plausible and
both WRONG here: the blob's half-width is 27-30 rows, identical to sharp
frames, so nothing was moving. Measured instead: a standing artefact at
y=309 that exists only in afternoon light (absent 10:00, present 0.050 from
~13:30, 0.065 by 15:30 local), which bites only when the ball's own peak
runs weak (0.13-0.16 around y 230-250, against 0.21-0.30 elsewhere). Same
family as the historic 12:51-13:09 UTC artefacts. Id 1325 passed at 6.6x
only because its ball stood close enough to the artefact to fall inside the
ambiguity metric's 60-row exclusion zone.

That watch item fired the same evening: by 17:31 the artefact reached 0.100
and refused two more frames (1338/1339, ball at 4.8 where its peak runs
weak — engine's hidden readings 4.83/4.80 against the span's known 4.80, so
availability lost, accuracy not). REF_DAY was rebuilt that night as v1.10.10
with the whole daylit day in the stack, 25 frames 06:52-19:52: the artefact
dissolves, 117 of the day's 118 uploads read, no reading moved more than
0.052, night sweep still picks night 23/23. The one remaining refusal
(1339, 17:31, 1.9x) is the day's worst-lit frame refusing honestly.

Still true and worth keeping: a frame can go dark for one frame (1324: tube
149 -> 131 while the LED glare held still — a shadow or cloud, not
exposure), and a ball at 4+ sits where the LED's reflection band washes its
contrast down to 0.13-0.17. Both make thin margins in poor light; both fail
as refusals. The dusk handover measured 2026-08-23: day reference carries to
19:52, night takes over at 20:07, no gap.

**A second lamp invalidates the lighting, and the archive keeps the evidence.**
On 2026-09-07 between 16:51 and 17:53 local, nine uploaded frames are refused
with every reference at once: registration falls from 0.95-0.98 to 0.53-0.81
for night, day AND evening, then recovers completely by 18:04. Nothing else in
1053 frames over that week comes close — the best reference clears 0.85 on all
but those nine. The cause was the old floor lamp that used to light the meter
before the WS2812 went in: someone switched it on for an hour. The lamp has
since been removed, so this does not recur, and no detection for it was built.

Worth keeping for two reasons. It is what a genuinely invalidated lighting
looks like in the log — not a wrong number, not one reference disagreeing with
another, but ALL of them refusing together while the readings they would give
still agree with each other to 0.01. And brightness is not a signature: those
frames average 128-143 while frames that read fine either side of them average
108-137. The gate that caught it was registration, on the scale ticks.

**A span can also end without a press: the machine gets switched off.** She
turns the concentrator off when she goes out, so the float drops to its stop
and comes back up when she returns — 4.65, then 0.26, then 3.50 across two
periodic frames on 2026-08-26 (ids 1829-1831), no press between them and
nothing wrong. In the log that looks exactly like a knob turned by hand, and
both are real. So a span that straddles an outing is not one knob position:
check the picture before treating a jump as an engine fault, and do not use
such a span as an anchor.

Beware the third check when using the second: id 218 (2026-08-16 13:09 UTC)
looks like a confidently wrong reading of 4.37 against a "truth" of 2.63 from
its span, and is nothing of the sort — the ball really had moved to 4.3 and
the picture shows it. An anchor from a span is a hypothesis. Look at the
frame before believing it over the engine.

The labelled images are in the repo since 2026-09-05 (see above); the
Playwright suite that does leave-one-out still lives outside it. The repo is
public, and the images went in with that said out loud and agreed — they show
a flow meter, a 3D-printed cup and an LED on a worktop, and a sweep walks the
whole scale deliberately, so it carries no information about what flow the
patient actually uses. The uploaded archive in R2 would; that stays out.

### An engine's calibration has an epoch, and it is a time
A detection engine is calibrated against one camera pose and one lighting, so
running it over frames from before that calibration produces rows that are
noise. The admin page can therefore restrict a re-analysis to frames from a
given time onward (`<details id="epok">`), with the firmware table as a way to
fill that time in.

**The boundary is a timestamp, not a firmware version**, and 2026-08-22 is why:
the WS2812 went in mid-`v1.10.0` and the camera was still being nudged for
another quarter of an hour after that. Measured against engine `79d22250`,
frame 1161 (19:52) registers 0.745 and is refused, frame 1162 (20:06:18)
registers 0.982 and reads. No version number expresses that. Version strings
also do not compare as text — `1.10.0` sorts before `1.9.7` — while ISO8601
sorts chronologically by construction, which is what the filter relies on.

Worth knowing before worrying about it: the engine **refuses** pre-epoch
frames rather than misreading them — registration catches the wrong camera
pose, as it is meant to. The filter keeps the table readable; it is not what
keeps the numbers honest. And `analyses` is keyed `(reading_id, engine)`, so
re-analysing never overwrites what an older engine said about a frame.

### D1 bills rows READ, and the page has to be able to say how many
On 2026-09-11 the admin Worker started throwing 1101 on every request. The
exception was `D1_ERROR: exceeded D1's free tier daily row read limit` — on
the FIRST statement of the handler, before any of that day's changes ran, so
the deploy was innocent and a rollback would not have helped. The quota resets
at midnight UTC and the page came back on its own.

**What consumed it is not known**, and that is the actual finding. Adding up
the day's harvesting — a dozen full sweeps over `readings` joined to
`analyses`, 1361 upserts, a handful of `COUNT`/`GROUP BY` — lands around fifty
thousand rows, not five million. Nothing recorded the one number that would
have answered it: D1 returns `meta.rows_read` on every statement and this
Worker threw it away.

So every statement now goes through `meter()`, which sums `rows_read` and
`rows_written` for the request and logs one line. Observability is enabled, so
it shows in `wrangler tail` and in the dashboard. `.first()` is no longer used
anywhere in the Worker — it returns the row WITHOUT the meta, so a query run
that way is invisible to the meter, and the test harness throws if anything
calls it.

**The firmware list moved to its own endpoint** (`GET /epoker`). It is a
`GROUP BY` over every reading — measured as `SCAN readings` plus two temp
b-trees — and it was running on every page load to fill a `<details>` panel
that is collapsed by default. It is now fetched when the panel is first
opened. Page load went from four statements to three.

Measured plans on the checked-in schema, worth knowing before optimising the
wrong thing: the main rows query is cheap (`SCAN r USING COVERING INDEX
readings_received_at`, stopping at LIMIT, with index seeks for both joins and
the correlated subquery). The `?id=` rank query uses the covering index in
both its old OR form and its current two-term form — a review claim that the
OR defeated the index was wrong.

**Analysing often costs less than analysing seldom.** A re-analysis is charged
per row touched, so a sweep over a fortnight of frames costs what a hundred
daily sweeps cost — except the daily ones spread across a hundred quota
windows and the fortnight lands in one. And harvest metadata ONCE per
investigation: re-querying the same rows for each sub-step is where this
session's reads actually went.

### The control panel is two columns on a laptop
`#cols` wraps `#view` (rotation/mirror, the picture, the reading, the quality
line) and `#panel` (everything else). One column below 920 px — the phone
layout is untouched — and side by side above it, with `#view` sticky so the
picture stays put while the controls scroll. Anything added to the page now
goes inside one of those two wrappers.

The breakpoint is deliberately high: two columns narrower than what the phone
layout gives would make the desktop worse than the phone. And `canvas` is
capped at `calc(100vh - 290px)` in the wide layout rather than left free —
the reading and the quality line still sit under the picture, and a picture
free to fill the viewport pushes the number this page exists to show below
the fold.

### Knob calibration on the control panel (2026-09-27)
"Kalibrera ratten" measures how many degrees the knob needs per L/min along
the scale — the data for the flow-step buttons on her page (v1.11.3), which
stay hidden until its KNOB/BACKLASH line is in the preset. With a table and a
settled number read within 3 s she gets "+0,2 / +1 / +2" and the same down,
clamped to the table and to 1..9 L/min; otherwise the fixed-degree buttons
with a line saying why — never locked (August's rule). knobPlan() in the
engine sizes the turn; the page comments say what each guard is for. The routine turns under 1, back up to 1 (approaching from
below), climbs in small steps to just under the preset's top, measures the
backlash on reversing where the scale can be read, and returns to the start
closed on the reading. Aborts rather than turns on: Max, the flow going the
wrong way or not moving once it has, 15 s without a frame, a refused or
unanswered press, 15 turns. An abort never turns anything back — it says
what it last saw. The whole page is locked during a run except Stopp.
Tested end to end only against a simulated knob (raw frames rebuilt from the
Platinum sweep); its last round of fixes was tested but not cold-reviewed.

The band fields (forced shift/tilt) are remembered per machine
(`ev_<preset>_bDx`): a value set on the EverFlo made the Platinum refuse.

### The control panel's light section (v1.10.0)
`<details id="light">` on `everflo_control_panel.html` only — never on the
device page. On/off, a 0-255 brightness slider and a colour swatch, all
talking to `/api/light`, plus a "Färgtest" button for `/api/led-test`. It
loads the current state on "Starta" with a plain GET, which changes nothing.
Purpose: the light level for a detector is chosen by watching entydighet and
kontrast respond, and those numbers are already on this page.

### Access control (v1.12.0)
For a shared or public wifi at the care home. `#define CONTROL_AUTH 1` (the
default) means everything that turns the knob or changes the device —
plus/minus, step size, light, colour test, restart, firmware check, counter
reset — needs `CONTROL_KEY` from secrets.h; watching (picture, reading,
/api/status, /log) stays open. 0 is the old behaviour. A build switch, not an
app switch: a toggle that turns the lock off would itself need the lock. A
build with 1 and no key of 16+ characters does not compile (the example
file's key is empty for exactly that reason). A MINOR version: turning it on
needs more than a flash — pair her phone at the same time, or her buttons
stay hidden until someone does.

**Challenge-response, not a password in the request.** On an open network
everyone can read the traffic, so a key sent along would be captured and
replayed. The client fetches a one-time nonce (`/api/nonce`) and sends
`h = HMAC-SHA256(key, "<path>?<query up to &h=>")` with the nonce in that
query. The key never crosses the network. Nonces are STATELESS — issue time,
a counter and a tag under a key drawn at boot — so asking for them in a loop
starves nobody (a table of issued nonces could be flushed). Valid 60 s, and
accepted only with a counter above the last one used; the counter moves only
on a correctly signed request, so junk sent with a newer nonce cannot void
hers. Two controllers racing can lose one press; a retry fixes it. The browser side is plain JS (an http page has no
crypto.subtle), identical in her page and the control panel, and
`node tools/test_hmac.mjs` checks both copies against node:crypto.

**Her phone is paired once**: the panel's "Kopplingslänk" shows
`http://syrgas.local/#k=<key>`; opened on her phone, the page stores the key
in that browser and strips it from the address (behind #, never sent). Without
it her page shows the picture and the flow but no buttons, and a line asking
for the link. A refused press says so. The panel keeps a key per device
address. No lockout on failures: a 128-bit key is not guessed, and a lockout
would let anyone on the network take her buttons away.

**What it does not solve**: a guest network with client isolation (her phone
cannot reach the unit at all — test on site before moving it), and one with a
login page in the browser (the unit cannot click through it). Both need the
cloud path instead, which is a larger change. Whoever holds her unlocked phone
can control the flow; that is how she uses it.

**The limit, stated plainly: this stops a listener, not an impostor.** Over
plain http nothing proves the page came from the unit. Someone on the same
network who answers for syrgas.local (mDNS) or poses as its address (ARP)
can serve a page from that origin, read the key out of her browser's
storage and control the knob from then on. Only a transport the phone can
verify — https with a certificate it trusts, or the cloud path — closes that.
On a network with a password that only the care home's residents have, the
risk is small; on an open one it is real.

**Old copies of the control panel stop turning the knob** under CONTROL_AUTH
1: unsigned /api/plus and /api/minus get a 403 — a deliberate change of their
semantics, against the backward-compatibility rule above. Replace any copy on
a phone with the current file.

A refusal says why (`"why":"nonce"` or `"key"`): both pages retry once on a
nonce refusal (a race with another controller, or a restart), and only a key
refusal tells her to ask for a new pairing link. The control panel's "Kolla
firmware nu" is the signed way to /api/fw-check.

### Deployment safety
The system will run live at a patient's home (not yet deployed).
**Never automatic.** An update happens only because a human pushed one; the
device must never look for a build and install it on its own. That rule is
older than OTA and survives it — see "Over-the-air update" below for how each
mechanism keeps it. Keep the previous firmware as a fallback: there is no
bootloader rollback, so a bad image is recovered over USB. Current UI needs
only `/bild` +
`/api/plus|minus` (stable since v1.6.6). `/api/steg?v=N` (implemented
in v1.7.0) adds adjustable step size: clamped in firmware to compiled
4–180°/press, RAM only, reverts to default 39°/press on reboot. The
control panel exposes it as a free number field and shows the value the
firmware actually applied after clamping.

### Over-the-air update (v1.9.2)
ArduinoOTA on port 3232, hostname `syrgas`, so the unit shows up as a network
port in the Arduino IDE. Password-required: `OTA_PASSWORD` in `secrets.h`, and
with no password compiled in OTA stays **off** rather than open. This port can
replace the firmware driving a motor bolted to an oxygen concentrator, so
"whoever is on her wifi" is not an access policy. Same caveat as the other
secrets — esptool can read the password back out of the image, so it defends
against the network, not against someone holding the device.

Two interlocks, and both halves are needed because `move()` runs on the web
server's task while `ArduinoOTA.handle()` runs in `loop()`: `loop()` withholds
`handle()` while `busy`, and `move()` refuses while `otaActive`. Without the
second, a button pressed mid-update turns the knob while the app partition is
being rewritten.

`ArduinoOTA.setMdnsEnabled(false)` is deliberate. mDNS is already up from
`setup()`, and `ArduinoOTA.begin()` would call `MDNS.begin()` a second time,
which fails with "already initialized" and logs what looks like a fault. The
`_arduino._tcp` record is registered by hand instead — that record is what puts
the device in the IDE's port list.

**The update gets the whole machine** (v1.9.6). Both paths stop the camera and
both HTTP servers before anything touches flash, and the receive timeout is
raised from the library's 1000 ms to 5000 ms. The first real attempt died at 9%
with "receive failed": a flash write on an ESP32 disables the cache and stalls
every other task, and this device also grabs frames without ever idling and
answers on two ports, so nothing was left to service the incoming stream.
Order inside `otaQuiesce()` is load-bearing — servers first, camera last,
because `httpd_stop()` blocks until a running handler returns and the reverse
would free frame buffers under a request still being served. `otaResume()`
tears down before bringing up so a double call is harmless, which matters
because ArduinoOTA's connect-failure branch calls the error callback twice; and
if the camera will not come back it restarts the device rather than sit blind.

**LAN only.** espota talks to the device directly, so this removes the cable
from a visit, not the visit. No bootloader rollback either: the Arduino core
does not enable it, so a firmware that boots badly still needs USB. What makes
that acceptable is that the concentrator does not depend on the ESP32 at all —
the driver idles disabled, the knob turns by hand, and a bricked unit costs the
remote control, not the oxygen.

### Cloud-pull OTA (v1.9.3, certificate pinned in v1.9.4) — update from anywhere
The device asks the ingest Worker every 15 minutes whether a human has left a
build waiting. It never pushes, and the device never chooses. Two verbs keep
the old rule intact:

```sh
node tools/publish_firmware.mjs publish build/…/everflo_remote_control.ino.bin 1.9.3
node tools/publish_firmware.mjs arm 1.9.3        # the separate, deliberate act
node tools/publish_firmware.mjs status | disarm
```

Publishing is inert — the build sits in R2 and the device is told nothing.
Arming is what lets a unit at a patient's home replace its own firmware, so it
costs its own command. A single `deploy` verb would make the dangerous thing
the easy thing. `firmware.armed_at` carries this, and a partial unique index
(`firmware_one_armed`) makes "at most one armed build" a property of the
database rather than of the tool that writes it.

`arm` **is a production action**: the unit installs within 15 minutes and
reboots.

**The rule is: do not arm unless you are close enough to drive over and fix it**
(the operator's own words, 2026-09-12). Not "only arm a build you have seen
boot" — that is what this said until then, and read literally it makes the
whole cloud path pointless: standing next to the unit you do not need it, and
away from it you can never satisfy the condition. Arming a fresh build forward
is a leap no rule removes without a second device to try it on first. If you
have a spare XIAO on the bench, that is the order that buys something: flash
the bench, watch it boot, then arm for hers.

**What the old wording was reaching for is the rollback direction, and there
it is exactly right.** There is no bootloader rollback, so the only way out of
a bad build from a distance is to arm a DIFFERENT one — and that one has to be
a build you know boots. Every previous version stays in R2 for this. The
asymmetry to have clear before arming:

- **Boots but behaves wrong** — the unit reports in, `armed_at` clears, you arm
  the previous version and it is back within 15 minutes. No trip.
- **Does not boot at all** — it never reports, the bad build stays armed
  (correctly — it never landed), and recovery is a trip with a USB cable.

So the question before arming is not "has this image booted somewhere" but
"if it lands in the second case tonight, can I get there". What a bricked unit
costs is the remote control, not the oxygen: the driver idles disabled and the
knob turns by hand.

The loop closes on the device's own report: the ingest handler clears
`armed_at` when a reading arrives carrying that version. So "armed" means
"waiting to land", and a build that bricks the unit stays armed — correctly,
because it never landed. `lastFwCheck` is seeded to `millis()` rather than 0 so
a unit in a boot loop cannot ask for the build that is crashing it seconds
after every boot.

Endpoints (both bearer-token, same token as ingest): `GET /firmware?fw=<current>`
answers 204 for "nothing armed" *and* for "what is armed is what you already
run"; `GET /firmware.bin?v=<version>` streams it with `x-MD5`, which is the
header HTTPUpdate verifies against, and 404s if that version is no longer the
armed one. Content-length comes from the R2 object, never the D1 row — a
disagreement between them would truncate the transfer before the MD5 was ever
checked, so the Worker refuses with 500 instead.

MD5 catches a corrupted download, not a hostile one. Whoever can write the R2
object or the D1 row owns this device. Note the asymmetry that limits the
damage from the device's own credential: the token can only *read* firmware —
arming needs Cloudflare credentials, so a leaked device token cannot install
anything.

**The firmware endpoints are the one place TLS is verified** (`cloud_roots.h`,
added v1.9.4). Everywhere else in the sketch uses `setInsecure()`, which was a
fair trade when a man-in-the-middle could at worst read a picture of a flow
meter or collect a write-only token. It stops being fair when the same
connection can hand the device its next firmware: unverified TLS plus OTA is
remote code execution with extra steps, on hardware bolted to an oxygen
concentrator. Both firmware requests therefore pin the roots the Worker's
certificate actually chains to — GTS Root R4 (what Cloudflare issues from
today) and ISRG Root X1 (because they rotate CAs and a rotation must not brick
the update path). Verified against the live chain 2026-08-17. A move to a third
CA makes verification fail and the update simply not happen, which is the safe
direction, and ArduinoOTA over the LAN is still there to fix it.
`cloud_roots.h` is generated from the macOS system trust store; the roots
expire 2035 and 2036.

Verified end to end 2026-08-17 without the device: publish-does-not-offer,
arm-offers, never-offer-what-it-runs, 1.37 MB downloaded byte-identical to the
local build with a matching `x-MD5`, 403 without a token, 404 on a stale
version, and disarm-on-report. The synthetic reading used for the last one was
deleted afterwards.

## Wishlist / backlog
- Share one frame between simultaneous `/bild` viewers. Today every request
  calls `esp_camera_fb_get()`, so N viewers cost N captures and each sees a
  different frame. The port 80 httpd runs in a single task and handles
  requests sequentially, so a cache touched only by `h_snapshot` needs no
  mutex: a PSRAM buffer plus a timestamp, serving the stored JPEG when it
  is younger than ~200 ms. Do NOT share that cache with `loop()` or the
  port 81 stream server — that would need synchronisation across three
  tasks. Saves capture and JPEG encoding, not bandwidth. Deferred from
  2026-08-15: nothing is broken, it could not be tested before the visit,
  and a cache is a deliberately stale frame in a system whose whole point
  is that the image is current.
- **Rename the Swedish URL paths to English** (`/bild`, `/api/nollstall`,
  `/api/omstart`, `/api/steg`). Agreed 2026-08-22: they are wire format, none
  of it is text the patient reads, and the language split says English there.
  New paths are already being named in English (`/api/ui-pulse`,
  `/api/led-test`). Its own commit, not folded into a feature, and the hazard
  to design around is that **the control panel is deployed by copying a file
  to a phone** — there is no guarantee the copy on her phone matches the repo,
  so a rename can silently kill a panel that has been sitting there since
  summer. Serve both names for a release, then drop the old ones once the
  copies in the wild have been replaced. The NVS key `"lage"` and the
  `localStorage` keys are NOT part of this: renaming those loses stored state.
- `/api/glomwifi` (force portal without physical access)
- ArduinoOTA and cloud-pull OTA both done (v1.9.2, v1.9.3) — see above
