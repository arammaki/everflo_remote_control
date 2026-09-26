#!/usr/bin/env node
/* ============================================================
   Builds the calibration of a concentrator preset from a labelled sweep —
   the reference image, the y -> flow curve and the ranges around it — and
   prints what it measured, so a human decides what goes into balldetector.js.

       node tools/calibrate.mjs <sweep dir> [--geometry g.json] [--out dir]

   <sweep dir> holds the frames saved with "Spara bild" on the control panel
   (480x640, already oriented and mirrored the way the engine analyses them),
   named bild_<label>L_<timestamp>.jpg exactly as tools/validate_engine.mjs
   reads them, plus a file PRESET naming the preset (one line, e.g.
   "platinum9"). PRESET is required, as it is for validate_engine.mjs: a
   calibration made under the wrong machine's geometry is worse than none.

   Geometry — the bands (XL/XR, AX1/AX2, RY1/RY2), the peak window
   (YTOP/YBOT) and the tube's lean (BASE_TILT) — comes from the engine's
   preset when it has one. A preset that has never been calibrated has none,
   and then --geometry is required: a JSON object with those nine keys. This
   tool never chooses geometry for you. It prints SUGGESTIONS for the ball
   band and the lean (step 4 below), because those were measured by hand for
   EverFlo and a second opinion helps, but a band is a judgement about where
   the ticks and the ball are and what the LED does to them, and CLAUDE.md
   records what each wrong guess cost.

   What it does:
     1. Median, per pixel, of the engine's own toGray() over every frame,
        rounded to 8 bits. The ball stands at a different height in each
        frame, so in the median it is gone and the scene stays — the same
        construction as the committed references. Written to --out as
        ref.png (8-bit grayscale PNG) and ref.dataurl.txt (the string to paste
        into balldetector.js as a REF_PNG_<ID> constant).
     2. With that reference live, measures y for every frame through the real
        analyze(), fits flow = a*y^2 + b*y + c over the frames with a numeric
        label, and reports residuals, Y_CAL_MIN/MAX and a Y_MAX_STATE. Each
        frame's margins against the shared quality gates T are printed; a
        frame that fails any gate is flagged, and a calibration that needs a
        gate lowered is a calibration that is not done.
     3. When the preset already has a curve and references (recalibrating
        EverFlo, or re-running over the sweep that made them), compares the
        new reference and curve with the committed ones.
     4. Suggests a ball band and a lean from where the ball is in each frame.
     5. Prints a preset snippet to paste, without the base64.

   Honest limitations:
   - The frames are decoded by sips, not a browser. validate_engine.mjs has the
     same caveat and the same evidence that it does not matter.
   - The curve is fitted to y measured against a reference built from the
     same frames. That is how every calibration here has been made, but it is
     not leave-one-out: residuals measure fit, not generalisation.
   - A sweep is ONE lighting. The reference it gives is a night (or day)
     reference, not all of them; the others are built from uploads later.
   - The geometry suggestions find the darkest blob against the median. A
     hand, a shadow or the LED's glare in a frame will pull its point; the
     line fit drops outliers and says how many, but read the per-frame table.

   Requires macOS `sips` and nothing else — no npm packages, no browser.
   ============================================================ */

import { readFileSync, writeFileSync, readdirSync, mkdtempSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const ENGINE = join(here, '..', 'balldetector.js');
const GEOMETRY_KEYS = ['XL', 'XR', 'AX1', 'AX2', 'YTOP', 'YBOT', 'RY1', 'RY2', 'BASE_TILT'];

/* ---------- arguments ---------- */
const args = process.argv.slice(2);
const opt = {};
const positional = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--geometry' || a === '--out') {
    const v = args[i + 1];
    if (!v || v.startsWith('--')) { console.error(`${a} needs a value`); process.exit(2); }
    opt[a.slice(2)] = v; i++;
  } else if (a.startsWith('--')) {
    console.error(`Unknown option ${a}`); process.exit(2);
  } else positional.push(a);
}
if (positional.length !== 1) {
  console.error('Usage: node tools/calibrate.mjs <sweep dir> [--geometry g.json] [--out dir]');
  process.exit(2);
}
const sweepDir = positional[0];

let presetId;
try {
  presetId = readFileSync(join(sweepDir, 'PRESET'), 'utf8').trim();
} catch (e) {
  console.error(e.code === 'ENOENT'
    ? `Which concentrator? Put its preset id in ${sweepDir}/PRESET.`
    : `Cannot read ${sweepDir}/PRESET: ${e.message}`);
  process.exit(2);
}

/* ---------- decoding (same as validate_engine.mjs) ---------- */
const work = mkdtempSync(join(tmpdir(), 'everflo-calibrate-'));
const toBmp = (src, name) => {
  const out = join(work, name + '.bmp');
  execFileSync('sips', ['-s', 'format', 'bmp', src, '--out', out], { stdio: 'ignore' });
  return out;
};
function readBmp(path) {
  const d = readFileSync(path);
  const off = d.readUInt32LE(10), w = d.readInt32LE(18), hRaw = d.readInt32LE(22);
  const bpp = d.readUInt16LE(28);
  if (bpp !== 24) throw new Error(`${path}: ${bpp} bpp, expected 24`);
  const h = Math.abs(hRaw), topDown = hRaw < 0, stride = Math.ceil((w * 3) / 4) * 4;
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

/* ---------- labels (the semantics of validate_engine.mjs's parseName) ----------
   Copied, not imported: that file runs its validation on import. Keep the two
   in step — a form one of them knows and the other does not is a frame that
   is calibrated against and never validated, or the reverse. */
function parseName(file) {
  const m = file.match(/^bild_(.+?)L_.*\.jpe?g$/i);
  if (!m) return null;
  const s = m[1];
  if (/^over_max$/i.test(s)) return { name: s, expect: 'max', value: null };
  if (/^(\d+(\.\d+)?_)?min$/i.test(s)) return { name: s, expect: 'rest', value: null };
  if (/^max$/i.test(s)) return { name: s, expect: 'reading', value: null };
  // Read by eye at an angle, or below the calibrated range: the number is
  // approximate, so the frame is asserted only to produce a reading.
  if (/^\d+(\.\d+)?_approx$/i.test(s)) return { name: s, expect: 'reading', value: null };
  const mx = s.match(/^(\d+(?:\.\d+)?)_?max$/i);
  if (mx) return { name: s, expect: 'value', value: Number(mx[1]) };
  if (/^\d+(\.\d+)?$/.test(s)) return { name: s, expect: 'value', value: Number(s) };
  return { name: s, expect: null, value: null };
}

let entries;
try { entries = readdirSync(sweepDir); } catch (e) {
  console.error(`Cannot read ${sweepDir}: ${e.code === 'ENOENT' ? 'no such directory' : e.message}`);
  process.exit(2);
}
const images = entries.filter((f) => /\.jpe?g$/i.test(f)).sort();
const bad = images.filter((f) => { const p = parseName(f); return !p || !p.expect; });
if (bad.length) {
  console.error(`Cannot tell what these frames are: ${bad.join(', ')}\n` +
                'Rename them to bild_<label>L_... — a calibration will not guess a label.');
  process.exit(2);
}
if (images.length < 5) {
  console.error(`${images.length} frame(s) in ${sweepDir}: too few for a median without a ball in it.`);
  process.exit(2);
}

/* ---------- engine ---------- */
const src = readFileSync(ENGINE, 'utf8');
writeFileSync(join(work, 'engine.mjs'), src +
  '\nexport { T,W,H,toGray,flatfield,buildRef,analyze,PRESETS,PRESET_KEYS,usePreset,setRefs,isCalibrated };\n');
const E = await import(pathToFileURL(join(work, 'engine.mjs')).href);
if (!Object.prototype.hasOwnProperty.call(E.PRESETS, presetId)) {
  console.error(`Unknown preset "${presetId}". The engine has: ${Object.keys(E.PRESETS).join(', ')}`);
  process.exit(2);
}
const preset = E.PRESETS[presetId];
const { W, H, T } = E;

/* The committed state, taken before anything below edits the in-memory preset. */
const committed = {
  CAL: preset.CAL ? preset.CAL.slice() : null,
  Y_CAL_MIN: preset.Y_CAL_MIN, Y_CAL_MAX: preset.Y_CAL_MAX, Y_MAX_STATE: preset.Y_MAX_STATE,
  refs: preset.refs(),
};

let geometrySource;
const presetHasGeometry = GEOMETRY_KEYS.every((k) => preset[k] !== null && preset[k] !== undefined);
if (opt.geometry) {
  let g;
  try { g = JSON.parse(readFileSync(opt.geometry, 'utf8')); } catch (e) {
    console.error(`--geometry ${opt.geometry}: ${e.message}`); process.exit(2);
  }
  const missing = GEOMETRY_KEYS.filter((k) => typeof g[k] !== 'number');
  const extra = Object.keys(g).filter((k) => !GEOMETRY_KEYS.includes(k));
  if (missing.length || extra.length) {
    console.error(`--geometry: needs numbers for ${GEOMETRY_KEYS.join(', ')}` +
                  (missing.length ? `; missing ${missing.join(', ')}` : '') +
                  (extra.length ? `; unknown ${extra.join(', ')}` : ''));
    process.exit(2);
  }
  Object.assign(preset, g);
  geometrySource = `--geometry ${opt.geometry}` +
    (presetHasGeometry ? ` (overriding the preset's own)` : '');
} else if (presetHasGeometry) {
  geometrySource = `the ${presetId} preset in balldetector.js`;
} else {
  console.error(`The ${presetId} preset has no geometry yet. Pass --geometry g.json with ` +
                `${GEOMETRY_KEYS.join(', ')}. A first guess is enough to get the suggestions ` +
                `printed; CLAUDE.md records how EverFlo's were measured.`);
  process.exit(2);
}
/* Measured under a throwaway preset in memory, never the real one: analyze()
   needs a curve to run at all and usePreset() refuses a curve without every
   state filled in, but y depends on the geometry alone. The identity curve
   (flow = y) makes it obvious if one of these values ever leaks into a
   printout, and the states are set where they can never fire. The reference
   list is a placeholder for that check; setRefs() supplies the real one below. */
E.PRESETS.__measure = {
  name: "measurement", ...Object.fromEntries(GEOMETRY_KEYS.map((k) => [k, preset[k]])),
  CAL: [0, 1, 0], Y_CAL_MIN: 0, Y_CAL_MAX: H, Y_MAX_STATE: -1,
  LOW_FLOW: -Infinity, LOW_LABEL: "-", LOW_REASON: "-", MAX_REASON: "-",
  // Every display-crop key the engine knows, null: derived, so a new one
  // cannot break the measurement the way VIEW_Y/VIEW_H once did.
  ...Object.fromEntries(E.PRESET_KEYS.filter((k) => k.startsWith("VIEW_")).map((k) => [k, null])),
  refs: () => [["placeholder", "natt"]],
};
E.usePreset("__measure");

/* ---------- 1. the reference ---------- */
const frames = images.map((f) => {
  const p = parseName(f);
  const img = readBmp(toBmp(join(sweepDir, f), 'f' + Math.random().toString(36).slice(2)));
  if (img.width !== W || img.height !== H)
    throw new Error(`${f}: ${img.width}x${img.height}, expected ${W}x${H} — is this a saved canvas frame?`);
  return { file: f, ...p, img, gray: E.toGray(img) };
});

const median = new Uint8Array(W * H);
{
  const n = frames.length, col = new Float64Array(n);
  for (let i = 0; i < W * H; i++) {
    for (let k = 0; k < n; k++) col[k] = frames[k].gray[i];
    col.sort();
    const m = n % 2 ? col[(n - 1) / 2] : (col[n / 2 - 1] + col[n / 2]) / 2;
    median[i] = Math.max(0, Math.min(255, Math.round(m)));
  }
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** 8-bit grayscale PNG (colour type 0), filter 0 on every row. */
function pngGray(px, w, h) {
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0;
    Buffer.from(px.buffer, px.byteOffset + y * w, w).copy(raw, y * (w + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 0; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = opt.out ? resolve(opt.out) : mkdtempSync(join(tmpdir(), `calibration-${presetId}-`));
mkdirSync(outDir, { recursive: true });
const png = pngGray(median, W, H);
writeFileSync(join(outDir, 'ref.png'), png);
const dataUrl = 'data:image/png;base64,' + png.toString('base64');
writeFileSync(join(outDir, 'ref.dataurl.txt'), dataUrl);

/* Decode our own PNG back through sips and build the reference from THAT, the
   way the browser gets it: the check that the encoder is right is that the
   engine reads the file we are about to commit, not the array we meant. */
const pngGrayBack = (file, name) => {
  const im = readBmp(toBmp(file, name));
  return { im, gray: E.toGray(im) };
};
const back = pngGrayBack(join(outDir, 'ref.png'), 'refback');
{
  let worst = 0;
  for (let i = 0; i < W * H; i++) worst = Math.max(worst, Math.abs(back.im.data[i * 4] - median[i]));
  if (worst > 0) throw new Error(`ref.png does not decode to the median (worst ${worst}) — encoder bug`);
}
const refFf = E.flatfield(back.gray);
E.setRefs([[E.buildRef(refFf), 'natt']]);

console.log(`preset     ${presetId} (${preset.name})`);
console.log(`geometry   from ${geometrySource}`);
console.log(`           ${GEOMETRY_KEYS.map((k) => `${k}=${preset[k]}`).join(' ')}`);
console.log(`frames     ${frames.length} in ${sweepDir}`);
console.log(`reference  ${join(outDir, 'ref.png')} (${(png.length / 1024).toFixed(0)} kB, ` +
            `${(dataUrl.length / 1024).toFixed(0)} kB as a data URL)`);

/* ---------- 2. measure y, fit the curve ---------- */
for (const fr of frames) fr.r = E.analyze(fr.img);

function gates(r) {
  const fails = [];
  if (r.reg < T.reg) fails.push('registration');
  if (r.peak < T.contrast) fails.push('contrast');
  if (r.margin < T.margin) fails.push('ambiguity');
  if (r.spread > T.spread) fails.push('spread');
  if (Math.abs(r.dx) > 20 || Math.abs(r.dy) > 20) fails.push('shift');
  return fails;
}

/** Least squares for flow = a*y^2 + b*y + c, by the normal equations. */
function fitQuadratic(pts) {
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], v = [0, 0, 0];
  for (const { y, f } of pts) {
    const row = [y * y, y, 1];
    for (let i = 0; i < 3; i++) { v[i] += row[i] * f; for (let j = 0; j < 3; j++) A[i][j] += row[i] * row[j]; }
  }
  for (let i = 0; i < 3; i++) {                       // Gauss-Jordan with partial pivoting
    let p = i;
    for (let r = i + 1; r < 3; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    [A[i], A[p]] = [A[p], A[i]]; [v[i], v[p]] = [v[p], v[i]];
    for (let r = 0; r < 3; r++) {
      if (r === i) continue;
      const k = A[r][i] / A[i][i];
      for (let c = i; c < 3; c++) A[r][c] -= k * A[i][c];
      v[r] -= k * v[i];
    }
  }
  return [v[0] / A[0][0], v[1] / A[1][1], v[2] / A[2][2]];
}
const curve = (C, y) => C[0] * y * y + C[1] * y + C[2];

const numeric = frames.filter((fr) => fr.expect === 'value');
if (numeric.length < 4) {
  console.error(`\n${numeric.length} frame(s) with a numeric label: too few to fit three coefficients.`);
  process.exit(1);
}
const CAL = fitQuadratic(numeric.map((fr) => ({ y: fr.r.y, f: fr.value })));
let sum = 0, worst = 0;
for (const fr of numeric) {
  fr.fit = curve(CAL, fr.r.y);
  fr.res = fr.fit - fr.value;
  sum += Math.abs(fr.res); worst = Math.max(worst, Math.abs(fr.res));
}
const ys = numeric.map((fr) => fr.r.y);
const yCalMin = Math.round(Math.min(...ys)), yCalMax = Math.round(Math.max(...ys));

console.log('\nlabel          y      fit    res  | contrast   unamb  match   dx    dy  spread | gates');
let refused = 0;
for (const fr of [...frames].sort((a, b) => a.r.y - b.r.y)) {
  const r = fr.r, g = gates(r);
  if (g.length) refused++;
  console.log(
    `${fr.name.padEnd(10)} ${r.y.toFixed(1).padStart(6)} ` +
    `${fr.fit !== undefined ? fr.fit.toFixed(2).padStart(7) : curve(CAL, r.y).toFixed(2).padStart(7)} ` +
    `${fr.res !== undefined ? ((fr.res >= 0 ? '+' : '') + fr.res.toFixed(3)).padStart(6) : '     -'}  |` +
    ` ${r.peak.toFixed(3).padStart(8)} ${r.margin.toFixed(1).padStart(6)}x ${r.reg.toFixed(3).padStart(6)}` +
    ` ${r.dx.toFixed(1).padStart(5)} ${r.dy.toFixed(1).padStart(5)} ${String(r.spread).padStart(6)} | ` +
    (g.length ? 'REFUSED: ' + g.join(', ') : 'ok'));
}
const minOf = (k) => Math.min(...frames.map((fr) => fr.r[k]));
const maxOf = (k) => Math.max(...frames.map((fr) => fr.r[k]));
console.log(`\ncurve      CAL=[${CAL.map((c) => c.toPrecision(9)).join(', ')}]`);
console.log(`fit        mean ${(sum / numeric.length).toFixed(3)} L/min, worst ${worst.toFixed(3)} over ` +
            `${numeric.length} numeric labels`);
console.log(`range      Y_CAL_MIN=${yCalMin} Y_CAL_MAX=${yCalMax} (y of the numeric labels)`);
console.log(`margins    contrast ${minOf('peak').toFixed(3)} (gate ${T.contrast}), ambiguity ` +
            `${minOf('margin').toFixed(1)}x (${T.margin}), registration ${minOf('reg').toFixed(3)} ` +
            `(${T.reg}), spread ${maxOf('spread')} (${T.spread})`);
if (refused)
  console.log(`\n${refused} frame(s) fail a gate against their OWN reference. Do not lower T: find ` +
              'out what the frame shows, retake it or fix the geometry.');

/* The curve must fall across the scale: y grows downward, flow grows upward.
   A fit that is not monotonic over its own range has a turning point inside
   it and maps two heights to one flow. */
const vertexY = -CAL[1] / (2 * CAL[0]);
if (vertexY > yCalMin && vertexY < yCalMax)
  console.log(`\nWARNING: the curve turns at y=${vertexY.toFixed(1)}, inside ${yCalMin}..${yCalMax}.`);

const over = frames.filter((fr) => fr.expect === 'max');
let yMaxState = null;
if (over.length) {
  const yOver = Math.max(...over.map((fr) => fr.r.y));
  yMaxState = Math.floor((yOver + Math.min(...ys)) / 2);
  console.log(`Max        over_max frame(s) at y=${over.map((fr) => fr.r.y.toFixed(1)).join(', ')}, top ` +
              `label at y=${Math.min(...ys).toFixed(1)} -> Y_MAX_STATE ~ ${yMaxState} (midway, rounded down)`);
  if (yOver >= Math.min(...ys))
    console.log('           The over_max frame is NOT above the top label. Check both frames.');
} else {
  console.log('Max        no bild_over_maxL_ frame: Y_MAX_STATE cannot be placed from this sweep.');
}
const rest = frames.filter((fr) => fr.expect === 'rest');
for (const fr of rest)
  console.log(`rest       ${fr.name} at y=${fr.r.y.toFixed(1)} reads ${curve(CAL, fr.r.y).toFixed(2)} on this ` +
              'curve — the bottom state\'s LOW_FLOW must sit above that, and below the lowest flow in use.');

/* ---------- 3. against the committed calibration ---------- */
if (committed.CAL) {
  const lo = committed.Y_CAL_MIN;
  const hi = Math.max(committed.Y_CAL_MAX, ...rest.map((fr) => Math.ceil(fr.r.y)));
  let d = 0, at = lo;
  for (let y = lo; y <= hi; y++) {
    const e = Math.abs(curve(CAL, y) - curve(committed.CAL, y));
    if (e > d) { d = e; at = y; }
  }
  console.log(`\ncommitted  CAL=[${committed.CAL.join(', ')}]`);
  console.log(`           new curve differs by at most ${d.toFixed(3)} L/min over y ${lo}..${hi} (at y=${at})`);
}
if (committed.refs.length) {
  const [url, name] = committed.refs[0];
  const f = join(work, 'committed.png');
  writeFileSync(f, Buffer.from(url.replace(/^data:image\/png;base64,/, ''), 'base64'));
  const c = pngGrayBack(f, 'committed');
  let s = 0, mx = 0, at = 0;
  for (let i = 0; i < W * H; i++) {
    const e = Math.abs(c.im.data[i * 4] - median[i]);
    s += e; if (e > mx) { mx = e; at = i; }
  }
  console.log(`           reference vs committed '${name}': mean |diff| ${(s / (W * H)).toFixed(2)}, ` +
              `max ${mx} grey levels (at x=${at % W}, y=${Math.floor(at / W)})`);
}

/* ---------- 4. geometry suggestions ---------- */
/* Where is the ball in each frame, independently of the bands? It is the
   darkest thing against the median once both are flatfielded — the same sign
   the engine's difference profile uses. */
function blob(ff) {
  const d = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) d[i] = Math.max(0, refFf[i] - ff[i]);
  const r = 4, tmp = new Float32Array(W * H), s = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let a = 0; for (let k = -r; k <= r; k++) a += d[y * W + Math.min(W - 1, Math.max(0, x + k))];
    tmp[y * W + x] = a;
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let a = 0; for (let k = -r; k <= r; k++) a += tmp[Math.min(H - 1, Math.max(0, y + k)) * W + x];
    s[y * W + x] = a / ((2 * r + 1) ** 2);
  }
  const m = 20;
  let best = 0, bi = -1;
  for (let y = m; y < H - m; y++) for (let x = m; x < W - m; x++) if (s[y * W + x] > best) { best = s[y * W + x]; bi = y * W + x; }
  if (bi < 0) return null;
  const px = bi % W, py = Math.floor(bi / W);
  let sw = 0, sx = 0, sy = 0;
  for (let y = py - 30; y <= py + 30; y++) for (let x = px - 30; x <= px + 30; x++) {
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const w = Math.max(0, s[y * W + x] - 0.5 * best); sw += w; sx += w * x; sy += w * y;
  }
  const cx = sx / sw, cy = sy / sw, row = Math.round(cy) * W;
  let width = 0;
  for (let x = Math.max(0, px - 40); x <= Math.min(W - 1, px + 40); x++) if (s[row + x] > 0.5 * best) width++;
  return { x: cx, y: cy, width, peak: best };
}
const pts = frames.map((fr) => ({ fr, b: blob(E.flatfield(fr.gray)) })).filter((p) => p.b);

/** x = x0 + t*(y - H/2): the convention bandProfile() uses, so t IS a tilt. */
function fitLine(ps) {
  const n = ps.length;
  let my = 0, mx = 0;
  for (const p of ps) { my += p.b.y - H / 2; mx += p.b.x; }
  my /= n; mx /= n;
  let sxy = 0, syy = 0;
  for (const p of ps) { const dy = p.b.y - H / 2 - my; sxy += dy * (p.b.x - mx); syy += dy * dy; }
  const t = sxy / syy;
  return { t, x0: mx - t * my };
}
let used = pts, line = fitLine(used), dropped = [];
{
  const res = used.map((p) => p.b.x - (line.x0 + line.t * (p.b.y - H / 2)));
  const med = (a) => { const s = [...a].sort((u, v) => u - v); return s[Math.floor(s.length / 2)]; };
  const mad = med(res.map((r) => Math.abs(r)));
  const lim = 3 * Math.max(mad, 0.5);
  dropped = used.filter((_, i) => Math.abs(res[i]) > lim);
  used = used.filter((_, i) => Math.abs(res[i]) <= lim);
  if (used.length >= 3) line = fitLine(used);
}
const rms = Math.sqrt(used.reduce((a, p) => a + (p.b.x - (line.x0 + line.t * (p.b.y - H / 2))) ** 2, 0) / used.length);
const widths = used.map((p) => p.b.width).sort((a, b) => a - b);
const wMed = widths[Math.floor(widths.length / 2)];
const yspan = Math.max(...used.map((p) => p.b.y)) - Math.min(...used.map((p) => p.b.y));
const blobVsEngine = Math.max(...used.map((p) => Math.abs(p.b.y - p.fr.r.y)));

console.log('\nsuggested geometry (printed, never applied — read CLAUDE.md before using any of it)');
console.log(`  lean       BASE_TILT ~ ${line.t.toFixed(4)} from the ball's own path over ${yspan.toFixed(0)} rows ` +
            `(${used.length} frames, rms ${rms.toFixed(1)} px off the line` +
            (dropped.length ? `, ${dropped.length} dropped as outliers: ${dropped.map((p) => p.fr.name).join(', ')}` : '') + ')');
console.log(`  ball band  centre x ${line.x0.toFixed(1)} at y=${H / 2}, blob width ${wMed} px (median) -> ` +
            `XL=${Math.round(line.x0 - wMed / 2)} XR=${Math.round(line.x0 + wMed / 2)}`);
console.log(`  check      blob y agrees with the engine's y to within ${blobVsEngine.toFixed(1)} px`);
if (rms > 3 || blobVsEngine > 10 || used.length < frames.length * 0.8)
  console.log('  UNRELIABLE: the blob track is noisy or disagrees with the engine — look at the frames.');
console.log('  Not suggested: the anchor band (AX1/AX2), the row band (RY1/RY2) and the window\n' +
            '  (YTOP/YBOT). Those were chosen by measuring the gates across candidates, not by\n' +
            '  finding a feature, and this tool does not pretend otherwise.');

/* ---------- 5. snippet ---------- */
/* Generated from the engine's own PRESET_KEYS, so the snippet cannot lack a
   field usePreset() demands — a hand-written list here once omitted VIEW_X and
   VIEW_W. Anything this tool does not measure comes from the preset as it
   stands, and is marked when it is still null: those are decisions for the
   user (the texts, LOW_FLOW, the display crop), not measurements. */
const id = presetId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
const measured = {
  ...Object.fromEntries(GEOMETRY_KEYS.map((k) => [k, preset[k]])),
  CAL: CAL.map((c) => Number(c.toPrecision(9))),
  Y_CAL_MIN: yCalMin, Y_CAL_MAX: yCalMax,
  Y_MAX_STATE: yMaxState ?? null,
};
const candidate = Object.fromEntries(E.PRESET_KEYS.map((k) => [k, k in measured ? measured[k] : preset[k]]));
const lines = E.PRESET_KEYS.map((k) => {
  const v = candidate[k];
  const note = v != null ? '' : k === 'Y_MAX_STATE' ? ' /* no over_max frame in the sweep */'
             : k.startsWith('VIEW_') ? ' /* optional: null shows the whole frame */' : ' /* decide */';
  return `    ${k}:${JSON.stringify(v)},${note}`;
});
console.log(`
preset snippet — paste into PRESETS, and the contents of
${join(outDir, 'ref.dataurl.txt')}
as const REF_PNG_${id}="..." below the table.

  ${presetId}:{
    name:${JSON.stringify(preset.name)},
${lines.join('\n')}
    refs:()=>[[REF_PNG_${id},'natt']],
  },`);
/* Would it load? The engine's own check, on the candidate with this run's
   reference — the same refusal the phone would give, said here instead. */
E.PRESETS.__candidate = { name: 'candidate', ...candidate,
  refs: () => [['data:image/png;base64,' + readFileSync(join(outDir, 'ref.png')).toString('base64'), 'natt']] };
try {
  E.usePreset('__candidate');
  console.log('\nThe snippet is complete: usePreset() accepts it.');
} catch (e) {
  console.log(`\nNOT READY: ${e.message}. Fill those in before pasting.`);
}
