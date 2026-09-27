/**
 * H102 — a failed compensation unwind MUST NOT consume the terminal event.
 *
 * `executor.ts` called `unwindTerminatedRun` UNGUARDED, with the nearest
 * enclosing `catch` ~520 lines above, immediately before `emitTerminalFailure`.
 * `unwindTerminatedRun` -> `resolveObligation` throws on a stale view, an illegal
 * transition, and — since the ADR 0554 P4 cross-instance CAS — CONTENTION (eight
 * lost compare-and-swaps on one obligation). Any of those threw straight past the
 * emit: the run lost its `run.failed` event AND its dead-letter attribution, and
 * the only trace that it had ended at all was its absence.
 *
 * The hazard PREDATES the CAS. What the CAS added is a LOAD-TRIGGERED path to a
 * throw previously reachable only by operator race — likeliest during recovery
 * under contention, which is exactly when the terminal event matters most.
 *
 * RECORD, DO NOT SWALLOW: the emit runs regardless, and carries WHY the unwind
 * failed. Losing the compensation failure to save the terminal event would just
 * move the hole.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { setEventLogBackend } from '../src/executor/eventLog.js';
import { emitTerminalFailure } from '../src/executor/executor.js';

let storage: Storage;
beforeEach(async () => {
  storage = await openStorage('memory://');
  setEventLogBackend(storage);
});
afterEach(async () => { await storage.close?.(); });

async function failedPayload(runId: string): Promise<Record<string, unknown>> {
  const events = await storage.listEvents(runId);
  const failed = events.find((e) => e.type === 'run.failed');
  expect(failed, 'no run.failed event was appended').toBeDefined();
  const payload = failed!.payload as { error?: Record<string, unknown> };
  return payload.error ?? {};
}

describe('H102 — the terminal event carries an unwind failure instead of being eaten by it', () => {
  it('records `compensationError` on run.failed when the unwind threw', async () => {
    await emitTerminalFailure({
      storage,
      runId: 'r-unwind-threw',
      error: { code: 'node_failed', message: 'boom' },
      compensationError: 'compensation obligation inv-1 write contention — 8 CAS attempts lost',
    });
    const err = await failedPayload('r-unwind-threw');
    expect(err.compensationError).toContain('8 CAS attempts lost');
    // The terminal error itself must survive intact — the compensation note is
    // ADDITIVE, not a replacement. A reader must still see what killed the run.
    expect(err.code).toBe('node_failed');
    expect(err.message).toBe('boom');
  });

  it('...and OMITS the field entirely when the unwind succeeded (the negative)', async () => {
    // Without this, a field that was always present would satisfy the leg above
    // and tell every consumer that every run had a compensation failure.
    await emitTerminalFailure({
      storage,
      runId: 'r-unwind-ok',
      error: { code: 'node_failed', message: 'boom' },
    });
    const err = await failedPayload('r-unwind-ok');
    expect('compensationError' in err).toBe(false);
  });

  // STRUCTURAL: the behavioural legs above prove the RECORDING half. The other
  // half — that a throwing unwind cannot skip the emit — is a control-flow
  // property of one call site, pinned here by source order because driving it
  // end-to-end needs a full failing-run harness and a mocked compensation
  // module. Asserted explicitly rather than assumed, with the ordering checked
  // rather than merely the presence of a `try`.
  it('EVERY unwind call site in executor.ts is guarded, and there is more than one', () => {
    // WIDENED by H58 (2026-08-18). The original used `findIndex`, so it checked
    // the FIRST `await unwindTerminatedRun(` and implied the rest. That was
    // sound when there was one site; H58d added a second (the run-duration cap),
    // and a matcher that checks one site while reading as "the unwind is guarded"
    // is the checks-one-implies-all shape this suite exists to remove — removing
    // the guard from the LATER site would have left this green.
    const src = readFileSync(new URL('../src/executor/executor.ts', import.meta.url), 'utf8');
    const lines = src.split('\n');
    const sites = lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => /^[^/]*await unwindTerminatedRun\(/.test(l))
      .map(({ i }) => i);

    // NON-VACUITY FLOOR: a refactor that renames or removes the calls must not
    // silently turn this into a test that asserts nothing over an empty set.
    expect(sites.length, 'expected at least two unwind call sites in executor.ts').toBeGreaterThanOrEqual(2);

    for (const unwind of sites) {
      const where = `executor.ts:${unwind + 1}`;
      const before = lines.slice(Math.max(0, unwind - 3), unwind).join('\n');
      expect(before, `${where}: the unwind call is NOT inside a try block`).toMatch(/try\s*\{/);
      const after = lines.slice(unwind, unwind + 12).join('\n');
      expect(after, `${where}: no catch immediately after the unwind`).toMatch(/\}\s*catch/);
      const emit = lines.findIndex((l, i) => i > unwind && /await emitTerminalFailure\(/.test(l));
      expect(emit, `${where}: emitTerminalFailure does not follow the unwind`).toBeGreaterThan(unwind);
    }
  });

  it('...and that matcher can fail (positive control)', () => {
    // The pre-H102 spelling: bare call, no try, emit still following. If the
    // matcher above passed on THIS, it would be pinning nothing.
    const pre = ['    await unwindTerminatedRun({ storage, run, definition });',
                 '    await emitTerminalFailure({ storage });'];
    expect(pre.slice(0, 1).join('\n')).not.toMatch(/try\s*\{/);
    expect(pre.join('\n')).not.toMatch(/\}\s*catch/);
  });
});
