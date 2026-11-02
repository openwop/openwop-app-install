/**
 * ADR 0672 D4 (`CMSAWF-13`) — `repinContentApproval` and `setApprovalProposal` hold the
 * guarantee their own headers claim.
 *
 * Born red: both were blind read-modify-writes — no CAS, and OUTSIDE `withApprovalLock` —
 * while `repinContentApproval`'s header stated "It refuses anything that is not still
 * `pending`". Check-then-act. A repin interleaving a decide reverted an APPROVED row to
 * pending, erased `resolvedAt`/`decidedBy`, and left it indexed under BOTH statuses because
 * `indexApproval` was called with no `prevStatus` (and it only deletes the old entry when
 * one is supplied).
 *
 * TST-BZA-8 (grade-tests w66). Red when: repin drops its `status !== 'pending'` refusal
 * (leg 1); repin's compare-and-swap is replaced by a blind write (leg 2 — FORCED: the
 * repin's read is served a stale PENDING snapshot of a row that is already APPROVED, the
 * cross-instance interleave the CAS exists for; the in-process lock cannot help there);
 * setApprovalProposal drops its pending refusal (leg 4).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initHostExtPersistence, DurableCollection } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import {
  createContentApproval, resolveApproval, getApproval, repinContentApproval,
  setApprovalProposal, listApprovals,
} from '../src/host/approvalService.js';

const T = 'tRepin';
const ix = new DurableCollection<{ ixId: string; approvalId: string }>('approval:by-tenant-status', (r) => r.ixId);

const queue = async (pageId: string): Promise<string> =>
  (await createContentApproval({
    tenantId: T, orgId: 'org-1', pageId, pageTitle: `T ${pageId}`,
    proposal: `Publish CMS page "${pageId}"`, pageVersion: 1,
  })).approvalId;

beforeEach(async () => {
  const storage = await openStorage('memory://');
  initHostExtPersistence(storage);
});
afterEach(() => { vi.restoreAllMocks(); });

describe('ADR 0672 D4 — repin cannot resurrect a decided row', () => {
  it('leg 1: a repin AFTER a decide refuses — the row stays approved with its attribution', async () => {
    const id = await queue('p1');
    await resolveApproval(id, { status: 'approved', decidedBy: 'u-reviewer' });

    const out = await repinContentApproval(id, { pageVersion: 99 });
    expect(out, 'the header promises a refusal for anything not still pending').toBeNull();

    const row = await getApproval(id);
    expect(row?.status).toBe('approved');
    expect(row?.decidedBy, 'attribution must not be erased').toBe('u-reviewer');
    expect(row?.resolvedAt, 'the decision timestamp must survive').toBeTruthy();
    expect(row?.pageVersion, 'and the pin must not move under a decided row').toBe(1);
  });

  it('leg 2: the row is never indexed under TWO statuses', async () => {
    const id = await queue('p2');
    // The snapshot another instance would still hold: read while PENDING.
    const stale = await getApproval(id);
    expect(stale?.status).toBe('pending');
    await resolveApproval(id, { status: 'approved', decidedBy: 'u-reviewer' });

    // Serve the repin's read that stale snapshot — once, for this row only.
    const realGet = DurableCollection.prototype.get;
    let served = 0;
    vi.spyOn(DurableCollection.prototype, 'get').mockImplementation(async function (this: DurableCollection<unknown>, key: string) {
      if (key === id && served === 0) { served += 1; return structuredClone(stale); }
      return realGet.call(this, key);
    });
    const out = await repinContentApproval(id, { pageVersion: 99 });
    vi.restoreAllMocks();
    expect(served, 'the repin read the stale snapshot — otherwise the CAS was never in play').toBe(1);
    expect(out, 'a CAS against the stale PENDING row must refuse').toBeNull();

    const row = await getApproval(id);
    expect(row?.status, 'the stale repin must not revert the decision').toBe('approved');
    expect(row?.decidedBy).toBe('u-reviewer');
    expect(row?.pageVersion).toBe(1);

    const rows = await ix.listByPrefix(`${T}:`);
    const forThis = rows.filter((r) => r.approvalId === id);
    expect(forThis.length, `indexed ${forThis.length}× — a dual-indexed row appears in two queues`).toBe(1);
    expect(forThis[0]?.ixId).toContain(':approved:');

    // ...and the pending queue really is empty for it (the user-visible half).
    const pending = await listApprovals(T, 'pending');
    expect(pending.map((a) => a.approvalId)).not.toContain(id);
  });

  it('leg 3: a repin on a PENDING row still works — the fix is a refusal, not a freeze', async () => {
    const id = await queue('p3');
    const out = await repinContentApproval(id, { pageVersion: 42 });
    expect(out?.pageVersion, 'the unpinned_review self-heal depends on this path').toBe(42);
    expect((await getApproval(id))?.status).toBe('pending');
  });

  it('leg 4: setApprovalProposal has the identical guarantee', async () => {
    const id = await queue('p4');
    await resolveApproval(id, { status: 'rejected', note: 'no' });
    expect(await setApprovalProposal(id, 'rewritten'), 'must refuse on a decided row').toBeNull();
    expect((await getApproval(id))?.proposal).not.toBe('rewritten');

    const id2 = await queue('p5');
    expect((await setApprovalProposal(id2, 'refreshed'))?.proposal, 'and still works while pending').toBe('refreshed');
  });
});
