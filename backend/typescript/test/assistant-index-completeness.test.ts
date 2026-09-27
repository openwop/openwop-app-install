/**
 * COS-4 (data-integrity Blocker) — a commitment present in the base
 * `assistant:commitment` collection but MISSING from the ADR 0029 secondary
 * index must NOT be invisible to `listCommitments` (and therefore the briefing,
 * health, and board projection). Before the fix `listCommitments` read the ADR
 * 0029 index EXCLUSIVELY, so such a row (a legacy pre-index row, a lost index
 * write, or one caught in the old per-boot backfill-race window) silently
 * vanished with no error and no log. The fix reads through the base collection's
 * COMPLETE built-in tenant index (`listForTenantIndexed`) instead.
 *
 * This also witnesses the second half of the Blocker: the legacy backfill is now
 * gated on a DURABLE marker, so it runs once — not on every cold start.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { initHostExtPersistence, __hostExtStorage } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import {
  __resetAssistantStore,
  upsertCommitmentBySource,
  listCommitments,
  backfillCommitmentIndexes,
  type SourceRef,
} from '../src/features/assistant/assistantService.js';
import { composeBriefing } from '../src/features/assistant/briefing.js';
import { buildAssistantHealth } from '../src/features/assistant/health.js';

let storage: Storage;

beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  await __resetAssistantStore();
});

const T = 'cos4-tenant';
const src = (k: string): SourceRef => ({
  kind: 'manual', externalId: `manual-${k}`, contentHash: `hash-${k}`, capturedAt: new Date().toISOString(),
});

/** Strip EVERY index trace of a commitment, simulating a legacy pre-index row:
 *  the base row survives, but the ADR 0029 secondary index, the built-in tenant
 *  marker, and both backfill sentinels are gone. */
async function stripAllIndexTraces(tenantId: string, commitmentId: string): Promise<void> {
  const s = __hostExtStorage()!;
  await s.kvDelete(`hostext:assistant:commitment:by-tenant:${tenantId}:${commitmentId}`);
  await s.kvDelete(`hostext:assistant:commitment:by-status:${tenantId}:open:${commitmentId}`);
  await s.kvDelete(`hostextidx:assistant:commitment:${tenantId}:${commitmentId}`);
  await s.kvDelete('hostextidxmeta:assistant:commitment:backfilled'); // built-in index sentinel
  await s.kvDelete('hostextidxmeta:assistant:commitment:legacy-backfilled'); // ADR 0029 backfill marker
}

describe('COS-4 — an un-indexed commitment is not invisible', () => {
  it('surfaces a commitment present in the base collection but missing from the index', async () => {
    const { commitment } = await upsertCommitmentBySource(T, {
      owner: { kind: 'self' }, description: 'ship the Q3 wholesale proposal', source: src('a'),
      dueAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    // Sanity: the base row is present, and it starts visible via the normal path.
    expect((await listCommitments(T)).map((c) => c.commitmentId)).toContain(commitment.commitmentId);

    // Now simulate the pre-index / lost-index state: base row survives, every
    // index trace is gone.
    await stripAllIndexTraces(T, commitment.commitmentId);

    // BORN-RED before the fix (listCommitments read the ADR 0029 index
    // exclusively → the row was absent). GREEN after: it reads the complete
    // built-in tenant index, whose durable-sentinel back-fill re-surfaces the
    // legacy row.
    const seen = await listCommitments(T);
    expect(seen.map((c) => c.commitmentId)).toContain(commitment.commitmentId);

    // The same completeness must reach the derived read surfaces.
    const status = await listCommitments(T, { status: 'open' });
    expect(status.map((c) => c.commitmentId)).toContain(commitment.commitmentId);

    const briefing = await composeBriefing(T);
    expect(briefing.topCommitments.map((c) => c.commitmentId)).toContain(commitment.commitmentId);

    const health = await buildAssistantHealth(T);
    expect(health.commitments.open).toBeGreaterThanOrEqual(1);
  });

  it('stays tenant-isolated — the recovered row never leaks to another tenant', async () => {
    const { commitment } = await upsertCommitmentBySource(T, {
      owner: { kind: 'self' }, description: 'private to T', source: src('b'),
    });
    await stripAllIndexTraces(T, commitment.commitmentId);
    expect(await listCommitments('other-tenant')).toHaveLength(0);
    expect((await listCommitments(T)).map((c) => c.commitmentId)).toContain(commitment.commitmentId);
  });
});

describe('COS-4 — the legacy backfill is gated on a durable marker', () => {
  it('runs once, then skips the cross-tenant re-scan on subsequent boots', async () => {
    await upsertCommitmentBySource(T, { owner: { kind: 'self' }, description: 'x', source: src('c') });
    await upsertCommitmentBySource(T, { owner: { kind: 'self' }, description: 'y', source: src('d') });
    // Clear only the durable marker (leave the rows) to model a fresh deploy.
    await storage.kvDelete('hostextidxmeta:assistant:commitment:legacy-backfilled');

    const first = await backfillCommitmentIndexes();
    expect(first).toBe(2); // scanned + indexed the two rows
    const marker = await storage.kvGet('hostextidxmeta:assistant:commitment:legacy-backfilled');
    expect(marker).not.toBeNull();

    // A second (cold-start) call must NOT re-scan — it returns 0, the skip signal.
    expect(await backfillCommitmentIndexes()).toBe(0);
    expect(await backfillCommitmentIndexes()).toBe(0);
  });
});
