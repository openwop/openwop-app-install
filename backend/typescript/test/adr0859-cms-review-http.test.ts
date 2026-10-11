/**
 * ADR 0859 — the CMS review lifecycle through the HTTP boundary (feature loop round 2, row 34).
 *
 *   - D3: a new review notifies the org's managers (addressed, never the submitter, never a
 *     non-manager); a person's decision notifies the submitter.
 *   - D4: the submitter cannot approve their own page while another manager can — on EVERY
 *     decide lane (the page header, `/approvals/:id/claim`, `/reviews/…/actions`), because a
 *     mismatch in how a lane keys the decider would fail OPEN. Every refusal has a control.
 *   - D5: an entity section is disclosed on the row (ADR 0594 D1), and the disclosure clears.
 *   - D7: `/reviews` hides and refuses a content-publish row for a non-manager; the sweep runs.
 *
 * Sabotage (w16 probes, each red here): notifying every member, or the submitting
 * manager, or re-notifying on a resubmit; dropping the decided notice, notifying the
 * deciding submitter, or putting the reject reason in it; a separation-of-duties
 * predicate that never matches, replaces instead of unions submitters, counts the other
 * submitters as "someone else", locks out a sole approver, applies with the gate OFF or
 * to a reject; dropping `awaitingAnotherApprover`; a resubmit that keeps a stale
 * disclosure; `/reviews` scoped to `workspace:write`; no sweep at boot; a quorum gate
 * that holds policy-less rows.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootPlanningApp, makeClient, enableToggle, uniqEmail, type Client } from './planningHarness.js';
import { getApproval } from '../src/host/approvalService.js';
import { isCmsPublishSweepRunning } from '../src/features/cms/publishSweep.js';

let BASE = '';
let closeApp: () => Promise<void>;
let n = 0;

beforeAll(async () => {
  const h = await bootPlanningApp(); BASE = h.base; closeApp = h.close;
  // The de-facto-owner bypass would make every refusal pass vacuously.
  delete process.env.OPENWOP_DEMO_MODE;
});
afterAll(async () => { await enableToggle('cms-approval-gate', 'off'); await closeApp(); });

const client = (): Client => makeClient(() => BASE);
const APPROVALS = '/host/openwop-app/approvals';
const u = (orgId: string, s = ''): string => `/host/openwop-app/cms/orgs/${encodeURIComponent(orgId)}${s}`;

async function signup(c: Client, tenantId: string): Promise<string> {
  const r = await c.post('/host/openwop-app/test/login', { email: uniqEmail('cmsrv'), tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user.userId as string;
}
const addMember = async (owner: Client, orgId: string, subject: string, roles: string[]): Promise<void> => {
  const r = await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'M', subject, roles });
  expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
};

/** An org with an owner, a second admin, an editor and a viewer — each its own session. */
async function team(): Promise<{ tenantId: string; orgId: string; owner: Client; ownerId: string; admin: Client; adminId: string; editor: Client; editorId: string; viewer: Client }> {
  const tenantId = `org:cmsrv-${Date.now()}-${n++}`;
  const owner = client(); const ownerId = await signup(owner, tenantId);
  const org = await owner.post('/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  const orgId = org.body.orgId as string;
  const admin = client(); const adminId = await signup(admin, tenantId); await addMember(owner, orgId, adminId, ['admin']);
  const editor = client(); const editorId = await signup(editor, tenantId); await addMember(owner, orgId, editorId, ['editor']);
  const viewer = client(); const viewerId = await signup(viewer, tenantId); await addMember(owner, orgId, viewerId, ['viewer']);
  return { tenantId, orgId, owner, ownerId, admin, adminId, editor, editorId, viewer };
}

async function submitted(c: Client, orgId: string, title: string, sections: unknown[] = [{ type: 'hero', data: { heading: title } }]): Promise<{ pageId: string; approvalId: string }> {
  const created = await c.post(u(orgId, '/pages'), { title, sections });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const pageId = created.body.pageId as string;
  const sub = await c.post(u(orgId, `/pages/${pageId}/submit`));
  expect(sub.status, JSON.stringify(sub.body)).toBe(200);
  const review = await c.get(u(orgId, `/pages/${pageId}/review`));
  expect(review.body.review?.status).toBe('pending');
  return { pageId, approvalId: review.body.review.approvalId as string };
}

interface Notice { type: string; title: string; metadata?: { approvalId?: string; pageId?: string } }
const noticesOf = async (c: Client, type: string): Promise<Notice[]> => {
  const r = await c.get('/host/openwop-app/notifications');
  expect(r.status).toBe(200);
  return (r.body.notifications as Notice[]).filter((x) => x.type === type);
};

describe('D3 — the reviewer is told, the author is told', () => {
  it('a new review notifies managers only — not the submitter, not a viewer — and a resubmit does not re-notify', async () => {
    await enableToggle('cms-approval-gate', 'on');
    const t = await team();
    const { pageId, approvalId } = await submitted(t.editor, t.orgId, 'Pricing page');
    const forOwner = await noticesOf(t.owner, 'approval.content-review-requested');
    const forAdmin = await noticesOf(t.admin, 'approval.content-review-requested');
    expect(forOwner).toHaveLength(1);
    expect(forAdmin).toHaveLength(1);
    expect(forAdmin[0].title).toContain('Pricing page');
    expect(await noticesOf(t.editor, 'approval.content-review-requested'), 'the submitter was told about their own submission').toHaveLength(0);
    expect(await noticesOf(t.viewer, 'approval.content-review-requested'), 'a non-manager learned the review exists').toHaveLength(0);

    // A resubmit repins the open row — it is not a new review.
    expect((await t.editor.post(u(t.orgId, `/pages/${pageId}/submit`))).status).toBe(200);
    expect(await noticesOf(t.admin, 'approval.content-review-requested')).toHaveLength(1);
    expect((await getApproval(approvalId))?.status).toBe('pending');

    // A MANAGER who submits is not told about their own submission either (the
    // editor above is excluded by the audience already; this is the submitter rule).
    const adminPage = await submitted(t.admin, t.orgId, 'Admin page');
    const forPage = (xs: Notice[]): Notice[] => xs.filter((x) => x.metadata?.pageId === adminPage.pageId);
    expect(forPage(await noticesOf(t.owner, 'approval.content-review-requested')), 'positive control').toHaveLength(1);
    expect(forPage(await noticesOf(t.admin, 'approval.content-review-requested')), 'the submitting manager was told about their own submission').toHaveLength(0);
  });

  it('a decision notifies the submitter, and not the decider', async () => {
    await enableToggle('cms-approval-gate', 'on');
    const t = await team();
    const { approvalId } = await submitted(t.editor, t.orgId, 'Launch post');
    expect((await t.admin.post(`${APPROVALS}/${approvalId}/reject`, { note: 'Tighten the intro' })).status).toBe(200);
    const decided = await noticesOf(t.editor, 'approval.content-review-decided');
    expect(decided).toHaveLength(1);
    expect(decided[0].title).toContain('Changes requested');
    expect(JSON.stringify(decided[0]), 'the reviewer\'s reason left the page read').not.toContain('Tighten the intro');
    expect(await noticesOf(t.admin, 'approval.content-review-decided')).toHaveLength(0);
  });

  it('a decider who also submitted is not told of their own decision; the other submitter is', async () => {
    await enableToggle('cms-approval-gate', 'on');
    const t = await team();
    const { pageId, approvalId } = await submitted(t.owner, t.orgId, 'Co-submitted');
    expect((await t.admin.post(u(t.orgId, `/pages/${pageId}/submit`))).status).toBe(200);
    expect((await t.owner.post(`${APPROVALS}/${approvalId}/claim`)).status).toBe(200);
    expect(await noticesOf(t.admin, 'approval.content-review-decided'), 'positive control: the other submitter').toHaveLength(1);
    expect(await noticesOf(t.owner, 'approval.content-review-decided'), 'the decider was told of their own decision').toHaveLength(0);
  });
});

describe('D4 — separation of duties under the gate', () => {
  it('the submitter is refused on all three decide lanes while another manager exists; the other manager approves', async () => {
    await enableToggle('cms-approval-gate', 'on');
    const t = await team();
    const { pageId, approvalId } = await submitted(t.owner, t.orgId, 'Self review');

    const header = await t.owner.post(u(t.orgId, `/pages/${pageId}/approve`));
    expect(header.status, JSON.stringify(header.body)).toBe(403);
    expect(header.body?.details?.reason).toBe('separation-of-duties');
    const claim = await t.owner.post(`${APPROVALS}/${approvalId}/claim`);
    expect(claim.status, JSON.stringify(claim.body)).toBe(403);
    expect(claim.body?.details?.reason).toBe('separation-of-duties');
    const review = await t.owner.post(`/host/openwop-app/reviews/${encodeURIComponent(`approval:${approvalId}`)}/actions/approve`, {});
    expect(review.status, JSON.stringify(review.body)).toBe(403);
    expect(JSON.stringify(review.body)).toContain('separation-of-duties');
    expect((await t.owner.get(u(t.orgId, `/pages/${pageId}`))).body.status).toBe('in_review');
    expect((await getApproval(approvalId))?.status, 'a refusal consumed the row').toBe('pending');

    // The editor is told up front, so it can show "waiting for another approver".
    expect((await t.owner.get(u(t.orgId, `/pages/${pageId}/review`))).body.review.awaitingAnotherApprover).toBe(true);
    expect((await t.admin.get(u(t.orgId, `/pages/${pageId}/review`))).body.review.awaitingAnotherApprover).toBeUndefined();

    // Positive control.
    const other = await t.admin.post(`${APPROVALS}/${approvalId}/claim`);
    expect(other.status, JSON.stringify(other.body)).toBe(200);
    expect((await t.owner.get(u(t.orgId, `/pages/${pageId}`))).body.status).toBe('published');
  });

  it('a second person\'s resubmit does not erase the first submitter (review H2)', async () => {
    await enableToggle('cms-approval-gate', 'on');
    const t = await team();
    const { pageId, approvalId } = await submitted(t.owner, t.orgId, 'Two submitters');
    expect((await t.editor.post(u(t.orgId, `/pages/${pageId}/submit`))).status).toBe(200);
    const self = await t.owner.post(`${APPROVALS}/${approvalId}/claim`);
    expect(self.status, `the editor's resubmit laundered the owner's self-approval: ${JSON.stringify(self.body)}`).toBe(403);
    expect(self.body?.details?.reason).toBe('separation-of-duties');
  });

  it('when every manager has submitted, one of them can still approve (code grade CMSA2CD-3)', async () => {
    // Owner and admin are the org's only managers, and both submitted. "Someone else
    // can approve" must mean someone who is NOT a submitter, or each is refused for
    // the other and the page is stuck.
    await enableToggle('cms-approval-gate', 'on');
    const t = await team();
    const { pageId, approvalId } = await submitted(t.owner, t.orgId, 'Both submitted');
    expect((await t.admin.post(u(t.orgId, `/pages/${pageId}/submit`))).status).toBe(200);
    const claim = await t.owner.post(`${APPROVALS}/${approvalId}/claim`);
    expect(claim.status, JSON.stringify(claim.body)).toBe(200);
    expect((await t.owner.get(u(t.orgId, `/pages/${pageId}`))).body.status).toBe('published');
  });

  it('self-REJECT is a withdrawal and stays allowed', async () => {
    await enableToggle('cms-approval-gate', 'on');
    const t = await team();
    const { pageId, approvalId } = await submitted(t.owner, t.orgId, 'Withdraw');
    expect((await t.owner.post(`${APPROVALS}/${approvalId}/reject`, { note: 'Not ready' })).status).toBe(200);
    expect((await t.owner.get(u(t.orgId, `/pages/${pageId}`))).body.status).toBe('draft');
  });

  it('with the gate OFF the submitter may approve (a direct publish is allowed anyway)', async () => {
    await enableToggle('cms-approval-gate', 'off');
    const t = await team();
    const { pageId, approvalId } = await submitted(t.owner, t.orgId, 'Gate off');
    const self = await t.owner.post(`${APPROVALS}/${approvalId}/claim`);
    expect(self.status, JSON.stringify(self.body)).toBe(200);
    expect((await t.owner.get(u(t.orgId, `/pages/${pageId}`))).body.status).toBe('published');
  });

  it('a sole approver is never locked out', async () => {
    await enableToggle('cms-approval-gate', 'on');
    const tenantId = `org:cmsrv-solo-${Date.now()}-${n++}`;
    const owner = client(); await signup(owner, tenantId);
    const org = await owner.post('/host/openwop-app/orgs', { name: 'Solo' });
    const { pageId, approvalId } = await submitted(owner, org.body.orgId, 'Solo page');
    expect((await owner.post(`${APPROVALS}/${approvalId}/claim`)).status).toBe(200);
    expect((await owner.get(u(org.body.orgId, `/pages/${pageId}`))).body.status).toBe('published');
  });
});

describe('D5 — the card discloses sections that resolve live (ADR 0594 D1)', () => {
  it('an entity section is listed on the row, and a resubmit without it clears the disclosure', async () => {
    await enableToggle('cms-approval-gate', 'on');
    const t = await team();
    const live = { type: 'entityList', data: { heading: 'Team', tenantId: t.tenantId, typeName: 'team-member', titleField: 'name' } };
    const { pageId, approvalId } = await submitted(t.owner, t.orgId, 'Team page', [{ type: 'hero', data: { heading: 'Hi' } }, live]);
    const row = await getApproval(approvalId);
    expect(row?.liveReferenceSections?.map((s) => s.type)).toEqual(['entityList']);

    const page = (await t.owner.get(u(t.orgId, `/pages/${pageId}`))).body;
    const patched = await t.owner.patch(u(t.orgId, `/pages/${pageId}`), { sections: [{ type: 'hero', data: { heading: 'Hi' } }], expectedVersion: page.version });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect((await t.owner.post(u(t.orgId, `/pages/${pageId}/submit`))).status).toBe(200);
    expect((await getApproval(approvalId))?.liveReferenceSections, 'a stale disclosure outlived the section').toBeUndefined();
  });
});

describe('D7 — the witnesses that would let a fail-open edit ship green', () => {
  it('/reviews neither lists nor decides a content-publish row for a non-manager', async () => {
    await enableToggle('cms-approval-gate', 'on');
    const t = await team();
    const { pageId, approvalId } = await submitted(t.editor, t.orgId, 'Hidden from editors');
    const forEditor = await t.editor.get('/host/openwop-app/reviews');
    expect(forEditor.status).toBe(200);
    expect(JSON.stringify(forEditor.body)).not.toContain(approvalId);
    const forAdmin = await t.admin.get('/host/openwop-app/reviews');
    expect(JSON.stringify(forAdmin.body), 'positive control: the manager sees it').toContain(approvalId);
    const act = await t.editor.post(`/host/openwop-app/reviews/${encodeURIComponent(`approval:${approvalId}`)}/actions/approve`, {});
    // Existence-hiding: a row the caller may not see is a uniform 404, not a 403.
    expect(act.status, JSON.stringify(act.body)).toBe(404);
    expect(act.body?.error).toBe('not_found');
    expect((await t.admin.get(u(t.orgId, `/pages/${pageId}`))).body.status).toBe('in_review');
  });

  it('boot starts the scheduled-publish sweep', () => {
    expect(isCmsPublishSweepRunning()).toBe(true);
  });
});
