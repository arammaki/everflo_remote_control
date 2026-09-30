# Test images

Sets checked in opposite directions — a sweep must read, an old pose must be
refused. All run through the same harness so the two directions cannot drift apart:

```sh
node tools/validate_engine.mjs test/sweep-2026-08-22
node tools/validate_engine.mjs test/negative-old-poses --expect-rejected
node tools/validate_engine.mjs test/platinum9-sweep-2026-09-30
node tools/validate_engine.mjs test/negative-platinum9-2026-09-29 --expect-rejected
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

## `platinum9-sweep-2026-09-30/` — the Invacare Platinum 9's calibration

20 labelled frames taken 2026-09-30 11:51–11:55 local at the care home, a lamp
on in the hall and the WS2812 on: the resting stop (`0_min`), 0.5 to 9 in half
steps and the ball on the red line (`max`, which must read as a number — the
Max state begins above the line). Labels up to 7 were read straight on; 0.5
and 7.5 up are `<n>_approx`, held to label − 1 .. label + tolerance and never
fitted to. The curve comes from the printed scale with a height-dependent
parallax; see the CAL comment in the preset.

Its `TOLERANCE` is 0.3 L/min, not the default 0.2, for one label: 5.5 reads
−0.24 and sits 18 px from its neighbour 6 where every other half step is 9–13.
The other straight-on labels read within 0.15.

Cross-checked 2026-09-30: these frames read as `everflo` are refused 20/20,
and the EverFlo sweep plus the 78 old poses read as `platinum9` 101/101.

## `negative-platinum9-2026-09-29/` — the kitchen pose, refused

Both sweeps of 2026-09-29 in the kitchen (16:39–16:45 daylight, 17:47–17:52
later light; the file names carry UTC), 41 frames. They calibrated the
Platinum for a day; the unit then moved to the care home and the camera with
it. Run with `--expect-rejected`: all 41 refused.

## `negative-platinum9-2026-09-26/` — the Platinum's first pose, refused

The first Platinum sweep (2026-09-26 21:31–21:35 UTC, night, WS2812 plus the
ceiling lamp). The camera has been moved since, so like `negative-old-poses/`
it is run with `--expect-rejected`: all 21 refused (registration 0.62 at
best, against the 0.75 gate).
