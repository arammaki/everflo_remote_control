/* ============================================================
   The reader Worker's references, precomputed (2026-10-22).

   A reference in the engine is a PNG that loadRef() decodes and flatfields
   in the browser. analyze() then uses only three profiles of it — ball,
   anchor and anchorX, from buildRef() — never the flatfield itself. The
   reader Worker runs on Cloudflare's free plan, 10 ms of CPU per
   invocation, and flatfielding twelve references on every cold start would
   cost more than reading a frame. So build_webui.mjs computes the profiles
   here, with the engine's own buildRef() under each preset, and the Worker
   gets them as data.

   The PNGs are decoded with node:zlib rather than sips, because there is
   nothing to interpret: every reference is 8-bit grayscale, no palette, no
   interlace, no gamma or colour chunk (decodeGray refuses anything else), so
   the browser's decode and this one are the same bytes. The profiles are
   Float32Arrays in the engine, and are passed on as the raw float32 bytes in
   base64, so the Worker gets them bit for bit.

   Used by build_webui.mjs, and by anyone validating the reader against an
   older engine: buildProfiles(source) takes the engine's source text.
   ============================================================ */

import { inflateSync } from 'node:zlib';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** An 8-bit grayscale, non-interlaced PNG as RGBA ImageData-like pixels. */
export function decodeGray(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let o = 8, w = 0, h = 0;
  const idat = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o), type = buf.toString('ascii', o + 4, o + 8);
    const body = buf.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') {
      w = body.readUInt32BE(0); h = body.readUInt32BE(4);
      const [depth, colour, , , interlace] = body.subarray(8);
      if (depth !== 8 || colour !== 0 || interlace !== 0)
        throw new Error(`PNG is not plain 8-bit grayscale (depth ${depth}, colour ${colour}, interlace ${interlace})`);
    } else if (type === 'IDAT') idat.push(body);
    else if (type !== 'IEND' && !(type.charCodeAt(0) & 0x20))
      throw new Error(`PNG has a critical chunk this decoder does not know: ${type}`);
    else if (type === 'gAMA' || type === 'iCCP' || type === 'sRGB' || type === 'cHRM')
      throw new Error(`PNG carries colour information (${type}); the browser may not decode it to the same bytes`);
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const gray = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (w + 1)], src = raw.subarray(y * (w + 1) + 1, (y + 1) * (w + 1));
    for (let x = 0; x < w; x++) {
      const a = x ? gray[y * w + x - 1] : 0, b = y ? gray[(y - 1) * w + x] : 0;
      const c = x && y ? gray[(y - 1) * w + x - 1] : 0;
      let p;
      switch (f) {
        case 0: p = 0; break;
        case 1: p = a; break;
        case 2: p = b; break;
        case 3: p = (a + b) >> 1; break;
        case 4: { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c);
          p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; break; }
        default: throw new Error(`PNG filter ${f} on row ${y}`);
      }
      gray[y * w + x] = (src[x] + p) & 255;
    }
  }
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { data[4 * i] = data[4 * i + 1] = data[4 * i + 2] = gray[i]; data[4 * i + 3] = 255; }
  return { data, width: w, height: h };
}

const b64 = (f32) => Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength).toString('base64');

/** The engine source as an importable module, with what the reader needs exported. */
export const EXPORTS = 'export {toGray,flatfield,buildRef,analyze,judge,usePreset,setRefs,isCalibrated,PRESETS,W,H};\n';

/** { <preset>: [{name, ball, anchor, anchorX}] } for every calibrated preset, profiles base64 float32. */
export async function buildProfiles(source) {
  const dir = mkdtempSync(join(tmpdir(), 'reader-profiles-'));
  try {
    const file = join(dir, 'engine.mjs');
    writeFileSync(file, source + '\n' + EXPORTS);
    const E = await import(pathToFileURL(file).href);
    const out = {};
    for (const id of Object.keys(E.PRESETS)) {
      if (!E.isCalibrated(id)) continue;
      E.usePreset(id);
      out[id] = E.PRESETS[id].refs().map(([url, name]) => {
        const img = decodeGray(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
        if (img.width !== E.W || img.height !== E.H) throw new Error(`${id}/${name}: ${img.width}x${img.height}`);
        const R = E.buildRef(E.flatfield(E.toGray(img)));
        return { name, ball: b64(R.ball), anchor: b64(R.anchor), anchorX: b64(R.anchorX) };
      });
    }
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
