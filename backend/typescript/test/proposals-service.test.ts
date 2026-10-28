/**
 * Reviewable-learning proposals SERVICE-layer coverage (RFC 0096, ADR 0938),
 * driven against an in-memory sqlite `DurableCollection` (grade-code FEAT-4).
 * The HTTP files (`proposals.test.ts`, `proposals-r2-probes.test.ts`,
 * `proposals-mutation-authority.test.ts`) cover the routes; this file is the home
 * of the service rules themselves:
 *   - ADR 0938 D4 — one transition table, every write a CAS on the row read with
 *     a per-row `revision`; refusals are `proposal_state_conflict` / `proposal_stale`.
 *   - ADR 0938 D5 — apply binds to BOTH the `revision` and the `artifactDigest`
 *     the reviewer saw; the digest is sha256 over RFC 8785 JCS bytes (pinned to a
 *     literal computed outside the product, `shasum -a 256`).
 *   - ADR 0938 D1 — apply installs only through a registered installer, handing it
 *     the stored bytes verbatim (`proposal-no-resynthesis`).
 *   - ADR 0938 D8 — the seeded demo row is never served.
 *   - Tenant isolation is a DOUBLE guard: the tenant-prefixed key / prefix scan AND
 *     the `owner.tenant === tenant` re-check. Removing either alone is invisible
 *     (8fw5g6-pgp-owner-guard-only, vacuous by design: a row's key is derived from
 *     `owner.tenant`); 8fw5g6-pgp-list-both-cov / -get-unpartitioned-cov remove both.
 *     This case absorbed `prop-grade-probe.test.ts` PROPP-1 (/grade-tests 8f W5).
 * Sabotages witnessed (/grade-tests 8f W5): each transition-table row opened, the
 * CAS made a blind put, the stated-revision check dropped, a fake installer, a
 * resynthesised artifact, either half of the apply binding dropped, a constant or
 * insertion-order digest, and either demo-row filter dropped.
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
  registerProposalInstaller,
  artifactDigestOf,
  DEMO_PROPOSAL_ID,
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
  beforeEach(async () => {
    initHostExtPersistence(openSqliteStorage(':memory:'));
    await __test.collection.__clear();
  });

  afterEach(() => {
    __test.installers.clear();
  });

  const load = async (tenant: string, id: string): Promise<Proposal> => {
    const p = await getProposal(tenant, id);
    expect(p).not.toBeNull();
    return p!;
  };
  const seen = (p: Proposal) => ({ revision: p.revision ?? 0, artifactDigest: artifactDigestOf(p.artifact) });

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
    expect((await getProposal(TENANT_A, 'p1'))?.owner.tenant).toBe(TENANT_A); // A reads its own (positive control)
    expect((await listProposals(TENANT_A)).map((p) => p.id)).toEqual(['p1']);
    expect(await getProposal(TENANT_B, 'p1')).toBeNull();
    expect(await listProposals(TENANT_B)).toHaveLength(0);
  });

  it('reviseProposal edits a draft → revised, bumps the revision, never activates; applied is terminal (409)', async () => {
    await putProposal(draft(TENANT_A, 'p1'));
    const revised = await reviseProposal(await load(TENANT_A, 'p1'), { title: 'Tighter', rationale: 'why' });
    expect(revised.state).toBe('revised');
    expect(revised.title).toBe('Tighter');
    expect(revised.rationale).toBe('why');
    expect(revised.revision).toBe(1);
    expect(revised.activation).toBeUndefined();

    await putProposal(draft(TENANT_A, 'p2', { state: 'applied', activation: { approvalId: null, installedArtifactRef: 'ref' } }));
    await expect(reviseProposal(await load(TENANT_A, 'p2'), { title: 'no' })).rejects.toMatchObject({
      httpStatus: 409, details: { reason: 'proposal_state_conflict', state: 'applied', action: 'revise' },
    });
    expect((await load(TENANT_A, 'p2')).title).not.toBe('no');
  });

  it('reject and archive transition state; rejected may only be archived', async () => {
    await putProposal(draft(TENANT_A, 'p1'));
    expect((await rejectProposal(await load(TENANT_A, 'p1'))).state).toBe('rejected');
    await expect(reviseProposal(await load(TENANT_A, 'p1'), { title: 'x' })).rejects.toMatchObject({
      httpStatus: 409, details: { reason: 'proposal_state_conflict', state: 'rejected', action: 'revise' },
    });
    expect((await archiveProposal(await load(TENANT_A, 'p1'))).state).toBe('archived');
    await expect(archiveProposal(await load(TENANT_A, 'p1'))).rejects.toMatchObject({
      httpStatus: 409, details: { reason: 'proposal_state_conflict', state: 'archived', action: 'archive' },
    });
  });

  it('a write over a row someone else changed is refused (CAS), and a stated revision must match', async () => {
    await putProposal(draft(TENANT_A, 'p1'));
    const read = await load(TENANT_A, 'p1');
    await reviseProposal(read, { title: 'first' });
    await expect(rejectProposal(read)).rejects.toMatchObject({ httpStatus: 409, details: { reason: 'proposal_stale', revision: 1 } }); // stale row
    await expect(rejectProposal(await load(TENANT_A, 'p1'), 0)).rejects.toMatchObject({ httpStatus: 409, details: { reason: 'proposal_stale', revision: 1 } }); // stale revision
    expect((await load(TENANT_A, 'p1')).state).toBe('revised');
  });

  it('applyProposal with no installer for the kind refuses and changes nothing (ADR 0938 D1)', async () => {
    await putProposal(draft(TENANT_A, 'p1'));
    const p = await load(TENANT_A, 'p1');
    await expect(applyProposal(p, seen(p))).rejects.toMatchObject({ httpStatus: 409, details: { reason: 'proposal_not_installable' } });
    const after = await load(TENANT_A, 'p1');
    expect(after.state).toBe('draft');
    expect(after.activation).toBeUndefined();
  });

  it('applyProposal installs the stored bytes verbatim through the registered installer', async () => {
    const handed: Array<Record<string, unknown>> = [];
    registerProposalInstaller('prompt-template', {
      async install(_t, prop) { handed.push(prop.artifact); return { installedArtifactRef: 'tmpl:1' }; },
    });
    await putProposal(draft(TENANT_A, 'p1'));
    const p = await load(TENANT_A, 'p1');
    const res = await applyProposal(p, seen(p));
    expect(res.installedArtifactRef).toBe('tmpl:1');
    expect(handed).toEqual([p.artifact]); // proposal-no-resynthesis: the stored bytes, unchanged
    const reread = await load(TENANT_A, 'p1');
    expect(reread.state).toBe('applied');
    expect(reread.activation).toEqual({ approvalId: null, installedArtifactRef: 'tmpl:1' });
    await expect(applyProposal(reread, seen(reread))).rejects.toMatchObject({
      httpStatus: 409, details: { reason: 'proposal_state_conflict', state: 'applied', action: 'apply' },
    }); // terminal
  });

  it('applyProposal bound to a stale digest is refused before the installer runs', async () => {
    let calls = 0;
    registerProposalInstaller('prompt-template', { async install() { calls += 1; return { installedArtifactRef: 'x' }; } });
    await putProposal(draft(TENANT_A, 'p1'));
    const p = await load(TENANT_A, 'p1');
    await expect(applyProposal(p, { revision: 0, artifactDigest: 'not-it' })).rejects.toMatchObject({ details: { reason: 'proposal_stale' } });
    expect(calls).toBe(0);
  });

  it('applyProposal bound to a stale REVISION is refused even when the artifact is unchanged (ADR 0938 D5)', async () => {
    // A title-only revise moves `revision` and leaves `artifactDigest` alone, so only
    // the revision half of the binding can refuse an apply of what the reviewer did
    // not see (8fw5g6-svc-bind-no-revision was vacuous before this case).
    let calls = 0;
    registerProposalInstaller('prompt-template', { async install() { calls += 1; return { installedArtifactRef: 'x' }; } });
    await putProposal(draft(TENANT_A, 'p1'));
    const sawAtN = seen(await load(TENANT_A, 'p1'));
    expect(sawAtN.revision).toBe(0);
    const atN1 = await reviseProposal(await load(TENANT_A, 'p1'), { title: 'Retitled after the review' });
    expect(atN1.revision).toBe(1);
    expect(artifactDigestOf(atN1.artifact)).toBe(sawAtN.artifactDigest); // the artifact did not move
    await expect(applyProposal(await load(TENANT_A, 'p1'), sawAtN)).rejects.toMatchObject({
      httpStatus: 409, details: { reason: 'proposal_stale', revision: 1 },
    });
    expect(calls).toBe(0);
    expect((await load(TENANT_A, 'p1')).state).toBe('revised');
  });

  it('the digest ignores key order (ADR 0938 A3)', () => {
    expect(artifactDigestOf({ a: 1, b: { c: 2, d: 3 } })).toBe(artifactDigestOf({ b: { d: 3, c: 2 }, a: 1 }));
    // The literal is sha256 of the JCS bytes `{"a":1,"b":{"c":2,"d":3}}`, computed
    // OUTSIDE the product (`printf '%s' '{"a":1,"b":{"c":2,"d":3}}' | shasum -a 256`),
    // so a digest that ignores its input (one constant for every artifact) is red. The
    // `sha256:` prefix is the RFC 0249 form (ADR 0972 D7).
    expect(artifactDigestOf({ b: { d: 3, c: 2 }, a: 1 })).toBe('sha256:932875ab5b23eb47bb2711f951d85ba23eef4b50c3e2eb6b5f3f9b9ac1217c6b');
    expect(artifactDigestOf({ a: 2, b: { c: 2, d: 3 } })).not.toBe('sha256:932875ab5b23eb47bb2711f951d85ba23eef4b50c3e2eb6b5f3f9b9ac1217c6b');
  });

  it('the seeded demo row is never served (ADR 0938 D8)', async () => {
    await putProposal(draft(TENANT_A, DEMO_PROPOSAL_ID));
    expect(await getProposal(TENANT_A, DEMO_PROPOSAL_ID)).toBeNull();
    expect(await listProposals(TENANT_A)).toEqual([]);
  });
});
