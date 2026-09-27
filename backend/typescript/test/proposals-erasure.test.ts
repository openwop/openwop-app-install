/**
 * PROPC-ERASURE-DSAR — the per-subject eraser for the reviewable-learning
 * proposals store (RFC 0096).
 *
 * `owner.principal` is NOT an opaque service principal: the one real producer
 * (the ambient-work-graph `accept` route) writes `user.userId`, exactly the key
 * `eraseSubject` is called with on user deletion. Before the fix, `features/
 * proposals` registered ZERO erasers, so a member's DSAR left their
 * `owner.principal` on every proposal they had accepted (whole-tenant teardown
 * was covered by the `tenantOf`, the per-subject case was not).
 *
 * The cases assert the SPLIT (the assistant-erasure precedent), not a blanket
 * sweep: the subject's attribution is REDACTED and the row is KEPT (a proposal is
 * org work-content an `apply` can install). Both halves are asserted — what went
 * (owner.principal → `erased:subject`) and what stayed (the row, its artifact,
 * another subject's proposals, and other tenants). Born-red: without the eraser
 * registration the redaction never happens and `owner.principal` survives.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { __clearToggleStore } from '../src/host/featureToggles/service.js';
import { putProposal, getProposal, listProposals } from '../src/features/proposals/proposalsService.js';
import { eraseSubjectProposals } from '../src/features/proposals/erasure.js';
import { eraseSubject } from '../src/host/subjectErasure.js';
import type { Proposal } from '../src/features/proposals/types.js';

const ERASED = 'erased:subject';

const mkProposal = (id: string, tenant: string, principal: string | undefined): Proposal => ({
  id,
  kind: 'workflow-chain-pack',
  state: 'draft',
  title: 'Automate a recurring pattern',
  artifact: { toolSequence: ['search', 'summarize'], occurrences: 3 },
  provenance: { sourceRunIds: ['run-1', 'run-2'] },
  owner: { tenant, ...(principal ? { principal } : {}) },
  createdAt: '2026-01-01T00:00:00.000Z',
});

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  await createApp({ port: 18994, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await __clearToggleStore();
});

// Unique tenant per test keeps the shared memory store's prefix scans isolated.
let n = 0;
const freshTenant = (): string => `t-propc-${n++}`;

describe('PROPC-ERASURE-DSAR — proposals subject erasure', () => {
  it('REDACTS owner.principal to the tombstone and KEEPS the row (via the registered eraseSubject fan-out)', async () => {
    const tenant = freshTenant();
    const subject = 'user:alice';
    await putProposal(mkProposal('p1', tenant, subject));

    // The HOST seam — proves the eraser is REGISTERED (feature.ts imports erasure.ts),
    // not merely that the function works.
    await eraseSubject(tenant, subject);

    const after = await getProposal(tenant, 'p1');
    expect(after, 'the row is KEPT, not deleted (a proposal is org work-content)').not.toBeNull();
    expect(after!.owner.principal, 'the subject attribution is tombstoned').toBe(ERASED);
    // What STAYED: the artifact (org content) and the row identity.
    expect(after!.artifact).toEqual({ toolSequence: ['search', 'summarize'], occurrences: 3 });
    expect(after!.provenance.sourceRunIds).toEqual(['run-1', 'run-2']);
  });

  it('leaves ANOTHER subject’s proposal untouched (scoped, not a sweep)', async () => {
    const tenant = freshTenant();
    await putProposal(mkProposal('p-alice', tenant, 'user:alice'));
    await putProposal(mkProposal('p-bob', tenant, 'user:bob'));

    const report = await eraseSubjectProposals(tenant, 'user:alice');

    expect(report.rowsTouched, 'exactly the one matching proposal').toBe(1);
    expect((await getProposal(tenant, 'p-alice'))!.owner.principal).toBe(ERASED);
    expect((await getProposal(tenant, 'p-bob'))!.owner.principal, 'bob’s proposal is untouched').toBe('user:bob');
  });

  it('is tenant-scoped — the same principal string in another tenant is untouched', async () => {
    const tenant = freshTenant();
    const other = freshTenant();
    const subject = 'user:carol';
    await putProposal(mkProposal('p-here', tenant, subject));
    await putProposal(mkProposal('p-there', other, subject));

    await eraseSubjectProposals(tenant, subject);

    expect((await getProposal(tenant, 'p-here'))!.owner.principal).toBe(ERASED);
    expect((await getProposal(other, 'p-there'))!.owner.principal, 'a co-named subject in another tenant is not reached').toBe(subject);
  });

  it('is idempotent — a re-run matches nothing and reports rowsTouched 0', async () => {
    const tenant = freshTenant();
    await putProposal(mkProposal('p1', tenant, 'user:dana'));

    expect((await eraseSubjectProposals(tenant, 'user:dana')).rowsTouched).toBe(1);
    expect((await eraseSubjectProposals(tenant, 'user:dana')).rowsTouched, 'already tombstoned → no re-match').toBe(0);
    // And the store still holds the (now-tombstoned) row.
    expect((await listProposals(tenant)).length).toBe(1);
  });

  it('fail-closed — an empty subjectKey is never a tenant-wide sweep', async () => {
    const tenant = freshTenant();
    await putProposal(mkProposal('p1', tenant, 'user:erin'));

    expect((await eraseSubjectProposals(tenant, '')).rowsTouched).toBe(0);
    expect((await getProposal(tenant, 'p1'))!.owner.principal, 'nothing erased on an empty key').toBe('user:erin');
  });
});
