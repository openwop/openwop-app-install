/**
 * Notice announce sweep — tranche 1, and the ONE-PER-PAGE discipline.
 *
 * `announce()` has a SINGLE polite slot (`ui/announce.tsx`), so a second call in
 * the same render clobbers the first. Blanket-wiring every failure Notice on a
 * page therefore does not announce more — it announces LESS, and unpredictably,
 * because whichever renders last wins.
 *
 * So the rule is a judgement, not a sweep: announce the notice whose absence
 * would cause a WRONG CONCLUSION ABOUT DATA. This pins that the pages in this
 * tranche wire exactly one, and that the deliberate skips stay skipped — the
 * skip is the part a later "helpful" edit would undo.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..', '..');
const read = (p: string): string => readFileSync(join(SRC, p), 'utf8');

/**
 * Count Notices that wire an announcement.
 *
 * Two idioms, both real. The plain prop `announce={...}`, and a CONDITIONAL
 * SPREAD — `{...(cond ? { announce: msg } : {})}` — which pages use when the
 * announcement is conditional, because `exactOptionalPropertyTypes` rejects
 * passing `announce={cond ? msg : undefined}` to an optional prop.
 *
 * Matching only `announce=` missed the spread form entirely and scored a
 * correctly-wired page as ZERO (LibraryPage, after #2694 moved it to the
 * conditional form). A source-scan tripwire that cannot see a legal idiom
 * reports a regression that is not there — and, worse, would go green if
 * someone "fixed" it by deleting the real announcement. Accept `=` or `:`.
 */
const announced = (p: string): number => (read(p).match(/<Notice[^>]*\bannounce\s*[:=]/g) ?? []).length;

const TRANCHE = [
  'PrivacyPage.tsx',
  'settings/EventBindingsPage.tsx',
  'chat/artifacts/LibraryPage.tsx',
  'features/comments/CommentsPage.tsx',
  'features/comments/CommentsPanel.tsx',
  'runs/RunAuditPage.tsx',
  'features/documents/DocumentsPage.tsx',
];

// Pages allowed MORE than one announcement, each with the reason — a named
// exception rather than a loosened bound, so a genuinely accidental second
// announcement still fails everywhere else.
//
// The invariant that actually matters is "announcements that can COINCIDE must
// not exceed one", which is not statically decidable; one-per-file was the
// proxy. When the proxy and the invariant diverge, argue the case here instead
// of relaxing the assertion for everyone.
const EXPECTED_ANNOUNCEMENTS: Record<string, number> = {
  // 2026-08-11: gained a failed-read disclosure for `projectsFailed`. It does NOT
  // contend for the polite slot — it renders inside
  // `<Modal label={t('addToProject')}>`, opened by an explicit user action AFTER
  // load, so it is sequential by construction, exactly like the action results
  // this tranche is about.
  'features/documents/DocumentsPage.tsx': 2,
  // 2026-08-19 (CMNT-1): gained `linkedResourceMissing` beside the existing
  // `resourcesFailed`. They cannot contend for the polite slot because they are
  // MUTUALLY EXCLUSIVE BY CONSTRUCTION, not by timing: `linkedMissing`'s own
  // predicate carries `&& !resourcesFailed` (`CommentsPage.tsx:200-202`), so a
  // failed list read can never also report "the link named a resource this org
  // does not have" — which would be a false diagnosis of a read failure, the
  // reason the guard is in the predicate rather than in the JSX.
  // The count is 2 because `announced()` reads SOURCE, not renders; one
  // announcement fires per paint. If that guard is ever removed, this entry is
  // wrong and must come out with it.
  'features/comments/CommentsPage.tsx': 2,
};

// 2026-09-11 (CMNT-UX-22, ADR 0659 D7): `CommentsPanel` joins the tranche at the
// default of 1. It was ABSENT while carrying two announcement sites fed by two
// INDEPENDENT reads — `Notice announce={directoryNamesFallback}` (the member
// directory) and the failed-thread `StateCard announce` — with no guard between
// them, so a paint where both fired silently dropped one. `announced()` counts
// `<Notice … announce>` only, so the count here is 1; the exclusion that makes
// it TRUE rather than merely counted is in the panel's predicate
// (`namesFailed && !failed`), the same argument `CommentsPage` carries above.


describe('Notice sweep tranche 1 — exactly one announcement per page', () => {
  it.each(TRANCHE)('%s announces exactly one Notice', (p) => {
    expect(announced(p)).toBe(EXPECTED_ANNOUNCEMENTS[p] ?? 1);
  });

  it('RunAuditPage announces the UNKNOWN, not the host\'s real answer', () => {
    const s = read('runs/RunAuditPage.tsx');
    // capsFailed = "we couldn't ask" -> announced.
    expect(s).toMatch(/announce=\{t\('auditCapsUnknown'\)\}/);
    // auditProfile === false = the host really lacks it -> a FACT, not an unknown.
    expect(s).not.toMatch(/announce=\{t\('auditProfileMissingPre'\)\}/);
  });

  it('DocumentsPage announces the incomplete LIST, not the missing control', () => {
    const s = read('features/documents/DocumentsPage.tsx');
    // An incomplete list is the false-conclusion class; a missing button is visible.
    expect(s).toMatch(/announce=\{t\('canvasSourcesFailed'\)\}/);
    expect(s).not.toMatch(/announce=\{t\('accessCheckFailed'\)\}/);
  });

  it('no announced Notice also carries an id — that pairing must not compile', () => {
    // `announce` + `id` is banned in the type (an aria-describedby target is
    // already read on focus; announcing would speak it twice). Belt and braces:
    // assert no file in the tranche pairs them, so a future refactor that widens
    // the type still trips here.
    for (const p of TRANCHE) {
      for (const el of read(p).match(/<Notice[^>]*>/g) ?? []) {
        if (/\bannounce=/.test(el)) expect(el, `${p}: ${el}`).not.toMatch(/\bid=/);
      }
    }
  });
});
