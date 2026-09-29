#!/usr/bin/env node
/* ============================================================
   Checks the plain-JS HMAC-SHA256 that her page and the control panel sign
   control requests with, against node:crypto.

       node tools/test_hmac.mjs

   The code lives twice — inline in the device page (everflo_remote_control.ino)
   and in everflo_control_panel.html — because her page must work even when
   /motor.js does not load, and an http:// page has no crypto.subtle. This
   reads the block out of BOTH files, byte for byte as shipped, so the copies
   cannot drift apart or break unseen. A signature the device rejects looks to
   her like "not approved to control". Exits non-zero on any mismatch.
   ============================================================ */
import { readFileSync } from 'node:fs';
import { createHmac, randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const block = (text, where) => {
  const a = text.indexOf('const SHA_K=['), b = text.indexOf('\nfunction hmacHex(', a);
  const end = text.indexOf('\n}\n', b);
  if (a < 0 || b < 0 || end < 0) throw new Error(`${where}: HMAC block not found`);
  return text.slice(a, end + 2);
};
const sources = {
  'device page': block(readFileSync(join(root, 'everflo_remote_control.ino'), 'utf8'), 'device page'),
  'control panel': block(readFileSync(join(root, 'everflo_control_panel.html'), 'utf8'), 'control panel'),
};
if (sources['device page'] !== sources['control panel']) {
  console.error('The two copies differ — they must be identical.');
  process.exit(1);
}
const hmacHex = new Function(sources['device page'] + '\nreturn hmacHex;')();
const cases = [['key', 'The quick brown fox jumps over the lazy dog'], ['', ''], ['k'.repeat(100), 'x'],
  ['åäö', '/api/plus?steg=40&n=00ff00ff00ff00ff00ff00ff00ff00ff']];
for (let i = 0; i < 500; i++)
  cases.push([randomBytes(i % 70).toString('hex'), '/api/plus?steg=' + i + '&n=' + randomBytes(16).toString('hex') + 'x'.repeat(i % 130)]);
let bad = 0;
for (const [k, m] of cases)
  if (hmacHex(k, m) !== createHmac('sha256', Buffer.from(k, 'utf8')).update(Buffer.from(m, 'utf8')).digest('hex')) bad++;
console.log(`${cases.length} cases, ${bad} mismatches; both copies identical`);
process.exit(bad ? 1 : 0);
