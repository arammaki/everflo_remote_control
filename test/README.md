# Test images

Sets checked in opposite directions — a sweep must read, an old pose must be
refused. All run through the same harness so the two directions cannot drift apart:

```sh
node tools/validate_engine.mjs test/sweep-2026-08-22
node tools/validate_engine.mjs test/negative-old-poses --expect-rejected
node tools/validate_engine.mjs test/platinum9-sweep-2026-09-30b
node tools/validate_engine.mjs test/platinum9-sweep-2026-09-30b-natt
node tools/validate_engine.mjs test/negative-platinum9-2026-09-30 --expect-rejected
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

## `platinum9-sweep-2026-09-30b/` and `-natt/` — the Platinum 9's calibration

The fourth camera pose, at the care home. Day: 21 labelled frames, 14:21–14:26
local, the hall lamp on — the reference, the bands and the curve come from it.
Night: 20 frames, 14:27–14:30, the lamp off and the curtains drawn — its own
reference, shifted into the day one's coordinates, and never fitted to. Labels
up to 7 were read straight on; 0.5, 0.75 and 7.5 up are `<n>_approx`, held to
label − 1 .. label + tolerance.

Day 21/21, mean 0.094, worst 0.33; night 17/20, mean 0.093, worst 0.29. The
night sweep's resting ball, 0.5 and 1 L/min are refused at the calibrated
tilt (since `TILT_MARGIN`, 1.12.14) and listed in its `ALLOW_REFUSED` — a
file the harness reads: a listed label may be refused without failing the
sweep, anything else refused still fails it, and a listed frame that reads is
still held to its label. `TOLERANCE` is 0.35 in both for the half marks,
judged by eye between ticks (day 2.5 +0.33, night 6.5 −0.29); the whole marks
1..7 read within 0.12 (day) and 0.18 (night). `ALIGN_GEOMETRY.json` is the
geometry each reference was aligned with (see tools/align_reference.mjs).

Cross-checked 2026-09-30: both read as `everflo` are refused 41/41, and the
EverFlo sweep plus the 78 old poses read as `platinum9` are refused 101/101.

## `negative-platinum9-2026-09-30/` — the care home's morning pose, refused

The two sweeps of 2026-09-30 11:51–12:02 (day and dark), from the pose the
camera had before it was moved again at noon: 40 frames, all refused.

## `negative-platinum9-2026-09-29/` and `platinum9-kitchen-2026-09-29/`

The kitchen sweeps of 2026-09-29 (41 frames), split when the fourth pose
came. 33 are refused against it (`negative-…`, in the suite) — and they are
the only Platinum frames refused by dx alone (17, at 24–29 px) or ambiguity
alone (2), which is what they are kept for: the other Platinum negative sets
fail three or four gates at once. The other 8 (`platinum9-kitchen-…`, 3.5 to
7.5 of the daylight sweep) read, registration 0.77–0.82, and read right:
3.63, 3.94, 4.47, 5.43, 6.07, 6.38, 7.05 against 3.5, 4, 4.5, 5.5, 6, 6.5, 7
— within 0.13; the side-read 7.5 read 7.19 until 1.12.14 and is refused
since. The camera at the care
home ended up close to where it sat in the kitchen. That set is not in the
suite: it reads by coincidence of pose, and a future pose may refuse it.

## `negative-platinum9-2026-09-26/` — the Platinum's first pose, refused

The first Platinum sweep (2026-09-26 21:31–21:35 UTC, night, WS2812 plus the
ceiling lamp). The camera has been moved since, so like `negative-old-poses/`
it is run with `--expect-rejected`: all 21 refused. Registration against the
current references reaches 0.52 at best (it reached 0.72 against the
morning pose's, 2026-09-30).
