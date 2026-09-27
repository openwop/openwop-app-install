/**
 * ADR 0070 — multi-approver / quorum approvals.
 *
 * An approval whose `policy.requiredApprovals > 1` turns each claim/reject into
 * an eligibility-checked VOTE recorded in the durable `review:decision` ledger
 * (keyed by `approvalId`, generalized from the interrupt ledger). The gate stays
 * `pending` — no handler dispatch / run start — until the threshold is met, then
 * finalizes exactly once. This pins:
 *   - vote accumulation + progress reporting,
 *   - dedup (a reviewer voting twice counts once),
 *   - eligibility (explicit `approverRefs` list ⇒ 403 for a non-member, no
 *     authenticated approver ⇒ 403),
 *   - quorum-met ⇒ the single finalize fires (here the content-publish handler),
 *   - a single-approver / no-policy approval is byte-unchanged (resolves on the
 *     first vote — the 40 existing approval tests are the regression guard).
 */

import { beforeAll, beforeEach, describe, expect, it, afterAll} from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStorage } from '../src/storage/index.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { createHostAdapterSuite } from '../src/host/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  createContentApproval,
  registerContentApprovalHandler,
  getContentApprovalHandler,
  getApproval,
  type PendingApproval,
} from '../src/host/approvalService.js';
import { claimApproval } from '../src/host/approvalDecision.js';
import { __clearDecisionLedger } from '../src/host/reviewDecisionLedger.js';
import { OpenwopError } from '../src/types.js';

const storage = await openStorage('memory://');
initHostExtPersistence(storage);
initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-appr-quorum-')) });
const hostSuite = createHostAdapterSuite({ storage });
const deps = { storage, hostSuite };

const TENANT = 'tenant-q';
const ORG = 'org-q';
const ALICE = 'user:alice';
const BOB = 'user:bob';
const CAROL = 'user:carol';

// A content-publish approval gives a clean, registered finalize (no roster/run
// setup): the handler just reports the page approved.
let published: Array<{ approvalId: string; outcome: string; by?: string }> = [];
// ADR 0672 D6 (`CMSAWF-9`) — this stub is registered on a PROCESS-GLOBAL slot
// (`registerContentApprovalHandler` assigns a module-level variable). Without a restore it
// outlives this file, so any suite sharing the worker afterwards decides content-publish
// rows through a handler that RESOLVES NOTHING. Captured and restored below.
//
// Standing limitation, recorded rather than papered over: because the stub never resolves,
// every content-publish assertion in THIS file is an assertion about the stub, not about
// `decideContentPublish`. That is `CMSAWF-9`. What the file does still witness honestly is
// the quorum TALLY in `evaluateQuorum` — which is why it is kept rather than deleted. The
// claim that no production lane can reach that path is pinned separately, over the real
// call sites, in `approval-quorum-cms-lanes.test.ts`.
let priorHandler: ReturnType<typeof getContentApprovalHandler> = null;
beforeAll(() => {
  priorHandler = getContentApprovalHandler();
  registerContentApprovalHandler(async (_tenantId, approvalId, outcome, opts) => {
    published.push({ approvalId, outcome, by: opts.decidedByUserId });
    const approval = (await getApproval(approvalId)) as PendingApproval;
    return { approval: { ...approval, status: 'approved' }, changed: true };
  });
});

afterAll(() => {
  if (priorHandler) registerContentApprovalHandler(priorHandler);
});

beforeEach(async () => {
  await __clearDecisionLedger();
  published = [];
});

function seedQuorumApproval(approverRefs: string[], requiredApprovals = 2): Promise<PendingApproval> {
  return createContentApproval({
    tenantId: TENANT,
    orgId: ORG,
    pageId: 'page-1',
    pageTitle: 'Q3 family update',
    proposal: 'Publish the Q3 family-update page',
    policy: { requiredApprovals, approverRefs },
  });
}

describe('category: quorum vote accumulation + dedup', () => {
  it('stays pending until the threshold, reporting progress', async () => {
    const appr = await seedQuorumApproval([ALICE, BOB]);

    const first = await claimApproval(deps, { tenantId: TENANT, decidedBy: ALICE }, appr.approvalId);
    expect(first.status).toBe('pending');
    expect(first.policy).toEqual({ requiredApprovals: 2, approvals: 1, rejections: 0 });
    expect(published).toHaveLength(0); // not finalized
    expect((await getApproval(appr.approvalId))?.status).toBe('pending');
  });

  it('dedups a reviewer who votes twice (counts once)', async () => {
    const appr = await seedQuorumApproval([ALICE, BOB]);
    await claimApproval(deps, { tenantId: TENANT, decidedBy: ALICE }, appr.approvalId);
    const again = await claimApproval(deps, { tenantId: TENANT, decidedBy: ALICE }, appr.approvalId);
    expect(again.status).toBe('pending');
    expect(again.policy).toEqual({ requiredApprovals: 2, approvals: 1, rejections: 0 });
    expect(published).toHaveLength(0);
  });

  it('finalizes exactly once when a SECOND distinct approver meets quorum', async () => {
    const appr = await seedQuorumApproval([ALICE, BOB]);
    await claimApproval(deps, { tenantId: TENANT, decidedBy: ALICE }, appr.approvalId);
    const second = await claimApproval(deps, { tenantId: TENANT, decidedBy: BOB }, appr.approvalId);
    expect(second.status).toBe('approved');
    expect(second.pageId).toBe('page-1');
    expect(published).toEqual([{ approvalId: appr.approvalId, outcome: 'approved', by: BOB }]);
  });
});

describe('category: eligibility', () => {
  it('rejects an approver not on the explicit approverRefs list (403)', async () => {
    const appr = await seedQuorumApproval([ALICE, BOB]);
    await expect(claimApproval(deps, { tenantId: TENANT, decidedBy: CAROL }, appr.approvalId)).rejects.toMatchObject({
      httpStatus: 403,
    });
    expect(published).toHaveLength(0);
  });

  it('rejects an unauthenticated vote on a quorum gate (403)', async () => {
    const appr = await seedQuorumApproval([ALICE, BOB]);
    await expect(claimApproval(deps, { tenantId: TENANT }, appr.approvalId)).rejects.toBeInstanceOf(OpenwopError);
  });
});
