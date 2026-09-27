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
    // The property the spec actually states, derived rather than asserted
    // separately: the executor computes `observed = now - runStartMs` and
    // `deadline = runStartMs + limit`, so a breach at `now > deadline` implies
    // `observed > limit` for every possible clock value.
    const runStartMs = 5_000;
    for (const limit of [0, 1, 250, 600_000]) {
      const deadlineAt = runStartMs + limit;
      for (const offset of [-2, -1, 0, 1, 2, 1_000]) {
        const now = deadlineAt + offset;
        if (!isRunDurationBreached(now, deadlineAt)) continue;
        const observed = now - runStartMs;
        expect(observed, `limit=${limit} offset=${offset}`).toBeGreaterThan(limit);
      }
    }
  });

  it('a zero-length window still requires the clock to advance past it', () => {
    // Degenerate but reachable via `Math.min(requested, ceiling)`; with `>=` a
    // zero window breached instantly at `observed === limit === 0`.
    expect(isRunDurationBreached(0, 0)).toBe(false);
    expect(isRunDurationBreached(1, 0)).toBe(true);
  });
});
