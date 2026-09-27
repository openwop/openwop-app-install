/**
 * R2 CN-SP-6 — a failed subject eraser must be NAMEABLE to the operator.
 *
 * `host/subjectErasure.eraseSubject` reports a failure as
 * ``erasers[i]?.name || `eraser#${i}` `` and surfaces it on `failedFeatures`,
 * which is the GDPR audit path: an operator reading "one of your erasers threw"
 * needs to know WHICH SYSTEM still holds the subject's data. `fn.name` is free —
 * but ONLY if the registration passes something that HAS a name. An arrow passed
 * inline to the call (`registerSubjectEraser(async (t, k) => {…})`) has
 * `.name === ''`, so the fallback fires and the report degrades to a bare index
 * that names nothing to escalate with.
 *
 * FOUND: two sites had that exact shape — `host/notificationSubjectErasure.ts`
 * (CMNT-11, added in this batch) and `features/sales-commissions/feature.ts`
 * (R2 COM2-M9). Both are fixed; this gate is what stops the third.
 *
 * ── TWO CONTRACTS, and why the gate demands a BARE IDENTIFIER ──
 *
 * Nameability is only half of what the registration site owes. The other half is
 * DEDUPE: `registerSubjectEraser` is idempotent BY REFERENCE
 * (`if (!erasers.includes(fn)) erasers.push(fn)`). A named function EXPRESSION
 * satisfies nameability and still fails dedupe, because
 * `registerSubjectEraser(async function eraseX(){…})` constructs a fresh closure
 * on every call — so a second `installX()` appends a duplicate and inflates the
 * `total` the compliance report prints. Only a stable module-level reference
 * makes the re-registration the no-op the API advertises.
 *
 * So the gate asserts the strictly-stronger BARE IDENTIFIER form, which is what
 * the large majority of registrations already use
 * (`registerSubjectEraser(eraseSubjectCanvas)`). NAMED_EXPRESSION_RESIDUAL below
 * is the shrink-only list of sites that are nameable but not reference-stable:
 * they are recorded rather than silently permitted, and the list may only get
 * shorter.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC_ROOT = join(__dirname, '..', 'src');

/** Sites that pass a NAMED function expression: nameable (R2 CN-SP-6 holds), but
 *  a fresh closure per call, so `registerSubjectEraser`'s by-reference dedupe
 *  cannot see a re-registration. SHRINK-ONLY — hoist to a module-level function
 *  and delete the entry; never add one. */
const NAMED_EXPRESSION_RESIDUAL: readonly string[] = [
  'features/commerce/feature.ts',
  'features/dashboard/dashboardService.ts',
  'features/kb/kbService.ts',
  'features/profiles/profilesKnowledgeService.ts',
  'features/promotions/feature.ts',
  'features/sharing/sharingService.ts',
  'host/approvalDelegations.ts',
  'host/approvalService.ts',
  'host/compensationLedger.ts',
  'host/reviewDecisionLedger.ts',
  'host/teamsApprovalDelivery.ts',
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/**
 * Strip `/*…*\/` and `//…` comments so the scan sees CODE only.
 *
 * NOT optional, and not defensive: the first run of this gate reddened against
 * the very docblocks written to explain it — the prose above quotes
 * ``registerSubjectEraser(async function eraseX(){…})`` and
 * ``registerSubjectEraser(async (t, k) => {…})`` as examples of the defect, and a
 * raw-text scan read those as call sites in `src/**`. That is the recorded
 * "ratchet gates count COMMENTS" class: a gate that measures documentation
 * instead of behaviour is red on a correct tree and, worse, could be made green
 * by editing a comment.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Every `registerSubjectEraser(<arg…` call site, with the first ~40 chars of the
 *  argument — enough to classify its shape without parsing TypeScript. The
 *  DEFINITION in `subjectErasure.ts` is excluded (it is `export function
 *  registerSubjectEraser(fn: …)`, not a call). */
function callSites(): { rel: string; arg: string }[] {
  const out: { rel: string; arg: string }[] = [];
  for (const file of walk(SRC_ROOT)) {
    const rel = file.slice(SRC_ROOT.length + 1).split('\\').join('/');
    if (rel === 'host/subjectErasure.ts') continue;
    const src = stripComments(readFileSync(file, 'utf8'));
    for (const m of src.matchAll(/registerSubjectEraser\(\s*([\s\S]{0,40})/g)) {
      out.push({ rel, arg: m[1]!.trim() });
    }
  }
  return out;
}

/** A stable module-level reference: `registerSubjectEraser(eraseSubjectFoo)`. */
const BARE_IDENTIFIER = /^[A-Za-z_$][\w$]*\s*\)/;
/** Nameable but freshly constructed: `async function eraseFoo(` / `function eraseFoo(`. */
const NAMED_EXPRESSION = /^(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(/;

describe('R2 CN-SP-6 — every SubjectEraser registration is nameable', () => {
  const sites = callSites();

  it('the census is non-empty — a regex that matches nothing would pass vacuously', () => {
    // Without this floor a typo in `callSites()` turns every assertion below into
    // `expect([]).toEqual([])`: green, and policing nothing. The corpus has dozens
    // of registrations; 10 is a floor well under the real count that still fails
    // loudly if the walk or the pattern breaks.
    expect(sites.length).toBeGreaterThan(10);
  });

  it('NO registration passes an anonymous function — the operator would get `eraser#N`', () => {
    const anonymous = sites
      .filter((s) => !BARE_IDENTIFIER.test(s.arg) && !NAMED_EXPRESSION.test(s.arg))
      .map((s) => `${s.rel} — registerSubjectEraser(${s.arg.slice(0, 30)}…)`);
    expect(
      anonymous,
      'An anonymous arrow/function has `.name === ""`, so `eraseSubject` reports it as a bare index on the GDPR audit path. Pass a module-level named function instead.',
    ).toEqual([]);
  });

  it('the named-expression residual is SHRINK-ONLY — no new by-reference-dedupe holes', () => {
    const actual = [...new Set(sites.filter((s) => NAMED_EXPRESSION.test(s.arg)).map((s) => s.rel))].sort();
    const unexpected = actual.filter((f) => !NAMED_EXPRESSION_RESIDUAL.includes(f));
    expect(
      unexpected,
      'A named function EXPRESSION is a fresh closure per call, so `registerSubjectEraser`\'s by-reference dedupe cannot see a re-registration. Hoist it to a module-level function.',
    ).toEqual([]);
  });

  it('the residual list is not stale — every entry still has a named-expression site', () => {
    const actual = new Set(sites.filter((s) => NAMED_EXPRESSION.test(s.arg)).map((s) => s.rel));
    const stale = NAMED_EXPRESSION_RESIDUAL.filter((f) => !actual.has(f));
    expect(stale, 'Fixed sites must be REMOVED from the residual list so it stays honest.').toEqual([]);
  });

  it('the two sites this batch fixed pass a bare module-level identifier', () => {
    // The specific regression under repair: both were `registerSubjectEraser(async
    // (tenantId, subjectKey) => {…})`. Asserted positively so a revert reddens
    // here naming the file, not just in the class-wide arm above.
    for (const rel of ['host/notificationSubjectErasure.ts', 'features/sales-commissions/feature.ts']) {
      const site = sites.find((s) => s.rel === rel);
      expect(site, `${rel} must still register a subject eraser`).toBeDefined();
      expect(BARE_IDENTIFIER.test(site!.arg), `${rel} must pass a module-level named function, got: ${site!.arg.slice(0, 40)}`).toBe(true);
    }
  });
});
