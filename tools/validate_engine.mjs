#!/usr/bin/env node
/* ============================================================
   Runs the real balldetector.js against a directory of labelled
   images and reports the error against the label in each filename.

       node tools/validate_engine.mjs ~/Downloads

   Run this after ANY change to balldetector.js. The engine reads oxygen
   flow for a patient; a refactor that looks harmless can move a number or
   silently disable a quality gate, and neither shows up in a diff.

   Requires macOS `sips` (built in) and nothing else — no npm packages,
   no browser. Files must be named bild_<flow>L_<timestamp>.jpg, where
   <flow> is the reading, optionally followed by "max" for the frame
   with the knob at its stop, which must read as Max and not as a number.

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
const imageDir = args.find((a) => !a.startsWith('--'));
if (!imageDir) {
  console.error('Usage: node tools/validate_engine.mjs <dir with bild_*.jpg> [--expect-rejected]');
  process.exit(2);
}

const work = mkdtempSync(join(tmpdir(), 'everflo-validate-'));
const toBmp = (src, name) => {
  const out = join(work, name + '.bmp');
  execFileSync('sips', ['-s', 'format', 'bmp', src, '--out', out], { stdio: 'ignore' });
  return out;
};

/* The engine file is used as-is. It only gets a REF setter appended,
   because loadRef() needs Image and canvas, which Node does not have. */
const src = readFileSync(ENGINE, 'utf8');
writeFileSync(join(work, 'engine.mjs'), src +
  '\nexport function __setREF(r){ REF = r; }\n' +
  '\nexport function __setREFS(n, d, e){ REF = n; REF_DAY = d; REF_EVENING = e; }\n' +
  'export { T,toGray,flatfield,buildRef,analyze,judge };\n');
const E = await import(pathToFileURL(join(work, 'engine.mjs')).href);

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

// Rebuild BOTH references the way loadRef() does, from the engine's own
// embedded PNGs. Both, deliberately: the labelled sweep is a night sweep, so
// this also proves the selection picks the night reference for night frames —
// a day reference that somehow out-registered it on sweep frames would show
// up here as readings drifting, not stay hidden behind a single-ref harness.
const refPng = join(work, 'ref.png');
writeFileSync(refPng, Buffer.from(
  src.match(/const REF_PNG="data:image\/png;base64,([^"]+)"/)[1], 'base64'));
const night = E.buildRef(E.flatfield(E.toGray(readBmp(toBmp(refPng, 'ref')))));
/* Every reference the engine carries, because the selection is per frame:
   a harness holding fewer than the phone does reports a different engine. */
const extra = (name, file) => {
  const m = src.match(new RegExp(`const ${name}="data:image/png;base64,([^"]+)"`));
  if (!m) return null;
  const png = join(work, file + '.png');
  writeFileSync(png, Buffer.from(m[1], 'base64'));
  return E.buildRef(E.flatfield(E.toGray(readBmp(toBmp(png, file)))));
};
E.__setREFS(night, extra('REF_PNG_DAY', 'refday'), extra('REF_PNG_EVENING', 'refeve'));

/* Three naming generations live in the saved sweeps, and a filter that
   silently drops the ones it does not recognise is worse than one that fails
   loudly: the three it dropped here were the resting stop, the top mark, and
   the frame taken past the end of the scale — the only frames that reach the
   "Under 0,3" and Max states, which is to say the only ones that would catch
   YTOP or YBOT being moved far enough to make those states unreachable.
   Measured 2026-09-05: 20 of the 23 frames in the 2026-08-22 sweep were being
   scored, and the summary line said "20 read" without saying 3 were skipped.

     bild_2.5L_...       a labelled value
     bild_minL_...       the resting stop (sweeps up to 2026-08-16)
     bild_0_minL_...     the resting stop (2026-08-22 sweep)
     bild_maxL_...       the top mark, unlabelled (older sweeps)
     bild_5.7maxL_...    the top mark with its value
     bild_5.7_maxL_...   ditto (2026-08-22 sweep)
     bild_over_maxL_...  deliberately past the end of the printed scale */
function parseName(file) {
  const m = file.match(/^bild_(.+?)L_.*\.jpe?g$/i);
  if (!m) return null;
  const s = m[1];
  const min = /min$/i.test(s), max = /max$/i.test(s), over = /^over_/i.test(s);
  const rest = s.replace(/(^over)?_?(min|max)$/i, '');
  // The resting stop has no true value — the ball is against its stop, not at
  // a flow — so a numeric part there ("0_min") is a name, not a label.
  const value = !min && /^[0-9]*\.?[0-9]+$/.test(rest) ? Number(rest) : null;
  return { name: s, min, max, over, value };
}

const files = readdirSync(imageDir).filter((f) => parseName(f)).sort();
if (!files.length) {
  console.error(`No bild_*.jpg found in ${imageDir}`);
  process.exit(2);
}

console.log('label      read   diff  | contrast  unamb  match  shift  spread | verdict');
let sum = 0, n = 0, worst = 0, failures = 0;

for (const f of files) {
  const p = parseName(f);
  const label = p.name;
  const r = E.analyze(readBmp(toBmp(join(imageDir, f), label.replace(/\W/g, '_'))));
  const b = E.judge(r);
  const verdict = !b.ok ? 'REJECTED' : b.maxState ? 'Max' : b.bottomState ? 'Below 0.5' : 'ok';

  /* What each kind of frame has to produce:
       a labelled value  a reading within TOLERANCE of the label
       min               a reading, any reading — the ball is against its stop,
                         so there is no true value to compare against
       max, unlabelled   a reading; the top mark carries no number here
       over_max          the Max state, not a number. A frame taken past the
                         printed scale that comes back with a flow means the
                         y<Y_MAX_STATE guard has stopped guarding.
     In --expect-rejected mode every frame must be REJECTED instead: that is
     what a wrong camera pose, an occlusion or a garbage frame has to do. */
  let diff = '';
  if (expectRejected) {
    if (verdict !== 'REJECTED') failures++;
  } else if (p.over) {
    if (verdict !== 'Max') failures++;
  } else if (verdict !== 'ok' && verdict !== 'Below 0.5') {
    failures++;
  } else if (p.value != null) {
    const d = r.flow - p.value;
    diff = (d >= 0 ? '+' : '') + d.toFixed(2);
    sum += Math.abs(d); n++; worst = Math.max(worst, Math.abs(d));
    if (Math.abs(d) > TOLERANCE) failures++;
  }

  console.log(
    `${label.padEnd(10)} ${verdict === 'ok' ? r.flow.toFixed(2).padStart(5) : '  -  '} ${diff.padStart(6)} |` +
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
    `${n} with a labelled value, worst ${worst.toFixed(3)}, ` +
    `${failures} outside tolerance or rejected`);
process.exit(failures ? 1 : 0);
