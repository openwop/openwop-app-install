#!/usr/bin/env node
/**
 * ADR 0661 phase 2 — an allowlist entry whose file no longer fetches is a LIE.
 *
 * Phase 1 shipped a ratchet that checks entries EXIST, are unique and sorted, and
 * never exceed a ceiling. It said out loud what it could not check: a listed file
 * that has stopped making live calls. That entry keeps the guard permanently
 * disarmed for a path nothing uses, and it overstates the remaining work — the
 * count is the thing people will steer by.
 *
 * It is not hypothetical. Phase 3's first burn-down fixed three files and left all
 * three lines in place; the ratchet reported a healthy 88 and could not see it.
 *
 * WHY A SEPARATE SCRIPT AND NOT A GATE INSIDE THE GUARD. The fact is only knowable
 * AFTER a whole suite has run, aggregated across parallel workers — no single test
 * file can observe it. So the guard WITNESSES (appends the file path when an
 * allowlisted call actually happens) and this script JUDGES, once, at the end.
 *
 * COST: none. `ci.sh` points OPENWOP_LIVE_FETCH_AUDIT at a temp file around the
 * frontend vitest step it already runs, then calls this. No extra suite run.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: fail on an unwitnessed entry when the audit
 * is absent or empty. An empty audit means the witness did not run — a scan that
 * saw nothing must not read as "every entry is stale", which would be the same
 * measured-the-wrong-population defect this ADR keeps finding. It REFUSES instead.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LIST = join(ROOT, 'frontend', 'react', 'test-live-fetch-allowlist.txt');
const AUDIT = process.argv[2] ?? process.env['OPENWOP_LIVE_FETCH_AUDIT'];

const fail = (m) => { console.error(`✗ check-live-fetch-stale: ${m}`); process.exit(1); };

if (!AUDIT) fail('no audit path given (argv[1] or OPENWOP_LIVE_FETCH_AUDIT). Nothing was compared.');
if (!existsSync(AUDIT)) fail(`audit file ${AUDIT} does not exist — the witness never ran. Nothing was compared.`);

// An entry may carry an inline reason: `path  # why`. Entries WITH one are
// exempt from the stale assertion below — see ENTRIES_WITH_REASON.
const rawLines = readFileSync(LIST, 'utf8').split('\n').map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));
const entryPath = (l) => l.split('#')[0].trim();
const entries = rawLines.map(entryPath);
/** Paths whose line carries `# …` — a stated reason this file may not fetch every run. */
const excused = new Set(rawLines.filter((l) => l.includes('#')).map(entryPath));
const witnessed = new Set(readFileSync(AUDIT, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean));

// THE FLOOR. An empty or near-empty audit is a broken witness, not a clean tree.
// Without this the check would "pass" by declaring every entry stale, or worse,
// report a huge cleanup that is an artefact of its own instrumentation.
if (witnessed.size === 0) {
  fail(`the audit recorded ZERO allowlisted fetches across the whole suite. That is the witness failing, not ${entries.length} stale entries. Check that ci.sh exports OPENWOP_LIVE_FETCH_AUDIT around the vitest step and that src/test/no-live-fetch.ts is in setupFiles.`);
}

// EXCUSED ENTRIES ARE NOT STALE. Some allowlisted reads are fire-and-forget
// effects that race the end of the test, so whether they fetch AT ALL varies run
// to run on an unchanged tree — `failedReadDecisions.test.tsx` is the measured
// case. Reporting those as stale would make this check red at random, which is
// worse than the gap it closes.
//
// The first version had no such exemption, and its own failure message told the
// reader to "say so in a comment beside the entry" — a remedy NONE of the three
// parsers implemented. It fired on its first real full-CI run. A remedy that
// cannot be followed is the same defect #3770 fixed in a different message.
const stale = entries.filter((e) => !witnessed.has(e) && !excused.has(e));
if (stale.length > 0) {
  fail(
    `${stale.length} allowlist entr(y/ies) never made a live call in this run:\n` +
      stale.map((s) => `  ${s}`).join('\n') +
      `\n  Each keeps the guard disarmed for a file that no longer needs it, and inflates the\n` +
      `  count people steer by. If the file was fixed, delete the line and lower the CEILING in\n` +
      `  scripts/check-live-fetch-allowlist.mjs. If it fetches only on a path this run did not\n` +
      `  take, say so in a comment beside the entry — an unexplained silent entry is the defect.`,
  );
}

const exc = excused.size ? `, ${excused.size} excused with a stated reason` : '';
console.log(`✓ check-live-fetch-stale: ${entries.length - excused.size} allowlist entr(y/ies) witnessed making a live call${exc} (${witnessed.size} distinct file(s) recorded).`);
