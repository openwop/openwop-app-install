/**
 * UX_UPGRADE-assistant ROUND 2 — AST2-B1.
 *
 * Approving an assistant action SENDS A REAL MESSAGE on a shared connection.
 * `routes.ts` knows that and gates its own approve/reject on `workspace:write`,
 * with a vuln-scan comment naming the reason ("approve/reject which can trigger
 * real email sends — the surface previously gated on tenant only, so a
 * viewer-role member could act").
 *
 * That gate lived on ONE of three decide paths. The same approval is decidable
 * from `POST /approvals/:id/claim` and `POST /reviews/:id/actions/approve`, both
 * of which delegate authorization to `assertApprovalEligibility` — an OPT-IN
 * registry that is a **no-op for kinds that register nothing**. `assistant-action`
 * registered nothing, so the rule the route documents did not exist on the two
 * generic lanes: a viewer could approve an outbound send.
 *
 * This file drives the SHARED CHOKE (`assertApprovalEligibility`) rather than any
 * one route, because the defect was route↔route drift — a test bound to a single
 * route is exactly what missed it. The registration is made at boot by
 * `registerAssistantActionApproval`, so `createApp` is the wiring under test.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { __clearToggleStore } from '../src/host/featureToggles/service.js';
import { __resetAssistantStore, enqueuePendingAction, getPendingAction, listPendingActions } from '../src/features/assistant/assistantService.js';
import { fireRosterMemberDeleted } from '../src/host/rosterLifecycle.js';
import { enqueueActionWithApproval } from '../src/features/assistant/actionApproval.js';
import { assertApprovalEligibility, getApproval } from '../src/host/approvalService.js';
import { createOrg, createMember } from '../src/host/accessControlService.js';

const TENANT = 'org:assistant-authority';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  await createApp({ port: 18993, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await __clearToggleStore();
  await __resetAssistantStore();
});

/** Draft an outbound email action and return its approval row. */
async function draftedApproval() {
  const action = await enqueueActionWithApproval(TENANT, {
    kind: 'email.send',
    draft: 'Hi Dana — confirming Thursday.',
    payload: { to: ['dana@acme.test'], subject: 'Thursday' },
  });
  expect(action.approvalId, 'the action should be back-linked to its approval').toBeTruthy();
  const approval = await getApproval(action.approvalId!);
  expect(approval).toBeTruthy();
  return approval!;
}

describe('AST2-B1 — deciding an assistant action needs write authority on EVERY path', () => {
  it('refuses a member with read-only scopes', async () => {
    const org = await createOrg({ tenantId: TENANT, name: 'Acme', createdBy: 'u:owner' });
    await createMember({ tenantId: TENANT, orgId: org.orgId, subject: 'u:viewer', displayName: 'V', roles: ['viewer'] });
    const approval = await draftedApproval();

    // The generic lanes call exactly this before dispatching. Before the fix it
    // returned silently for `assistant-action` and the send went out.
    await expect(assertApprovalEligibility(TENANT, 'u:viewer', approval))
      .rejects.toMatchObject({ code: 'forbidden_scope' });
  });

  it('refuses a decider with no identity at all', async () => {
    const approval = await draftedApproval();
    await expect(assertApprovalEligibility(TENANT, undefined, approval))
      .rejects.toMatchObject({ code: 'forbidden_scope' });
  });

  it('ALLOWS a member who holds workspace:write (the negative control)', async () => {
    // Without this arm, the two above are satisfied by a check that refuses
    // everyone — which would break every legitimate approval instead of the
    // illegitimate ones.
    const org = await createOrg({ tenantId: TENANT, name: 'Acme2', createdBy: 'u:owner' });
    await createMember({ tenantId: TENANT, orgId: org.orgId, subject: 'u:editor', displayName: 'E', roles: ['editor'] });
    const approval = await draftedApproval();
    await expect(assertApprovalEligibility(TENANT, 'u:editor', approval)).resolves.toBeUndefined();
  });

  it('ALLOWS the wildcard OPERATOR — the escape the routes already grant', async () => {
    // The first cut of this gate revoked it. `requireTenantScope` returns early
    // on `principal.tenants:['*']` (env API key, admin tooling, the conformance
    // harness), but an eligibility check receives a tenant and a subject, never
    // a Request — so the escape has to be THREADED. Without this arm the gate
    // silently narrows admin access instead of closing the viewer hole: the
    // opposite defect, and the existing inbox-claim test caught it in one run.
    const approval = await draftedApproval();
    await expect(assertApprovalEligibility(TENANT, 'operator-principal', approval, { isOperator: true }))
      .resolves.toBeUndefined();
    // …and the SAME subject without the operator flag is still refused, so the
    // arm above is testing the flag rather than the subject.
    await expect(assertApprovalEligibility(TENANT, 'operator-principal', approval))
      .rejects.toMatchObject({ code: 'forbidden_scope' });
  });

  it('ALLOWS the personal/anon workspace owner — threaded, because it is a REQUEST fact', async () => {
    // This arm used to read `assertApprovalEligibility(TENANT, TENANT, …)` and
    // call itself "the solo-user flow". It was VACUOUS: `tenantId === subject`
    // is a comparison across two different id namespaces and is never true for
    // any real session (anon is `anon:<sid>` vs `session:<sid>`; a bound user is
    // `user:<sha256>` vs its userId). It passed while the actual owner lane
    // 403'd — the anon sandbox user's own Approve button on /inbox was dead.
    // The owner exit is a fact about the REQUEST, so it is threaded like the
    // operator one, and asserted here as the flag it now is.
    const approval = await draftedApproval();
    await expect(assertApprovalEligibility(TENANT, 'session:anon-sid', approval, { isPersonalOwner: true }))
      .resolves.toBeUndefined();
    // …and the same subject WITHOUT the flag is still refused, so this tests the
    // flag rather than the subject.
    await expect(assertApprovalEligibility(TENANT, 'session:anon-sid', approval))
      .rejects.toMatchObject({ code: 'forbidden_scope' });
  });

  it('the ROUTES populate both request-level exits (the wiring, not the helper)', async () => {
    // Every arm above drives the helper directly, which is what let the
    // namespace mismatch hide: the helper was self-consistent and the WIRING was
    // wrong. This asserts the two flags are actually threaded from the HTTP
    // boundary, by reading the source of the decide routes — the seam a
    // helper-level test structurally cannot reach.
    const { readFileSync } = await import('node:fs');
    // COUNTS, not `toContain`. `approvals.ts` has TWO decide routes (claim and
    // reject) and `reviews.ts` one; a presence check passes while one of them
    // silently loses the threading — a sabotage probe demonstrated exactly that
    // against the first version of this assertion.
    const EXPECTED: Record<string, number> = { 'src/routes/approvals.ts': 2, 'src/routes/reviews.ts': 1 };
    const count = (hay: string, needle: string): number => hay.split(needle).length - 1;
    for (const [rel, n] of Object.entries(EXPECTED)) {
      const src = readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
      expect(count(src, 'decidedByWildcardOperator'), `${rel}: every decide route threads the operator fact`).toBe(n);
      expect(count(src, 'decidedByPersonalOwner'), `${rel}: every decide route threads the personal-owner fact`).toBe(n);
      // NOT `isSuperadmin` for the operator exit: that is strictly wider (also
      // true for any OPENWOP_SUPERADMIN_TENANTS-listed tenant), so using it
      // would let a viewer in such a workspace bypass this gate entirely.
      expect(count(src, "req.principal?.tenants?.includes('*')")).toBe(n);
    }
  });
});

describe('AST2-M2 — the roster-delete listener rejects ONLY the stranded ghosts', () => {
  it('leaves an action that never had an approval alone', async () => {
    // The first cut rejected these. Two populations have no `approvalId`:
    // the DEMO SEED (which calls `enqueuePendingAction` directly, so deleting
    // any unrelated roster member permanently emptied the demo "waiting on me"
    // queue — its re-seed guard has no status filter, so the rows never come
    // back), and a LIVE enqueue caught between writing the action and
    // back-linking its approval. Both are un-stranded; neither is this
    // listener's business.
    const orphan = await enqueuePendingAction(TENANT, {
      kind: 'email.send',
      draft: 'Seeded demo draft',
      payload: { to: ['demo@acme.test'], demo: true },
    });
    await fireRosterMemberDeleted({ tenantId: TENANT, rosterId: 'host:some-other-agent' });
    expect((await getPendingAction(TENANT, orphan.actionId))!.status).toBe('pending');
  });

  it('DOES reject an action whose approval the cascade deleted (the case it exists for)', async () => {
    // Without this arm, "leaves things alone" is satisfied by a listener that
    // does nothing at all.
    const stranded = await enqueuePendingAction(TENANT, {
      kind: 'email.send',
      draft: 'Drafted by an agent that is now gone',
      payload: { to: ['dana@acme.test'] },
    });
    const { setPendingActionApproval } = await import('../src/features/assistant/assistantService.js');
    await setPendingActionApproval(TENANT, stranded.actionId, 'appr:deleted-by-cascade');

    await fireRosterMemberDeleted({ tenantId: TENANT, rosterId: 'host:deleted-assistant' });
    expect((await getPendingAction(TENANT, stranded.actionId))!.status).toBe('rejected');
  });

  it('leaves a healthy pending action alone (the other control)', async () => {
    const live = await draftedApproval();
    const before = await listPendingActions(TENANT, 'pending');
    expect(before.some((a) => a.approvalId === live.approvalId)).toBe(true);
    await fireRosterMemberDeleted({ tenantId: TENANT, rosterId: 'host:unrelated' });
    const after = await listPendingActions(TENANT, 'pending');
    expect(after.some((a) => a.approvalId === live.approvalId)).toBe(true);
  });
});
