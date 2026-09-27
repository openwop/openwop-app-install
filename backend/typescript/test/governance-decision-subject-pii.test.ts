/**
 * WF-CONS-14 — no writer may put a RAW subject identifier into the durable
 * governance decision log.
 *
 * `consentService.isAllowed` passed `subject: subjectKey` verbatim, three lines
 * below the sibling `log.info` that hashes the same value under a comment
 * explaining that since ADR 0394 a subjectKey may be a raw E.164 phone number.
 * The PII-hashing fix had landed on the LOG line and was never carried to the
 * DURABLE write — the higher-frequency of the two (every denial, versus once
 * per DSAR).
 *
 * WHY A SOURCE-SCANNING GATE AND NOT JUST THE ONE-LINE FIX. Rows written here
 * are unrecoverable: `recordGovernanceDecision` appends to the global
 * `audit_log` table, which has no tenant column, no registered subject eraser,
 * no retention purger, and is excluded from ADR 0284 tenant teardown by
 * `storage.ts` `deleteAllTenantData`'s own docblock. It is also STRUCTURALLY
 * INVISIBLE to both ADR 0464 coverage gates, whose denominators are
 * `new DurableCollection` namespaces — this sink declares none. So there is no
 * existing tripwire that could ever notice the next instance, and the class
 * (not the instance) is what needs closing.
 *
 * The rule: every `subject:` argument must be a CALL (a hashing helper) or an
 * explicitly-allowlisted opaque identifier. A bare variable is refused, because
 * "it happens to hold a non-PII value today" is exactly the reasoning that
 * shipped the defect.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = join(__dirname, '..', 'src');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.includes('__tests__')) out.push(p);
  }
  return out;
}

/** Comments are not code — the repo's own KB-3 lesson, in the gate that would
 *  otherwise pass over a commented-out violation as if it were a live one. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

interface Site { file: string; subject: string }

/** Every `recordGovernanceDecision({...})` call, with the text of its `subject:`
 *  argument (or `''` when the call omits the field entirely). */
function callSites(): Site[] {
  const out: Site[] = [];
  for (const file of walk(SRC)) {
    const src = stripComments(readFileSync(file, 'utf8'));
    for (const m of src.matchAll(/recordGovernanceDecision\s*\(\s*\{/g)) {
      // Balanced-brace scan from the object literal's `{`.
      const open = src.indexOf('{', m.index);
      let depth = 0;
      let end = -1;
      for (let i = open; i < src.length; i += 1) {
        if (src[i] === '{') depth += 1;
        else if (src[i] === '}') { depth -= 1; if (depth === 0) { end = i; break; } }
      }
      if (end < 0) continue;
      const body = src.slice(open, end + 1);
      const sub = /(?:^|[{,\s])subject\s*:\s*([^,\n}]+)/.exec(body);
      out.push({ file: file.slice(SRC.length + 1), subject: (sub?.[1] ?? '').trim() });
    }
  }
  return out;
}

/**
 * Expressions accepted as an opaque subject reference. Adding an entry is a
 * deliberate, reviewable act: it asserts the value can never carry a person's
 * identifier. A bare `subjectKey` / `contactId` / `email` / phone belongs
 * nowhere on this list.
 */
const ALLOWED_SUBJECT_EXPRESSIONS = new Set<string>([
  '', // the call omits `subject:` entirely
]);

/**
 * The helpers that actually PSEUDONYMISE. An explicit allowlist, not a shape.
 *
 * Review F6 — this was `/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*\(/`, i.e.
 * "any call expression". That accepts `subjectKey.trim()`, `String(subjectKey)`,
 * `normalizePhone(e164)` and `identity(contactId)` — every one of which puts a
 * RAW identifier into `audit_log`, the sink with no tenant column, no eraser,
 * no purger and an explicit exclusion from ADR 0284 tenant teardown. The gate
 * was checking punctuation, not pseudonymity, while the PR body claimed it
 * closed *the class*. It is the "a ratchet polices a SPELLING, not the
 * invariant" family, and a bare `hash(x)` shape test would be the same mistake
 * one step in: what matters is that a SPECIFIC, reviewed implementation runs.
 *
 * Adding a name here is a deliberate, reviewable act: it asserts that helper
 * produces a value from which the subject cannot be recovered. The optional
 * leading `await` covers an async digest helper without widening the shape.
 */
const HASHING_HELPERS = [
  'hashSubjectKey',   // features/consent/consentService.ts — tenant-salted SHA-256, 16 chars
] as const;
const HASH_CALL = new RegExp(`^(?:await\\s+)?(?:${HASHING_HELPERS.join('|')})\\s*\\(`);

const sites = callSites();

describe('WF-CONS-14 — the governance decision log holds no raw subject identifiers', () => {
  it('the scan is NON-VACUOUS (a broken walker or regex would pass everything)', () => {
    // A floor below the real population would let the matcher silently break.
    // Re-derive with:
    //   grep -rn 'recordGovernanceDecision(' backend/typescript/src --include='*.ts' | grep -v '\.test\.ts'
    // RE-DERIVED 2026-08-19 (never a copied number): SIX production call sites
    // -- consentService x3 (the isAllowed denial, deleteSubject's erasure row,
    // deleteSubject's CONS-4 legal-hold refusal), cdp/identityService x1,
    // host/conversationToolLoop x2. The definition itself is not a call and is
    // not matched. Raise this floor deliberately when a writer is added.
    expect(sites.length).toBeGreaterThanOrEqual(6);
    // The consent lane is the one the defect lived in; if the scan stops seeing
    // it, every assertion below is hollow.
    expect(sites.some((s) => s.file.includes('consent'))).toBe(true);
  });

  it('every `subject:` argument is a hashing CALL or an explicit allowlist entry', () => {
    const offenders = sites.filter(
      (s) => !ALLOWED_SUBJECT_EXPRESSIONS.has(s.subject) && !HASH_CALL.test(s.subject),
    );
    expect(
      offenders.map((s) => `${s.file}: subject: ${s.subject}`),
      'a bare identifier here is durable, un-erasable PII — hash it (see hashSubjectKey)',
    ).toEqual([]);
  });

  it('the consent denial path specifically hashes (the instance that shipped)', () => {
    const consent = sites.filter((s) => s.file.includes('features/consent/consentService.ts'));
    // the isAllowed denial + deleteSubject's erasure row + deleteSubject's
    // CONS-4 legal-hold refusal row.
    // ADR 0657: +2 — `readmitSubject`'s allow row and `deleteSubject`'s mid-request hold
    // deny row (CONS-29); both hash. Raised deliberately, never silently.
    expect(consent.length).toBe(5);
    for (const s of consent) expect(s.subject).toMatch(/^hashSubjectKey\(/);
  });
});
