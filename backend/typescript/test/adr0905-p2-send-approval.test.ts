/**
 * ADR 0905 P2 — the `email-campaign-send` approval, through the HTTP boundary (the CMS
 * ladder re-run for email) plus the service-level send gate.
 *
 *  - submit → the ONE approval row, visible to admins and to configured approvers only;
 *  - decide through the shared inbox lane (`/approvals/:id/claim|reject`);
 *  - stale_review 409 (the row stays pending), review_closed 409, self-approval refused,
 *    a CAS double-approve yields one transition;
 *  - an approver-group member (not admin) can approve; a non-member editor cannot;
 *  - gate ON: no send without approval, from the route AND from `sendCampaign` directly;
 *    an approved send renders the APPROVED version; a `sending` continuation proceeds;
 *  - a template edit returns an in-review campaign to draft and closes its row.
 *
 * Sabotage-witnessed: dropping the self-approval check, the decide-time pin compare, the
 * approver-ref eligibility, the send gate in `assertSendAllowed`, or the audience's
 * approver-ref arm each reds at least one case.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { bootPlanningApp, makeClient, enableToggle, uniqEmail, type Client } from './planningHarness.js';
import { getApproval } from '../src/host/approvalService.js';
import {
  __resetEmailStore, createTemplate, createCampaign, sendCampaign, setSenderAddress, updateTemplate, getCampaign,
  type EmailMessage,
} from '../src/features/email/emailService.js';
import { createContact, __resetCrmStore } from '../src/features/crm/contactsService.js';
import { __resetConsentStore } from '../src/features/consent/consentService.js';
import { createGroup, listMembers } from '../src/host/accessControlService.js';

let BASE = '';
let closeApp: () => Promise<void>;
let n = 0;

beforeAll(async () => {
  const h = await bootPlanningApp(); BASE = h.base; closeApp = h.close;
  process.env.OPENWOP_EMAIL_LINK_BASE_URL = 'https://app.example';
  delete process.env.OPENWOP_DEMO_MODE; // the de-facto-owner bypass would make refusals vacuous
  for (const id of ['users', 'crm', 'email']) await enableToggle(id, 'on');
});
afterAll(async () => { await enableToggle('email-approval-gate', 'off'); await closeApp(); });

const client = (): Client => makeClient(() => BASE);
const APPROVALS = '/host/openwop-app/approvals';
const E = (orgId: string, s = ''): string => `/host/openwop-app/email/orgs/${encodeURIComponent(orgId)}${s}`;

async function signup(c: Client, tenantId: string): Promise<string> {
  const r = await c.post('/host/openwop-app/test/login', { email: uniqEmail('emrv'), tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user.userId as string;
}
async function addMember(owner: Client, orgId: string, subject: string, roles: string[]): Promise<void> {
  const r = await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'M', subject, roles });
  expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
}

/** An org with an owner, a second admin, two editors (one becomes a client approver). */
async function team() {
  const tenantId = `org:emrv-${Date.now()}-${n++}`;
  const owner = client(); const ownerId = await signup(owner, tenantId);
  const org = await owner.post('/host/openwop-app/orgs', { name: 'Agency' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  const orgId = org.body.orgId as string;
  const admin = client(); const adminId = await signup(admin, tenantId); await addMember(owner, orgId, adminId, ['admin']);
  const editor = client(); const editorId = await signup(editor, tenantId); await addMember(owner, orgId, editorId, ['editor']);
  const clientUser = client(); const clientId = await signup(clientUser, tenantId); await addMember(owner, orgId, clientId, ['editor']);
  expect((await owner.put(E(orgId, '/settings'), { senderAddress: 'news@agency.test' })).status).toBe(200);
  const tpl = await editor.post(E(orgId, '/templates'), { name: 'Launch', subject: 'Big news', body: 'Hello {{contact.name}}' });
  const cmp = await editor.post(E(orgId, '/campaigns'), { templateId: tpl.body.templateId });
  expect(cmp.status, JSON.stringify(cmp.body)).toBe(201);
  return { tenantId, orgId, owner, ownerId, admin, adminId, editor, editorId, clientUser, clientId, templateId: tpl.body.templateId as string, campaignId: cmp.body.campaignId as string };
}

async function submit(c: Client, orgId: string, campaignId: string): Promise<string> {
  const r = await c.post(E(orgId, `/campaigns/${campaignId}/submit-review`));
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.body.campaign.status).toBe('in_review');
  return r.body.approvalId as string;
}

describe('ADR 0905 D3 — review lifecycle through the inbox', () => {
  it('submit creates one row (resubmit repins it); an admin approves; the campaign is `approved`', async () => {
    const t = await team();
    const approvalId = await submit(t.editor, t.orgId, t.campaignId);
    expect(await submit(t.editor, t.orgId, t.campaignId)).toBe(approvalId);
    const row = await getApproval(approvalId);
    expect(row).toMatchObject({ kind: 'email-campaign-send', status: 'pending', emailSend: { campaignId: t.campaignId, templateVersion: 1, subject: 'Big news', senderAddress: 'news@agency.test' } });

    // Visibility: the admin sees the card; a plain editor does not.
    const seen = async (c: Client) => ((await c.get(`${APPROVALS}?status=pending`)).body.items as Array<{ approvalId: string }>).some((a) => a.approvalId === approvalId);
    expect(await seen(t.admin)).toBe(true);
    expect(await seen(t.clientUser)).toBe(false);

    const ok = await t.admin.post(`${APPROVALS}/${approvalId}/claim`);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await t.editor.get(E(t.orgId, '/campaigns'))).body.campaigns.find((c: { campaignId: string }) => c.campaignId === t.campaignId)).toMatchObject({ status: 'approved', review: { outcome: 'approved' } });
    // CAS: a second approve is a 409, not a second transition.
    expect((await t.owner.post(`${APPROVALS}/${approvalId}/claim`)).status).toBe(409);
  });

  it('reject returns the campaign to draft with the reviewer note ("changes requested")', async () => {
    const t = await team();
    const approvalId = await submit(t.editor, t.orgId, t.campaignId);
    expect((await t.admin.post(`${APPROVALS}/${approvalId}/reject`, { note: 'Fix the subject' })).status).toBe(200);
    const c = await getCampaign(t.tenantId, t.orgId, t.campaignId);
    expect(c).toMatchObject({ status: 'draft', review: { outcome: 'changes_requested', note: 'Fix the subject' } });
  });

  it('a plain editor cannot decide (403); a configured approver-group member can see and approve', async () => {
    const t = await team();
    const approvalId0 = await submit(t.editor, t.orgId, t.campaignId);
    expect((await t.clientUser.post(`${APPROVALS}/${approvalId0}/claim`)).status).toBe(403);
    expect((await getApproval(approvalId0))?.status).toBe('pending');
    await t.editor.post(E(t.orgId, `/campaigns/${t.campaignId}/withdraw-review`));

    // Only an admin may name approvers.
    const member = (await listMembers(t.tenantId, t.orgId)).find((m) => m.subject === t.clientId)!;
    const group = await createGroup({ tenantId: t.tenantId, orgId: t.orgId, name: 'Client approvers', memberIds: [member.memberId] });
    expect((await t.editor.put(E(t.orgId, '/settings/approvers'), { groupRefs: [group.groupId] })).status).toBe(403);
    expect((await t.owner.put(E(t.orgId, '/settings/approvers'), { groupRefs: ['grp-does-not-exist'] })).status).toBe(400);
    expect((await t.owner.put(E(t.orgId, '/settings/approvers'), { groupRefs: [group.groupId] })).status).toBe(200);

    const approvalId = await submit(t.editor, t.orgId, t.campaignId);
    expect((await getApproval(approvalId))?.policy).toMatchObject({ requiredApprovals: 1, approverGroupRefs: [group.groupId] });
    const listed = (await t.clientUser.get(`${APPROVALS}?status=pending`)).body.items as Array<{ approvalId: string }>;
    expect(listed.some((a) => a.approvalId === approvalId)).toBe(true);
    const ok = await t.clientUser.post(`${APPROVALS}/${approvalId}/claim`);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it('stale_review: a template edit while in review returns the campaign to draft and closes the row (review_closed on decide)', async () => {
    const t = await team();
    const approvalId = await submit(t.editor, t.orgId, t.campaignId);
    expect((await t.editor.patch(E(t.orgId, `/templates/${t.templateId}`), { subject: 'Edited' })).status).toBe(200);
    expect((await getCampaign(t.tenantId, t.orgId, t.campaignId))?.status).toBe('draft');
    expect((await getApproval(approvalId))?.status).toBe('rejected');
    expect((await t.admin.post(`${APPROVALS}/${approvalId}/claim`)).status).toBe(409);
  });

  it('stale_review: a sender change the eager path misses still refuses the approve and keeps the row pending', async () => {
    const t = await team();
    const approvalId = await submit(t.editor, t.orgId, t.campaignId);
    // Bypass the eager invalidation: write the settings row the way an old instance would.
    const { DurableCollection } = await import('../src/host/hostExtPersistence.js');
    const raw = new DurableCollection<Record<string, unknown>>('email:settings', (s) => `${String(s.tenantId)}::${String(s.orgId)}`);
    await raw.put({ tenantId: t.tenantId, orgId: t.orgId, senderAddress: 'other@agency.test', updatedBy: 'x', updatedAt: new Date().toISOString() });
    const r = await t.admin.post(`${APPROVALS}/${approvalId}/claim`);
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toContain('stale_review');
    expect((await getApproval(approvalId))?.status).toBe('pending');
  });

  it('self-approval is refused under the gate while another admin exists; allowed with the gate OFF', async () => {
    const t = await team();
    await enableToggle('email-approval-gate', 'on');
    try {
      const approvalId = await submit(t.admin, t.orgId, t.campaignId);
      const r = await t.admin.post(`${APPROVALS}/${approvalId}/claim`);
      expect(r.status, JSON.stringify(r.body)).toBe(403);
      expect(r.body?.details?.reason).toBe('separation-of-duties');
      expect((await getApproval(approvalId))?.status).toBe('pending');
      expect((await t.owner.post(`${APPROVALS}/${approvalId}/claim`)).status).toBe(200);
    } finally { await enableToggle('email-approval-gate', 'off'); }
    const t2 = await team();
    const id2 = await submit(t2.admin, t2.orgId, t2.campaignId);
    expect((await t2.admin.post(`${APPROVALS}/${id2}/claim`)).status).toBe(200);
  });

  it('another tenant cannot decide the row (uniform 404)', async () => {
    const t = await team();
    const other = await team();
    const approvalId = await submit(t.editor, t.orgId, t.campaignId);
    expect([403, 404]).toContain((await other.owner.post(`${APPROVALS}/${approvalId}/claim`)).status);
    expect((await getApproval(approvalId))?.status).toBe('pending');
  });

  it('gate ON: the send route refuses an unapproved campaign with 409 approval_required', async () => {
    const t = await team();
    await enableToggle('email-approval-gate', 'on');
    try {
      const r = await t.editor.post(E(t.orgId, `/campaigns/${t.campaignId}/send`), {});
      expect(r.status, JSON.stringify(r.body)).toBe(409);
      expect(JSON.stringify(r.body)).toContain('approval_required');
    } finally { await enableToggle('email-approval-gate', 'off'); }
  });
});

describe('ADR 0905 D3/D4 — the service-level send gate', () => {
  const T = 'tGate';
  let delivered: EmailMessage[] = [];
  const provider = { id: 'test-transport', send: async (m: EmailMessage) => { delivered.push(m); } };

  beforeEach(async () => {
    await __resetEmailStore(); await __resetCrmStore(); await __resetConsentStore();
    delivered = [];
    await setSenderAddress(T, T, 'sender@acme.test', 'u1');
    for (const x of ['a', 'b', 'c']) await createContact({ tenantId: T, name: x, email: `${x}@x.com`, stage: 'lead' });
  });

  it('gate ON: sendCampaign called directly refuses a draft (409 approval_required)', async () => {
    await enableToggle('email-approval-gate', 'on');
    try {
      const tpl = await createTemplate({ tenantId: T, orgId: T, name: 'N', subject: 'S', body: 'B', createdBy: 'u1' });
      const c = await createCampaign({ tenantId: T, orgId: T, templateId: tpl.templateId, createdBy: 'u1' });
      await expect(sendCampaign(T, T, c.campaignId, { provider })).rejects.toMatchObject({ httpStatus: 409, details: { reason: 'approval_required' } });
      expect(delivered).toHaveLength(0);
    } finally { await enableToggle('email-approval-gate', 'off'); }
  });

  it('gate ON: a `sending` continuation proceeds; a send started before the gate is not stranded', async () => {
    const tpl = await createTemplate({ tenantId: T, orgId: T, name: 'N', subject: 'S', body: 'B', createdBy: 'u1' });
    const c = await createCampaign({ tenantId: T, orgId: T, templateId: tpl.templateId, createdBy: 'u1' });
    await sendCampaign(T, T, c.campaignId, { provider, limit: 1 });
    await enableToggle('email-approval-gate', 'on');
    try {
      const rest = await sendCampaign(T, T, c.campaignId, { provider, limit: 10 });
      expect(rest?.status).toBe('sent');
      expect(delivered).toHaveLength(3);
      // …but a RESEND under the gate needs a fresh approval cycle.
      await expect(sendCampaign(T, T, c.campaignId, { provider, resend: true })).rejects.toMatchObject({ httpStatus: 409 });
    } finally { await enableToggle('email-approval-gate', 'off'); }
  });

  it('an approved send delivers the APPROVED version row, even if the live row drifted without the eager hook', async () => {
    const t = await team();
    for (const x of ['a', 'b']) await createContact({ tenantId: t.tenantId, name: x, email: `${x}@y.com`, stage: 'lead' });
    const approvalId = await submit(t.editor, t.orgId, t.campaignId);
    expect((await t.admin.post(`${APPROVALS}/${approvalId}/claim`)).status).toBe(200);
    // An old instance rewrites the live template text without bumping its version.
    const { DurableCollection } = await import('../src/host/hostExtPersistence.js');
    const raw = new DurableCollection<Record<string, unknown>>('email:template', (x) => String(x.templateId));
    const live = await raw.get(t.templateId);
    await raw.put({ ...live!, subject: 'Drifted subject' });
    await enableToggle('email-approval-gate', 'on');
    try {
      const sent = await sendCampaign(t.tenantId, t.orgId, t.campaignId, { provider });
      expect(sent?.status).toBe('sent');
      expect(sent?.sendPin).toMatchObject({ templateVersion: 1, subject: 'Big news' });
      expect(delivered.length).toBeGreaterThan(0);
      expect(delivered.every((m) => m.subject === 'Big news')).toBe(true);
    } finally { await enableToggle('email-approval-gate', 'off'); }
  });

  it('an approved campaign whose template is then edited is back in draft and cannot be sent under the gate', async () => {
    const t = await team();
    const approvalId = await submit(t.editor, t.orgId, t.campaignId);
    expect((await t.admin.post(`${APPROVALS}/${approvalId}/claim`)).status).toBe(200);
    await updateTemplate(t.tenantId, t.orgId, t.templateId, { subject: 'Sneaky edit' });
    expect((await getCampaign(t.tenantId, t.orgId, t.campaignId))?.status).toBe('draft');
    await enableToggle('email-approval-gate', 'on');
    try {
      await expect(sendCampaign(t.tenantId, t.orgId, t.campaignId, { provider })).rejects.toMatchObject({ httpStatus: 409 });
      expect(delivered).toHaveLength(0);
    } finally { await enableToggle('email-approval-gate', 'off'); }
  });
});
