/**
 * ADR 0469 OQ2 — never-decided anon-surface-write holds auto-expire on the
 * confidential-pii retention window. `purgeExpiredAnonHolds` deletes ONLY pending
 * anon holds older than the cutoff (their PII can't linger for a gone visitor); a
 * decided hold and a non-anon approval are kept, and the pending status-index entry
 * is dropped with the row.
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

const anon = (runId: string) => createAnonSurfaceWriteApproval({
  tenantId: 'ttl', orgId: 'o', widgetId: 'w', principal: `anon:${runId}`, runId, toolCallIdx: 0,
  tool: { name: 'openwop:kanban.add-todo', args: { title: 'x' } },
});

describe('ADR 0469 OQ2 — anon-hold TTL purge', () => {
  it('deletes a PENDING anon hold older than the cutoff (+ drops its pending index)', async () => {
    const a = await anon('ttl-1');
    expect((await getApproval(a.approvalId))?.status).toBe('pending');
    const out = await purgeExpiredAnonHolds('ttl', FUTURE);
    expect(typeof out === 'number' ? out : out.deleted).toBeGreaterThanOrEqual(1);
    expect(await getApproval(a.approvalId)).toBeNull();
    // gone from the pending index too (listPendingApprovals reads the by-tenant-status index)
    const pending = await listApprovals('ttl', 'pending');
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
    await purgeExpiredAnonHolds('ttl', FUTURE); // purge tenant 'ttl', not 'ttl-other'
    expect((await getApproval(mine.approvalId))?.status).toBe('pending');
  });
});
