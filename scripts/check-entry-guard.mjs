#!/usr/bin/env node
/**
 * ZERO gate: no hand-rolled "am I the entry point?" comparison anywhere.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────
 *
 * Three sites in this repo compared `import.meta.url` to `process.argv[1]` by
 * hand. All three were wrong the same way, and the failure is silent:
 * `import.meta.url` is REALPATH-resolved while `argv[1]` is not, so through a
 * symlinked absolute path the comparison is false and the guarded block simply
 * does not run — exit 0, no output, nothing logged.
 *
 *   1. `backend/typescript/src/index.ts` — `main()` never ran, so the server
 *      started NOTHING and exited 0 with an empty log. That is the "flaky"
 *      SHUTDOWN-1 gate: 4/4 failures from a `/tmp` worktree at idle load (#3070).
 *   2. `scripts/gen-distribution.mjs` — `--check` exited 0 having validated
 *      nothing. `ci:distribution` runs that command — but nothing ran
 *      `ci:distribution`, so the GATE COULD NOT FAIL for two independent reasons.
 *      `scripts/ci.sh` now runs `--check` directly.
 *   3. `scripts/measure-stripped-workflow-inputs.mjs` — measured nothing.
 *
 * They all normally work by luck: the usual invocation is a RELATIVE path and
 * `process.cwd()` is realpath-resolved, so the comparison happens to match. One
 * absolute symlinked invocation (macOS `/tmp` -> `/private/tmp`, a `pnpm`/CI
 * checkout behind a symlink, a container bind-mount) is all it takes.
 *
 * A ZERO gate, not a ratchet. There is no legitimate instance of this pattern —
 * the shared helpers do it correctly — so the allowed count is 0, and a
 * baseline that could drift upward would defeat the point.
 *
 * WHAT THIS CANNOT SEE, said plainly: it is a source scan. A comparison
 * assembled at runtime, or spelled some way this regex does not model, passes.
 * It pins the three known spellings and anything close to them; it is not a
 * proof of absence.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntryModule } from './lib/entry-module.mjs';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');

/**
 * Directories that are not ours to police, matched by NAME anywhere in the tree.
 *
 * `lib` is deliberately NOT here. It was, and the self-check below caught it:
 * the name is build output under `backend/typescript/lib`, but it is SOURCE
 * under `scripts/lib` — so a name-based skip made this gate blind to an entire
 * source directory, including its own helper. A skip list that over-matches is
 * indistinguishable from a gate that does not run.
 */
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage',
  '.next', '.turbo', 'test-results', 'e2e-artifacts', 'playwright-report',
]);

/** Build-output paths that share a name with a source directory — skipped by
 *  repo-relative PATH, so `scripts/lib` stays in scope. */
const SKIP_PATHS = new Set([
  'backend/typescript/lib',
]);

const EXTS = ['.ts', '.tsx', '.mjs', '.cjs', '.js'];

/**
 * The offending spellings.
 *
 * Both anchor on `import.meta.url` being compared against something built from
 * `process.argv[1]`, which is the actual defect — not on any particular helper.
 */
const PATTERNS = [
  {
    id: 'concat',
    // import.meta.url === `file://${process.argv[1]}`
    re: /import\.meta\.url\s*===?\s*[`'"]file:\/\/\$\{\s*process\.argv\[1\]\s*\}/,
    why: 'string-concatenated file:// URL — not realpath-resolved, and not percent-encoded',
  },
  {
    id: 'fileURLToPath',
    // fileURLToPath(import.meta.url) === process.argv[1]
    re: /fileURLToPath\s*\(\s*import\.meta\.url\s*\)\s*===?\s*process\.argv\[1\]/,
    why: 'compares a realpath-resolved path against a raw argv[1]',
  },
];

/** Files allowed to CONTAIN the pattern because they document or test it. */
const DOC_ALLOWLIST = new Set([
  'scripts/check-entry-guard.mjs',
  'scripts/lib/entry-module.mjs',
  'backend/typescript/src/host/entryModule.ts',
]);

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (SKIP_PATHS.has(relative(ROOT, full))) continue;
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) yield* walk(full);
    else if (EXTS.some((e) => entry.endsWith(e))) yield full;
  }
}

const hits = [];
/**
 * SELF-VALIDATION — the gate must prove its own scan ran.
 *
 * As first shipped (#3117) this collected violations and failed only when
 * `hits.length > 0`, which means a scan that examined ZERO files reported
 * SUCCESS. Measured: run it against a directory containing nothing but the
 * helper and it prints the green line and exits 0. So a path bug, a rename of
 * the root resolution, or a `SKIP_DIRS` entry that over-matched would silently
 * disable this gate — which is EXACTLY the "passes without checking anything"
 * defect it was written to catch. The gate had the bug it guards against.
 *
 * The floor is not a file count (brittle: a slim distribution legitimately has
 * fewer files). It is the three files this gate KNOWS must exist, because it
 * allowlists them by name. If the walk cannot see its own documentation, it
 * cannot see anything, and saying so is the only honest outcome.
 */
const seenAllowlisted = new Set();
for (const file of walk(ROOT)) {
  const rel = relative(ROOT, file);
  if (DOC_ALLOWLIST.has(rel)) { seenAllowlisted.add(rel); continue; }
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { continue; }
  if (!text.includes('import.meta.url')) continue; // cheap pre-filter
  const lines = text.split('\n');
  for (const p of PATTERNS) {
    lines.forEach((line, i) => {
      // A commented-out example is documentation, not code.
      const code = line.replace(/^\s*(\/\/|\*|#).*$/, '');
      if (p.re.test(code)) hits.push({ rel, line: i + 1, why: p.why, text: line.trim() });
    });
  }
}

const unseen = [...DOC_ALLOWLIST].filter((f) => !seenAllowlisted.has(f));
if (unseen.length > 0) {
  console.error('✗ check-entry-guard: THE SCAN IS BROKEN — it never reached files it knows exist:');
  for (const f of unseen) console.error(`    ${f}`);
  console.error('');
  console.error('  Refusing to report success on a scan that examined the wrong tree.');
  console.error(`  (root resolved to: ${ROOT})`);
  process.exit(1);
}

if (hits.length > 0) {
  console.error(`✗ check-entry-guard: ${hits.length} hand-rolled entry-point comparison(s):`);
  for (const h of hits) {
    console.error(`    ${h.rel}:${h.line}  ${h.why}`);
    console.error(`      ${h.text}`);
  }
  console.error('');
  console.error('  These are FALSE through a symlink, so the guarded block silently never runs.');
  console.error("  Use `isEntryModule(import.meta.url)` — scripts/lib/entry-module.mjs, or");
  console.error('  backend/typescript/src/host/entryModule.ts for the server.');
  process.exit(1);
}

if (isEntryModule(import.meta.url)) {
  console.log('✓ check-entry-guard: no hand-rolled entry-point comparisons (zero gate).');
}
