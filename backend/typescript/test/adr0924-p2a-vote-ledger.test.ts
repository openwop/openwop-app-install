/**
 * ADR 0924 P2a — the host half of the two-party quorum groundwork, on the ONE
 * vote entry (`castApprovalVote`, `host/approvalDecision.ts`) and the ONE ledger
 * (`host/reviewDecisionLedger.ts`).
 *
 * Pins (review finding in brackets):
 *  - [C1/H1] on a per-party row, two agency votes are NOT a quorum; a client vote
 *    cast on the client lane lands in the same ledger and completes it;
 *  - [H2] the party is recorded on the vote, from the lane: a decide context that
 *    smuggles `party` / `lane` fields still records `agency`, and subject erasure
 *    keeps `party` while scrubbing the ref;
 *  - [C1] a client vote is refused (`not_a_party`) on a row that does not name
 *    the client, and on a kind that takes no client votes;
 *  - [C2] the kind's per-vote check runs on a vote that does NOT complete the
 *    quorum, and a refusal there records nothing;
 *  - [H3] completing the quorum re-checks the earlier votes; a dropped vote is
 *    removed from the ledger and the row stays pending.
 *
 * The kind here is content-publish with a stub finalize (the `approval-quorum`
 * precedent), plus vote hooks this file registers and removes. The campaign
 * change-set hooks are witnessed over HTTP in `adr0924-p2a-change-set-votes`.
 *
 * Red witness: on `main`, `src/host/approvalDecision.ts` has no
 * `castApprovalVote` / `registerApprovalVoteHooks` and `evaluateQuorum` counts a
 * bare total, and `src/host/reviewDecisionLedger.ts` has no `party`, so the
 * two-agency case finalizes and the file fails to import. Sabotage (to run at
 * the gate): drop `partiesMet` in `evaluateQuorumTally` → the two-agency case
 * goes red; write `party` from `ctx` instead of the lane → the smuggle case goes
 * red; skip `staleVotes` → the re-check case goes red.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStorage } from '../src/storage/index.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { createHostAdapterSuite } from '../src/host/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  createContentApproval,
  getApproval,
  getContentApprovalHandler,
  registerContentApprovalHandler,
  type ApprovalPolicy,
  type PendingApproval,
} from '../src/host/approvalService.js';
import { castApprovalVote, claimApproval, registerApprovalVoteHooks } from '../src/host/approvalDecision.js';
import {
  __clearDecisionLedger,
  ERASED_REF,
  eraseReviewDecisionsForSubject,
  listGateDecisions,
} from '../src/host/reviewDecisionLedger.js';
import { OpenwopError } from '../src/types.js';

const storage = await openStorage('memory://');
initHostExtPersistence(storage);
initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'openwop-adr0924-p2a-')) });
const deps = { storage, hostSuite: createHostAdapterSuite({ storage }) };

const TENANT = 'tenant-p2a';
const ORG = 'org-p2a';
const ALICE = 'user:alice';
const BOB = 'user:bob';
const CLIENT_ANN = 'client-approver:ann';
const CLIENT_LANE = { party: 'client', approverId: 'ann', sentBy: BOB } as const;

/** One agency party and one client party, the `client_and_agency` shape. */
const TWO_PARTY: ApprovalPolicy = {
  requiredApprovals: 2,
  approverRefs: [ALICE, BOB],
  rejectionPolicy: 'any',
  perParty: [{ party: 'agency', min: 1 }, { party: 'client', min: 1 }],
  clientApprover: true,
};

let finalized: string[] = [];
let priorHandler: ReturnType<typeof getContentApprovalHandler> = null;
beforeAll(() => {
  priorHandler = getContentApprovalHandler();
  registerContentApprovalHandler(async (_tenantId, approvalId) => {
    finalized.push(approvalId);
    const approval = (await getApproval(approvalId)) as PendingApproval;
    return { approval: { ...approval, status: 'approved' }, changed: true };
  });
});
afterAll(() => {
  if (priorHandler) registerContentApprovalHandler(priorHandler);
});
beforeEach(async () => {
  await __clearDecisionLedger();
  finalized = [];
  registerApprovalVoteHooks('content-publish', { acceptsClientVotes: true });
});
afterEach(() => {
  registerApprovalVoteHooks('content-publish', {});
});

let n = 0;
const seed = (policy: ApprovalPolicy): Promise<PendingApproval> => createContentApproval({
  tenantId: TENANT, orgId: ORG, pageId: `page-${++n}`, pageTitle: 'Webinar page', proposal: 'Publish the webinar page', policy,
});
const clientVote = (approvalId: string) =>
  castApprovalVote(deps, { tenantId: TENANT, decidedBy: CLIENT_ANN }, approvalId, 'approved', CLIENT_LANE);

async function refusalOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (err) {
    if (!(err instanceof OpenwopError)) throw err;
    return (err.details as { reason?: string } | undefined)?.reason ?? err.code;
  }
}

describe('ADR 0924 P2a — per-party quorum on the one ledger (C1, H1)', () => {
  it('two agency votes stay pending; the client vote on the client lane completes it', async () => {
    const appr = await seed(TWO_PARTY);
    expect((await claimApproval(deps, { tenantId: TENANT, decidedBy: ALICE }, appr.approvalId)).status).toBe('pending');
    expect((await claimApproval(deps, { tenantId: TENANT, decidedBy: BOB }, appr.approvalId)).status).toBe('pending');
    expect(finalized, 'two agency votes must not stand in for the client').toEqual([]);

    const done = await clientVote(appr.approvalId);
    expect(done.status).toBe('approved');
    expect(finalized).toEqual([appr.approvalId]);
  });

  it('a client vote is refused on a quorum row that does not name the client, and on a kind with no client lane', async () => {
    const agencyOnly = await seed({ requiredApprovals: 2, approverRefs: [ALICE, BOB] });
    expect(await refusalOf(clientVote(agencyOnly.approvalId))).toBe('not_a_party');
    expect(await listGateDecisions(agencyOnly.approvalId)).toEqual([]);

    registerApprovalVoteHooks('content-publish', {});
    const twoParty = await seed(TWO_PARTY);
    expect(await refusalOf(clientVote(twoParty.approvalId))).toBe('not_a_party');
    expect(await listGateDecisions(twoParty.approvalId)).toEqual([]);
  });
});

describe('ADR 0924 P2a — the party lives on the vote and comes from the lane (H2)', () => {
  it('a context that smuggles a party still records agency', async () => {
    const appr = await seed(TWO_PARTY);
    const smuggled = { tenantId: TENANT, decidedBy: ALICE, party: 'client', lane: CLIENT_LANE };
    expect((await claimApproval(deps, smuggled, appr.approvalId)).status).toBe('pending');
    const rows = await listGateDecisions(appr.approvalId);
    expect(rows.map((r) => ({ reviewerRef: r.reviewerRef, party: r.party }))).toEqual([{ reviewerRef: ALICE, party: 'agency' }]);
    // So the client party is still missing: a second "client" smuggle from an
    // agency member is just another agency vote.
    const smuggledBob = { ...smuggled, decidedBy: BOB };
    expect((await claimApproval(deps, smuggledBob, appr.approvalId)).status).toBe('pending');
    expect(finalized).toEqual([]);
  });

  it('erasure scrubs the client ref and keeps the party', async () => {
    const appr = await seed(TWO_PARTY);
    expect((await clientVote(appr.approvalId)).status).toBe('pending');
    expect(await eraseReviewDecisionsForSubject(TENANT, CLIENT_ANN)).toBe(1);
    const [row] = await listGateDecisions(appr.approvalId);
    expect(row).toMatchObject({ reviewerRef: ERASED_REF, party: 'client' });
    // The erased client vote still counts for the client, never as an agency vote.
    expect((await claimApproval(deps, { tenantId: TENANT, decidedBy: ALICE }, appr.approvalId)).status).toBe('approved');
  });
});

describe('ADR 0924 P2a — checks on every vote, re-checks at completion (C2, H3)', () => {
  it('the per-vote check runs on a vote that does not complete the quorum, and a refusal records nothing', async () => {
    const seen: string[] = [];
    registerApprovalVoteHooks('content-publish', {
      acceptsClientVotes: true,
      voteCheck: async (_a, ctx) => {
        seen.push(ctx.decidedBy ?? '');
        if (ctx.decidedBy === BOB) throw new OpenwopError('forbidden', 'You asked for this change.', 403, { reason: 'separation-of-duties' });
      },
    });
    const appr = await seed(TWO_PARTY);
    expect(await refusalOf(claimApproval(deps, { tenantId: TENANT, decidedBy: BOB }, appr.approvalId))).toBe('separation-of-duties');
    expect(await listGateDecisions(appr.approvalId), 'a refused first vote must not be counted').toEqual([]);
    expect((await claimApproval(deps, { tenantId: TENANT, decidedBy: ALICE }, appr.approvalId)).status).toBe('pending');
    expect(seen).toEqual([BOB, ALICE]);
  });

  it('completing the quorum drops an earlier vote that no longer holds, and the row stays pending', async () => {
    let aliceStillEligible = false;
    registerApprovalVoteHooks('content-publish', {
      acceptsClientVotes: true,
      staleVotes: async (_a, votes) => votes
        .filter((v) => v.reviewerRef === ALICE && !aliceStillEligible)
        .map((vote) => ({ vote, reason: 'not_an_approver' })),
    });
    const appr = await seed(TWO_PARTY);
    expect((await claimApproval(deps, { tenantId: TENANT, decidedBy: ALICE }, appr.approvalId)).status).toBe('pending');
    // Alice loses the right to approve before the client completes the quorum.
    const out = await clientVote(appr.approvalId);
    expect(out.status).toBe('pending');
    expect(finalized).toEqual([]);
    expect((await listGateDecisions(appr.approvalId)).map((r) => r.party)).toEqual(['client']);
    expect((await getApproval(appr.approvalId))?.status).toBe('pending');
    // Positive control: an eligible agency vote now completes it.
    aliceStillEligible = true;
    expect((await claimApproval(deps, { tenantId: TENANT, decidedBy: ALICE }, appr.approvalId)).status).toBe('approved');
    expect(finalized).toEqual([appr.approvalId]);
  });
});
