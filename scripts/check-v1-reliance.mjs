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
import { scanMatches, stripeChokeViolations, V1_PATH } from './v1RelianceScan.mjs';

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

const spa = matches('frontend/react/src', V1_PATH, TS, NO_TESTS);
const spaProtocol = spa.filter((m) => !m.startsWith('/v1/host/') && !isDocCitation(m));
const spaHostExt = spa.filter((m) => m.startsWith('/v1/host/openwop-app/'));

const be = matches('backend/typescript/src', V1_PATH, ['*.ts']);
const beProtocol = be.filter((m) => !m.startsWith('/v1/host/') && !isDocCitation(m));
const beHostExt = be.filter((m) => m.startsWith('/v1/host/openwop-app/'));

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
const ownSegments = [...new Set(JSON.parse(readFileSync(join(ROOT, 'schemas/v2/path-manifest.json'), 'utf8')).operations
  .map((o) => o.path.split('/')[1]?.split(':')[0])
  .filter((seg) => seg && !seg.startsWith('.')))];
const VERSIONED_OWN_URL = `\\$\\{[^}]*\\}/v[0-9]+/(host/|(${ownSegments.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})([/?:]|$))`;
const versionedOwnUrls = matches('backend/typescript/src', VERSIONED_OWN_URL, ['*.ts'], NO_TESTS);

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
  spaProtocolCallSites: spaProtocol.length,
  spaHostExtensionCallSites: spaHostExt.length,
  spaOpenWopVersionHeaders: spaVersionHeader,
  backendProtocolPathRefs: beProtocol.length,
  backendHostExtensionPathRefs: beHostExt.length,
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

const facts = [
  ['preferredVersion (header-less default contract)', preferred],
  ['storage currentContract() default', '1 — the v1 wire and every background worker'],
  ['v2 routing', "req.url = `/v1${req.url}` — v2 is a rewrite onto the v1 handlers"],
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
  const regressed = was !== undefined && (better ? now < was : now > was);
  const progressed = was !== undefined && (better ? now > was : now < was);
  if (regressed) failed++;
  if (progressed) improved++;
  const mark = was === undefined ? '?' : regressed ? '✗' : progressed ? '↓' : ' ';
  const dir = better ? ' (higher is better)' : '';
  console.log(`  ${mark} ${k.padEnd(34)} ${String(now).padStart(5)}${was === undefined ? '  (no baseline)' : now === was ? '' : `  (baseline ${was})`}${dir}`);
}
console.log();

if (failed > 0) {
  console.error(`✗ check-v1-reliance: ${failed} metric(s) moved the WRONG WAY (v1 reliance up, or v2 adoption down).`);
  console.error('  Every new /v1/ call site is one more migration on cutover day (ADR 0642).');
  console.error('  Use the unversioned key + `OpenWOP-Version: 2` where the operation is in');
  console.error('  schemas/v2/path-manifest.json. If it is a /v1/host/openwop-app/* extension');
  console.error('  path, there is a v2 home since RFC 0181 — the version-agnostic');
  console.error('  `/host/<org>/…` root (ADR 0652), which answers identically with or');
  console.error('  without a version header and does NOT retire with /v1. MEASURED live:');
  console.error('  /api/host/openwop-app/orgs and its /v1 twin both return 200. So a new');
  console.error('  /v1/host/openwop-app/* call site is now avoidable, not unavoidable —');
  console.error('  use the canonical root. Re-baseline with --update');
  console.error('  only when that cost is intended and stated.');
  process.exit(1);
}
console.log(`✓ check-v1-reliance: no new v1 reliance${improved ? ` (${improved} count(s) fell — re-baseline with --update)` : ''}.`);
console.log('  NOTE: zero is the target (ADR 0812: v1 is being removed from this codebase).');
console.log('  Counts may only fall. Re-baseline with --update as each phase lands.');
