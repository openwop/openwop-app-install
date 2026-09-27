/**
 * Strategy governance wiring (ADR 0230) — ROUTE harness over the real app:
 *   - gate OFF ⇒ PATCH draft→active transitions directly (byte-identical posture)
 *   - gate ON ⇒ activation is intercepted: strategy stays draft,
 *     `activationPending: true` projected, a `strategy-activation` approval
 *     queued in the SHARED approvals inbox; claim → active; reject → draft
 *   - mixed patch (title + status) applies the other fields, queues activation
 *   - protected-field edit on an ACTIVE strategy auto-reverts to draft (visible)
 *   - a decider without `host:members:manage` in the strategy's org gets 403
 *   - versions (§B4): revisions append with dedupe; content-only restore
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootPlanningApp, makeClient, enableToggle, uniqEmail, type Client } from './planningHarness.js';

let BASE = '';
let closeApp: () => Promise<void>;
let n = 0;

beforeAll(async () => {
  const h = await bootPlanningApp(); BASE = h.base; closeApp = h.close;
  await enableToggle('strategy', 'on');
});
afterAll(async () => { await closeApp(); });

const client = (): Client => makeClient(() => BASE);

async function signup(c: Client, tenantId: string): Promise<{ userId: string }> {
  const r = await c.post('/v1/host/openwop-app/test/login', { email: uniqEmail('gov'), tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}
const setToggle = (id: string, status: 'on' | 'off'): Promise<void> => enableToggle(id, status);

const S = '/v1/host/openwop-app/strategy';
const APPROVALS = '/v1/host/openwop-app/approvals';
const freshTenant = (): string => `org:gov-${Date.now()}-${n++}`;

async function ownerWithOrg(tenantId: string): Promise<{ owner: Client; userId: string; orgId: string }> {
  const owner = client();
  const u = await signup(owner, tenantId);
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, userId: u.userId, orgId: org.body.orgId };
}

/** Find the pending strategy-activation approval for a strategy in the caller's inbox. */
async function pendingActivation(c: Client, strategyId: string): Promise<any | undefined> {
  const inbox = await c.get(`${APPROVALS}?status=pending`);
  expect(inbox.status).toBe(200);
  return (inbox.body.items as any[]).find((a) => a.kind === 'strategy-activation' && a.strategyId === strategyId);
}

describe('strategy activation gate (ADR 0230 §B3)', () => {
  it('gate OFF ⇒ PATCH draft→active transitions directly, no approval queued', async () => {
    const { owner, orgId } = await ownerWithOrg(freshTenant());
    await setToggle('strategy-approval-gate', 'off');
    const s = (await owner.post(S, { orgId, title: 'Direct' })).body;
    const r = await owner.patch(`${S}/${s.id}`, { status: 'active' });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('active');
    expect(r.body.activationPending).toBeUndefined();
    expect(await pendingActivation(owner, s.id)).toBeUndefined();
  });

  it('gate ON ⇒ activation intercepted + queued; claim activates; mixed patch applies other fields', async () => {
    const { owner, orgId } = await ownerWithOrg(freshTenant());
    await setToggle('strategy-approval-gate', 'on');
    try {
      const s = (await owner.post(S, { orgId, title: 'Gated' })).body;

      // Mixed patch: the title applies; status stays draft; approval queued.
      const r = await owner.patch(`${S}/${s.id}`, { title: 'Gated v2', status: 'active' });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
      expect(r.body.title).toBe('Gated v2');
      expect(r.body.status).toBe('draft');
      expect(r.body.activationPending).toBe(true);

      // The projection also rides GET /:id.
      const got = await owner.get(`${S}/${s.id}`);
      expect(got.body.activationPending).toBe(true);

      // A second activation PATCH does not queue a duplicate.
      await owner.patch(`${S}/${s.id}`, { status: 'active' });
      const inbox = await owner.get(`${APPROVALS}?status=pending`);
      const mine = (inbox.body.items as any[]).filter((a: any) => a.kind === 'strategy-activation' && a.strategyId === s.id);
      expect(mine).toHaveLength(1);

      // The org owner (host:members:manage) claims → the strategy activates.
      const appr = await pendingActivation(owner, s.id);
      expect(appr).toBeTruthy();
      const claim = await owner.post(`${APPROVALS}/${appr.approvalId}/claim`);
      expect(claim.status, JSON.stringify(claim.body)).toBe(200);
      const after = await owner.get(`${S}/${s.id}`);
      expect(after.body.status).toBe('active');
      expect(after.body.activationPending).toBeUndefined();
    } finally {
      await setToggle('strategy-approval-gate', 'off');
    }
  });

  it('gate ON ⇒ reject leaves the strategy draft and consumes the approval', async () => {
    const { owner, orgId } = await ownerWithOrg(freshTenant());
    await setToggle('strategy-approval-gate', 'on');
    try {
      const s = (await owner.post(S, { orgId, title: 'Rejected bet' })).body;
      await owner.patch(`${S}/${s.id}`, { status: 'active' });
      const appr = await pendingActivation(owner, s.id);
      expect(appr).toBeTruthy();
      const rej = await owner.post(`${APPROVALS}/${appr.approvalId}/reject`);
      expect(rej.status, JSON.stringify(rej.body)).toBe(200);
      const after = await owner.get(`${S}/${s.id}`);
      expect(after.body.status).toBe('draft');
      expect(await pendingActivation(owner, s.id)).toBeUndefined();
      // Re-requesting activation re-queues a fresh approval.
      await owner.patch(`${S}/${s.id}`, { status: 'active' });
      expect(await pendingActivation(owner, s.id)).toBeTruthy();
    } finally {
      await setToggle('strategy-approval-gate', 'off');
    }
  });

  // SGC-1 (regression guard) — a REJECT must not be a zero-emission outcome. The
  // resolved approval row is the durable record SGU-1's provenance surface reads
  // ("Rejected by X on T"); a reject that consumes the approval but records NO
  // decider/timestamp would leave the gate accountable-in-name-only. Guards the
  // reject arm specifically (the approve arm stamps the same fields).
  it('gate ON ⇒ reject records its decision outcome (decidedBy + resolvedAt) on the durable row', async () => {
    const { owner, userId, orgId } = await ownerWithOrg(freshTenant());
    await setToggle('strategy-approval-gate', 'on');
    try {
      const s = (await owner.post(S, { orgId, title: 'Accountable reject' })).body;
      await owner.patch(`${S}/${s.id}`, { status: 'active' });
      const appr = await pendingActivation(owner, s.id);
      expect(appr).toBeTruthy();
      const rej = await owner.post(`${APPROVALS}/${appr.approvalId}/reject`);
      expect(rej.status, JSON.stringify(rej.body)).toBe(200);

      // The decision must surface on the resolved-rejected list with WHO + WHEN.
      const rejected = await owner.get(`${APPROVALS}?status=rejected`);
      expect(rejected.status).toBe(200);
      const row = (rejected.body.items as any[]).find(
        (a: any) => a.kind === 'strategy-activation' && a.strategyId === s.id,
      );
      expect(row, 'rejected strategy-activation must be listable').toBeTruthy();
      expect(row.status).toBe('rejected');
      expect(row.decidedBy, 'reject must record the deciding subject').toBe(userId);
      expect(typeof row.resolvedAt).toBe('string');
      expect(Number.isNaN(Date.parse(row.resolvedAt))).toBe(false);
    } finally {
      await setToggle('strategy-approval-gate', 'off');
    }
  });

  // SGU-1 (review finding 1) — the decided-history provenance group reads via a
  // BOUNDED `?kind=&limit=` narrowing so it never pulls the tenant's whole
  // all-kinds history. Guard the route's new params.
  it('approvals list narrows by kind and caps by limit', async () => {
    const { owner, orgId } = await ownerWithOrg(freshTenant());
    await setToggle('strategy-approval-gate', 'on');
    try {
      const s = (await owner.post(S, { orgId, title: 'Narrowable' })).body;
      await owner.patch(`${S}/${s.id}`, { status: 'active' });
      const appr = await pendingActivation(owner, s.id);
      await owner.post(`${APPROVALS}/${appr.approvalId}/reject`);

      // kind filter: strategy-activation returns the row; a different kind excludes it.
      const sa = await owner.get(`${APPROVALS}?kind=strategy-activation`);
      expect(sa.status).toBe(200);
      expect((sa.body.items as any[]).every((a) => a.kind === 'strategy-activation')).toBe(true);
      expect((sa.body.items as any[]).some((a) => a.strategyId === s.id)).toBe(true);
      const cs = await owner.get(`${APPROVALS}?kind=commerce-spend`);
      expect((cs.body.items as any[]).some((a) => a.strategyId === s.id)).toBe(false);

      // limit caps the returned count.
      const capped = await owner.get(`${APPROVALS}?kind=strategy-activation&limit=1`);
      expect((capped.body.items as any[]).length).toBeLessThanOrEqual(1);
    } finally {
      await setToggle('strategy-approval-gate', 'off');
    }
  });

  it('gate ON ⇒ a protected-field edit on an ACTIVE strategy auto-reverts to draft (visible)', async () => {
    const { owner, orgId } = await ownerWithOrg(freshTenant());
    // Activate while the gate is OFF, then turn it ON.
    await setToggle('strategy-approval-gate', 'off');
    const s = (await owner.post(S, { orgId, title: 'Live plan', objectives: [{ title: 'O1', keyResults: [] }] })).body;
    await owner.patch(`${S}/${s.id}`, { status: 'active' });
    await setToggle('strategy-approval-gate', 'on');
    try {
      const r = await owner.patch(`${S}/${s.id}`, { objectives: [{ title: 'O1 rewritten', keyResults: [] }] });
      expect(r.status).toBe(200);
      expect(r.body.status).toBe('draft'); // auto-reverted, visible in the response
      expect(r.body.objectives[0].title).toBe('O1 rewritten');
      // A NON-protected edit does not revert.
      await owner.patch(`${S}/${s.id}`, { status: 'active' });
      const appr = await pendingActivation(owner, s.id);
      await owner.post(`${APPROVALS}/${appr.approvalId}/claim`);
      const r2 = await owner.patch(`${S}/${s.id}`, { summary: 'harmless note' });
      expect(r2.body.status).toBe('active');
    } finally {
      await setToggle('strategy-approval-gate', 'off');
    }
  });

  /**
   * SPC-5 / ADR 0597 §3. The gate shipped keyed on two hand-picked TRANSITIONS
   * (`draft → active`, and a protected edit while `s.status === 'active'`).
   * `paused` matched NEITHER, so this exact three-PATCH sequence rewrote every
   * protected field of a live, approved strategy and put it back live with no
   * approval, no `autoRevertedToDraft` marker, and no audit flag. The string
   * `paused` appeared in ZERO strategy tests.
   *
   * The gate is now a total function of the status union, so the case below is
   * written per STATE, not per transition.
   */
  it('SPC-5 — pause → edit protected fields → activate cannot bypass the gate', async () => {
    const { owner, orgId } = await ownerWithOrg(freshTenant());
    await setToggle('strategy-approval-gate', 'off');
    const s = (await owner.post(S, { orgId, title: 'Live plan', objectives: [{ title: 'O1', keyResults: [] }] })).body;
    await owner.patch(`${S}/${s.id}`, { status: 'active' });
    await setToggle('strategy-approval-gate', 'on');
    try {
      // 1. Pause. A plain write; no gate branch is supposed to match.
      const paused = await owner.patch(`${S}/${s.id}`, { status: 'paused' });
      expect(paused.status, JSON.stringify(paused.body)).toBe(200);
      expect(paused.body.status).toBe('paused');

      // 2. Rewrite ALL FOUR protected fields while paused. `paused` is an
      //    APPROVED, non-terminal state, so this must re-open re-approval and
      //    say so.
      const edited = await owner.patch(`${S}/${s.id}`, {
        objectives: [{ title: 'O1 rewritten', keyResults: [] }],
        period: { label: 'FY99' },
        planningHorizon: 'quarter',
        accountableExecutive: 'Someone Else',
      });
      expect(edited.status, JSON.stringify(edited.body)).toBe(200);
      expect(edited.body.status, 'a protected edit on a paused (approved) strategy must revert').toBe('draft');
      expect(edited.body.autoRevertedToDraft).toBe(true);
      expect(edited.body.autoRevertedFields.sort()).toEqual(['accountableExecutive', 'objectives', 'period', 'planningHorizon']);

      // 3. Re-activate. It must be INTERCEPTED, not applied.
      const reactivate = await owner.patch(`${S}/${s.id}`, { status: 'active' });
      expect(reactivate.status).toBe(200);
      expect(reactivate.body.status, 'the status flip applied with no approval').not.toBe('active');
      expect(reactivate.body.activationPending).toBe(true);
      const appr = await pendingActivation(owner, s.id);
      expect(appr, 'no approval was ever queued for the re-activation').toBeTruthy();
      const claim = await owner.post(`${APPROVALS}/${appr.approvalId}/claim`);
      expect(claim.status, JSON.stringify(claim.body)).toBe(200);
      expect((await owner.get(`${S}/${s.id}`)).body.status).toBe('active');
    } finally {
      await setToggle('strategy-approval-gate', 'off');
    }
  });

  /**
   * The DESTINATION rule from every non-active origin, and the terminal-state
   * carve-out. `completed`/`archived` must NOT auto-revert on a protected edit:
   * archiving is reserved to `requireConfigAuthority`, so resurrecting an
   * archived row into `draft` on a plain `workspace:write` edit would be a NEW
   * escalation created by the fix for an old one. They are covered by the
   * destination rule instead — which this asserts.
   */
  it('SPC-5 — activation is gated from EVERY non-active origin; terminal states are not resurrected', async () => {
    for (const origin of ['paused', 'completed', 'archived'] as const) {
      const { owner, orgId } = await ownerWithOrg(freshTenant());
      await setToggle('strategy-approval-gate', 'off');
      const s = (await owner.post(S, { orgId, title: `From ${origin}`, objectives: [{ title: 'O1', keyResults: [] }] })).body;
      await owner.patch(`${S}/${s.id}`, { status: 'active' });
      await owner.patch(`${S}/${s.id}`, { status: origin });
      await setToggle('strategy-approval-gate', 'on');
      try {
        // Terminal states stay put under a protected edit (no un-archive).
        if (origin !== 'paused') {
          const edited = await owner.patch(`${S}/${s.id}`, { objectives: [{ title: 'rewritten', keyResults: [] }] });
          expect(edited.body.status, `${origin} must not be resurrected into draft`).toBe(origin);
          expect(edited.body.autoRevertedToDraft).toBeUndefined();
        }
        // …but going live from any of them is gated.
        const r = await owner.patch(`${S}/${s.id}`, { status: 'active' });
        expect(r.body.status, `${origin} → active applied with no approval`).not.toBe('active');
        expect(r.body.activationPending, `${origin} → active queued nothing`).toBe(true);
        // "Approve what you see" still holds for a non-draft origin.
        const appr = await pendingActivation(owner, s.id);
        expect((await owner.post(`${APPROVALS}/${appr.approvalId}/claim`)).status, `claim from ${origin}`).toBe(200);
        expect((await owner.get(`${S}/${s.id}`)).body.status, `approving from ${origin} changed nothing`).toBe('active');
      } finally {
        await setToggle('strategy-approval-gate', 'off');
      }
    }
  });

  it('a decider without host:members:manage gets 403 (approval stays pending)', async () => {
    const tenantId = freshTenant();
    const { owner, orgId } = await ownerWithOrg(tenantId);
    const editor = client(); const editorUser = await signup(editor, tenantId);
    await owner.post(`/v1/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'E', subject: editorUser.userId, roles: ['editor'] });
    await setToggle('strategy-approval-gate', 'on');
    try {
      const s = (await owner.post(S, { orgId, title: 'Sensitive' })).body;
      await owner.patch(`${S}/${s.id}`, { status: 'active' });
      const appr = await pendingActivation(owner, s.id);
      expect(appr).toBeTruthy();
      // List gating (review fix): a member without host:members:manage never
      // even sees the row (the content-publish MEDIUM-2 posture, reused).
      expect(await pendingActivation(editor, s.id)).toBeUndefined();
      const denied = await editor.post(`${APPROVALS}/${appr.approvalId}/claim`);
      expect(denied.status, JSON.stringify(denied.body)).toBe(403);
      const after = await owner.get(`${S}/${s.id}`);
      expect(after.body.status).toBe('draft'); // untouched
    } finally {
      await setToggle('strategy-approval-gate', 'off');
    }
  });
});

describe('strategy versions (ADR 0230 §B4)', () => {
  it('appends deduped revisions and restores content only', async () => {
    const { owner, orgId } = await ownerWithOrg(freshTenant());
    const s = (await owner.post(S, { orgId, title: 'V1 title', summary: 'first' })).body;

    // Content change → new revision; a no-op patch → deduped (nothing appended).
    await owner.patch(`${S}/${s.id}`, { title: 'V2 title' });
    await owner.patch(`${S}/${s.id}`, { title: 'V2 title' }); // identical content
    const versions = await owner.get(`${S}/${s.id}/versions`);
    expect(versions.status, JSON.stringify(versions.body)).toBe(200);
    const list: any[] = versions.body.versions;
    expect(list.length).toBe(2); // create + one distinct patch
    expect(list[0].n).toBe(1);
    expect(list[0].title).toBe('V1 title');
    expect(list[1].title).toBe('V2 title');

    // Full snapshot read.
    const rev1 = await owner.get(`${S}/${s.id}/versions/1`);
    expect(rev1.status).toBe(200);
    expect(rev1.body.snapshot.summary).toBe('first');

    // Restore v1 content; scope/status/links are untouched by design.
    const restored = await owner.post(`${S}/${s.id}/versions/1/restore`);
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    expect(restored.body.title).toBe('V1 title');
    // The restore itself appends a revision (content changed back).
    const after = await owner.get(`${S}/${s.id}/versions`);
    expect(after.body.versions.length).toBe(3);

    // Unknown revision → 404; versions read is read-gated like GET /:id.
    expect((await owner.get(`${S}/${s.id}/versions/99`)).status).toBe(404);
    const other = client(); await signup(other, freshTenant());
    expect((await other.get(`${S}/${s.id}/versions`)).status).toBe(404);
  });
});

/**
 * ADR 0597 §Correction 3 (MEDIUM-6) — the SAME write-then-validate family as
 * §Correction 2, one route away.
 *
 * `routes.ts` queued the activation approval and THEN called `updateStrategy`,
 * which is the validator. So a PATCH carrying an invalid field alongside
 * `status:'active'` returned 400, changed nothing — and left a live pending
 * approval behind. An approver then claims a request the owner believes was
 * rejected. Pre-existing, but §3 WIDENED the reachable origins from `draft`
 * alone to every non-active state, so every one of them inherited it.
 */
describe('ADR 0597 §Correction 3 — a rejected activation PATCH queues no approval', () => {
  it('leaves no pending approval when the same PATCH fails validation', async () => {
    const { owner, orgId } = await ownerWithOrg(freshTenant());
    await setToggle('strategy-approval-gate', 'on');
    try {
      const s = (await owner.post(S, { orgId, title: 'Half-applied' })).body;

      // `planningHorizon` is closed-world; `updateStrategy` 400s on it. The
      // activation intent in the SAME body is what used to be queued first.
      const bad = await owner.patch(`${S}/${s.id}`, { status: 'active', planningHorizon: 'not-a-horizon' });
      expect(bad.status, JSON.stringify(bad.body)).toBe(400);

      expect((await owner.get(`${S}/${s.id}`)).body.status, 'the strategy moved on a refused PATCH').toBe('draft');
      expect(await pendingActivation(owner, s.id),
        'a refused PATCH left an approver holding a live activation request the owner never made').toBeUndefined();

      // MATCHED POSITIVE CONTROL: the same activation, valid, still queues.
      const good = await owner.patch(`${S}/${s.id}`, { status: 'active' });
      expect(good.status, JSON.stringify(good.body)).toBe(200);
      expect(good.body.activationPending).toBe(true);
      expect(await pendingActivation(owner, s.id), 'the gate stopped queueing altogether').toBeTruthy();
    } finally { await setToggle('strategy-approval-gate', 'off'); }
  });

  it('the same holds for the WIDENED origins §3 opened (paused → active)', async () => {
    const { owner, orgId } = await ownerWithOrg(freshTenant());
    await setToggle('strategy-approval-gate', 'off');
    const s = (await owner.post(S, { orgId, title: 'Paused half-apply' })).body;
    expect((await owner.patch(`${S}/${s.id}`, { status: 'active' })).status).toBe(200);
    expect((await owner.patch(`${S}/${s.id}`, { status: 'paused' })).status).toBe(200);
    await setToggle('strategy-approval-gate', 'on');
    try {
      const bad = await owner.patch(`${S}/${s.id}`, { status: 'active', planningHorizon: 'not-a-horizon' });
      expect(bad.status, JSON.stringify(bad.body)).toBe(400);
      expect((await owner.get(`${S}/${s.id}`)).body.status).toBe('paused');
      expect(await pendingActivation(owner, s.id)).toBeUndefined();
    } finally { await setToggle('strategy-approval-gate', 'off'); }
  });
});

/**
 * ADR 0597 §Correction 4 (MEDIUM-3) — "approve what you see", checked instead of
 * asserted.
 *
 * `activationApproval.ts` comments that the `strategyFromStatus` compare makes
 * *"'approve what you see' hold for every origin state"*, and §3 says terminal
 * states are covered by the destination rule *"and the approver sees the edited
 * content."* Both are false, and the review's own scoping of the defect to
 * `archived` was too narrow: the compare only catches an edit that MOVES THE
 * STATUS. A protected-field edit that leaves the status alone is invisible to
 * it, and whether the status moves is decided by `protectedEditRequiresReapproval`
 * — which is false for `draft` (unapproved) AND for the terminal states.
 *
 * So the guarantee held for exactly ONE origin — `paused` — and there only
 * incidentally, because the auto-revert to `draft` happens to move the status
 * the compare reads.
 */
describe('ADR 0597 §Correction 4 — a protected edit under review cannot be approved unseen', () => {
  const swapped = [{ title: 'Attacker objective', keyResults: [{ title: 'Ship the attacker KR' }] }];

  async function queuedFrom(status: 'draft' | 'archived' | 'completed'): Promise<{ owner: Client; id: string; approvalId: string }> {
    const { owner, orgId } = await ownerWithOrg(freshTenant());
    await setToggle('strategy-approval-gate', 'off');
    const s = (await owner.post(S, { orgId, title: 'Under review', objectives: [{ title: 'Honest objective', keyResults: [{ title: 'Honest KR' }] }] })).body;
    if (status !== 'draft') {
      expect((await owner.patch(`${S}/${s.id}`, { status })).status, `could not reach ${status}`).toBe(200);
    }
    await setToggle('strategy-approval-gate', 'on');
    const queued = await owner.patch(`${S}/${s.id}`, { status: 'active' });
    expect(queued.status, JSON.stringify(queued.body)).toBe(200);
    const appr = await pendingActivation(owner, s.id);
    expect(appr, `nothing was queued from ${status}`).toBeTruthy();
    return { owner, id: s.id, approvalId: appr.approvalId };
  }

  for (const origin of ['draft', 'archived', 'completed'] as const) {
    it(`closes the review when protected content changes under it (origin: ${origin})`, async () => {
      const { owner, id, approvalId } = await queuedFrom(origin);
      try {
        const edit = await owner.patch(`${S}/${id}`, { objectives: swapped, accountableExecutive: 'Attacker' });
        expect(edit.status, JSON.stringify(edit.body)).toBe(200);

        // The ATTACK itself, not just the card: claiming the withdrawn review
        // must not put the swapped objectives live. Asserting only that the
        // inbox row is gone would pass against a card that is merely hidden.
        await owner.post(`${APPROVALS}/${approvalId}/claim`);
        expect((await owner.get(`${S}/${id}`)).body.status,
          'swapped content went LIVE off a withdrawn review').not.toBe('active');

        // The approver must not be left holding a card whose content changed
        // under it — and the change must be VISIBLE in the response, not just
        // absent from the inbox.
        expect(await pendingActivation(owner, id),
          'swapped content is still approvable — the approver would activate objectives they never saw').toBeUndefined();
        expect(edit.body.activationReviewClosed,
          'the review was closed silently: the owner is never told the submission was withdrawn').toBe(true);
      } finally { await setToggle('strategy-approval-gate', 'off'); }
    });
  }

  it('MATCHED CONTROL — `paused` was already covered, via the auto-revert, and still is', async () => {
    const { owner, orgId } = await ownerWithOrg(freshTenant());
    await setToggle('strategy-approval-gate', 'off');
    const s = (await owner.post(S, { orgId, title: 'Paused review' })).body;
    expect((await owner.patch(`${S}/${s.id}`, { status: 'active' })).status).toBe(200);
    expect((await owner.patch(`${S}/${s.id}`, { status: 'paused' })).status).toBe(200);
    await setToggle('strategy-approval-gate', 'on');
    try {
      expect((await owner.patch(`${S}/${s.id}`, { status: 'active' })).status).toBe(200);
      const edit = await owner.patch(`${S}/${s.id}`, { objectives: swapped });
      expect(edit.status).toBe(200);
      expect(edit.body.autoRevertedToDraft, 'the paused auto-revert stopped firing').toBe(true);
      expect(await pendingActivation(owner, s.id)).toBeUndefined();
    } finally { await setToggle('strategy-approval-gate', 'off'); }
  });

  /**
   * The SECOND lane of the same class, found by walking the call graph of
   * `updateStrategy` instead of the finding's example. `POST
   * /:id/versions/:n/restore` writes ALL FOUR protected fields
   * (`planningHorizon`, `period`, `objectives`, `accountableExecutive`) and does
   * not pass through the gate block at all. Restoring an old revision under a
   * pending review swaps the content the approver read for content they never
   * saw — the identical escalation, one verb away.
   */
  it('the RESTORE lane withdraws the review too (protected content, second verb)', async () => {
    const { owner, orgId } = await ownerWithOrg(freshTenant());
    await setToggle('strategy-approval-gate', 'off');
    const s = (await owner.post(S, { orgId, title: 'Restorable', objectives: [{ title: 'Version one objective', keyResults: [] }] })).body;
    expect((await owner.patch(`${S}/${s.id}`, { objectives: [{ title: 'Version two objective', keyResults: [] }] })).status).toBe(200);
    await setToggle('strategy-approval-gate', 'on');
    try {
      // The approver is shown version TWO.
      expect((await owner.patch(`${S}/${s.id}`, { status: 'active' })).status).toBe(200);
      const appr = await pendingActivation(owner, s.id);
      expect(appr, 'nothing queued').toBeTruthy();

      // …and version ONE is put back underneath them.
      const restored = await owner.post(`${S}/${s.id}/versions/1/restore`);
      expect(restored.status, JSON.stringify(restored.body)).toBe(200);
      expect(restored.body.objectives[0].title).toBe('Version one objective');

      expect(await pendingActivation(owner, s.id),
        'a restore swapped the content under a live review and left it approvable').toBeUndefined();
      expect(restored.body.activationReviewClosed).toBe(true);
      await owner.post(`${APPROVALS}/${appr.approvalId}/claim`);
      expect((await owner.get(`${S}/${s.id}`)).body.status,
        'restored-out-from-under content went live off a withdrawn review').not.toBe('active');
    } finally { await setToggle('strategy-approval-gate', 'off'); }
  });

  it('MATCHED POSITIVE CONTROL — an UNPROTECTED edit leaves the review standing', async () => {
    const { owner, id } = await queuedFrom('archived');
    try {
      const edit = await owner.patch(`${S}/${id}`, { title: 'Renamed, same plan' });
      expect(edit.status).toBe(200);
      expect(edit.body.activationReviewClosed).toBeUndefined();
      expect(await pendingActivation(owner, id),
        'a benign rename withdrew the submission — the fix over-fires').toBeTruthy();
    } finally { await setToggle('strategy-approval-gate', 'off'); }
  });
});
