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
 * WHAT THIS IS NOT. It is NOT a gate demanding zero. Zero is currently
 * FORBIDDEN: `versioning.md` §1.1 requires `preferredVersion` to name a 1.x
 * member for as long as `protocolVersions[]` carries one, so a host that
 * removed v1 today would be non-conformant, not ahead of schedule. Retirement
 * is ATOMIC and gated on the v1 EOS clock (2026-12-04) — see ADR 0642.
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
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = join(ROOT, 'scripts', 'v1-reliance-baseline.json');

/**
 * Every CODE-line match of `pattern` under `dir` — comments and test files
 * excluded.
 *
 * CORRECTED 2026-09-10. The first version counted every occurrence of the
 * literal, so a PR that MOVED four SPA surfaces off `/v1/` and documented why
 * (header comments naming the old and new addresses, and a wire-level test
 * asserting the new ones) reported spaProtocolCallSites 87 → 91 and
 * spaHostExtensionCallSites 543 → 555 — the ratchet fired on the migration it
 * exists to reward, and was re-baselined over before the numbers were read.
 * Attributed line by line: +11 in one test file's URL expectations, +19 in
 * comments, and a NET FALL in code. A ratchet that counts prose polices a
 * spelling, not the invariant; this one now reads whole lines and drops any
 * that begin with a comment marker, and never reads a test file.
 */
function matches(dir, pattern, includes, excludes = []) {
  const args = ['-rnE', pattern, dir];
  for (const inc of includes) args.push(`--include=${inc}`);
  for (const ex of excludes) args.push(ex);
  let lines;
  try {
    lines = execFileSync('grep', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n');
  } catch { return []; }           // grep exits 1 on no match
  const re = new RegExp(pattern, 'g');
  const out = [];
  for (const line of lines) {
    if (!line) continue;
    const text = line.replace(/^[^:]+:\d+:/, '');          // strip `path:line:`
    const t = text.trimStart();
    if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
    for (const m of text.match(re) ?? []) out.push(m);
  }
  return out;
}

/** Test files are assertions ABOUT the wire, not calls on it. */
const NO_TESTS = ['--exclude-dir=__tests__', '--exclude=*.test.ts', '--exclude=*.test.tsx'];
const TS = ['*.ts', '*.tsx'];
const V1_PATH = '/v1/[a-zA-Z0-9._{}$/-]*';
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

const measured = {
  spaProtocolCallSites: spaProtocol.length,
  spaHostExtensionCallSites: spaHostExt.length,
  spaOpenWopVersionHeaders: spaVersionHeader,
  backendProtocolPathRefs: beProtocol.length,
  backendHostExtensionPathRefs: beHostExt.length,
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

console.log('▶ v1 reliance inventory (ADR 0642; EOS 2026-12-04)\n');
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
console.log('  NOTE: zero is not the target today. `versioning.md` §1.1 requires a 1.x');
console.log('  preferredVersion while protocolVersions[] carries one, so removing v1 before');
console.log('  the EOS overlap ends would be non-conformant. This ratchets, it does not cut.');
