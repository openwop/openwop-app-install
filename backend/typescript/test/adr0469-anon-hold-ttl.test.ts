/**
 * ADR 0469 OQ2 — never-decided anon-surface-write holds auto-expire on the
 * confidential-pii retention window. `purgeExpiredAnonHolds` deletes ONLY pending
 * anon holds older than the cutoff (their PII can't linger for a gone visitor); a
 * decided hold and a non-anon approval are kept, and the pending status-index entry
 * is dropped with the row.
 *
 * TST-BQR-18. Red when the purge stops filtering to `anon-surface-write`,
 * stops deleting the row, or crosses tenants. Tenant scoping is a DOUBLE
 * guard: the read (`listApprovals(tenantId,'pending')` — tenant-prefixed index
 * + a row-tenant filter) AND the write (`purgeRowsByAge` skips any row whose
 * tenant is not the purging tenant); a probe on one alone is vacuous, so the
 * reprobe breaks both together. Honest ceiling: the pending-index drop cannot
 * be observed through `listApprovals`, which already discards an index entry
 * whose row is gone (a reader acting as a second guard).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  createAnonSurfaceWriteApproval,
  createApproval,
  getApproval,
  resolveApproval,
  purgeExpiredAnonHolds,
  listApprovals,
} from '../src/host/approvalService.js';

const FUTURE = '2999-01-01T00:00:00.000Z'; // every now-stamped row is "older" than this ⇒ eligible
const PAST = '2000-01-01T00:00:00.000Z';   // nothing is older than this ⇒ retained

beforeAll(async () => { initHostExtPersistence(await openStorage('memory://')); });

const anon = (runId: string, tenantId = 'ttl') => createAnonSurfaceWriteApproval({
  tenantId, orgId: 'o', widgetId: 'w', principal: `anon:${runId}`, runId, toolCallIdx: 0,
  tool: { name: 'openwop:kanban.add-todo', args: { title: 'x' } },
});

describe('ADR 0469 OQ2 — anon-hold TTL purge', () => {
  it('deletes a PENDING anon hold older than the cutoff (+ drops its pending index)', async () => {
    const a = await anon('ttl-1', 'ttl-case1'); // its own tenant: an exact count
    expect((await getApproval(a.approvalId))?.status).toBe('pending');
    const out = await purgeExpiredAnonHolds('ttl-case1', FUTURE);
    expect(out).toEqual({ deleted: 1, failed: 0 });
    expect(await getApproval(a.approvalId)).toBeNull();
    // gone from the pending listing too
    const pending = await listApprovals('ttl-case1', 'pending');
    expect(pending.find((p) => p.approvalId === a.approvalId)).toBeUndefined();
  });

  it('KEEPS a pending anon hold newer than the cutoff', async () => {
    const a = await anon('ttl-2');
    await purgeExpiredAnonHolds('ttl', PAST);
    expect((await getApproval(a.approvalId))?.status).toBe('pending');
  });

  it('KEEPS a resolved anon hold (audit record — only pending expires)', async () => {
    const a = await anon('ttl-3');
    await resolveApproval(a.approvalId, { status: 'rejected' });
    await purgeExpiredAnonHolds('ttl', FUTURE);
    expect((await getApproval(a.approvalId))?.status).toBe('rejected');
  });

  it('KEEPS a non-anon pending approval (only anon-surface-write expires)', async () => {
    const other = await createApproval({ tenantId: 'ttl', rosterId: 'r', persona: 'P', workflowId: 'wf', proposal: 'run something' });
    await purgeExpiredAnonHolds('ttl', FUTURE);
    expect((await getApproval(other.approvalId))?.status).toBe('pending');
  });

  it('is tenant-scoped — another tenant’s hold is untouched', async () => {
    const mine = await createAnonSurfaceWriteApproval({ tenantId: 'ttl-other', orgId: 'o', widgetId: 'w', principal: 'anon:x', runId: 'ttl-4', toolCallIdx: 0, tool: { name: 'openwop:kanban.add-todo' } });
    const purged = await anon('ttl-5'); // positive control: the purge DOES run for 'ttl'
    await purgeExpiredAnonHolds('ttl', FUTURE); // purge tenant 'ttl', not 'ttl-other'
    expect(await getApproval(purged.approvalId)).toBeNull();
    expect((await getApproval(mine.approvalId))?.status).toBe('pending');
  });
});
