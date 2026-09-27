/**
 * The four sabotages that hardened `check-hv-citations`, kept as assertions.
 *
 * #2974's grade pass found four ways that gate could pass while measuring
 * nothing, fixed all four, and recorded in its commit body: "All four sabotages
 * re-run and now exit 1." That was true when written — and unprotected. The
 * probes were manual and discarded, so the next edit to one of these regexes
 * silently re-opens the hole with a green tick.
 *
 * This is the same lesson `GATE-5` recorded for the merge-gate scripts. A gate
 * that guards other people's claims needs its own guard, or it is just another
 * claim.
 *
 * Each case below is a REAL exploit from that grade pass, quoted from the
 * tracker rows it defeated.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error — .mjs gate module, deliberately untyped: it runs under plain
// node in CI with no build step, and a .d.ts would be a second source of truth.
import { EVIDENCE, NEGATED, rowBlock, classifyRow, resolveRowFloor, FILE_ROW_FLOOR } from '../../scripts/hvCitations.mjs';

describe('sabotage 1 — a NEGATED citation must not self-certify', () => {
  it('rejects "unverified", which `verified\\b` used to match inside', () => {
    // The original regex had no LEADING boundary, so "UNverified" satisfied it.
    expect(classifyRow('- [x] `HV-A1` … — unverified, and there are no live walkthroughs.'))
      .toBe('negated');
  });

  it('rejects a row whose block says no tests cover it', () => {
    expect(classifyRow('- [x] `HV-A2` … — no __tests__ cover this at all.')).toBe('negated');
  });

  it('still ACCEPTS an honest row that cites a test AND names a gap', () => {
    // Order matters: positive evidence wins. A row citing a real test and
    // honestly noting what it does not cover is the BEST kind of row, and an
    // over-eager negation check would reject exactly those.
    expect(classifyRow('- [x] `HV-B1` `foo.test.tsx` covers it; nothing proves the read re-runs.'))
      .toBe('cited');
  });
});

describe('sabotage 2 — a hex colour is not a PR reference', () => {
  it('rejects `#123456` quoted in prose', () => {
    expect(classifyRow('- [x] `HV-A3` … — see the swatch #123456 in DESIGN.md.')).toBe('bare');
  });

  it('accepts a real PR reference in both bare and parenthesised form', () => {
    expect(classifyRow('- [x] `HV-C1` fixed in #2960')).toBe('cited');
    expect(classifyRow('- [x] `HV-C2` fixed in (#2960)')).toBe('cited');
  });
});

describe('sabotage 3 — evidence must not bleed in from unrelated prose', () => {
  it('does NOT extend a row block into a following UNINDENTED paragraph', () => {
    const lines = [
      '- [x] `HV-Z1` This row states nothing at all about coverage.',
      '',
      'An unrelated paragraph mentioning (#2960) that belongs to no row.',
    ];
    const text = rowBlock(lines, 0);
    expect(text, 'the unrelated paragraph must not be attributed to this row').not.toMatch(/#2960/);
    expect(classifyRow(text)).toBe('bare');
  });

  it('DOES keep the row\'s own indented continuation lines', () => {
    // The narrowing must not go so far that a legitimately wrapped row loses its
    // citation — that would fail honest rows and train people to inline everything.
    const lines = [
      '- [x] `HV-Z2` A row whose evidence wraps onto',
      '  the next line: `thing.test.tsx` covers it.',
      '',
      'Unrelated prose.',
    ];
    expect(classifyRow(rowBlock(lines, 0))).toBe('cited');
  });
});

describe('sabotage 4 — the regexes themselves keep their polarity', () => {
  it('EVIDENCE requires a leading word boundary on `verified`', () => {
    // Guards the exact character that was missing. Asserted on the regex rather
    // than only through classifyRow, so a future rewrite that reintroduces the
    // hole fails here even if NEGATED happens to mask it downstream.
    expect(EVIDENCE.test('unverified live 2026-08-05')).toBe(false);
    expect(EVIDENCE.test('verified live 2026-08-05')).toBe(true);
  });

  it('NEGATED covers each phrasing the tracker actually uses', () => {
    for (const s of ['unverified', 'not verified', 'no __tests__', 'no tests cover', 'nothing whatsoever proves']) {
      expect(NEGATED.test(`a row saying ${s} here`), `"${s}" must count as a negation`).toBe(true);
    }
    expect(NEGATED.test('verified live 2026-08-05')).toBe(false);
  });
});

describe('sabotage 5 — the row floor may be RAISED but never lowered', () => {
  // Found by /grade-code asking for a FIFTH way to pass while measuring nothing.
  // The floor catches an id-drift that takes the population 201 -> 134; an
  // override that could LOWER it handed that hole straight back. Same defect as
  // OPENWOP_TEST_TYPES_BASELINE before it was made tighten-only — a sibling gate
  // I had hardened two days earlier and did not think to check.
  it('REFUSES a floor lower than the committed one', () => {
    const r = resolveRowFloor('1');
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/LOWER/);
  });

  it('accepts a RAISED floor, so proving a higher one stays possible', () => {
    const r = resolveRowFloor(String(FILE_ROW_FLOOR + 5));
    expect(r.ok).toBe(true);
    expect(r.floor).toBe(FILE_ROW_FLOOR + 5);
  });

  it('falls back to the committed floor when unset or empty', () => {
    expect(resolveRowFloor(undefined)).toEqual({ ok: true, floor: FILE_ROW_FLOOR });
    expect(resolveRowFloor('')).toEqual({ ok: true, floor: FILE_ROW_FLOOR });
  });

  it('refuses a non-count rather than coercing it', () => {
    // `Number('abc')` is NaN and `NaN < floor` is false — an unguarded version
    // would sail past the comparison and disable the floor entirely.
    for (const bad of ['abc', '-1', '3.5']) {
      expect(resolveRowFloor(bad).ok, `${bad} must be refused`).toBe(false);
    }
  });
});
