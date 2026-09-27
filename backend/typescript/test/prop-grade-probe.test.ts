/**
 * GRADING PROBE — "Proposals" (FEATURES.md ordinal 239, RFC 0096 reviewable-learning).
 * Evidence only. GREEN + CI-safe (in-memory sqlite DurableCollection; no app boot).
 *
 * Witnesses Headline #2 — the proposal store's TENANT READ GUARD: a proposal owned
 * by tenant A is never readable by tenant B (`getProposal` returns null and
 * `listProposals` excludes it), because `getProposal` re-checks
 * `owner.tenant === tenant` on top of the tenant-prefixed key. This is the
 * read/apply isolation the `/grade-code` pass confirmed PASS.
 *
 * NOTE: the HEADLINE finding of this grade is NOT green-witnessable here and is a
 * born-red fix, so it is deliberately NOT asserted:
 *   - PROPC-ERASURE-TEARDOWN (HIGH): the proposals `DurableCollection` is built
 *     with NO `tenantOf` resolver and stores tenant nested at `owner.tenant` (no
 *     top-level `tenantId`), so `purgeTenantRows` skips every row on account
 *     teardown — proposal rows (userId + AI content + sourceRunIds) survive tenant
 *     deletion. The fix (add a `tenantOf` + a SubjectEraser) makes a
 *     "rows purged on teardown" test flip red→green; asserting the current
 *     (defective) no-top-level-tenantId shape here would enshrine the defect, so
 *     this probe witnesses only the read-guard positive.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { listProposals, getProposal, putProposal, __test } from '../src/features/proposals/proposalsService.js';
import type { Proposal } from '../src/features/proposals/types.js';

const A = 'tenant-probe-a';
const B = 'tenant-probe-b';
const draft = (tenant: string, id: string): Proposal => ({
  id, kind: 'prompt-template', state: 'draft', title: 'probe',
  artifact: { template: 'x {{w}}', variables: ['w'] },
  provenance: { sourceRunIds: ['run-1'] }, duplicateOf: null,
  owner: { tenant }, createdAt: '2026-08-28T00:00:00.000Z',
});

describe('Proposals — tenant read guard (by execution)', () => {
  beforeEach(async () => {
    process.env.OPENWOP_PROPOSALS_ACTIVATION = 'direct-rbac';
    initHostExtPersistence(openSqliteStorage(':memory:'));
    await __test.collection.__clear();
  });

  it('PROPP-1: tenant B cannot read or list tenant A\'s proposal', async () => {
    await putProposal(draft(A, 'pa'));
    expect((await getProposal(A, 'pa'))?.owner.tenant).toBe(A); // A reads its own (control)
    expect(await getProposal(B, 'pa')).toBeNull(); // cross-tenant read refused
    const listB = await listProposals(B);
    expect(listB.some((p) => p.id === 'pa')).toBe(false); // never in B's slice
  });
});
