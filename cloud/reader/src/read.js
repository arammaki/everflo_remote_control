/* One uploaded frame in, one row for `analyses` out — the part of the reader
   Worker that does not touch Cloudflare, so it can be run in Node against
   frames the admin page has already read in a browser (that is how the
   decoder was chosen, see CLAUDE.md "The reader Worker").

   makeReader(E, profiles, decode): E is the engine as a module (engine.js
   here, or an older engine for validation), profiles what
   tools/reader_profiles.mjs built from that same engine, decode(ArrayBuffer)
   a JPEG decoder resolving to {data: RGBA, width, height}. The Worker passes
   mozjpeg (WASM); Node passes the same codec compiled from its file. */

import { verdict, quality } from '../../../tools/verdict.mjs';
import { orient } from '../../../tools/orient.mjs';

const f32 = (b64) => {
  const bin = atob(b64), u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return new Float32Array(u.buffer);
};

export function makeReader(E, profiles, decode) {
  const loaded = new Set();
  /* Resolves to {skip} when there is nothing to store, else {v, q}: v from
     verdict() (state, flow), q the quality object. */
  return async function read(bytes, preset) {
    if (!Object.prototype.hasOwnProperty.call(E.PRESETS, preset)) return { skip: `unknown preset ${preset}` };
    // Uncalibrated: the admin page stores nothing for it either (verdict state null).
    if (!E.isCalibrated(preset)) return { skip: `preset ${preset} is uncalibrated` };
    const raw = await decode(bytes);
    if (raw.width !== E.H || raw.height !== E.W) return { skip: `frame is ${raw.width}x${raw.height}` };
    /* The preset is one global in the engine. Selected after the await, with
       nothing awaited from here to judge() — the admin page's rule. */
    E.usePreset(preset);
    if (!loaded.has(preset)) {
      const list = profiles[preset];
      if (!list) return { skip: `no profiles for ${preset}` };
      E.setRefs(list.map((p) => [{ ff: null, ball: f32(p.ball), anchor: f32(p.anchor), anchorX: f32(p.anchorX) }, p.name]));
      loaded.add(preset);
    }
    const r = E.analyze(orient(raw));
    const v = verdict(r, E.judge(r));
    return v.state ? { v, q: quality(r) } : { skip: 'nothing to store' };
  };
}
