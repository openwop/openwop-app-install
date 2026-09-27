/**
 * ADR 0672 D3 (`CMSAWF-15`) — a review that was OVERTAKEN is recorded as superseded, not
 * rejected.
 *
 * Born red: every superseding closure resolved the row `'rejected'` and `resolveApproval`
 * derived the chain `outcome` from `next.status`, so the tamper-evident chain said "the
 * review was rejected" about a page that had just gone LIVE — the one thing an audit chain
 * must not do. `superseded` did not exist on the row or in the chain.
 *
 * Leg 3 is the one the review insisted on: a chain-only value would have been INVISIBLE to
 * the submitter surface, which reads the row and never the chain, making the fix decorative.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { getApproval, resolveApproval, createContentApproval } from '../src/host/approvalService.js';
import { listChain } from '../src/host/auditChainService.js';

const T = 'tSupersede';

const queue = async (pageId: string): Promise<string> => {
  const a = await createContentApproval({
    tenantId: T, orgId: 'org-1', pageId, slug: pageId, title: `Page ${pageId}`,
    proposal: `Publish CMS page "${pageId}"`, requestedBy: 'u-author',
  } as never);
  return a.approvalId;
};

beforeEach(async () => {
  const storage = await openStorage('memory://');
  initHostExtPersistence(storage);
});

describe('ADR 0672 D3 — superseded is not rejected', () => {
  it('leg 1: the CHAIN records `superseded` while the ROW stays `rejected`', async () => {
    const id = await queue('p1');
    await resolveApproval(id, { status: 'rejected', note: 'Superseded by direct publish.', chainOutcome: 'superseded' });

    const row = await getApproval(id);
    expect(row?.status, 'the row keeps the only terminal non-approved status there is').toBe('rejected');

    const chain = await listChain(T);
    const entry = chain.find((e) => JSON.stringify(e).includes(id));
    expect(entry, 'the decision must reach the chain at all').toBeTruthy();
    expect(JSON.stringify(entry), 'the chain must not say the review was REJECTED').toContain('superseded');
  });

  it('leg 2: a REAL rejection still records `rejected` — the fix is not a blanket relabel', async () => {
    const id = await queue('p2');
    await resolveApproval(id, { status: 'rejected', note: 'Not ready.' });
    const chain = await listChain(T);
    const entry = chain.find((e) => JSON.stringify(e).includes(id));
    expect(JSON.stringify(entry)).toContain('"outcome":"rejected"');
    expect(JSON.stringify(entry)).not.toContain('superseded');
    expect((await getApproval(id))?.superseded, 'and the row carries no flag').toBeFalsy();
  });

  it('leg 3: the supersession is REACHABLE from the row — a chain-only value would be invisible', async () => {
    // `GET …/pages/:id/review` projects the ROW, never the chain. Without a row-level
    // marker the submitter reads `rejected` for a page that went live, and D3 is decorative.
    const id = await queue('p3');
    await resolveApproval(id, { status: 'rejected', note: 'Superseded by direct publish.', chainOutcome: 'superseded' });
    const row = await getApproval(id);
    expect(row?.superseded, 'the submitter surface reads this, not the chain').toBe(true);
  });
});
