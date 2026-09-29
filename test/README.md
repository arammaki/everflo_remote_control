# Test images

Sets checked in opposite directions — a sweep must read, an old pose must be
refused. All run through the same harness so the two directions cannot drift apart:

```sh
node tools/validate_engine.mjs test/sweep-2026-08-22
node tools/validate_engine.mjs test/negative-old-poses --expect-rejected
node tools/validate_engine.mjs test/platinum9-sweep-2026-09-29
node tools/validate_engine.mjs test/negative-platinum9-2026-09-26 --expect-rejected
```

Every directory carries a `PRESET` file naming the concentrator its frames
are of (`everflo` or `platinum9`). The harness reads it and refuses to
run without one: a sweep scored against the wrong machine's calibration is
refused wholesale, which looks exactly like an engine that has broken. A new
machine's sweep goes in its own directory with its own `PRESET`.

## `sweep-2026-08-22/` — the calibration in force

The 23 labelled frames the current engine is built from: `REF_PNG`, the bands,
`BASE_TILT` and `CAL` all come from these. Taken 2026-08-22 20:06–20:14 under
the WS2812 at level 50 in a dark kitchen — the lighting the unit actually runs
in. The 21 frames carrying a number must read within 0.2 L/min of it.

They are here because the repo already contained everything *derived* from
them and nothing to derive it from. A recalibration is judged by comparing the
new sweep against this one, and `tools/validate_engine.mjs` had no data to run
against without them.

Two frames carry a state rather than a value. `0_min` is the ball against its
resting stop: it must produce a reading, and does so as "Under 0,3" — there is
no true value to compare against. `over_max` was taken deliberately past the
end of the printed scale and must come back as `Max` rather than as a number.
`5.7_max` despite its name is an ordinary labelled value, the top mark, and is
compared numerically: it reads 5.76 at y=154.4, four pixels below the Max
boundary at y=150.

## `negative-old-poses/` — 78 frames that must be refused

The sweeps from 2026-08-13, 08-15 and 08-16, from three camera poses that no
longer exist. Their labels were true when they were taken and are worthless
now, which is exactly what makes them useful: a frame from the wrong camera
pose must be **refused**, not read, and these are real frames rather than
synthetic ones. Measured 2026-09-05: all 78 refused. Registration runs
0.224–0.785 and two of them clear the 0.75 gate, but shift and spread catch
those.

**What this set does and does not prove.** Evaluate each gate on its own and
registration refuses 76 of the 78 and is the sole reason on 8; ambiguity
refuses 49 but is never the only gate refusing, and contrast never fires. So
the set constrains registration, and a change that loosened ambiguity would
pass it while being entirely untested. Do not read a green run here as
permission to touch that gate — `judge()` returns on the first gate that
fires, so its printed reason will happily say "ambiguity" for a frame the
shift gate was also refusing.

Do NOT run the plain harness over this directory — without `--expect-rejected`
it reports 78 failures, which is the correct answer to the wrong question.

This covers one case of the negative suite described in CLAUDE.md. Garbage
frames, occlusions, large shifts and wrong rotation are still uncovered, as is
the tolerance suite that says a 15 px shift, blur or a thin occluder must
still read about right. Those are constructible from the sweep above.

## `platinum9-sweep-2026-09-29/` — the Invacare Platinum 9's calibration

21 labelled frames, 0 to 9 L/min in half steps, the resting stop (`0_min`)
and the ball on the red line (`max`, which must read as a number — the Max
state begins above the line). Taken 2026-09-29 16:39–16:45 local in DAYLIGHT with
the WS2812 on, after the camera had been moved.

The motor mount had been made smaller, so this time the labels up to 7 were
read straight on; from 7.5 up they were read from the side and are named
`<n>_approx`, as are 0.5 and 0.75 below the calibrated range. They are held only to a loose bound — between the label
minus 1 and the label plus the tolerance — and never fitted to. The curve
comes from the printed scale: see the CAL comment in the preset.

Its `TOLERANCE` is 0.35 L/min, not the default 0.2, and the reason is the
half marks: 1.5 and 2.5 read +0.16 and +0.29, 5.5 and 6.5 −0.20 and −0.25.
Against the printed ticks they drift steadily with height (5-6 px off at the
bottom, 13-14 at the top), while every whole mark 1..7 sits within 9-12 px of
its tick — a midpoint judged by eye, not a curve error. That is how the knob
was set, not a looser gate — the engine's quality thresholds are the same for
every machine.

Cross-checked 2026-09-29: these frames read as `everflo` are refused 21/21,
and the EverFlo sweep plus the 78 old poses read as `platinum9` are refused
101/101.

## `platinum9-sweep-2026-09-29-kvall/` — the second Platinum reference

20 labelled frames taken 17:47–17:52 local the same day, late-afternoon light with
no sun in the room, from which `REF_PNG_PLATINUM9_KVALL` is built (each frame
shifted back by its own dx/dy against the day reference first: the camera sat
8–14 px further right by then). **Not a must-pass set yet**: under the free
tilt search 4 frames are refused (0_min, 0.5, 4.5, 6.5 — the search steps 1
degree off and the ticks near the top become rivals). With the tilt locked at
0 all 20 read, within about 0.1 of their labels on the whole marks. The mount
twists with the knob; see the comment at the preset's `refs`.

## `negative-platinum9-2026-09-26/` — the Platinum's first pose, refused

The first Platinum sweep (2026-09-26 21:31–21:35 UTC, night, WS2812 plus the
ceiling lamp). The camera has been moved since, so like `negative-old-poses/`
it is run with `--expect-rejected`: all 21 refused (registration 0.62 at
best, against the 0.75 gate).
