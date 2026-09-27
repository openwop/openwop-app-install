/**
 * ADR 0585 P0b — the dispatch lease becomes a CLAIM a former owner cannot retake.
 *
 * ── WHAT THIS PROTECTS, IN ONE LINE ──────────────────────────────────────────
 *
 * `setRunDispatchLease` is `UPDATE … WHERE run_id = ?` — no owner predicate. As
 * a dispatch-time stamp that is correct. As the P0 HEARTBEAT it was a defect: a
 * reclaimed-then-resumed instance would take the run back from its new owner and
 * self-renew, after which the sweeper sees a healthy lease and never re-reclaims.
 * Unreachable while the lease outlives the run ceiling; P1 is what activates it.
 *
 * The FIRST case below is the positive control for exactly that, and it fails
 * against the pre-P0b code. Everything else here rests on it: if a renewal could
 * still steal, the lost-lease signal would never fire and every other assertion
 * would be vacuously green.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import {
  assertEffectAllowed,
  runWithEffectContext,
  markDispatchLeaseLost,
  hasLostDispatchLease,
  LeaseLostError,
  __resetLostDispatchLeasesForTest,
} from '../src/host/runEffectContext.js';
import type { RunRecord } from '../src/types.js';

const OWNER_A = 'host-a-111';
const OWNER_B = 'host-b-222';

function runRow(runId: string): RunRecord {
  const now = new Date().toISOString();
  return {
    runId, workflowId: 'wf', tenantId: 'default', status: 'running',
    createdAt: now, updatedAt: now, inputs: {},
  } as RunRecord;
}

describe('ADR 0585 P0b — CAS renewal', () => {
  it('POSITIVE CONTROL: a NON-owner cannot renew, and does not modify the row', async () => {
    const s = openSqliteStorage(':memory:');
    await s.insertRun(runRow('r1'));
    await s.setRunDispatchLease('r1', OWNER_A, 1_000);

    // B tries to renew a lease it does not hold. Under the pre-P0b
    // unconditional UPDATE this SUCCEEDED and rewrote dispatch_owner to B.
    const ok = await s.renewRunDispatchLeaseIfOwner('r1', OWNER_B, 999_000);
    expect(ok).toBe(false);

    const after = await s.getRun('r1');
    expect(after?.dispatchOwner, 'a failed renewal must not change the owner').toBe(OWNER_A);
    expect(after?.dispatchLeaseExpiresAt, 'nor extend the lease').toBe(1_000);
  });

  it('the real owner CAN renew, and only the expiry moves', async () => {
    const s = openSqliteStorage(':memory:');
    await s.insertRun(runRow('r2'));
    await s.setRunDispatchLease('r2', OWNER_A, 1_000);

    expect(await s.renewRunDispatchLeaseIfOwner('r2', OWNER_A, 5_000)).toBe(true);
    const after = await s.getRun('r2');
    expect(after?.dispatchOwner).toBe(OWNER_A);
    expect(after?.dispatchLeaseExpiresAt).toBe(5_000);
  });

  it('a reclaim by B makes A\'s next renewal fail — the liveness signal', async () => {
    const s = openSqliteStorage(':memory:');
    await s.insertRun(runRow('r3'));
    await s.setRunDispatchLease('r3', OWNER_A, 1_000);

    // The sweeper hands the run to B (this is what claimOrphanedRuns does).
    await s.setRunDispatchLease('r3', OWNER_B, 9_000);

    // A resumes from suspension and heartbeats. It learns, on the write it was
    // making anyway — no extra read buys this.
    expect(await s.renewRunDispatchLeaseIfOwner('r3', OWNER_A, 99_000)).toBe(false);
    expect((await s.getRun('r3'))?.dispatchOwner, 'B keeps the run').toBe(OWNER_B);
  });

  it('a missing run reads as "not ours" rather than throwing', async () => {
    const s = openSqliteStorage(':memory:');
    expect(await s.renewRunDispatchLeaseIfOwner('nope', OWNER_A, 1)).toBe(false);
  });
});

describe('ADR 0585 P0b — the effect gate', () => {
  beforeEach(() => { __resetLostDispatchLeasesForTest(); });

  it('refuses an effect once the run\'s lease is lost, with a typed error', () => {
    markDispatchLeaseLost('r4');
    expect(hasLostDispatchLease('r4')).toBe(true);
    expect(() =>
      runWithEffectContext({ runId: 'r4', replaying: false }, () => assertEffectAllowed('network-egress')),
    ).toThrow(LeaseLostError);
  });

  it('ABSENT-CASE: an unaffected run still passes the gate', () => {
    // Without this, the case above would pass against a gate that refused
    // everything — the guard would be "working" by being broken.
    markDispatchLeaseLost('r4');
    expect(() =>
      runWithEffectContext({ runId: 'r5', replaying: false }, () => assertEffectAllowed('network-egress')),
    ).not.toThrow();
  });

  it('outside a run there is no ambient context and the gate is a no-op', () => {
    markDispatchLeaseLost('r4');
    expect(() => assertEffectAllowed('network-egress')).not.toThrow();
  });

  it('the error names the run and the effect kind, so a log line is actionable', () => {
    markDispatchLeaseLost('r6');
    try {
      runWithEffectContext({ runId: 'r6', replaying: false }, () => assertEffectAllowed('email'));
      throw new Error('expected LeaseLostError');
    } catch (e) {
      expect(e).toBeInstanceOf(LeaseLostError);
      expect((e as LeaseLostError).runId).toBe('r6');
      expect((e as LeaseLostError).effectKind).toBe('email');
    }
  });
});

describe('ADR 0585 P0b — the losing executor writes NOTHING', () => {
  /**
   * The disposition that protects money. A terminal event from a former owner
   * is a lost update on a row the new owner is also writing; worse, on the
   * failure path a `node.failed` is what TRIGGERS compensation, so the zombie
   * would fire refund inverses against effects the new owner is legitimately
   * re-executing. Pinned structurally because driving a real two-process
   * reclaim needs a fleet this suite does not have.
   */
  const src = new URL('../src/executor/executor.ts', import.meta.url);

  it('the abandon path calls neither emitTerminalFailure nor unwindTerminatedRun', async () => {
    const { readFileSync } = await import('node:fs');
    const text = readFileSync(src, 'utf8');
    const start = text.indexOf('const abandonLostLease');
    expect(start, 'abandonLostLease must exist').toBeGreaterThan(-1);
    const body = text.slice(start, text.indexOf('};', start));
    expect(body).not.toMatch(/emitTerminalFailure/);
    expect(body).not.toMatch(/unwindTerminatedRun/);
    expect(body, 'and it must not invent a wire status').not.toMatch(/status: '(failed|cancelled)'/);
  });

  it('a LeaseLostError is re-thrown rather than recorded as a node failure', async () => {
    const { readFileSync } = await import('node:fs');
    const text = readFileSync(src, 'utf8');
    expect(text).toMatch(/if \(err instanceof LeaseLostError\) throw err;/);
    // ...and caught before it can reject into dispatchRunInBackground's catch,
    // which marks runs failed.
    expect(text).toMatch(/task\.catch\(/);
  });

  it('the heartbeat renews CONDITIONALLY — a steal-back would be silent otherwise', async () => {
    const { readFileSync } = await import('node:fs');
    const text = readFileSync(src, 'utf8');
    expect(text).toMatch(/renewRunDispatchLeaseIfOwner\(/);
    // The unconditional form must not be reachable from the heartbeat.
    const hb = text.slice(text.indexOf('const renewDispatchLeaseIfDue'));
    const body = hb.slice(0, hb.indexOf('\n  };'));
    expect(body, 'the heartbeat must not use the unconditional stamp').not.toMatch(/setRunDispatchLease\(/);
  });
});
