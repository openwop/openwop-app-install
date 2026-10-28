/**
 * RFC 0058 — the run-duration bound is breached only once the deadline is
 * PASSED, never when it is merely reached.
 *
 * `capabilities.md` §"Engine-enforced limits": the `cap.breached` payload's
 * `observed` is "always strictly greater than `limit`". The executor compared
 * `>=` until 2026-08-14, so on the tick where the clock landed exactly on the
 * deadline it emitted `observed === limit` — a true non-conformance that the
 * `run-execution-bounds-shape` conformance scenario reported correctly and that
 * I twice dismissed as a flake on a loaded machine.
 *
 * WHY THIS IS A UNIT TEST OF A PREDICATE. The failing input is ONE specific
 * millisecond. An integration test that starts a run and waits cannot reliably
 * land on it — that is precisely why the defect survived as an intermittent red
 * for months rather than a reproducible failure. Testing the comparison directly
 * makes the boundary case deterministic instead of hoping the scheduler hits it.
 *
 * Breaks it (round-1 probes, witnessed): `>` → `>=` (8fw2g2-rdb-strict reds the
 * regression, the table and the zero window) and a predicate one ms late
 * (rdb-past reds 'PAST the deadline' and the table's breached rows).
 */
import { describe, expect, it } from 'vitest';
import { isRunDurationBreached } from '../src/executor/executor.js';

describe('RFC 0058 — run-duration breach is strictly past the deadline', () => {
  const deadline = 1_000;

  it('BEFORE the deadline is not a breach', () => {
    expect(isRunDurationBreached(deadline - 1, deadline)).toBe(false);
    expect(isRunDurationBreached(0, deadline)).toBe(false);
  });

  it('EXACTLY ON the deadline is NOT a breach — the regression', () => {
    // The whole defect, in one assertion. With `>=` this returned true and the
    // emitted event carried `observed === limit`, which the spec forbids.
    expect(isRunDurationBreached(deadline, deadline)).toBe(false);
  });

  it('PAST the deadline is a breach', () => {
    expect(isRunDurationBreached(deadline + 1, deadline)).toBe(true);
    expect(isRunDurationBreached(deadline + 60_000, deadline)).toBe(true);
  });

  it('the emitted `observed` is therefore always > `limit`', () => {
    // The property the spec actually states: the executor computes
    // `observed = now - runStartMs` and `deadline = runStartMs + limit`. An
    // exact table (no conditional skip): every (limit, offset) pair has a
    // literal expected verdict, and every breached row has observed > limit.
    const runStartMs = 5_000;
    const table: Array<[limit: number, offset: number, breached: boolean]> = [
      [0, -1, false], [0, 0, false], [0, 1, true],
      [1, -1, false], [1, 0, false], [1, 1, true],
      [250, -1, false], [250, 0, false], [250, 1, true],
    ];
    for (const [limit, offset, breached] of table) {
      const deadlineAt = runStartMs + limit;
      const now = deadlineAt + offset;
      expect(isRunDurationBreached(now, deadlineAt), `limit=${limit} offset=${offset}`).toBe(breached);
      if (breached) expect(now - runStartMs, `limit=${limit} offset=${offset}`).toBeGreaterThan(limit);
    }
  });

  it('a zero-length window still requires the clock to advance past it', () => {
    // Degenerate but reachable via `Math.min(requested, ceiling)`; with `>=` a
    // zero window breached instantly at `observed === limit === 0`.
    expect(isRunDurationBreached(0, 0)).toBe(false);
    expect(isRunDurationBreached(1, 0)).toBe(true);
  });
});
