#!/usr/bin/env node
/* ============================================================
   Publishes a firmware build so the unit can pull it over the air, and arms
   it so it actually will.

       node tools/publish_firmware.mjs publish <build.bin> <version>
       node tools/publish_firmware.mjs arm     <version> [--switch-machine]
       node tools/publish_firmware.mjs disarm
       node tools/publish_firmware.mjs status

   Two verbs, not one, on purpose. Publishing is safe — the build sits in R2
   and the device is never told about it. Arming is the act that lets a unit
   at a patient's home replace its own firmware, and it should cost a separate
   deliberate command. A single "deploy" would make the dangerous thing the
   easy thing.

   The device does the rest by itself: it asks once every 15 minutes, installs
   only an armed build whose version differs from its own, verifies the MD5,
   and reboots. When the new firmware boots and reports in, the ingest handler
   disarms. So a build that bricks the unit stays armed — it never landed.

   Recovery has no OTA path. There is no bootloader rollback, so a firmware
   that does not boot is fixed over USB, at her home. Before arming, flash the
   same .bin over the cable or over ArduinoOTA at least once and watch it come
   up. This tool is for the second unit-visit you avoid, not the first.

   Every build is for one concentrator (CONCENTRATOR in the sketch). `arm`
   compares the build's machine with the one the unit last reported and
   refuses a mismatch unless --switch-machine is given: moving the unit to
   another machine over the air is legitimate — switching back to the EverFlo
   is the whole point of keeping its preset — but it must be the act you meant,
   not a rollback that happened to pick the other machine's build.

   The version MUST equal the FW_VERSION compiled into the .bin, because that
   is what the device compares against and what the disarm-on-report matches.
   The mismatch is checked below rather than trusted.
   ============================================================ */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { presetOf } from './preset_of.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const CLOUD = join(here, '..', 'cloud');
const SKETCH = join(here, '..', 'everflo_remote_control.ino');
const BUCKET = 'everflo-images';

const wrangler = (args, opts = {}) =>
  execFileSync('npx', ['wrangler', ...args], { cwd: CLOUD, encoding: 'utf8', ...opts });

/** Runs SQL and returns the rows. */
function sql(command) {
  const out = wrangler(['d1', 'execute', 'everflo', '--remote', '--json', '--command', command],
                       { stdio: ['ignore', 'pipe', 'inherit'] });
  return JSON.parse(out.slice(out.indexOf('[')))[0].results;
}

/** Single-quoted SQL literal. Values here are version strings and hex digests,
    but quoting them properly costs one line and removes the question. */
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

const [verb, ...rest] = process.argv.slice(2);

if (verb === 'status') {
  const rows = sql('SELECT version, preset, size, md5, uploaded_at, armed_at FROM firmware ORDER BY uploaded_at DESC');
  if (!rows.length) { console.log('No firmware published.'); process.exit(0); }
  console.log('version   machine     size      uploaded              armed');
  for (const r of rows) {
    console.log(`${String(r.version).padEnd(9)} ${String(r.preset ?? '-').padEnd(10)} ` +
                `${String(r.size).padStart(8)}  ` +
                `${r.uploaded_at.slice(0, 19).replace('T', ' ')}   ` +
                (r.armed_at ? `ARMED ${r.armed_at.slice(0, 19).replace('T', ' ')}` : '-'));
  }
  process.exit(0);
}

if (verb === 'disarm') {
  sql('UPDATE firmware SET armed_at = NULL WHERE armed_at IS NOT NULL');
  console.log('Disarmed. The device will not be offered an update.');
  process.exit(0);
}

if (verb === 'arm') {
  const switching = rest.includes('--switch-machine');
  const version = rest.filter((a) => a !== '--switch-machine')[0];
  if (!version || rest.some((a) => a.startsWith('--') && a !== '--switch-machine')) {
    console.error('Usage: arm <version> [--switch-machine]'); process.exit(2);
  }
  const row = sql(`SELECT version, preset FROM firmware WHERE version = ${q(version)}`)[0];
  if (!row) { console.error(`Version ${version} has not been published.`); process.exit(2); }
  // Builds published before presets recorded none, and every one was EverFlo.
  const buildFor = row.preset ?? 'everflo';
  const last = sql('SELECT preset, fw FROM readings ORDER BY received_at DESC LIMIT 1')[0];
  const unitIs = last ? presetOf(last) : '?';
  console.log(`Build ${version} is for ${buildFor}; the unit last reported ${unitIs}.`);
  if (buildFor !== unitIs && !switching) {
    console.error('Refusing: that would move the unit to another machine\'s calibration and ' +
                  'button sizes. If that is what you mean, add --switch-machine.');
    process.exit(2);
  }
  // Only one row may be armed — the schema enforces it, so clear first rather
  // than collide with the unique index.
  sql('UPDATE firmware SET armed_at = NULL WHERE armed_at IS NOT NULL');
  sql(`UPDATE firmware SET armed_at = ${q(new Date().toISOString())} WHERE version = ${q(version)}`);
  console.log(`Armed ${version}, built for ${buildFor}.`);
  console.log('The unit will pick it up within 15 minutes and reboot into it.');
  console.log('It disarms itself once the new firmware reports in. If it never');
  console.log('does, the update did not land and recovery is over USB.');
  process.exit(0);
}

if (verb !== 'publish') {
  console.error('Usage: publish <build.bin> <version> | arm <version> | disarm | status');
  process.exit(2);
}

const [binPath, version] = rest;
if (!binPath || !version) { console.error('Usage: publish <build.bin> <version>'); process.exit(2); }

const bin = readFileSync(binPath);

/* The version the device will compare against is the one compiled into the
   image. Getting these out of step means either an update that installs
   forever or one that never installs, so check rather than trust. */
const compiled = readFileSync(SKETCH, 'utf8').match(/#define\s+FW_VERSION\s+"([^"]+)"/)?.[1];
if (compiled !== version) {
  console.error(`Refusing: FW_VERSION in the sketch is ${compiled}, you said ${version}.`);
  console.error('Publish the version that is actually compiled into the .bin.');
  process.exit(2);
}
if (!bin.subarray(0, 64 * 1024).includes(Buffer.from(version, 'ascii'))) {
  console.error(`Refusing: the string "${version}" does not appear in the image header.`);
  console.error('That usually means the .bin is stale — rebuild before publishing.');
  process.exit(2);
}

/* Which concentrator the image was built for, read from the image itself
   rather than the sketch — the sketch may have been edited since the build.
   The firmware logs "Concentrator preset: <id>" at boot, so the string is in
   every build since 1.10.13, and an image without it is refused. */
const preset = bin.toString('latin1').match(/Concentrator preset: ([a-z0-9_-]{1,32})/)?.[1];
if (!preset) {
  console.error('Refusing: no "Concentrator preset:" string in the image — built before 1.10.13?');
  process.exit(2);
}
console.log(`Built for: ${preset}`);
/* One version names one build. The R2 key has no machine in it, so a second
   build of the same version for another machine would silently replace the
   first — possibly the very image kept for rolling back. Bump FW_VERSION. */
const existing = sql(`SELECT preset FROM firmware WHERE version = ${q(version)}`)[0];
if (existing && (existing.preset ?? 'everflo') !== preset) {
  console.error(`Refusing: ${version} is already published for ${existing.preset ?? 'everflo'}. ` +
                'Bump FW_VERSION for the other machine\'s build.');
  process.exit(2);
}

const md5 = createHash('md5').update(bin).digest('hex');
const key = `firmware/everflo-${version}.bin`;

console.log(`Uploading ${bin.length} bytes to ${key} ...`);
// Absolute: wrangler runs with cwd set to cloud/, so a path the user typed
// relative to the repo root would resolve somewhere else entirely.
wrangler(['r2', 'object', 'put', `${BUCKET}/${key}`, '-J', 'eu', '--remote',
          '--file', resolve(binPath), '--content-type', 'application/octet-stream'],
         { stdio: 'inherit' });

sql(`INSERT INTO firmware (version, r2_key, md5, size, uploaded_at, armed_at, preset)
     VALUES (${q(version)}, ${q(key)}, ${q(md5)}, ${bin.length}, ${q(new Date().toISOString())}, NULL, ${q(preset)})
     ON CONFLICT(version) DO UPDATE SET
       r2_key = excluded.r2_key, md5 = excluded.md5,
       size = excluded.size, uploaded_at = excluded.uploaded_at, preset = excluded.preset`);

console.log(`Published ${version} for ${preset}, md5 ${md5}. NOT armed.`);
/* Said this way since 2026-09-12. It used to say "flash it once and watch it
   boot, then arm", which read literally makes the cloud path pointless: next
   to the unit you do not need it, away from it you can never satisfy it. The
   condition that matters is whether you could reach the unit tonight if the
   build does not boot — because that is the one failure this cannot undo. */
console.log(`Arm it only while you could drive over and fix it: a build that`);
console.log(`boots but misbehaves you can undo by arming the previous version,`);
console.log(`but one that does not boot at all needs a USB cable on site.`);
console.log(`  node tools/publish_firmware.mjs arm ${version}`);
