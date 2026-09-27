/**
 * ADR 0464 §2.1 — DSAR subject-eraser for the ADR 0473 auto-approve policy store.
 * A subject's created auto-approve policies are DELETED on erasure (the pair reverts
 * to manual approval), tenant-scoped, and only the erased subject's own policies go.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  setProposalAutoApprovePolicy,
  getProposalAutoApprovePolicy,
  eraseSubjectProposalPolicies,
} from '../src/host/workflowProposalPolicy.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';

const TENANT = 'org:acme';
const OTHER_TENANT = 'org:globex';
const ALICE = 'user:alice';
const BOB = 'user:bob';

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
});

describe('workflow-proposal-autoapprove subject erasure (ADR 0464 §2.1)', () => {
  it('deletes ONLY the erased subject’s policies, scoped to the tenant', async () => {
    await setProposalAutoApprovePolicy({ tenantId: TENANT, agentProfileId: 'agent-1', createdBy: ALICE });
    await setProposalAutoApprovePolicy({ tenantId: TENANT, agentProfileId: 'agent-2', createdBy: BOB });
    await setProposalAutoApprovePolicy({ tenantId: OTHER_TENANT, agentProfileId: 'agent-1', createdBy: ALICE });

    await eraseSubjectProposalPolicies(TENANT, ALICE);

    // Alice's policy in this tenant is gone; Bob's survives; Alice's OTHER-tenant policy is untouched.
    expect(await getProposalAutoApprovePolicy(TENANT, 'agent-1')).toBeNull();
    expect(await getProposalAutoApprovePolicy(TENANT, 'agent-2')).not.toBeNull();
    expect(await getProposalAutoApprovePolicy(OTHER_TENANT, 'agent-1')).not.toBeNull();
  });

  it('is a no-op for empty tenant / subject (fail-safe guard)', async () => {
    await setProposalAutoApprovePolicy({ tenantId: TENANT, agentProfileId: 'agent-3', createdBy: ALICE });
    await eraseSubjectProposalPolicies('', ALICE);
    await eraseSubjectProposalPolicies(TENANT, '');
    expect(await getProposalAutoApprovePolicy(TENANT, 'agent-3')).not.toBeNull();
  });
});
