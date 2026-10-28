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

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { bootPlanningApp, makeClient, enableToggle, uniqEmail, type Client } from './planningHarness.js';
import { getApproval, getEmailSendApprovalHandler, listApprovals, type PendingApproval } from '../src/host/approvalService.js';
import { DurableCollection, hostExtStorage } from '../src/host/hostExtPersistence.js';
import { emailSendReviewHash, withdrawReview } from '../src/features/email/sendApproval.js';
import {
  __resetEmailStore, createTemplate, createCampaign, sendCampaign, setSenderAddress, updateTemplate, getCampaign,
  type EmailMessage, type Campaign,
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
afterEach(() => vi.restoreAllMocks());

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

/** Existing lifecycle cases approve the displayed full review digest. */
async function approve(c: Client, approvalId: string) {
  const row = await getApproval(approvalId);
  return c.post(`${APPROVALS}/${approvalId}/claim`, { expectedContentHash: row?.emailSend?.reviewHash });
}

describe('ADR 0905 D3 — review lifecycle through the inbox', () => {
  it('a failed submission cannot close an identical successful resubmission that took ownership', async () => {
    const t = await team();
    const db = hostExtStorage(); const cas = db.kvCompareAndSwap.bind(db); const get = db.kvGet.bind(db);
    const campaignKey = `hostext:email:campaign:${t.campaignId}`;
    let failedFirstMirror = false; let blocked = false;
    let arrived!: () => void; let release!: () => void;
    const staleReadReady = new Promise<void>((resolve) => { arrived = resolve; });
    const resume = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(db, 'kvCompareAndSwap').mockImplementation(async (key, expected, value) => {
      if (!failedFirstMirror && key === campaignKey && JSON.parse(value).status === 'in_review') {
        failedFirstMirror = true; throw new Error('first mirror failed before commit');
      }
      return cas(key, expected, value);
    });
    vi.spyOn(db, 'kvGet').mockImplementation(async (key) => {
      const raw = await get(key);
      if (failedFirstMirror && !blocked && key === campaignKey) {
        // Capture A's failed-mirror read, outside the approval's process-local
        // lock. B can complete a real identical submit before A compensates.
        blocked = true; arrived(); await resume;
      }
      return raw;
    });
    const first = t.editor.post(E(t.orgId, `/campaigns/${t.campaignId}/submit-review`));
    await staleReadReady;
    let winner: PendingApproval | null = null;
    try {
      const [original] = (await listApprovals(t.tenantId)).filter((a) => a.emailSend?.campaignId === t.campaignId);
      const second = await t.editor.post(E(t.orgId, `/campaigns/${t.campaignId}/submit-review`));
      expect(second.status, JSON.stringify(second.body)).toBe(200);
      winner = await getApproval(second.body.approvalId as string);
      expect(winner?.emailSend?.reviewHash).toBe(original?.emailSend?.reviewHash);
      expect(winner?.emailSendRevision).not.toBe(original?.emailSendRevision);
    } finally { release(); }
    expect((await first).status).toBe(500);
    expect((await getApproval(winner!.approvalId))?.status).toBe('pending');
    expect((await getCampaign(t.tenantId, t.orgId, t.campaignId))?.status).toBe('in_review');
    expect((await approve(t.admin, winner!.approvalId)).status).toBe(200);
  });

  it.each(['before-commit', 'lost-ack'] as const)('a submission mirror %s closes only a failed new review and preserves a committed mirror', async (fault) => {
    const t = await team();
    const db = hostExtStorage(); const cas = db.kvCompareAndSwap.bind(db);
    let injected = false;
    vi.spyOn(db, 'kvCompareAndSwap').mockImplementation(async (key, expected, value) => {
      if (!injected && key === `hostext:email:campaign:${t.campaignId}` && value && JSON.parse(value).status === 'in_review') {
        injected = true;
        if (fault === 'lost-ack') expect((await cas(key, expected, value)).swapped).toBe(true);
        throw new Error('submission mirror fault');
      }
      return cas(key, expected, value);
    });
    const result = await t.editor.post(E(t.orgId, `/campaigns/${t.campaignId}/submit-review`));
    expect(injected).toBe(true);
    expect(result.status, JSON.stringify(result.body)).toBe(fault === 'lost-ack' ? 200 : 500);
    const rows = (await listApprovals(t.tenantId)).filter((a) => a.emailSend?.campaignId === t.campaignId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe(fault === 'lost-ack' ? 'pending' : 'rejected');
    expect((await getCampaign(t.tenantId, t.orgId, t.campaignId))?.status).toBe(fault === 'lost-ack' ? 'in_review' : 'draft');
  });

  it.each(['lost-ack', 'subsequent-send'] as const)('an acknowledged decision survives %s instead of reopening the approval', async (interleave) => {
    const t = await team();
    const id = await submit(t.editor, t.orgId, t.campaignId);
    const review = await getApproval(id);
    const db = hostExtStorage(); const cas = db.kvCompareAndSwap.bind(db); const get = db.kvGet.bind(db);
    let injected = false; let readsAfterWrite = 0;
    const keyOfCampaign = `hostext:email:campaign:${t.campaignId}`;
    vi.spyOn(db, 'kvGet').mockImplementation(async (key) => {
      if (injected && interleave === 'subsequent-send' && key === keyOfCampaign) { readsAfterWrite++; throw new Error('unnecessary post-CAS read fault'); }
      return get(key);
    });
    vi.spyOn(db, 'kvCompareAndSwap').mockImplementation(async (key, expected, value) => {
      if (!injected && key === keyOfCampaign && value && JSON.parse(value).status === 'approved') {
        const committed = await cas(key, expected, value);
        expect(committed.swapped).toBe(true);
        injected = true;
        if (interleave === 'lost-ack') throw new Error('decision acknowledgement lost');
        expect((await cas(key, value, JSON.stringify({ ...JSON.parse(value), status: 'sending' }))).swapped).toBe(true);
        return committed;
      }
      return cas(key, expected, value);
    });
    const result = await t.admin.post(`${APPROVALS}/${id}/claim`, { expectedContentHash: review?.emailSend?.reviewHash });
    expect(injected).toBe(true);
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    expect(readsAfterWrite).toBe(0);
    vi.restoreAllMocks();
    expect((await getApproval(id))?.status).toBe('approved');
    expect((await getCampaign(t.tenantId, t.orgId, t.campaignId))?.status).toBe(interleave === 'subsequent-send' ? 'sending' : 'approved');
  });

  it.each(['sender', 'audience'] as const)('a %s repin changes the full review digest while template content stays identical; both HTTP lanes refuse stale/missing hashes', async (field) => {
    const t = await team();
    const id = await submit(t.editor, t.orgId, t.campaignId);
    const old = (await getApproval(id))!.emailSend!;
    if (field === 'sender') {
      const settings = new DurableCollection<Record<string, unknown>>('email:settings', (s) => `${String(s.tenantId)}::${String(s.orgId)}`);
      await settings.put({ tenantId: t.tenantId, orgId: t.orgId, senderAddress: 'new@agency.test', updatedBy: 'old-instance', updatedAt: new Date().toISOString() });
    } else {
      const campaigns = new DurableCollection<NonNullable<Awaited<ReturnType<typeof getCampaign>>>>('email:campaign', (c) => c.campaignId);
      const current = await getCampaign(t.tenantId, t.orgId, t.campaignId);
      if (!current) throw new Error('missing fixture campaign');
      await campaigns.put({ ...current, audience: { stage: 'lead' } });
    }
    expect(await submit(t.editor, t.orgId, t.campaignId)).toBe(id);
    const fresh = (await getApproval(id))!.emailSend!;
    expect(fresh.contentHash).toBe(old.contentHash);
    expect(fresh.reviewHash).not.toBe(old.reviewHash);
    const reviewUrl = `/host/openwop-app/reviews/${encodeURIComponent(`approval:${id}`)}`;
    const projected = await t.admin.get(reviewUrl);
    expect(projected.status, JSON.stringify(projected.body)).toBe(200);
    expect(projected.body.emailSend).toMatchObject({ subject: fresh.subject, body: fresh.body, senderAddress: fresh.senderAddress, reviewHash: fresh.reviewHash });
    for (const url of [`${APPROVALS}/${id}/claim`, `${reviewUrl}/actions/approve`]) {
      for (const hash of [undefined, 'wrong-digest', old.reviewHash]) {
        const result = await t.admin.post(url, hash === undefined ? {} : { expectedContentHash: hash });
        expect(result.status, JSON.stringify(result.body)).toBe(409);
        expect(result.body.details).toMatchObject({ reason: 'stale_review', campaignId: 'cmp:<redacted:high-entropy>' });
        expect(JSON.stringify(result.body)).not.toContain(t.campaignId);
        expect((await getApproval(id))?.status).toBe('pending');
        expect((await getCampaign(t.tenantId, t.orgId, t.campaignId))?.status).toBe('in_review');
      }
    }
    const accepted = await t.admin.post(`${reviewUrl}/actions/approve`, { expectedContentHash: fresh.reviewHash });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect((await getCampaign(t.tenantId, t.orgId, t.campaignId))?.status).toBe('approved');
  });

  it('a cross-instance repin between validation and approval CAS stays pending and does not approve the campaign', async () => {
    const t = await team();
    const id = await submit(t.editor, t.orgId, t.campaignId);
    const old = await getApproval(id);
    if (!old?.emailSend) throw new Error('missing fixture review');
    const emailSend = { ...old.emailSend, senderAddress: 'concurrent@agency.test' };
    emailSend.reviewHash = emailSendReviewHash(emailSend);
    const next: PendingApproval = { ...old, emailSend, proposal: 'Concurrent sender repin' };
    const db = hostExtStorage(); const cas = db.kvCompareAndSwap.bind(db);
    let injected = false;
    vi.spyOn(db, 'kvCompareAndSwap').mockImplementation(async (key, expected, value) => {
      if (!injected && key === `hostext:approval:${id}` && value && JSON.parse(value).status === 'approved') {
        injected = true;
        expect((await cas(key, expected, JSON.stringify(next))).swapped).toBe(true);
      }
      return cas(key, expected, value);
    });
    const result = await t.admin.post(`${APPROVALS}/${id}/claim`, { expectedContentHash: old.emailSend.reviewHash });
    expect(injected).toBe(true);
    expect(result.status, JSON.stringify(result.body)).toBe(409);
    expect(await getApproval(id)).toMatchObject({ status: 'pending', emailSend: { senderAddress: 'concurrent@agency.test', reviewHash: emailSend.reviewHash } });
    expect((await getCampaign(t.tenantId, t.orgId, t.campaignId))?.status).toBe('in_review');
  });

  it('a campaign pin race after resolution is refused and reopens only the exact decision snapshot', async () => {
    const t = await team();
    const id = await submit(t.editor, t.orgId, t.campaignId);
    const row = await getApproval(id);
    const current = await getCampaign(t.tenantId, t.orgId, t.campaignId);
    if (!row?.emailSend || !current?.review) throw new Error('missing fixture review');
    const db = hostExtStorage(); const cas = db.kvCompareAndSwap.bind(db);
    let injected = false;
    vi.spyOn(db, 'kvCompareAndSwap').mockImplementation(async (key, expected, value) => {
      if (!injected && key === `hostext:email:campaign:${t.campaignId}` && value && JSON.parse(value).status === 'approved') {
        injected = true;
        const changed = { ...current, review: { ...current.review!, pin: { ...current.review!.pin, audienceHash: 'concurrent-audience' } } };
        expect((await cas(key, expected, JSON.stringify(changed))).swapped).toBe(true);
      }
      return cas(key, expected, value);
    });
    const result = await t.admin.post(`${APPROVALS}/${id}/claim`, { expectedContentHash: row.emailSend.reviewHash });
    expect(injected).toBe(true);
    expect(result.status, JSON.stringify(result.body)).toBe(409);
    expect((await getApproval(id))?.status).toBe('pending');
    expect(await getCampaign(t.tenantId, t.orgId, t.campaignId)).toMatchObject({ status: 'in_review', review: { pin: { audienceHash: 'concurrent-audience' } } });
  });

  it('campaign write failure awaits compensation and reports a compensation write fault', async () => {
    const t = await team();
    const id = await submit(t.editor, t.orgId, t.campaignId);
    const row = await getApproval(id);
    if (!row?.emailSend) throw new Error('missing fixture review');
    const db = hostExtStorage(); const cas = db.kvCompareAndSwap.bind(db);
    let entered!: () => void; let release!: () => void;
    const atCompensation = new Promise<void>((resolve) => { entered = resolve; });
    const unblock = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(db, 'kvCompareAndSwap').mockImplementation(async (key, expected, value) => {
      if (key === `hostext:email:campaign:${t.campaignId}` && value && JSON.parse(value).status === 'approved') throw new Error('campaign write fault');
      if (key === `hostext:approval:${id}` && value && JSON.parse(value).status === 'pending' && expected && JSON.parse(expected).status === 'approved') {
        entered(); await unblock; throw new Error('compensation write fault');
      }
      return cas(key, expected, value);
    });
    const decide = getEmailSendApprovalHandler();
    if (!decide) throw new Error('email handler missing');
    let finished = false;
    const request = decide(t.tenantId, id, 'approved', { decidedByUserId: t.adminId, expectedContentHash: row.emailSend.reviewHash })
      .then((result) => { finished = true; return { result, error: undefined }; }, (error: unknown) => { finished = true; return { result: undefined, error }; });
    await atCompensation;
    try {
      await Promise.resolve();
      expect(finished, 'the decide operation must await the compensating write').toBe(false);
    } finally { release(); }
    expect((await request).error).toMatchObject({ message: 'compensation write fault' });
    expect((await getCampaign(t.tenantId, t.orgId, t.campaignId))?.status).toBe('in_review');
    expect((await getApproval(id))?.status).toBe('approved');
  });

  it('compensation cannot reopen a decision snapshot changed by another instance', async () => {
    const t = await team();
    const id = await submit(t.editor, t.orgId, t.campaignId);
    const row = await getApproval(id);
    const db = hostExtStorage(); const cas = db.kvCompareAndSwap.bind(db);
    let raced = false;
    vi.spyOn(db, 'kvCompareAndSwap').mockImplementation(async (key, expected, value) => {
      if (key === `hostext:email:campaign:${t.campaignId}` && JSON.parse(value).status === 'approved') throw new Error('campaign write fault');
      if (!raced && key === `hostext:approval:${id}` && JSON.parse(value).status === 'pending' && expected && JSON.parse(expected).status === 'approved') {
        raced = true;
        expect((await cas(key, expected, JSON.stringify({ ...JSON.parse(expected), note: 'newer protected decision', decidedBy: 'another-instance' }))).swapped).toBe(true);
      }
      return cas(key, expected, value);
    });
    expect((await t.admin.post(`${APPROVALS}/${id}/claim`, { expectedContentHash: row?.emailSend?.reviewHash })).status).toBe(500);
    expect(raced).toBe(true);
    expect(await getApproval(id)).toMatchObject({ status: 'approved', note: 'newer protected decision', decidedBy: 'another-instance' });
  });

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

    const ok = await approve(t.admin, approvalId);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect((await t.editor.get(E(t.orgId, '/campaigns'))).body.campaigns.find((c: { campaignId: string }) => c.campaignId === t.campaignId)).toMatchObject({ status: 'approved', review: { outcome: 'approved' } });
    // CAS: a second approve is a 409, not a second transition.
    expect((await approve(t.owner, approvalId)).status).toBe(409);
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
    expect((await approve(t.clientUser, approvalId0)).status).toBe(403);
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
    const ok = await approve(t.clientUser, approvalId);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it('stale_review: a template edit while in review returns the campaign to draft and closes the row (review_closed on decide)', async () => {
    const t = await team();
    const approvalId = await submit(t.editor, t.orgId, t.campaignId);
    expect((await t.editor.patch(E(t.orgId, `/templates/${t.templateId}`), { subject: 'Edited' })).status).toBe(200);
    expect((await getCampaign(t.tenantId, t.orgId, t.campaignId))?.status).toBe('draft');
    expect((await getApproval(approvalId))?.status).toBe('rejected');
    expect((await approve(t.admin, approvalId)).status).toBe(409);
  });

  it('stale_review: a sender change the eager path misses still refuses the approve and keeps the row pending', async () => {
    const t = await team();
    const approvalId = await submit(t.editor, t.orgId, t.campaignId);
    // Bypass the eager invalidation: write the settings row the way an old instance would.
    const { DurableCollection } = await import('../src/host/hostExtPersistence.js');
    const raw = new DurableCollection<Record<string, unknown>>('email:settings', (s) => `${String(s.tenantId)}::${String(s.orgId)}`);
    await raw.put({ tenantId: t.tenantId, orgId: t.orgId, senderAddress: 'other@agency.test', updatedBy: 'x', updatedAt: new Date().toISOString() });
    const r = await approve(t.admin, approvalId);
    expect(r.status).toBe(409);
    expect(JSON.stringify(r.body)).toContain('stale_review');
    expect((await getApproval(approvalId))?.status).toBe('pending');
  });

  it('self-approval is refused under the gate while another admin exists; allowed with the gate OFF', async () => {
    const t = await team();
    await enableToggle('email-approval-gate', 'on');
    try {
      const approvalId = await submit(t.admin, t.orgId, t.campaignId);
      const r = await approve(t.admin, approvalId);
      expect(r.status, JSON.stringify(r.body)).toBe(403);
      expect(r.body?.details?.reason).toBe('separation-of-duties');
      expect((await getApproval(approvalId))?.status).toBe('pending');
      expect((await approve(t.owner, approvalId)).status).toBe(200);
    } finally { await enableToggle('email-approval-gate', 'off'); }
    const t2 = await team();
    const id2 = await submit(t2.admin, t2.orgId, t2.campaignId);
    expect((await approve(t2.admin, id2)).status).toBe(200);
  });

  it('another tenant cannot decide the row (uniform 404)', async () => {
    const t = await team();
    const other = await team();
    const approvalId = await submit(t.editor, t.orgId, t.campaignId);
    expect([403, 404]).toContain((await approve(other.owner, approvalId)).status);
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
    expect((await approve(t.admin, approvalId)).status).toBe(200);
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
    expect((await approve(t.admin, approvalId)).status).toBe(200);
    await updateTemplate(t.tenantId, t.orgId, t.templateId, { subject: 'Sneaky edit' });
    expect((await getCampaign(t.tenantId, t.orgId, t.campaignId))?.status).toBe('draft');
    await enableToggle('email-approval-gate', 'on');
    try {
      await expect(sendCampaign(t.tenantId, t.orgId, t.campaignId, { provider })).rejects.toMatchObject({ httpStatus: 409 });
      expect(delivered).toHaveLength(0);
    } finally { await enableToggle('email-approval-gate', 'off'); }
  });

  // The hook pauses the actual storage CAS, after send admission and audience
  // resolution. The competing operation commits through its real service before
  // the original CAS resumes; no clock sleeps or mocked authorization predicates.
  async function raceFirstPin(campaignId: string, competing: (next: Campaign, commit: (expected: Campaign, next: Campaign) => Promise<boolean>) => Promise<void>) {
    const storage = hostExtStorage();
    const realCas = storage.kvCompareAndSwap.bind(storage);
    let intercepted = false;
    const spy = vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (key, expected, value) => {
      if (!intercepted && key === `hostext:email:campaign:${campaignId}`) {
        const next = JSON.parse(value) as Campaign;
        if (next.status === 'sending') {
          intercepted = true;
          await competing(next, async (before, after) =>
            (await realCas(key, JSON.stringify(before), JSON.stringify(after))).swapped);
        }
      }
      return realCas(key, expected, value);
    });
    return { spy, wasIntercepted: () => intercepted };
  }

  it.each(['withdraw', 'template edit'] as const)('a %s winning the first send CAS cannot be resurrected by a retry', async (change) => {
    const t = await team();
    await createContact({ tenantId: t.tenantId, name: 'Recipient', email: 'recipient@example.test', stage: 'lead' });
    const approvalId = await submit(t.editor, t.orgId, t.campaignId);
    expect((await approve(t.admin, approvalId)).status).toBe(200);
    await enableToggle('email-approval-gate', 'on');
    const race = await raceFirstPin(t.campaignId, async () => {
      if (change === 'withdraw') await withdrawReview(t.tenantId, t.orgId, t.campaignId);
      else await updateTemplate(t.tenantId, t.orgId, t.templateId, { subject: 'Unapproved replacement' });
    });
    try {
      await expect(sendCampaign(t.tenantId, t.orgId, t.campaignId, { provider })).rejects.toMatchObject({ httpStatus: 409, details: { reason: 'approval_stale' } });
      expect(race.wasIntercepted()).toBe(true);
      expect(delivered).toHaveLength(0);
      expect(await getCampaign(t.tenantId, t.orgId, t.campaignId)).toMatchObject({ status: 'draft', review: { approvalId, outcome: 'closed' } });
      expect((await getCampaign(t.tenantId, t.orgId, t.campaignId))?.sendPin).toBeUndefined();
    } finally { race.spy.mockRestore(); await enableToggle('email-approval-gate', 'off'); }
  });

  it.each(['newer review', 'completed generation', 'corrupted pinned bytes'] as const)('a stale attempt cannot adopt a %s pin', async (change) => {
    const t = await team();
    await createContact({ tenantId: t.tenantId, name: 'Recipient', email: 'recipient@example.test', stage: 'lead' });
    const approvalId = await submit(t.editor, t.orgId, t.campaignId);
    expect((await approve(t.admin, approvalId)).status).toBe(200);
    await enableToggle('email-approval-gate', 'on');
    let winner: Campaign | undefined;
    const race = await raceFirstPin(t.campaignId, async (next, commit) => {
      if (change === 'newer review') {
        await withdrawReview(t.tenantId, t.orgId, t.campaignId);
        const newerApproval = await submit(t.editor, t.orgId, t.campaignId);
        expect(newerApproval).not.toBe(approvalId);
        expect((await approve(t.admin, newerApproval)).status).toBe(200);
      }
      const before = (await getCampaign(t.tenantId, t.orgId, t.campaignId))!;
      // The real new cycle has identical content but different authority. A peer
      // installs its pin through the actual storage CAS, not a stubbed CAS result.
      winner = { ...before, status: change === 'completed generation' ? 'sent' : 'sending', sendPin: change === 'corrupted pinned bytes' ? { ...next.sendPin!, body: 'Unapproved bytes' } : next.sendPin };
      expect(await commit(before, winner)).toBe(true);
    });
    try {
      await expect(sendCampaign(t.tenantId, t.orgId, t.campaignId, { provider })).rejects.toMatchObject({ httpStatus: 409, details: { reason: 'approval_stale' } });
      expect(race.wasIntercepted()).toBe(true);
      expect(delivered).toHaveLength(0);
      expect(await getCampaign(t.tenantId, t.orgId, t.campaignId)).toEqual(winner);
    } finally { race.spy.mockRestore(); await enableToggle('email-approval-gate', 'off'); }
  });

  it.each(['unrelated update', 'same approved send'] as const)('a CAS lost to %s preserves the approved send', async (change) => {
    const t = await team();
    await createContact({ tenantId: t.tenantId, name: 'Recipient', email: 'recipient@example.test', stage: 'lead' });
    const approvalId = await submit(t.editor, t.orgId, t.campaignId);
    expect((await approve(t.admin, approvalId)).status).toBe(200);
    await enableToggle('email-approval-gate', 'on');
    const race = await raceFirstPin(t.campaignId, async (next, commit) => {
      const original = await getCampaign(t.tenantId, t.orgId, t.campaignId);
      const winner = change === 'same approved send' ? next : { ...original!, updatedAt: 'unrelated-write' };
      expect(await commit(original!, winner)).toBe(true);
    });
    try {
      expect((await sendCampaign(t.tenantId, t.orgId, t.campaignId, { provider }))?.status).toBe('sent');
      expect(race.wasIntercepted()).toBe(true);
      expect(delivered).toHaveLength(1);
      expect(delivered[0].subject).toBe('Big news');
    } finally { race.spy.mockRestore(); await enableToggle('email-approval-gate', 'off'); }
  });


  it('a continuation rechecks its generation after audience resolution', async () => {
    const tpl = await createTemplate({ tenantId: T, orgId: T, name: 'N', subject: 'S', body: 'B', createdBy: 'u1' });
    const c = await createCampaign({ tenantId: T, orgId: T, templateId: tpl.templateId, createdBy: 'u1' });
    const first = await sendCampaign(T, T, c.campaignId, { provider, limit: 1 });
    expect(delivered).toHaveLength(1);
    const storage = hostExtStorage();
    const realGet = storage.kvGet.bind(storage);
    let reads = 0;
    const winner: Campaign = { ...first!, status: 'sending', sendGeneration: 1, sendPin: { ...first!.sendPin!, generation: 1 } };
    const spy = vi.spyOn(storage, 'kvGet').mockImplementation(async (key) => {
      if (key === `hostext:email:campaign:${c.campaignId}` && ++reads === 2) {
        await storage.kvSet(key, JSON.stringify(winner));
      }
      return realGet(key);
    });
    try {
      await expect(sendCampaign(T, T, c.campaignId, { provider })).rejects.toMatchObject({ httpStatus: 409, details: { reason: 'send_changed' } });
      expect(reads).toBeGreaterThanOrEqual(2);
      expect(delivered).toHaveLength(1);
      expect(await getCampaign(T, T, c.campaignId)).toEqual(winner);
    } finally { spy.mockRestore(); }
  });

  it('completion preserves a newer generation that starts while the provider is sending', async () => {
    const tpl = await createTemplate({ tenantId: T, orgId: T, name: 'N', subject: 'S', body: 'B', createdBy: 'u1' });
    const c = await createCampaign({ tenantId: T, orgId: T, templateId: tpl.templateId, createdBy: 'u1' });
    let winner: Campaign | undefined;
    const concurrentProvider = { id: 'test-transport', send: async (message: EmailMessage) => {
      delivered.push(message);
      const current = await getCampaign(T, T, c.campaignId);
      winner = { ...current!, sendGeneration: 1, sendPin: { ...current!.sendPin!, generation: 1 }, stats: { sent: 7, skipped: 0, failed: 0 } };
      await hostExtStorage().kvSet(`hostext:email:campaign:${c.campaignId}`, JSON.stringify(winner));
    } };
    await expect(sendCampaign(T, T, c.campaignId, { provider: concurrentProvider, limit: 1 })).rejects.toMatchObject({ httpStatus: 409, details: { reason: 'send_changed' } });
    expect(delivered).toHaveLength(1);
    expect(await getCampaign(T, T, c.campaignId)).toEqual(winner);
  });


  it('a gate-OFF first send cannot replace a newer generation after a lost CAS', async () => {
    const tpl = await createTemplate({ tenantId: T, orgId: T, name: 'N', subject: 'S', body: 'B', createdBy: 'u1' });
    const c = await createCampaign({ tenantId: T, orgId: T, templateId: tpl.templateId, createdBy: 'u1' });
    let winner: Campaign | undefined;
    const race = await raceFirstPin(c.campaignId, async (next, commit) => {
      const before = (await getCampaign(T, T, c.campaignId))!;
      winner = { ...next, sendGeneration: 1, sendPin: { ...next.sendPin!, generation: 1 } };
      expect(await commit(before, winner)).toBe(true);
    });
    try {
      await expect(sendCampaign(T, T, c.campaignId, { provider })).rejects.toMatchObject({ httpStatus: 409, details: { reason: 'send_changed' } });
      expect(race.wasIntercepted()).toBe(true);
      expect(delivered).toHaveLength(0);
      expect(await getCampaign(T, T, c.campaignId)).toEqual(winner);
    } finally { race.spy.mockRestore(); }
  });

  it('a partial pass preserves a peer completion of the same generation', async () => {
    const tpl = await createTemplate({ tenantId: T, orgId: T, name: 'N', subject: 'S', body: 'B', createdBy: 'u1' });
    const c = await createCampaign({ tenantId: T, orgId: T, templateId: tpl.templateId, createdBy: 'u1' });
    let winner: Campaign | undefined;
    const concurrentProvider = { id: 'test-transport', send: async (message: EmailMessage) => {
      delivered.push(message);
      const current = (await getCampaign(T, T, c.campaignId))!;
      winner = { ...current, status: 'sent', stats: { sent: 3, skipped: 0, failed: 0 } };
      await hostExtStorage().kvSet(`hostext:email:campaign:${c.campaignId}`, JSON.stringify(winner));
    } };
    expect(await sendCampaign(T, T, c.campaignId, { provider: concurrentProvider, limit: 1 })).toEqual(winner);
    expect(await getCampaign(T, T, c.campaignId)).toEqual(winner);
    expect(delivered).toHaveLength(1);
  });


  it('approval from sent starts one new generation and its continuation keeps the approved bytes', async () => {
    const t = await team();
    for (const name of ['a', 'b']) await createContact({ tenantId: t.tenantId, name, email: `${name}@resend.test`, stage: 'lead' });
    expect((await sendCampaign(t.tenantId, t.orgId, t.campaignId, { provider }))?.status).toBe('sent');
    await updateTemplate(t.tenantId, t.orgId, t.templateId, { subject: 'Approved second generation' });
    const approvalId = await submit(t.editor, t.orgId, t.campaignId);
    expect((await approve(t.admin, approvalId)).status).toBe(200);
    delivered = [];
    await enableToggle('email-approval-gate', 'on');
    try {
      const first = await sendCampaign(t.tenantId, t.orgId, t.campaignId, { provider, limit: 1 });
      expect(first).toMatchObject({ status: 'sending', sendGeneration: 1, sendPin: { generation: 1, subject: 'Approved second generation' } });
      expect((await sendCampaign(t.tenantId, t.orgId, t.campaignId, { provider }))?.status).toBe('sent');
      expect(delivered).toHaveLength(2);
      expect(delivered.map((message) => message.subject)).toEqual(['Approved second generation', 'Approved second generation']);
      expect(new Set(delivered.map((message) => message.idempotencyKey)).size).toBe(2);
      expect(delivered.every((message) => message.idempotencyKey?.includes(':g1:') === true)).toBe(true);
    } finally { await enableToggle('email-approval-gate', 'off'); }
  });

});
