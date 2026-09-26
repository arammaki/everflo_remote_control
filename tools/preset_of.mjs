/* Which concentrator preset a stored reading was taken with — ONE copy of the
   rule, imported by the admin Worker, publish_firmware.mjs and
   score_uploads.mjs, because a rule kept in three places drifts (the bottom
   state's threshold once did, to three different numbers).

   The device reports its preset with every upload since 1.10.13. NULL is
   therefore EverFlo only when the firmware predates that: every such build
   drove an EverFlo, which is history, not a default. A NULL from newer firmware
   means the row went through an ingest Worker that did not write the column
   (deployed out of order, or rolled back), and then nobody knows the machine:
   '?' is no preset, and every consumer refuses to read it. fw NULL is older
   still — the column predates 1.10.13 — so it is EverFlo too. */
export function presetOf(row) {
  if (row.preset != null) return row.preset;
  if (row.fw == null) return 'everflo';
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(row.fw);
  if (!m) return '?';
  const [a, b, c] = m.slice(1).map(Number);
  // Numbers, not text: '1.9.7' sorts after '1.10.13' as a string.
  return (a !== 1 ? a < 1 : b !== 10 ? b < 10 : c < 13) ? 'everflo' : '?';
}
