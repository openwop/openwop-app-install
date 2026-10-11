#!/usr/bin/env node
/**
 * Blocking high/critical npm-audit gate, with EXPIRING exceptions.
 *
 * WHY THIS EXISTS. The previous gate was `npm audit --omit=dev --audit-level=high`,
 * which is correct until the day an advisory has no fix. Then it is red forever,
 * and a permanently-red gate gets bypassed — `--no-verify`, or somebody quietly
 * lowers it to `--audit-level=critical` and the genuine highs stop being seen.
 * Both outcomes are worse than the advisory.
 *
 * The tempting alternative is worse still. For the advisory that motivated this
 * (GHSA-mh99-v99m-4gvg), npm reports `fixAvailable: true`, and taking it — an
 * `overrides` entry pinning brace-expansion@5.0.8 — makes `npm audit` report ZERO
 * vulnerabilities while every glob in the process throws, because minimatch@9
 * calls a default export that v5 does not have. A green gate over a broken app is
 * the exact failure this codebase keeps finding in its own checks.
 *
 * So: still blocking, but an advisory can be excepted EXPLICITLY, with a
 * justification, a reachability assessment, and a date after which the build
 * fails until someone re-makes the call. Three arms, and the last two are what
 * stop this from decaying into a suppression list:
 *
 *   UNEXPECTED  a high/critical with no exception            -> FAIL
 *   EXPIRED     an exception past `revisitAfter`             -> FAIL
 *   STALE       an exception whose advisory is GONE          -> FAIL
 *   MALFORMED   an exception missing a load-bearing field    -> FAIL
 *
 * The STALE arm matters most: without it, a fixed advisory keeps its exception
 * forever and the file becomes a list of things nobody has checked since.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/**
 * `omitDev` is the scope of each workspace's audit, and it is per-workspace on purpose.
 *
 * backend + frontend ship their `dependencies`; their devDependencies are build and
 * test tooling, so `--omit=dev` is the honest production scope.
 *
 * clients/desktop (ADR 0181, the Electron shell) is the opposite shape: electron-builder
 * REQUIRES `electron` in devDependencies, and the shell has NO `dependencies` at all. So
 * `--omit=dev` there audits an empty tree. MEASURED 2026-10-10 on 51f5a323f: it reported
 * `prod: 1` (the root package) and zero vulnerabilities, while the same lockfile carried
 * eight high-severity packages including `electron` itself, the runtime every packaged
 * app ships. That would be a check that cannot fail, so desktop audits ALL deps. The
 * tooling that comes along (electron-builder and its chain) runs on the packager's
 * machine and in no shipped artifact, but it is a small tree, and the alternative is to
 * scan nothing.
 */
const WORKSPACES = [
  { ws: 'backend/typescript', omitDev: true },
  { ws: 'frontend/react', omitDev: true },
  { ws: 'clients/desktop', omitDev: false },
];
const BLOCKING = new Set(['high', 'critical']);

// Test seams (scripts/test-gate-tooling.sh): a fixture exceptions file and a
// directory of canned `npm audit --json` reports (`<ws with / → __>.json`), so the
// matcher's failure cases can be RUN, not just read.
const cfg = JSON.parse(readFileSync(process.env.OPENWOP_AUDIT_EXCEPTIONS ?? join(ROOT, 'scripts', 'audit-exceptions.json'), 'utf8'));
const exceptions = cfg.exceptions ?? [];

/** `npm audit --json` exits non-zero when it finds anything — that is not an error. */
function auditJson(ws, omitDev) {
  if (process.env.OPENWOP_AUDIT_REPORTS_DIR) {
    return JSON.parse(readFileSync(join(process.env.OPENWOP_AUDIT_REPORTS_DIR, `${ws.replace(/\//g, '__')}.json`), 'utf8'));
  }
  try {
    return JSON.parse(execFileSync('npm', ['audit', ...(omitDev ? ['--omit=dev'] : []), '--json'], {
      cwd: join(ROOT, ws), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    }));
  } catch (err) {
    if (err.stdout) return JSON.parse(err.stdout);
    throw err;
  }
}

const today = new Date().toISOString().slice(0, 10);
const seen = new Set();
const unexpected = [];

/**
 * MALFORMED  an entry missing a load-bearing field                -> FAIL
 *
 * The fourth arm, added H60 (2026-08-18). The header calls every field
 * load-bearing, but nothing enforced that, and the omission was not cosmetic:
 * the EXPIRED arm below compares `e.revisitAfter < today`, and an entry with no
 * `revisitAfter` compares `undefined < '2026-08-18'` === false — FOREVER. A
 * malformed entry therefore switched its own time-box off, which is the one
 * property that stops this file decaying into a suppression list.
 *
 * `owner` and `mitigation` are required for the same reason the others are:
 * an exception with no owner is nobody's to revisit, and one with no stated
 * compensating control is a dismissal wearing a justification's clothes.
 */
const REQUIRED_FIELDS = [
  'advisory',
  'package',
  'workspace',
  'severity',
  'why',
  'reachability',
  'revisitAfter',
  'removeWhen',
  'owner',
  'mitigation',
];

const isEmpty = (v) =>
  v === undefined || v === null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.length === 0);

const malformed = [];
for (const e of exceptions) {
  const label = `${e.advisory ?? '(no advisory)'} (${e.package ?? '?'})`;
  const missing = REQUIRED_FIELDS.filter((k) => isEmpty(e[k]));
  if (missing.length) malformed.push(`${label}: missing/empty ${missing.join(', ')}`);
  else if (!/^\d{4}-\d{2}-\d{2}$/.test(e.revisitAfter)) {
    malformed.push(`${label}: revisitAfter must be ISO yyyy-mm-dd, got ${JSON.stringify(e.revisitAfter)}`);
  }
}

for (const { ws, omitDev } of WORKSPACES) {
  const report = auditJson(ws, omitDev);
  const vulns = report.vulnerabilities ?? {};

  // VACUITY GUARD. A report that parses but carries no vulnerability map at all
  // is indistinguishable from a clean tree, and would make this gate pass by
  // scanning nothing.
  if (typeof vulns !== 'object') {
    console.error(`✗ check-audit: ${ws} produced no vulnerability map — the audit did not run, the tree is not clean.`);
    process.exit(1);
  }

  /**
   * Resolve a package to the advisory ids it ultimately derives from.
   *
   * npm reports a `via` entry as EITHER an advisory object (this package is the
   * source) OR a package-name string ("depends on vulnerable versions of X").
   * One root advisory therefore surfaces as many entries — brace-expansion alone
   * produced seven, six of them pure transitive parents with no advisory object
   * of their own. Excepting the root has to cover the parents, or the exception
   * file would need an entry per hop and would rot the moment the tree reshapes.
   */
  const rootAdvisories = (name, guard = new Set()) => {
    if (guard.has(name)) return [];
    guard.add(name);
    const out = [];
    for (const via of vulns[name]?.via ?? []) {
      if (typeof via === 'object' && via.url) out.push(via.url.split('/').pop());
      else if (typeof via === 'string') out.push(...rootAdvisories(via, guard));
    }
    return out;
  };

  for (const [name, v] of Object.entries(vulns)) {
    if (!BLOCKING.has(v.severity)) continue;
    const ids = [...new Set(rootAdvisories(name))];
    // MATCH ON THE ADVISORY, NEVER ON THE PACKAGE NAME (H60, 2026-08-18).
    //
    // This used to read `e.package === name || ids.includes(e.advisory)`. The
    // first arm meant an exception for ONE advisory silently waived EVERY
    // future high/critical on that package: a second pdfjs-dist RCE, or any new
    // react-router advisory, would be absorbed by an entry whose `why` and
    // `reachability` were written about a different defect — and marked `seen`,
    // so neither the UNEXPECTED nor the STALE arm would fire. A suppression
    // list that grows silently is exactly what the header says this file must
    // not become.
    //
    // Dropping the arm is safe for transitive parents because `rootAdvisories`
    // already resolves a parent's `via` chain down to the root advisory ids —
    // that is what it is for. A package whose advisory ids cannot be resolved
    // at all now falls through to UNEXPECTED, which is the fail-loud direction.
    //
    // EVERY id, not the first (2026-09-30). This read
    // `exceptions.find(… ids.includes(e.advisory))` then `continue`: for a package
    // carrying TWO advisories, an exception for ONE waived BOTH, and only the
    // first entry was marked `seen` (the second then read as STALE). The same
    // fail-open H60 closed for package names, one level down — found when
    // @grpc/grpc-js reported GHSA-m9gg + GHSA-f596 together.
    const uncovered = [];
    for (const id of ids) {
      if (exceptions.some((e) => e.workspace === ws && e.advisory === id)) seen.add(id);
      else uncovered.push(id);
    }
    if (ids.length > 0 && uncovered.length === 0) continue;
    unexpected.push(`${ws}: ${name} (${v.severity}) ${(uncovered.length ? uncovered : ids).join(', ') || '—'}`);
  }
}

const expired = exceptions.filter((e) => e.revisitAfter < today);
// A VENDORED entry (`"vendored": true`) records a copy npm audit CANNOT see (a
// dependency bundled into another package's dist), so the audit's silence says
// nothing about it: the STALE arm would demand deleting the only record of a live
// risk the moment the audit-visible copies of the same advisory are fixed (#4166
// did exactly that for GHSA-hq66's unpdf-bundled pdf.js). Its staleness is owned by
// a test that measures the bundled version (test/kb-vendored-pdfjs.test.ts).
const stale = exceptions.filter((e) => !seen.has(e.advisory) && e.vendored !== true);

let failed = false;

if (malformed.length) {
  failed = true;
  console.error(`✗ check-audit: ${malformed.length} MALFORMED exception(s) — a missing field disables its own time-box:`);
  for (const m of malformed) console.error(`    ${m}`);
  console.error(`  Required: ${REQUIRED_FIELDS.join(', ')}.`);
}

if (unexpected.length) {
  failed = true;
  console.error(`✗ check-audit: ${unexpected.length} unexcepted high/critical advisory(ies):`);
  for (const u of unexpected) console.error(`    ${u}`);
  console.error('  Fix it, or add a scripts/audit-exceptions.json entry with a reachability assessment and a revisitAfter date.');
  console.error('  Do NOT reach for `npm audit fix` without running the app afterwards — see this file\'s header.');
}

if (expired.length) {
  failed = true;
  console.error(`✗ check-audit: ${expired.length} EXPIRED exception(s) — re-make the call, do not just move the date:`);
  for (const e of expired) console.error(`    ${e.advisory} (${e.package}) expired ${e.revisitAfter} — ${e.removeWhen}`);
}

if (stale.length) {
  failed = true;
  console.error(`✗ check-audit: ${stale.length} STALE exception(s) — the advisory is gone, so DELETE the entry:`);
  for (const e of stale) console.error(`    ${e.advisory} (${e.package}) is no longer reported in ${e.workspace}`);
}

if (failed) process.exit(1);

const note = exceptions.length
  ? ` ${exceptions.length} active exception(s), next review ${exceptions.map((e) => e.revisitAfter).sort()[0]}.`
  : '';
console.log(`✓ check-audit: no unexcepted high/critical advisories across ${WORKSPACES.length} workspaces.${note}`);
