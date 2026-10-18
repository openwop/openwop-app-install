/**
 * GATE-5: the probes that found GATE-2 and GATE-3, kept as assertions.
 *
 * Both defects shipped, passed review, and were caught only by hand-running the
 * failure case — then the probes were thrown away, which protects nothing. Each
 * test below pins one shape the ratchet MUST refuse. See
 * `docs/steward/CODEBASE-ASSESSMENT.md` § Merge-gate tooling.
 *
 * The committed FILE_BASELINE moves every time a test type error is fixed, so no
 * case pins today's number; they pass an explicit file baseline (181) and assert
 * the decision logic. Types: `scripts/testTypesRatchet.d.mts`.
 */
import { describe, it, expect } from 'vitest';
import { resolveBaseline, classifyTscResult, FILE_BASELINE } from '../../scripts/testTypesRatchet.mjs';

describe('resolveBaseline — the override may tighten, never loosen (GATE-3)', () => {
  it('refuses a baseline HIGHER than the committed one', () => {
    // The shipped defect: OPENWOP_TEST_TYPES_BASELINE=99999 turned any red run
    // green AND printed "down 99797" as though it were progress.
    expect(resolveBaseline('99999', 181)).toMatchObject({ ok: false, error: expect.stringMatching(/HIGHER/) });
  });

  it('accepts a LOWER baseline, so measuring a target still works', () => {
    expect(resolveBaseline('150', 181)).toMatchObject({ ok: true, baseline: 150 });
  });

  it('refuses a non-count', () => {
    for (const bad of ['abc', '-1', '3.5']) {
      expect(resolveBaseline(bad, 181), bad).toMatchObject({ ok: false, error: expect.stringMatching(/is not a count/) });
    }
  });

  it('falls back to the file baseline when unset or empty', () => {
    expect(resolveBaseline(undefined, 181)).toEqual({ ok: true, baseline: 181 });
    expect(resolveBaseline('', 181)).toEqual({ ok: true, baseline: 181 });
  });

  it('exports a baseline that is an exact measured count, not a round number', () => {
    // A padded baseline tolerates regressions it never mentions — the failure
    // check-failed-read-sentinels had at 100 against a real 81. This is the
    // property the file can check without a tsc pass; the value itself moves.
    expect(Number.isInteger(FILE_BASELINE)).toBe(true);
    // 0 is the one round number that cannot be padded: there is no slack below it.
    // Any other multiple of 10 is refused (wave 52 drove the real count to 0).
    if (FILE_BASELINE !== 0) expect(FILE_BASELINE % 10).not.toBe(0);
    expect(FILE_BASELINE).toBeGreaterThanOrEqual(0);
  });
});

describe('classifyTscResult — an unreadable result is never zero errors (GATE-2)', () => {
  it('refuses a spawn failure instead of reporting a clean codebase', () => {
    const r = classifyTscResult({ spawnFailed: true, spawnCode: 'ENOENT', output: '', status: 0 });
    expect(r).toMatchObject({ ok: false, reason: 'spawn-failed' });
  });

  it('refuses a PROJECT-LEVEL error — the missing-tsconfig shape that reported "down 201"', () => {
    const r = classifyTscResult({
      output: "error TS5058: The specified path does not exist: 'tsconfig.NOPE.json'.\n",
      status: 1,
    });
    expect(r).toMatchObject({ ok: false, reason: 'project-level-error' });
  });

  it('refuses a non-zero exit with nothing parseable — the missing-binary shape that reported "down 202"', () => {
    const r = classifyTscResult({ output: "Error: Cannot find module '.../tsc'\n", status: 1 });
    expect(r).toMatchObject({ ok: false, reason: 'unparseable' });
  });

  it('COUNTS ordinary per-file diagnostics', () => {
    const r = classifyTscResult({
      output:
        'src/a.test.ts(1,1): error TS2532: Object is possibly undefined.\n' +
        'src/b.test.ts(9,4): error TS2345: Argument type mismatch.\n',
      status: 1,
    });
    expect(r).toMatchObject({ ok: true, count: 2 });
  });

  it('treats TS6133 as an ORDINARY diagnostic, not configuration', () => {
    // My first fix for GATE-2 classified config errors by CODE RANGE
    // (`TS[56]\d{3}`), which swept up TS6133 "declared but never read" — an
    // ordinary per-file diagnostic — and broke the HAPPY PATH. The sound
    // discriminator is the file position. This test exists because that
    // regression actually happened.
    const r = classifyTscResult({
      output: "src/x.test.tsx(26,27): error TS6133: 'url' is declared but its value is never read.\n",
      status: 1,
    });
    expect(r).toMatchObject({ ok: true, count: 1 });
  });

  it('accepts a genuinely clean run (exit 0, no diagnostics) as zero', () => {
    expect(classifyTscResult({ output: '', status: 0 })).toMatchObject({ ok: true, count: 0 });
  });

  it('counts only the per-error lines, not summary or related-information lines', () => {
    // tsc puts the code on the per-error line only; this is the assumption the
    // whole count rests on, so it is pinned rather than trusted.
    const r = classifyTscResult({
      output:
        'src/a.test.ts(1,1): error TS2532: Object is possibly undefined.\n' +
        "  src/a.test.ts(1,1): 'x' is declared here.\n" +
        'Found 1 error in 1 file.\n',
      status: 1,
    });
    expect(r).toMatchObject({ ok: true, count: 1 });
  });
});
