#!/usr/bin/env node
/**
 * How much does THIS APP still rely on OpenWOP major 1?
 *
 * WHY THIS EXISTS. "Is there any v1 reliance left?" was asked, answered by a
 * hand audit, and the answer was five structural facts spread across four
 * layers — none of which any check could restate later. A hand audit is a claim
 * with a timestamp; the next person either re-does it or trusts a sentence.
 * ADR 0642's inventory has exactly that problem: it is a table in a document,
 * and nothing notices when the code moves underneath it.
 *
 * WHAT THIS IS NOT. It is NOT (yet) a gate demanding zero.
 *
 * CORRECTED 2026-10-15 (ADR 0812 P4 slice 2b): ONE metric now IS a gate at
 * zero — `ownV1PathRefs`, this host's own paths spelled `/v1` in shipped code.
 * The rest stay ratchets: the test corpus still holds the 410/308 front's own
 * tests, which must keep calling `/v1` to prove it answers 410.
 *
 * CORRECTED 2026-10-04 (ADR 0812): this used to say zero was FORBIDDEN until
 * the v1 EOS clock (2026-12-04). RFC 0234 (corpus 2.45.14) moved the floor to
 * 2026-10-04, app.openwop.dev retired v1 that day, and the product decision is to
 * DROP v1 from this codebase. Zero is now the TARGET. ADR 0812 P1–P3 drive the
 * counts there, and the ratchet keeps them from rising meanwhile.
 *
 * WHAT IT IS: a RATCHET. "No NEW v1 reliance" is enforceable today and is the
 * only half that is. Counts may fall freely; a count that RISES fails, because
 * every new `/v1/` call site is one more thing to migrate on cutover day and
 * the migration is already the largest part of the work.
 *
 * Run:  node scripts/check-v1-reliance.mjs [--update]
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanMatches, scanSites, stripeChokeViolations, keptLines, ownV1Pattern, V1_PATH } from './v1RelianceScan.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = join(ROOT, 'scripts', 'v1-reliance-baseline.json');

/** Scanning lives in `v1RelianceScan.mjs` so its reach is test-pinned (ADR 0786).
 *  History kept here: CORRECTED 2026-09-10 — comments and test files are not call
 *  sites (a PR that MOVED four SPA surfaces off /v1/ once read as +12). */
const matches = (dir, pattern, includes, excludes = []) => scanMatches(ROOT, dir, pattern, includes, excludes);

/** Test files are assertions ABOUT the wire, not calls on it. */
const NO_TESTS = ['--exclude-dir=__tests__', '--exclude=*.test.ts', '--exclude=*.test.tsx'];
const TS = ['*.ts', '*.tsx'];
/** Doc citations (`spec/v1/foo.md`, schema filenames) are prose, not call sites. */
const isDocCitation = (m) => /\.md\.?$|\.json$|\.schema\./.test(m);


/** The two constants that decide what a header-less client actually gets. */
/**
 * Read a named export's right-hand side out of a source file.
 *
 * THROWS when the symbol is not there, and that is the whole point.
 *
 * CORRECTED 2026-09-18 (ADR 0730 C.4). This returned the STRING
 * `'<unreadable>'` on a miss, and the caller printed it as the first and most
 * load-bearing fact in the report — the header-less default contract, the one
 * number that says whether this host still answers v1 by default. The symbol
 * it looked for, `PREFERRED_VERSION`, does not exist anywhere in the backend
 * and had not for some time: `preferredVersion` is a FUNCTION now, because the
 * retirement cut-switch made the value depend on `v1Retired()`. So the probe
 * printed `<unreadable>` and the script exited 0, run after run.
 *
 * An unreadable fact is indistinguishable from a healthy one when the exit
 * code is the same, which is the reliable tell for a check that has gone
 * inert. A probe that cannot find what it measures must fail, not narrate.
 */
function readExport(file, name) {
  const src = readFileSync(join(ROOT, file), 'utf8');
  const asConst = new RegExp(`export const ${name}[^=]*=\\s*([^;]+);`).exec(src);
  if (asConst) return asConst[1].trim();
  const asFn = new RegExp(`export function ${name}\\([^)]*\\)[^{]*\\{\\s*(?:\/\/[^\\n]*\\n\\s*)*return ([^;]+);`).exec(src);
  if (asFn) return asFn[1].trim();
  throw new Error(
    `check-v1-reliance: cannot read \`${name}\` from ${file}. The probe is measuring ` +
    `nothing. Point it at the symbol that owns this fact today, or delete the fact — ` +
    `do NOT let it report an unreadable value and pass.`,
  );
}
const preferred = readExport('backend/typescript/src/middleware/protocolVersion.ts', 'preferredVersion');

/** Does the SPA ever select major 2? One header would change the whole picture. */
const spaVersionHeader = matches('frontend/react/src', 'OpenWOP-Version|openwop-version|protocolVersion: V2_PROTOCOL_VERSION|major: 2', TS, NO_TESTS).length;

/**
 * URLs this host BUILDS that point at its own paths through a VERSIONED prefix:
 * a self-call (`${baseUrl}/v1/runs`), or a link it hands out
 * (`${publicBaseUrl(req)}/v1/host/…`). Each is a 410 on the day that major
 * retires. On 2026-09-30 they included the sub-run dispatcher and the messaging
 * bridge, which would have failed every sub-workflow and messaging run on the
 * ADR 0669 cut.
 *
 * Version-neutral on purpose (`/v<N>/`, not `/v1/`), so the next major needs no
 * edit here. "Our own paths" are DERIVED from the v2 path manifest's first
 * segments plus `host/`, never restated, so a new protocol family is covered the
 * day it lands. A third-party `/v1` API (ElevenLabs' `/v1/text-to-speech`) matches
 * neither.
 */
/**
 * ADR 0812 P4 slice 2b — the HARD gate. `/v1` spellings of this host's OWN
 * paths in shipped code (backend src, its sdk/ and conformance/ runners, the
 * SPA), tests excluded. v1 is deleted from this codebase, so the only
 * legitimate count is ZERO; a deliberate spelling (a persisted key, a
 * recogniser for links already sent) carries `ADR 0812 KEEP` and lands in the
 * ratcheted `keptV1Lines` instead.
 *
 * This REPLACES five per-layer counts (spa protocol/host-ext, backend
 * protocol/host-ext, and the older backend-only `/v1` total). Those counted
 * every `/v1/` string, so 50 of the backend's 71 were OpenAI, Gmail, GCS and
 * other third-party APIs, which no OpenWOP cut ever moves; zero was
 * unreachable and the number meant nothing. MEASURED 2026-10-15 on d3495f816.
 */
const OWN_SCAN_DIRS = [
  ['backend/typescript/src', ['*.ts'], NO_TESTS],
  ['backend/typescript/sdk', ['*.ts', '*.mjs', '*.js'], NO_TESTS],
  ['backend/typescript/conformance', ['*.ts', '*.mjs'], NO_TESTS],
  ['frontend/react/src', TS, NO_TESTS],
];
const HARD_ZERO = new Set(['ownV1PathRefs', 'backendVersionedOwnUrls']);

const ownSegments = [...new Set(JSON.parse(readFileSync(join(ROOT, 'schemas/v2/path-manifest.json'), 'utf8')).operations
  .map((o) => o.path.split('/')[1]?.split(':')[0])
  .filter((seg) => seg && !seg.startsWith('.')))];
const VERSIONED_OWN_URL = `\\$\\{[^}]*\\}/v[0-9]+/(host/|(${ownSegments.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})([/?:]|$))`;
const versionedOwnUrls = matches('backend/typescript/src', VERSIONED_OWN_URL, ['*.ts'], NO_TESTS);
const ownV1 = OWN_SCAN_DIRS.flatMap(([dir, inc, ex]) => scanSites(ROOT, dir, ownV1Pattern(ownSegments), inc, ex));
const kept = keptLines(ROOT, OWN_SCAN_DIRS.map(([d]) => d), ['*.ts', '*.tsx', '*.mjs', '*.js']);

/**
 * ADR 0812 P2 — the TEST CORPUS's `/v1` addressing. Excluded from every count
 * above on purpose: a test is an assertion about the wire, not a call on it.
 * With v1 being deleted it IS reliance, because each such test must be moved or
 * ported before P3 can remove the code it exercises. Counted separately so P2's
 * batches show progress and a new test cannot quietly add to the migration.
 * Includes the deliberate `/v1`-twin tests (retirement rehearsals, ADR 0806),
 * which P3 rewrites last.
 */
const testCorpus = [
  ...matches('backend/typescript/test', V1_PATH, TS),
  ...matches('frontend/react/e2e', V1_PATH, TS),
].filter((m) => !isDocCitation(m));

const measured = {
  testCorpusV1Refs: testCorpus.length,
  ownV1PathRefs: ownV1.length,
  keptV1Lines: kept.length,
  spaOpenWopVersionHeaders: spaVersionHeader,
  backendVersionedOwnUrls: versionedOwnUrls.length,
};

/**
 * DIRECTION IS PER-METRIC, and getting it wrong inverts the tool. Every count
 * here is v1 reliance and must not RISE — except `spaOpenWopVersionHeaders`,
 * which counts the SPA selecting major 2 and must not FALL.
 *
 * Caught by sabotage, not by review: the first version ratcheted every metric
 * one way, so adding `OpenWOP-Version: 2` to the SPA — the single most
 * desirable step toward v2 — failed as "new v1 reliance". A check that fails
 * the migration it exists to enable is worse than no check, because it is
 * cited as a reason not to migrate.
 */
const HIGHER_IS_BETTER = new Set(['spaOpenWopVersionHeaders']);

// CORRECTED 2026-10-15 (ADR 0812 P4 slice 2b): the last two facts here were
// hard-coded strings that went false at P3b/P3c and kept printing — "v2 is a
// rewrite onto the v1 handlers" had not been true for a week. They now state
// the current shape; only `preferredVersion` is read from source.
const facts = [
  ['preferredVersion (header-less default contract)', preferred],
  ['routing', 'routes register unversioned; /v1 answers 410 (held reads 308) at the front (ADR 0812 P3b/P3c)'],
  ['storage currentContract() fallback', '1 — the storage vocabulary for workers, not a wire major (ADR 0812 P0)'],
];

// ADR 0786 — the Stripe exemption must not be able to hide an OpenWOP path.
const chokeViolations = stripeChokeViolations(ROOT);
if (chokeViolations.length > 0) {
  for (const v of chokeViolations) console.error(`✗ check-v1-reliance: ${v}`);
  process.exit(1);
}

if (process.argv.includes('--update')) {
  writeFileSync(BASELINE, JSON.stringify(measured, null, 2) + '\n');
  console.log('✓ check-v1-reliance: baseline updated to current measurement.');
  console.log(JSON.stringify(measured, null, 2));
  process.exit(0);
}

if (!existsSync(BASELINE)) {
  console.error('✗ check-v1-reliance: no baseline. Create one with --update.');
  process.exit(1);
}
const base = JSON.parse(readFileSync(BASELINE, 'utf8'));

console.log('▶ v1 reliance inventory (ADR 0642 / ADR 0812; v1 retired on app.openwop.dev 2026-10-04)\n');
for (const [k, v] of facts) console.log(`  ${k.padEnd(48)} ${v}`);
console.log();

let failed = 0, improved = 0;
for (const [k, now] of Object.entries(measured)) {
  const was = base[k];
  const better = HIGHER_IS_BETTER.has(k);
  const regressed = HARD_ZERO.has(k) ? now > 0 : was !== undefined && (better ? now < was : now > was);
  const progressed = was !== undefined && (better ? now > was : now < was);
  if (regressed) failed++;
  if (progressed) improved++;
  const mark = was === undefined ? '?' : regressed ? '✗' : progressed ? '↓' : ' ';
  const dir = better ? ' (higher is better)' : HARD_ZERO.has(k) ? ' (must be 0)' : '';
  console.log(`  ${mark} ${k.padEnd(34)} ${String(now).padStart(5)}${was === undefined ? '  (no baseline)' : now === was ? '' : `  (baseline ${was})`}${dir}`);
}
console.log();

if (ownV1.length > 0) {
  console.error('✗ check-v1-reliance: shipped code spells one of this host\'s own paths with /v1:');
  for (const m of ownV1) console.error(`    ${m.file}:${m.line}  ${m.match}`);
  console.error('  v1 is deleted (ADR 0812). Use the unversioned path. If the string is not a');
  console.error('  call on the wire (a persisted key, a recogniser for an already-sent link),');
  console.error(`  mark the line \`ADR 0812 KEEP: <why>\` — it then counts in keptV1Lines.`);
}
if (failed > 0) {
  console.error(`✗ check-v1-reliance: ${failed} metric(s) moved the WRONG WAY (v1 reliance up, or v2 adoption down).`);
  console.error('  v1 is deleted from this codebase (ADR 0812) and /v1 answers 410 in production,');
  console.error('  so a new /v1 reference is a call that cannot succeed. Use the unversioned path');
  console.error('  (`/runs`, `/host/openwop-app/…`). Re-baseline with --update only when a count');
  console.error('  that rose is intended and stated (a new KEEP, a new 410-front test).');
  process.exit(1);
}
console.log(`✓ check-v1-reliance: no new v1 reliance${improved ? ` (${improved} count(s) fell — re-baseline with --update)` : ''}.`);
console.log('  NOTE: zero is the target (ADR 0812: v1 is being removed from this codebase).');
console.log('  Counts may only fall. Re-baseline with --update as each phase lands.');
