# Test images

Two sets, and they are checked in opposite directions. Both run through the
same harness so the two directions cannot drift apart:

```sh
node tools/validate_engine.mjs test/sweep-2026-08-22
node tools/validate_engine.mjs test/negative-old-poses --expect-rejected
```

## `sweep-2026-08-22/` — the calibration in force

The 23 labelled frames the current engine is built from: `REF_PNG`, the bands,
`BASE_TILT` and `CAL` all come from these. Taken 2026-08-22 20:06–20:14 under
the WS2812 at level 50 in a dark kitchen — the lighting the unit actually runs
in. Every frame must read within 0.2 L/min of its label.

They are here because the repo already contained everything *derived* from
them and nothing to derive it from. A recalibration is judged by comparing the
new sweep against this one, and `tools/validate_engine.mjs` had no data to run
against without them.

Three frames carry a state rather than a value: `0_min` is the ball against
its resting stop (must produce a reading, and does so as "Under 0,3" — there
is no true value to compare against), `5.7_max` is the top mark, and
`over_max` was taken deliberately past the end of the printed scale and must
come back as `Max` rather than as a number.

## `negative-old-poses/` — 78 frames that must be refused

The sweeps from 2026-08-13, 08-15 and 08-16, from three camera poses that no
longer exist. Their labels were true when they were taken and are worthless
now, which is exactly what makes them useful: a frame from the wrong camera
pose must be **refused**, not read, and these are real frames rather than
synthetic ones. Measured 2026-09-05: all 78 refused, registration 0.29–0.58
against the 0.75 gate.

Do NOT run the plain harness over this directory — without `--expect-rejected`
it reports 78 failures, which is the correct answer to the wrong question.

This covers one case of the negative suite described in CLAUDE.md. Garbage
frames, occlusions, large shifts and wrong rotation are still uncovered, as is
the tolerance suite that says a 15 px shift, blur or a thin occluder must
still read about right. Those are constructible from the sweep above.
