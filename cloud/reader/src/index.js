/* ============================================================
   EverFlo reader — reads uploaded frames on the server (2026-10-22).

   Until now a frame got its reading only when someone opened the admin page
   and pressed "Analysera": the engine runs in the browser. This Worker does
   the same once an hour, on a cron, for every frame that came in since its
   last run, and stores the result in `analyses` under the same engine hash —
   so the admin page opens with the readings already there.

   Information only, like the admin page. Nothing here reaches her page or the
   motor, and the device never hears of it.

   ON THE FREE PLAN THIS RUNS OVER ITS CPU LIMIT, knowingly. Workers Free
   allows 10 ms of CPU per invocation; one frame costs 85-226 ms on
   Cloudflare (measured 2026-10-22, 24 of 24 requests let through), so a run
   is 10-20x over per frame, and Cloudflare's documentation says a Worker
   that does so consistently may be stopped. The operator chose to run it
   anyway: the failure is benign — the readings go missing and the admin
   page reads them in the browser as before. What this file does about it:
   - Separate from the ingest Worker, which also serves firmware and must
     never be at risk of being stopped.
   - Each reading is committed as soon as it exists, so a run that is cut
     off loses only the frame it was on.
   - The frame being read is written down BEFORE the work starts. A frame
     whose run dies three times is given up (counted in `given_up`) rather
     than retried forever, which would stall everything behind it. A frame
     the decoder or the engine throws on is given up at once.
   - `reader_state` records each run, and the admin page warns when the
     reader has fallen behind or stopped running.

   Read-only on `readings` and R2; writes only `analyses` (never over a row
   the browser already wrote) and its own `reader_state` row.

   No public URL (workers_dev false): a scheduled handler only.
   ============================================================ */

import * as E from './engine.js';
import { PROFILES } from './profiles.js';
import { makeReader } from './read.js';
import { presetOf } from '../../../tools/preset_of.mjs';
import { storableFlow, cleanQuality } from '../../../tools/verdict.mjs';
import decodeJpeg, { init } from '@jsquash/jpeg/decode.js';
import mozjpeg from '@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm';

/* At most this many frames a run. An hour brings 4 periodic frames plus one
   per press, and a run that reads too many in one go is the likeliest to be
   stopped. A backlog drains at this rate per hour. */
const PER_RUN = 12;
/* A frame whose run never finishes is tried this many times, then skipped. */
const MAX_TRIES = 3;

/* mozjpeg (libjpeg-turbo's decoder) compiled to WASM. Chosen over jpeg-js
   (pure JS) on 150 frames the admin page had read in the browser, each re-read
   with the engine that had read it: mozjpeg gave the same state and reference
   on all 150 and flows within 0.0032 L/min (143 to the thousandth); jpeg-js
   put two of them to "Osäker", changed the reference on five and moved flows
   by up to 0.026. macOS's own decoder (sips) reproduces the browser exactly,
   150 of 150, but does not run on Cloudflare. Four times faster than jpeg-js
   too (2.5 against 9.7 ms a frame in Node). */
init(mozjpeg);
const read = makeReader(E, PROFILES, decodeJpeg);
const ENGINE_VERSION = E.ENGINE_VERSION;

/* D1 rows read and written, summed for the run and logged with it — the same
   reason the admin Worker meters every statement: the free tier's daily read
   quota ran out once (2026-09-11) and nobody could say which query spent it. */
const meter = { read: 0, written: 0 };
const count = (r) => { for (const x of [].concat(r)) {
  meter.read += x.meta?.rows_read ?? 0; meter.written += x.meta?.rows_written ?? 0; } return r; };

async function run(env) {
  const DB = env.DB, now = () => new Date().toISOString();
  meter.read = meter.written = 0;
  let st = count(await DB.prepare('SELECT * FROM reader_state WHERE id = 1').all()).results[0];
  if (!st) {
    /* First run ever: start from the newest frame, not the archive — the old
       frames are from other camera poses and engines, and the admin page's
       sweep with its epoch filter is the tool for those. */
    count(await DB.prepare(`INSERT INTO reader_state (id, last_id, tries, given_up)
                      SELECT 1, COALESCE(MAX(id), 1) - 1, 0, 0 FROM readings`).run());
    st = count(await DB.prepare('SELECT * FROM reader_state WHERE id = 1').all()).results[0];
  }
  /* `engine` is written on every save, so the admin page can tell a reader
     left on an old engine (deployed before build_webui.mjs changed it) from
     one that is current — its rows would otherwise look like any other.
     last_run_at only by the save that ENDS a run: a run Cloudflare cuts off
     must not look like one that finished, that is the failure to show. */
  const save = async (extra = [], ended = false) => {
    if (ended) st.last_run_at = now();
    return count(await DB.batch([...extra, DB.prepare(
      `UPDATE reader_state SET last_id = ?, trying_id = ?, tries = ?, given_up = ?,
              last_run_at = ?, last_read_at = ?, last_error = ?, engine = ? WHERE id = 1`)
      .bind(st.last_id, st.trying_id, st.tries, st.given_up, st.last_run_at, st.last_read_at,
            st.last_error, ENGINE_VERSION)]));
  };

  /* Only frames with work in them: no image, or already read with this engine
     in the browser, would otherwise use up the run's PER_RUN. `top` is the
     newest frame at the start, so a run that empties the queue can move
     last_id past the frames it had no reason to fetch. */
  const top = count(await DB.prepare('SELECT COALESCE(MAX(id), 0) AS top FROM readings').all())
    .results[0].top;
  const { results: rows } = count(await DB.prepare(
    `SELECT r.id, r.image_key, r.fw, r.preset
       FROM readings r
      WHERE r.id > ?1 AND r.id <= ?4 AND r.image_key IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM analyses a WHERE a.reading_id = r.id AND a.engine = ?2)
      ORDER BY r.id LIMIT ?3`)
    .bind(st.last_id, ENGINE_VERSION, PER_RUN, top).all());

  const n = { read: 0, skipped: 0, gaveUp: 0, thrown: 0 };
  let broke = false;   // the run stopped on an error rather than running out of work
  const advance = (id) => { st.last_id = id; st.trying_id = null; st.tries = 0; };
  for (const row of rows) {
    const tries = row.id === st.trying_id ? st.tries : 0;
    if (tries >= MAX_TRIES) {
      console.log(`reader: giving up on frame ${row.id} after ${tries} runs that did not finish`);
      advance(row.id); st.given_up++; n.gaveUp++;
      continue;
    }

    // Written down before the work, so a run cut off here is counted.
    st.trying_id = row.id; st.tries = tries + 1;
    await save();

    const failed = (e) => `frame ${row.id}: ${String(e?.message ?? e).slice(0, 200)}`;
    let bytes;
    try {
      const obj = await env.IMAGES.get(row.image_key);
      bytes = obj ? await obj.arrayBuffer() : null;
    } catch (e) {
      /* R2 can fail for a moment: left as `trying`, the next run tries again
         and MAX_TRIES ends it. */
      st.last_error = failed(e);
      console.log(`reader: ${st.last_error}`);
      broke = true;
      break;
    }
    let res;
    try {
      res = bytes ? await read(bytes, presetOf(row)) : { skip: 'image missing in R2' };
    } catch (e) {
      /* The decoder or the engine threw. The same bytes would throw again, so
         this frame is given up now rather than block the queue for three runs
         — but only one a run: a decoder that is broken as a whole (its WASM
         failed to start) throws on every frame, and must not empty the queue
         in one go. A second one waits as `trying` for the next run. */
      st.last_error = failed(e);
      console.log(`reader: ${st.last_error}`);
      if (n.thrown++) { broke = true; break; }
      advance(row.id); st.given_up++; n.gaveUp++;
      continue;
    }
    // The admin Worker's bounds on a stored flow (clean()), so the two writers agree.
    if (!res.skip && !storableFlow(res.v)) res = { skip: `flow ${res.v.flow} outside what is stored` };
    if (res.skip) {
      console.log(`reader: frame ${row.id} skipped: ${res.skip}`);
      advance(row.id); n.skipped++;
      continue;
    }
    advance(row.id); st.last_read_at = now(); n.read++;
    /* DO NOTHING on a conflict: if the browser read this frame with this
       engine in the meantime, its row stands. */
    await save([DB.prepare(
      `INSERT INTO analyses (reading_id, engine, flow, state, quality, analysed_at)
            VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(reading_id, engine) DO NOTHING`)
      .bind(row.id, ENGINE_VERSION, res.v.flow, res.v.state,
            cleanQuality({ ...res.q, src: 'server' }), now())]);
  }
  /* A run that worked through what it fetched: the queue up to `top` is done
     (what it did not fetch had no work), its error, if an earlier run left
     one, is history, and it counts as completed. One that stopped on an
     error, or hit one and read nothing, is not completed — a reader that
     fails on every frame must turn the admin page red, not look like a
     quiet hour. */
  if (!broke) {
    if (rows.length < PER_RUN && st.trying_id == null) st.last_id = Math.max(st.last_id, top);
    if (!n.thrown) st.last_error = null;
  }
  await save([], !broke && !(n.thrown && !n.read));
  console.log(`reader: engine ${ENGINE_VERSION}, ${n.read} read, ${n.skipped} skipped, ` +
              `${n.gaveUp} given up, up to frame ${st.last_id}; ` +
              `d1 ${meter.read} rows read, ${meter.written} written`);
}

export default {
  async scheduled(event, env, ctx) {
    await run(env);
  },
};
