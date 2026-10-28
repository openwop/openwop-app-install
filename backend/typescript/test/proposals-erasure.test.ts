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
 * another subject's proposals, and other tenants).
 *
 * What each case can and cannot prove (/grade-tests 8f W5 probes):
 *   - case 1 runs the HOST fan-out (`eraseSubject`) and red if the eraser is not
 *     registered (8fw5g6-er-unregistered). It does NOT prove `feature.ts` imports
 *     `erasure.ts`: this file imports `erasure.js` itself, which registers on load.
 *     That wiring is `subject-eraser-manifest.test.ts` › "nothing in the manifest
 *     is missing after createApp()" (8fw5g6-er-feature-import-cov).
 *   - the service writes and the eraser reads/CASes through two `DurableCollection`
 *     declarations; cases 1–4 red if their namespace or key drift apart
 *     (8fw5g6-er-namespace-drift) — the "two declarations stay identical" property
 *     `erasure.ts:47` cites.
 *   - tenant scoping is a double guard (the tenant-exact prefix scan + the defensive
 *     `owner.tenant` break); with the scan widened, the break leaves the foreign row
 *     unerased and the PROP2CD-4 exhaustion report THROWS, so the case reds loudly
 *     (8fw5g6-er-tenant-prefix-only, witnessed that way).
 *   - fail-closed: the empty-key return is reachable only for a stored principal
 *     of `''` (any other principal fails the `!== subjectKey` match first), so the
 *     case stores one (8fw5g6-er-empty-key-r2).
 *   - ADR 0938 D9: a revise landing between the eraser's scan and its write
 *     survives (8fw5g6-er-blind-put, -er-no-reread).
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { __clearToggleStore } from '../src/host/featureToggles/service.js';
import { DurableCollection } from '../src/host/hostExtPersistence.js';
import { putProposal, getProposal, listProposals, reviseProposal } from '../src/features/proposals/proposalsService.js';
import { eraseSubjectProposals } from '../src/features/proposals/erasure.js';
import { eraseSubject, registeredSubjectEraserIds } from '../src/host/subjectErasure.js';
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

    // The HOST seam: the fan-out reaches the proposals eraser (it is registered and
    // did not fail). The feature.ts wiring is subject-eraser-manifest's claim.
    expect(registeredSubjectEraserIds()).toContain('eraseSubjectProposals');
    const result = await eraseSubject(tenant, subject);
    expect(result.failedFeatures).not.toContain('eraseSubjectProposals');
    expect(result.missing).not.toContain('eraseSubjectProposals');

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
    // A stored principal of '' is the one row an empty key would MATCH, so only the
    // early return protects it (mkProposal omits a falsy principal, hence the literal).
    const blank: Proposal = { ...mkProposal('p-blank', tenant, undefined), owner: { tenant, principal: '' } };
    await putProposal(blank);

    expect((await eraseSubjectProposals(tenant, '')).rowsTouched).toBe(0);
    expect((await getProposal(tenant, 'p1'))!.owner.principal, 'nothing erased on an empty key').toBe('user:erin');
    expect((await getProposal(tenant, 'p-blank'))!.owner.principal, 'an empty key matched an empty principal').toBe('');
  });
});

describe('ADR 0938 D9 — the eraser writes by CAS, so it cannot overwrite a concurrent revise', () => {
  it('a revise that lands between the eraser\'s scan and its write survives, and the principal is still erased', async () => {
    const tenant = 'tenant-d9';
    const base: Proposal = {
      id: 'd9-1', kind: 'prompt-template', state: 'draft', title: 'Before',
      artifact: { template: 'x' }, provenance: { sourceRunIds: ['r1'] }, duplicateOf: null,
      owner: { tenant, principal: 'user:d9-subject' }, createdAt: new Date().toISOString(),
    };
    await putProposal(base);
    const snapshot = (await getProposal(tenant, 'd9-1'))!;
    // The revise lands AFTER the eraser's scan read `snapshot`.
    await reviseProposal(snapshot, { title: 'Revised concurrently' });
    const spy = vi.spyOn(DurableCollection.prototype, 'listByPrefix').mockResolvedValueOnce([snapshot]);
    try {
      const report = await eraseSubjectProposals(tenant, 'user:d9-subject');
      expect(report.rowsTouched).toBe(1);
    } finally {
      spy.mockRestore();
    }
    const after = (await getProposal(tenant, 'd9-1'))!;
    expect(after.title, 'the eraser overwrote a concurrent revise').toBe('Revised concurrently');
    expect(after.owner.principal).toBe('erased:subject');
    expect(after.revision, 'the retry CASed on the RE-READ row (revise → 1, erasure → 2)').toBe(2);
  });
});
