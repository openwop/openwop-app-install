/**
 * Reviewable-learning proposals SERVICE-layer coverage (RFC 0096) — fills the
 * grade-code FEAT-4 gap: the existing `proposals.test.ts` boots the full HTTP
 * app and focuses on the `proposal-no-resynthesis` invariant; the pure service
 * CRUD, the tenant-prefixed scan, the lifecycle transitions, and the cross-tenant
 * read guard were never unit-tested directly. This drives `proposalsService`
 * against an in-memory sqlite `DurableCollection`.
 *
 * Activation is pinned to `direct-rbac` (the default), so `applyProposal`
 * installs inline and never reaches `createApproval` — the test stays pure.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  listProposals,
  getProposal,
  reviseProposal,
  rejectProposal,
  archiveProposal,
  applyProposal,
  putProposal,
  MalformedForKindError,
  __test,
} from '../src/features/proposals/proposalsService.js';
import type { Proposal } from '../src/features/proposals/types.js';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

const draft = (tenant: string, id: string, overrides: Partial<Proposal> = {}): Proposal => ({
  id,
  kind: 'prompt-template',
  state: 'draft',
  title: 'Tighten the weekly-summary prompt',
  artifact: { template: 'Summarize {{week}} in <=5 bullets.', variables: ['week'] },
  provenance: { sourceRunIds: ['run-1'] },
  duplicateOf: null,
  owner: { tenant },
  createdAt: new Date().toISOString(),
  ...overrides,
});

describe('proposalsService (service layer, in-memory durable)', () => {
  const prevActivation = process.env.OPENWOP_PROPOSALS_ACTIVATION;

  beforeEach(async () => {
    process.env.OPENWOP_PROPOSALS_ACTIVATION = 'direct-rbac';
    initHostExtPersistence(openSqliteStorage(':memory:'));
    await __test.collection.__clear();
  });

  afterEach(() => {
    if (prevActivation === undefined) delete process.env.OPENWOP_PROPOSALS_ACTIVATION;
    else process.env.OPENWOP_PROPOSALS_ACTIVATION = prevActivation;
  });

  it('putProposal → getProposal round-trips the inert record', async () => {
    await putProposal(draft(TENANT_A, 'p1'));
    const got = await getProposal(TENANT_A, 'p1');
    expect(got).not.toBeNull();
    expect(got!.state).toBe('draft');
    expect(got!.kind).toBe('prompt-template');
    expect(got!.activation).toBeUndefined(); // inert-until-applied
  });

  it('listProposals returns only the tenant slice and filters by state/kind', async () => {
    await putProposal(draft(TENANT_A, 'p1'));
    await putProposal(draft(TENANT_A, 'p2', { kind: 'automation' }));
    await putProposal(draft(TENANT_B, 'p3')); // foreign tenant

    const all = await listProposals(TENANT_A);
    expect(all.map((p) => p.id).sort()).toEqual(['p1', 'p2']);
    expect(all.every((p) => p.owner.tenant === TENANT_A)).toBe(true);

    expect((await listProposals(TENANT_A, { kind: 'automation' })).map((p) => p.id)).toEqual(['p2']);
    expect((await listProposals(TENANT_A, { state: 'draft' })).map((p) => p.id).sort()).toEqual(['p1', 'p2']);
  });

  it('tenant isolation: tenant B cannot read tenant A\'s proposal', async () => {
    await putProposal(draft(TENANT_A, 'p1'));
    expect(await getProposal(TENANT_B, 'p1')).toBeNull();
    expect(await listProposals(TENANT_B)).toHaveLength(0);
  });

  it('reviseProposal edits a draft → revised but never activates; terminal states are no-ops', async () => {
    await putProposal(draft(TENANT_A, 'p1'));
    const revised = await reviseProposal(TENANT_A, 'p1', { title: 'Tighter', rationale: 'why' });
    expect(revised!.state).toBe('revised');
    expect(revised!.title).toBe('Tighter');
    expect(revised!.rationale).toBe('why');
    expect(revised!.activation).toBeUndefined();

    // an applied proposal is terminal — revise is a no-op that returns it unchanged
    await putProposal(draft(TENANT_A, 'p2', { state: 'applied', activation: { approvalId: null, installedArtifactRef: 'ref' } }));
    const noop = await reviseProposal(TENANT_A, 'p2', { title: 'no' });
    expect(noop!.state).toBe('applied');
    expect(noop!.title).not.toBe('no');
  });

  it('reject and archive transition state; foreign tenant → null', async () => {
    await putProposal(draft(TENANT_A, 'p1'));
    expect((await rejectProposal(TENANT_A, 'p1'))!.state).toBe('rejected');
    await putProposal(draft(TENANT_A, 'p2'));
    expect((await archiveProposal(TENANT_A, 'p2'))!.state).toBe('archived');

    expect(await rejectProposal(TENANT_B, 'p1')).toBeNull();
    expect(await archiveProposal(TENANT_B, 'p2')).toBeNull();
  });

  it('applyProposal (direct-rbac) installs the stored bytes verbatim and is deterministic', async () => {
    await putProposal(draft(TENANT_A, 'p1'));
    const res = await applyProposal(TENANT_A, 'p1');
    expect(res).not.toBeNull();
    expect(res!.proposal.state).toBe('applied');
    expect(res!.pendingApprovalId).toBeUndefined(); // no approval gate
    expect(res!.installedArtifactRef).toMatch(/^installed:prompt-template:p1:/);

    // proposal-no-resynthesis: re-applying the same stored bytes yields the same ref
    const again = await applyProposal(TENANT_A, 'p1');
    expect(again!.installedArtifactRef).toBe(res!.installedArtifactRef);

    // and the applied state is persisted
    const reread = await getProposal(TENANT_A, 'p1');
    expect(reread!.state).toBe('applied');
    expect(reread!.activation!.installedArtifactRef).toBe(res!.installedArtifactRef);
  });

  it('applyProposal rejects a malformed artifact for its kind', async () => {
    await putProposal(draft(TENANT_A, 'bad', { artifact: {} })); // empty artifact
    await expect(applyProposal(TENANT_A, 'bad')).rejects.toBeInstanceOf(MalformedForKindError);
  });

  it('applyProposal on a missing id returns null', async () => {
    expect(await applyProposal(TENANT_A, 'nope')).toBeNull();
  });
});
