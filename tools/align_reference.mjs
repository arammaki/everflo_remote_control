#!/usr/bin/env node
/* ============================================================
   Builds a lighting reference from a sweep whose camera has crept since the
   preset's geometry was measured, in the coordinates of the preset's FIRST
   reference — so every band and the curve apply to it unchanged.

       node tools/align_reference.mjs <sweep dir> <out prefix>

   Per frame: dx/dy measured by the engine against the first reference, the
   frame resampled as ref(x,y) = frame(x+dx, y+dy) (how analyzeWith() applies
   them), then the per-pixel median, as calibrate.mjs builds one. Writes
   <out prefix>.png and <out prefix>.dataurl.txt. The preset is read from the
   sweep's PRESET file. Check the result: registered against the first
   reference it should come out at dx ~0, dy ~0 (2026-09-29: 0.02 / -0.02).

   Made for REF_PNG_PLATINUM9_KVALL. It does not fix a camera that has
   ROTATED or moved closer — only a sideways/vertical creep — and it does not
   re-fit anything: if the sweep reads wrong against its own reference, the
   geometry has to be re-measured with calibrate.mjs instead.
   ============================================================ */
import { readFileSync, writeFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
const [DIR, OUT] = process.argv.slice(2);
if (!DIR || !OUT) { console.error('Usage: node tools/align_reference.mjs <sweep dir> <out prefix>'); process.exit(2); }
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const PRESET = readFileSync(join(DIR, 'PRESET'), 'utf8').trim();
const work = mkdtempSync(join(tmpdir(), 'align-ref-'));
const toBmp = (src, n) => { const o = join(work, n + '.bmp'); execFileSync('sips', ['-s', 'format', 'bmp', src, '--out', o], { stdio: 'ignore' }); return o; };
const readBmp = (p) => { const d = readFileSync(p), off = d.readUInt32LE(10), w = d.readInt32LE(18), hR = d.readInt32LE(22), h = Math.abs(hR), td = hR < 0, st = Math.ceil(w * 3 / 4) * 4, data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) { const r = off + (td ? y : h - 1 - y) * st; for (let x = 0; x < w; x++) { const s = r + x * 3, t = (y * w + x) * 4; data[t] = d[s + 2]; data[t + 1] = d[s + 1]; data[t + 2] = d[s]; data[t + 3] = 255; } } return { data, width: w, height: h }; };
writeFileSync(join(work, 'e.mjs'), readFileSync(join(REPO, 'balldetector.js'), 'utf8') + '\nexport {toGray,flatfield,buildRef,analyzeWith,usePreset,PRESETS,W,H};\n');
const E = await import(pathToFileURL(join(work, 'e.mjs')).href);
E.usePreset(PRESET);
const W = E.W, H = E.H;
const [dayUrl] = E.PRESETS[PRESET].refs()[0];
const dayPng = join(work, 'day.png'); writeFileSync(dayPng, Buffer.from(dayUrl.split(',')[1], 'base64'));
const Rday = E.buildRef(E.flatfield(E.toGray(readBmp(toBmp(dayPng, 'day')))));
const files = readdirSync(DIR).filter((f) => f.endsWith('.jpg')).sort();
const shifted = [];
for (const f of files) {
  const g = E.toGray(readBmp(toBmp(join(DIR, f), 'f')));
  const r = E.analyzeWith(Rday, E.flatfield(g));
  console.log(f.replace(/_2026.*/, '').padEnd(22), 'dx', r.dx.toFixed(2), 'dy', r.dy.toFixed(2), 'reg', r.reg.toFixed(3));
  const o = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const sx = Math.min(W - 1.001, Math.max(0, x + r.dx)), sy = Math.min(H - 1.001, Math.max(0, y + r.dy));
    const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
    const a = g[y0 * W + x0], b = g[y0 * W + x0 + 1], c = g[(y0 + 1) * W + x0], d = g[(y0 + 1) * W + x0 + 1];
    o[y * W + x] = (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
  }
  shifted.push(o);
}
const med = new Uint8Array(W * H), col = new Float64Array(shifted.length), n = shifted.length;
for (let i = 0; i < W * H; i++) { for (let k = 0; k < n; k++) col[k] = shifted[k][i]; col.sort(); const m = n % 2 ? col[(n - 1) / 2] : (col[n / 2 - 1] + col[n / 2]) / 2; med[i] = Math.max(0, Math.min(255, Math.round(m))); }
const crcT = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
const raw = Buffer.alloc((W + 1) * H); for (let y = 0; y < H; y++) { raw[y * (W + 1)] = 0; Buffer.from(med.buffer, y * W, W).copy(raw, y * (W + 1) + 1); }
const ih = Buffer.alloc(13); ih.writeUInt32BE(W, 0); ih.writeUInt32BE(H, 4); ih[8] = 8;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
writeFileSync(OUT + '.png', png); writeFileSync(OUT + '.dataurl.txt', 'data:image/png;base64,' + png.toString('base64'));
console.log('wrote', OUT + '.png', (png.length / 1024).toFixed(0), 'kB');
