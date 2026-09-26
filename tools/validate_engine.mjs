#!/usr/bin/env node
/* ============================================================
   Runs the real balldetector.js against a directory of labelled
   images and reports the error against the label in each filename.

       node tools/validate_engine.mjs test/sweep-2026-08-22

   Which concentrator preset to validate against comes from a file named
   PRESET in the directory (one line, e.g. "everflo"), or from --preset <id>.
   One of the two is required, and if both are given they must agree: a sweep
   validated against the wrong machine's calibration is refused wholesale,
   which looks exactly like an engine that has broken.

   Run this after ANY change to balldetector.js. The engine reads oxygen
   flow for a patient; a refactor that looks harmless can move a number or
   silently disable a quality gate, and neither shows up in a diff.

   Requires macOS `sips` (built in) and nothing else — no npm packages,
   no browser. Files are named bild_<label>L_<timestamp>.jpg, and the label
   says what the frame must produce — see parseName() for the forms and for
   what each one asserts. A file that starts with bild_ and cannot be parsed
   is a hard error, never a skip: an image is either asserted about or it
   stops the run.

   --expect-rejected takes ANY image, labelled or not. A garbage frame, an
   occluded one or a rotated one has no flow to name, and demanding a label
   there would have made the next half of the negative suite unbuildable.

   Two honest limitations:

   - The JPEG is decoded by sips, not by a browser. Measured 2026-08-15
     the difference does not matter (mean error 0.045, worst 0.133 against
     the labels, same ballpark as the browser-based suite), but this is
     not proof that the two decoders agree everywhere.
   - The embedded reference image was built from a sweep that includes
     these frames, so this is not leave-one-out. It catches regressions;
     it does not measure generalisation.

   Exits non-zero when an image is rejected or read more than 0.2 L/min
   off its label, so it works as a gate before committing.
   ============================================================ */

import { readFileSync, writeFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const TOLERANCE = 0.2;
const here = dirname(fileURLToPath(import.meta.url));
const ENGINE = join(here, '..', 'balldetector.js');

const args = process.argv.slice(2);
/* The negative direction of the same harness: point it at frames that MUST be
   refused — a different camera pose, an occlusion, a garbage frame — and it
   fails when any of them produces a number. Same decode, same references, so
   the two directions cannot drift apart. */
const expectRejected = args.includes('--expect-rejected');
const pi = args.indexOf('--preset');
const presetFlag = pi >= 0 ? args[pi + 1] : null;
if (pi >= 0 && (!presetFlag || presetFlag.startsWith('--'))) {
  console.error('--preset needs a value, e.g. --preset everflo');
  process.exit(2);
}
// A misspelt flag must not run the opposite assertion in silence.
const badFlag = args.find((a) => a.startsWith('--') && a !== '--expect-rejected' && a !== '--preset');
if (badFlag) {
  console.error(`Unknown option ${badFlag}`);
  process.exit(2);
}
const dirs = args.filter((a, i) => !a.startsWith('--') && !(pi >= 0 && i === pi + 1));
if (dirs.length > 1) {
  console.error(`One directory at a time, got: ${dirs.join(', ')}`);
  process.exit(2);
}
const imageDir = dirs[0];
if (!imageDir) {
  console.error('Usage: node tools/validate_engine.mjs <dir with bild_*.jpg> [--expect-rejected] [--preset <id>]');
  process.exit(2);
}

let presetFile = null;
try {
  presetFile = readFileSync(join(imageDir, 'PRESET'), 'utf8').trim();
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
}
if (presetFile !== null && presetFlag !== null && presetFile !== presetFlag) {
  console.error(`${imageDir}/PRESET says "${presetFile}", --preset says "${presetFlag}"`);
  process.exit(2);
}
const presetId = presetFlag ?? presetFile;
if (!presetId) {
  console.error(`Which concentrator? Put its preset id in ${imageDir}/PRESET, or pass --preset <id>.`);
  process.exit(2);
}

const work = mkdtempSync(join(tmpdir(), 'everflo-validate-'));
const toBmp = (src, name) => {
  const out = join(work, name + '.bmp');
  execFileSync('sips', ['-s', 'format', 'bmp', src, '--out', out], { stdio: 'ignore' });
  return out;
};

/* The engine file is used as-is, with an export line appended. References go
   in through setRefs(), because loadRef() needs Image and canvas, which Node
   does not have. */
const src = readFileSync(ENGINE, 'utf8');
writeFileSync(join(work, 'engine.mjs'), src +
  '\nexport { T,toGray,flatfield,buildRef,analyze,judge,PRESETS,usePreset,setRefs,isCalibrated };\n');
const E = await import(pathToFileURL(join(work, 'engine.mjs')).href);
if (!Object.prototype.hasOwnProperty.call(E.PRESETS, presetId)) {
  console.error(`Unknown preset "${presetId}". The engine has: ${Object.keys(E.PRESETS).join(', ')}`);
  process.exit(2);
}
E.usePreset(presetId);

/** 24-bit uncompressed BMP, either row order. */
function readBmp(path) {
  const d = readFileSync(path);
  const off = d.readUInt32LE(10);
  const w = d.readInt32LE(18);
  const hRaw = d.readInt32LE(22);
  const bpp = d.readUInt16LE(28);
  if (bpp !== 24) throw new Error(`${path}: ${bpp} bpp, expected 24`);
  const h = Math.abs(hRaw), topDown = hRaw < 0;
  const stride = Math.ceil((w * 3) / 4) * 4;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const row = off + (topDown ? y : h - 1 - y) * stride;
    for (let x = 0; x < w; x++) {
      const s = row + x * 3, t = (y * w + x) * 4;
      data[t] = d[s + 2]; data[t + 1] = d[s + 1]; data[t + 2] = d[s]; data[t + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

/* Every reference the preset carries, built the way loadRef() does, because
   the selection is per frame: a harness holding fewer references than the
   phone does reports a different engine. For the EverFlo night sweep this also
   proves the selection picks the night reference for night frames — a day
   reference that out-registered it would show up here as readings drifting. */
const refs = E.PRESETS[presetId].refs().map(([dataUrl, name], i) => {
  const png = join(work, `ref${i}.png`);
  writeFileSync(png, Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'));
  return [E.buildRef(E.flatfield(E.toGray(readBmp(toBmp(png, `ref${i}`))))), name];
});
E.setRefs(refs);
console.log(`preset ${presetId}: ${E.PRESETS[presetId].name}, ${refs.length} reference(s)` +
            (E.isCalibrated(presetId) ? '' : ' — NOT CALIBRATED, every frame will be refused'));

/* Three naming generations live in the saved sweeps, and a filter that
   silently drops the ones it does not recognise is worse than one that fails
   loudly: the three it dropped here were the resting stop, the top mark, and
   the frame taken past the end of the scale — the only frames that reach the
   "Under 0,3" and Max states, which is to say the only ones that would catch
   YTOP or YBOT being moved far enough to make those states unreachable.
   Measured 2026-09-05: 20 of the 23 frames in the 2026-08-22 sweep were being
   scored, and the summary line said "20 read" without saying 3 were skipped.

   So the label is parsed into what the frame must PRODUCE, and an
   unrecognised label stops the run. Accepting it and quietly having nothing
   to compare against would put the same hole back one level down — a frame
   named bild_2,5L_... with a comma would then be listed, never checked, and
   the run would still be green.

     bild_2.5L_...       'value'    read within TOLERANCE of 2.5
     bild_minL_...       'reading'  the resting stop (sweeps up to 2026-08-16)
     bild_0_minL_...     'reading'  the resting stop (2026-08-22 sweep). The
                                    ball is against its stop, not at a flow,
                                    so the 0 is a name and not a label.
     bild_maxL_...       'reading'  the top mark, unlabelled (older sweeps)
     bild_5.7maxL_...    'value'    the top mark with its value
     bild_5.7_maxL_...   'value'    ditto (2026-08-22 sweep)
     bild_over_maxL_...  'max'      deliberately past the end of the printed
                                    scale: the Max state, NOT a number. A
                                    number here means the y<Y_MAX_STATE guard
                                    has stopped guarding. */
function parseName(file) {
  const m = file.match(/^bild_(.+?)L_.*\.jpe?g$/i);
  if (!m) return null;
  const s = m[1];
  if (/^over_max$/i.test(s)) return { name: s, expect: 'max', value: null };
  if (/^(\d+(\.\d+)?_)?min$/i.test(s)) return { name: s, expect: 'reading', value: null };
  if (/^max$/i.test(s)) return { name: s, expect: 'reading', value: null };
  const mx = s.match(/^(\d+(?:\.\d+)?)_?max$/i);
  if (mx) return { name: s, expect: 'value', value: Number(mx[1]) };
  if (/^\d+(\.\d+)?$/.test(s)) return { name: s, expect: 'value', value: Number(s) };
  return { name: s, expect: null, value: null };      // recognised shape, unknown label
}

let entries;
try {
  entries = readdirSync(imageDir);
} catch (e) {
  // Misuse, not a failed validation: a typo in the path must not report as an
  // engine regression on a tool whose whole job is to be a gate.
  console.error(`Cannot read ${imageDir}: ${e.code === 'ENOENT' ? 'no such directory' : e.message}`);
  process.exit(2);
}
const images = entries.filter((f) => /\.jpe?g$/i.test(f)).sort();
const files = expectRejected ? images : images.filter((f) => parseName(f)).sort();
if (!files.length) {
  console.error(`No ${expectRejected ? 'images' : 'bild_*.jpg'} found in ${imageDir}`);
  process.exit(2);
}
if (!expectRejected) {
  /* Two ways a frame could go unasserted, and both stop the run. The first is
     a label shape parseName() knows nothing about; the second is a name that
     misses the bild_<label>L_ shape entirely — a lost underscore, or a save
     that fell back to the control panel's default label — which the filter
     above would drop in silence. That silent drop is the bug this tool has
     now had twice, so it is checked rather than reasoned about. */
  const bad = images.filter((f) => { const p = parseName(f); return !p || !p.expect; });
  if (bad.length) {
    console.error(`Cannot tell what these frames must produce: ${bad.join(', ')}\n` +
                  'Add the form to parseName() or rename the file — this tool ' +
                  'will not run over frames it cannot assert anything about.');
    process.exit(2);
  }
}

console.log('label      read   diff  | contrast  unamb  match  shift  spread | verdict');
let sum = 0, n = 0, worst = 0, failures = 0;

for (const f of files) {
  const p = parseName(f) ?? { name: f.replace(/\.jpe?g$/i, '').slice(0, 20), expect: null, value: null };
  const label = p.name;
  const r = E.analyze(readBmp(toBmp(join(imageDir, f), label.replace(/\W/g, '_'))));
  const b = E.judge(r);
  // The engine's own wording, so a verdict here can be grepped for in the log
  // and on the page the patient reads.
  const verdict = !b.ok ? 'REJECTED' : b.maxState ? 'Max' : b.bottomState ? b.label
                : b.extrapolated ? 'ok (extrapolated)' : 'ok';
  const read = b.ok && !b.maxState;

  /* --expect-rejected turns the assertion around: every frame must be
     REJECTED, which is what a wrong camera pose, an occlusion or a garbage
     frame has to do. Otherwise the label says what to assert. */
  let diff = '';
  if (expectRejected) {
    if (verdict !== 'REJECTED') failures++;
  } else if (p.expect === 'max') {
    if (verdict !== 'Max') failures++;
  } else if (!read) {
    failures++;
  } else if (p.expect === 'value') {
    const d = r.flow - p.value;
    diff = (d >= 0 ? '+' : '') + d.toFixed(2);
    sum += Math.abs(d); n++; worst = Math.max(worst, Math.abs(d));
    if (Math.abs(d) > TOLERANCE) failures++;
  }

  console.log(
    `${label.padEnd(10)} ${read && !b.bottomState ? r.flow.toFixed(2).padStart(5) : '  -  '} ${diff.padStart(6)} |` +
    ` ${r.peak.toFixed(3).padStart(8)} ${r.margin.toFixed(1).padStart(5)}x ${r.reg.toFixed(2).padStart(6)}` +
    ` ${r.dy.toFixed(1).padStart(6)} ${String(r.spread).padStart(7)} | ${verdict}` +
    (verdict === 'REJECTED' ? ' - ' + b.reason.slice(0, 50) : ''));
}

/* Says how many frames were SEEN, not only how many were scored numerically:
   the difference between those two numbers is where the skipped frames hid. */
console.log(expectRejected
  ? `\n${files.length} frames, ${files.length - failures} rejected as required, ` +
    `${failures} produced a reading`
  : `\n${files.length} frames, mean ${n ? (sum / n).toFixed(3) : '-'} L/min over the ` +
    `${n} with a labelled value, worst ${n ? worst.toFixed(3) : '-'}, ` +
    `${failures} outside tolerance or rejected`);
process.exit(failures ? 1 : 0);
