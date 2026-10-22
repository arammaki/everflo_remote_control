#!/usr/bin/env node
/* ============================================================
   Inlines balldetector.js into the two companion HTML pages.

       node build_webui.mjs           write the pages
       node build_webui.mjs --check   verify only, exit 1 if out of date

   The pages must stay self-contained single files: they are opened
   straight from the filesystem on a phone, where a relative
   <script src> does not load reliably. So the engine is duplicated
   into them on purpose — but generated, never hand-maintained.

   Edit the engine in balldetector.js. Everything between the markers
   in the HTML files is overwritten without warning.
   ============================================================ */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SOURCE = 'balldetector.js';
const TARGETS = ['everflo_control_panel.html', 'everflo_image_diagnostics.html'];
/* The sketch serves the same engine at /motor.js so the device page can show
   a reading without anyone transferring a file to a phone. It is a separate
   header, not part of the page string, because the page is copied into a
   String on every request and the engine (about 1 MB with its reference
   images) would not fit in heap. */
const HEADER = 'balldetector_js.h';

const BEGIN = '/* === ENGINE:BEGIN — generated from balldetector.js, do not edit here === */';
const END = '/* === ENGINE:END === */';

const check = process.argv.includes('--check');
const engine = readFileSync(join(here, SOURCE), 'utf8').replace(/\n+$/, '\n');

let stale = 0;
for (const name of TARGETS) {
  const path = join(here, name);
  const html = readFileSync(path, 'utf8');

  const from = html.indexOf(BEGIN);
  const to = html.indexOf(END);
  if (from === -1 || to === -1 || to < from) {
    console.error(`${name}: markers missing or reversed — refusing to touch the file.`);
    process.exit(2);
  }

  const wanted = html.slice(0, from + BEGIN.length) + '\n' + engine + html.slice(to);
  if (wanted === html) {
    console.log(`${name}: up to date`);
    continue;
  }
  stale++;
  if (check) {
    console.error(`${name}: OUT OF DATE — run: node build_webui.mjs`);
    continue;
  }
  writeFileSync(path, wanted);
  console.log(`${name}: updated`);
}

/* The C++ header. A raw string literal, so the delimiter must not appear in
   the engine — )JS" does not occur in JavaScript, but check anyway rather
   than emit a file that fails to compile in a confusing way. */
if (engine.includes(')JS"')) {
  console.error(`${SOURCE}: contains the raw-string delimiter )JS" — pick another delimiter.`);
  process.exit(2);
}
/* FNV-1a over the engine source. A content hash rather than a constant someone
   has to remember to bump, because it cannot drift from the code. It is the
   admin page's cache key, and since v1.9.7 the device reports it with every
   upload so a stored reading can be attributed to the engine that was live at
   the time. Computed here because both the header and the admin module need
   it. */
let h = 2166136261;
for (let i = 0; i < engine.length; i++) {
  h ^= engine.charCodeAt(i); h = Math.imul(h, 16777619);
}
const engineVersion = (h >>> 0).toString(16);

/* One engine per machine in the header, because a build drives ONE machine
   (CONCENTRATOR in the sketch) and the references of the other are the bulk of
   the engine: on 2026-10-22 the Platinum's five were 783 kB of an OTA slot at
   96%. Each variant is the whole engine with the OTHER machine's reference
   constants set to null — its preset is still there, so nothing else in the
   source changes, but its refs() would hand loadRef() nulls, which is why the
   sketch picks the variant with the same switch that picks the preset. The
   pages and the admin Worker keep every reference: the admin reads both
   machines' frames, and the diagnostics page offers both.
   ENGINE_VERSION stays the hash of the FULL source: for the machine a build
   drives the variant is the same engine, and the admin page, which runs the
   full one, must keep recognising the device's readings as its own. */
const VARIANTS = [['CONC_EVERFLO', 'EVERFLO'], ['CONC_PLATINUM9', 'PLATINUM9']];
const refNames = [...engine.matchAll(/^const (REF_PNG_[A-Z0-9_]+)="data:image\/png;base64,/gm)].map((m) => m[1]);
for (const n of refNames) {
  if (!VARIANTS.some(([, p]) => n.startsWith(`REF_PNG_${p}_`))) {
    console.error(`${SOURCE}: ${n} belongs to no machine in VARIANTS — name it REF_PNG_<MACHINE>_… or add the machine.`);
    process.exit(2);
  }
}
/* Each preset's refs() must name only ONE machine's constants: a list that
   borrowed the other machine's would compile and then find null on the device
   (a refusal on her page, not a wrong number, but caught here instead). */
for (const m of engine.matchAll(/refs:\(\)=>\[([\s\S]*?)\]\],/g)) {
  const machines = new Set([...m[1].matchAll(/REF_PNG_([A-Z0-9]+)_/g)].map((x) => x[1]));
  if (machines.size !== 1) {
    console.error(`${SOURCE}: a preset's refs() names ${machines.size ? [...machines].join(' and ') : 'no'} machine(s); it must name exactly one.`);
    process.exit(2);
  }
}
const variant = (keep) => {
  const out = engine.replace(/^const (REF_PNG_[A-Z0-9_]+)="data:image\/png;base64,[^"]*";$/gm,
    (line, n) => (n.startsWith(`REF_PNG_${keep}_`) ? line : `const ${n}=null;   // not in this machine's build`));
  const left = [...out.matchAll(/^const (REF_PNG_[A-Z0-9_]+)="data:/gm)].map((m) => m[1]);
  const want = refNames.filter((n) => n.startsWith(`REF_PNG_${keep}_`));
  if (left.join() !== want.join()) {
    console.error(`${HEADER}: the ${keep} variant kept [${left}] but should keep [${want}].`);
    process.exit(2);
  }
  return out;
};
const header = `/* GENERATED by build_webui.mjs from ${SOURCE} — do not edit.
   Served at /motor.js so the device page can compute a reading itself.
   One variant per machine, chosen by CONCENTRATOR: include this AFTER it. */
#pragma once
#define ENGINE_VERSION "${engineVersion}"
#if !defined(CONCENTRATOR) || ${VARIANTS.map(([c]) => `!defined(${c})`).join(' || ')}
  #error "balldetector_js.h: define CONCENTRATOR and the CONC_* machine ids before including it"
${VARIANTS.map(([c, p]) => `#elif CONCENTRATOR == ${c}
static const char BALLDETECTOR_JS[] = R"JS(
${variant(p)})JS";`).join('\n')}
#else
  #error "balldetector_js.h: no engine variant for this CONCENTRATOR"
#endif
`;
const headerPath = join(here, HEADER);
let headerNow = '';
try { headerNow = readFileSync(headerPath, 'utf8'); } catch { /* first run */ }
if (headerNow !== header) {
  stale++;
  if (check) console.error(`${HEADER}: OUT OF DATE — run: node build_webui.mjs`);
  else { writeFileSync(headerPath, header); console.log(`${HEADER}: updated`); }
} else {
  console.log(`${HEADER}: up to date`);
}

/* The admin Worker serves the same engine so uploaded frames can be analysed
   in the browser, where the calibration actually applies. JSON.stringify does
   the escaping, so no delimiter in the engine can break the module. */
const ADMIN = join(here, 'cloud', 'admin', 'src', 'engine.js');
const adminMod = `/* GENERATED by build_webui.mjs from ${SOURCE} — do not edit. */\n` +
  `export const ENGINE = ${JSON.stringify(engine)};\n` +
  `export const ENGINE_VERSION = ${JSON.stringify(engineVersion)};\n`;
let adminNow = '';
try { adminNow = readFileSync(ADMIN, 'utf8'); } catch { /* first run */ }
if (adminNow !== adminMod) {
  stale++;
  if (check) console.error(`cloud/admin/src/engine.js: OUT OF DATE — run: node build_webui.mjs`);
  else { writeFileSync(ADMIN, adminMod); console.log('cloud/admin/src/engine.js: updated'); }
} else {
  console.log('cloud/admin/src/engine.js: up to date');
}

/* The reader Worker (cloud/reader) reads uploads on the server, on a free plan
   that gives it 10 ms of CPU an invocation — so it gets the engine as a module
   with every REF_PNG set to null (they are most of its size, and it never
   decodes them) and the profiles analyze() actually uses, precomputed from
   those PNGs by tools/reader_profiles.mjs. Same ENGINE_VERSION: it is the same
   engine, and its readings go in the same column as the admin page's. */
{
  const { buildProfiles, EXPORTS } = await import('./tools/reader_profiles.mjs');
  const stripped = engine.replace(/^const (REF_PNG_[A-Z0-9_]+)="data:image\/png;base64,[^"]*";$/gm,
    (line, n) => `const ${n}=null;   // the reader uses tools/reader_profiles.mjs's profiles instead`);
  if (/"data:image\/png;base64,/.test(stripped)) {
    console.error(`${SOURCE}: a reference PNG the reader's strip pattern did not match.`);
    process.exit(2);
  }
  const gen = `/* GENERATED by build_webui.mjs from ${SOURCE} — do not edit. */\n`;
  const files = [
    ['cloud/reader/src/engine.js', gen + stripped + EXPORTS +
      `export const ENGINE_VERSION = ${JSON.stringify(engineVersion)};\n`],
    ['cloud/reader/src/profiles.js', gen +
      `export const PROFILES = ${JSON.stringify(await buildProfiles(engine))};\n`],
  ];
  for (const [rel, text] of files) {
    let now = '';
    try { now = readFileSync(join(here, rel), 'utf8'); } catch { /* first run */ }
    if (now === text) { console.log(`${rel}: up to date`); continue; }
    stale++;
    if (check) console.error(`${rel}: OUT OF DATE — run: node build_webui.mjs`);
    else { writeFileSync(join(here, rel), text); console.log(`${rel}: updated`); }
  }
}

if (check && stale) process.exit(1);

// Belt and braces: the engine must be byte-identical in both pages.
if (!check) {
  const cut = (s) => s.slice(s.indexOf(BEGIN), s.indexOf(END) + END.length);
  const [a, b] = TARGETS.map((n) => cut(readFileSync(join(here, n), 'utf8')));
  if (a !== b) {
    console.error('MISMATCH: the inlined engines differ between the two pages.');
    process.exit(3);
  }
  console.log('engine byte-identical in both pages');
}

/* The HMAC-SHA256 that signs control requests (v1.12.0) lives twice — in her
   page inside the sketch and in the control panel — because her page must
   work without /motor.js. Two hand-kept copies are exactly what broke a
   quality gate in 2026-08, so both runs check they are identical; if they
   are not, every press from one of them is refused. The copies are checked
   against node:crypto by tools/test_hmac.mjs. */
{
  const block = (name) => {
    const t = readFileSync(join(here, name), 'utf8');
    const a = t.indexOf('const SHA_K=['), b = t.indexOf('\nfunction hmacHex(', a), e = t.indexOf('\n}\n', b);
    return a < 0 || b < 0 || e < 0 ? null : t.slice(a, e + 2);
  };
  const [pg, cp] = ['everflo_remote_control.ino', 'everflo_control_panel.html'].map(block);
  if (!pg || !cp || pg !== cp) {
    console.error('MISMATCH: the HMAC block differs between her page (the .ino) and the control panel.');
    process.exit(4);
  }
  console.log('control-key HMAC identical in her page and the control panel');
}
