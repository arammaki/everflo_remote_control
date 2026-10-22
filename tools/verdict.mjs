/* What a frame's analysis is stored as in `analyses`, and shown as in the admin
   table. One source for both writers — the admin page in the browser (inlined
   into its script with toString(), so keep it self-contained: no imports, no
   closures) and the reader Worker on the server — so the two cannot drift
   into storing the same frame two ways.

   state:null means "nothing to store": a machine without a calibration yet can
   only refuse, and a table full of those refusals would say nothing about the
   frames that the next engine, calibrated, will read. */
export function verdict(r,b){
  if(r.uncalibrated) return {state:null, flow:null, txt:'okal.', cls:'bad'};
  if(!b.ok) return {state:b.title==='Osäker avläsning'?'uncertain':'no-reading',
                    flow:null, txt:b.title==='Osäker avläsning'?'osäker':'nej', cls:'bad'};
  if(b.maxState)    return {state:'max',   flow:null, txt:b.label, cls:'good'};
  if(b.bottomState) return {state:'below', flow:null, txt:b.label, cls:'good'};
  return {state:'ok', flow:r.flow, txt:r.flow.toFixed(2), cls:'good'};
}

/* What may be stored as a flow — the admin Worker's clean() applies it to rows
   the browser posts, the reader Worker to its own. 'ok' must carry a number. */
export function storableFlow(v){
  const ok = v.flow == null || (Number.isFinite(v.flow) && v.flow >= -1 && v.flow <= 20);
  return ok && !(v.state === 'ok' && v.flow == null);
}

/* The quality JSON stored beside it — the same fields, rounded the same way, as
   the admin page has always written. `ref` and `fallback` only when the engine
   said them: a page running a cached pre-v1.10.12 /motor.js has no fallback
   concept, and writing false there would be indistinguishable from "the
   best-registering reference answered". */
export function quality(r){
  return {reg:+r.reg.toFixed(3), peak:+r.peak.toFixed(3), margin:+r.margin.toFixed(1),
          dx:+r.dx.toFixed(1), dy:+r.dy.toFixed(1), spread:r.spread,
          ...(r.ref?{ref:r.ref}:{}),
          ...(typeof r.fallback==='boolean'?{fallback:r.fallback}:{})};
}

/* The quality JSON as STORED, by either writer: the admin Worker applies it to
   what the browser posts, the reader Worker to its own, so both store one shape.
   Rebuilt field by field rather than stored as the client sent it. Truncating
   a JSON string to a length limit can cut it mid-value, and this column exists
   to be read back during an investigation months later — corrupt JSON there
   fails exactly when it is needed. Six known numbers are bounded by
   construction and always parse. */
const QUALITY = { reg: 3, peak: 3, margin: 1, dx: 1, dy: 1, spread: 0 };
/* Which lighting answered. Not a number, so it is whitelisted by value rather
   than bounded by construction — a free string here would be the one field in
   this row that could carry anything. `fallback` says the best-registering
   reference REFUSED and this came from the next one (v1.10.12), which is what
   explains a reading sitting a few hundredths off its span months later. */
const REFS = new Set(['natt', 'dag', 'kväll', 'natt2', 'hall2', 'dag2', 'hall', 'rum', 'ljus', 'ljus3', 'natt3', 'kväll3']);
export function cleanQuality(q) {
  if (!q || typeof q !== 'object') return null;
  const out = {};
  for (const [k, dp] of Object.entries(QUALITY)) {
    const v = q[k];
    if (Number.isFinite(v) && Math.abs(v) < 1e6) out[k] = Number(v.toFixed(dp));
  }
  if (REFS.has(q.ref)) out.ref = q.ref;
  if (typeof q.fallback === 'boolean') out.fallback = q.fallback;
  // Written by the reader Worker (cloud/reader), whose decoder is not the browser's.
  if (q.src === 'server') out.src = 'server';
  return Object.keys(out).length ? JSON.stringify(out) : null;
}
