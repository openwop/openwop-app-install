/**
 * ADR 0371 Phase 1 — the removal-time stamp: terminal patches gain
 * `removalAt = completedAt + TTL` at the storage seam; 0 days disables;
 * explicit stamps are never overridden; non-terminal patches untouched.
 *
 * Breaks it (round-1 probes, witnessed): an UNSET env defaulting on
 * (8fw2g2-rrs-unset), junk failing open (rrs-junk), 0 not disabling (rrs-zero),
 * the sqlite `updateRun` seam skipping the stamp (rrs-seam), the TTL arithmetic
 * (rrs-ttl). Expected stamps are pinned LITERALS, not recomputed.
 *
 * "never overrides an explicit removalAt; leaves non-terminal patches alone"
 * ran with retention OFF in round 1 (afterEach clears the env), so nothing was
 * ever stamped and both halves held trivially (8fw2g2-rrs-explicit and
 * rrs-nonterminal VACUOUS). It now turns retention ON first and proves stamping
 * is live with a positive control in the same case.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { withRemovalStamp, defaultRetentionDays } from '../src/storage/runRetentionStamp.js';
import { openStorage } from '../src/storage/index.js';
import type { RunRecord } from '../src/types.js';

const PRIOR_RETENTION = process.env.OPENWOP_RUN_RETENTION_DAYS;
afterEach(() => {
  if (PRIOR_RETENTION === undefined) delete process.env.OPENWOP_RUN_RETENTION_DAYS;
  else process.env.OPENWOP_RUN_RETENTION_DAYS = PRIOR_RETENTION;
});

describe('run retention stamp (ADR 0371 P1)', () => {
  it('is OFF when the env var is UNSET (the documented keep-forever default) — no stamp', () => {
    delete process.env.OPENWOP_RUN_RETENTION_DAYS;
    expect(defaultRetentionDays()).toBe(0);
    expect(withRemovalStamp({ status: 'completed', completedAt: '2026-07-15T00:00:00.000Z' }).removalAt).toBeUndefined();
  });

  it('stamps completedAt + the env TTL when explicitly enabled', () => {
    process.env.OPENWOP_RUN_RETENTION_DAYS = '30';
    expect(withRemovalStamp({ status: 'completed', completedAt: '2026-07-15T00:00:00.000Z' }).removalAt)
      .toBe('2026-08-14T00:00:00.000Z'); // + 30 days
  });

  it('honors an explicit TTL; 0 disables; JUNK fails safe to OFF (never delete on a typo)', () => {
    process.env.OPENWOP_RUN_RETENTION_DAYS = '7';
    expect(defaultRetentionDays()).toBe(7);
    process.env.OPENWOP_RUN_RETENTION_DAYS = '0';
    expect(withRemovalStamp({ status: 'failed', completedAt: '2026-07-15T00:00:00.000Z' }).removalAt).toBeUndefined();
    process.env.OPENWOP_RUN_RETENTION_DAYS = 'nope';
    expect(defaultRetentionDays()).toBe(0);
    expect(withRemovalStamp({ status: 'completed', completedAt: '2026-07-15T00:00:00.000Z' }).removalAt).toBeUndefined();
  });

  it('never overrides an explicit removalAt; leaves non-terminal patches alone', () => {
    process.env.OPENWOP_RUN_RETENTION_DAYS = '30';
    // Positive control: stamping is ON in this case, so the two refusals below are
    // the guards and not "retention is off".
    expect(withRemovalStamp({ status: 'completed', completedAt: '2026-07-15T00:00:00.000Z' }).removalAt)
      .toBe('2026-08-14T00:00:00.000Z');
    const explicit = withRemovalStamp({ status: 'completed', removalAt: '2030-01-01T00:00:00.000Z' });
    expect(explicit.removalAt).toBe('2030-01-01T00:00:00.000Z');
    expect(withRemovalStamp({ status: 'running', completedAt: '2026-07-15T00:00:00.000Z' }).removalAt).toBeUndefined();
    expect(withRemovalStamp({ status: 'waiting-input', completedAt: '2026-07-15T00:00:00.000Z' }).removalAt).toBeUndefined();
    expect(withRemovalStamp({ currentNodeId: 'x' }).removalAt).toBeUndefined();
  });

  it('rides updateRun end-to-end (sqlite adapter): terminal write persists removalAt', async () => {
    process.env.OPENWOP_RUN_RETENTION_DAYS = '30';
    const storage = await openStorage('memory://');
    const runId = randomUUID();
    const now = new Date().toISOString();
    const run: RunRecord = {
      runId, workflowId: 'wf-x', tenantId: 'org:x', status: 'running',
      inputs: null, metadata: {}, configurable: {}, createdAt: now, updatedAt: now,
    };
    await storage.insertRun(run);
    const completedAt = '2026-07-15T12:00:00.000Z';
    await storage.updateRun(runId, { status: 'completed', completedAt });
    const read = await storage.getRun(runId);
    expect(read?.removalAt).toBe('2026-08-14T12:00:00.000Z'); // completedAt + 30 days
    await storage.close?.();
  });
});
