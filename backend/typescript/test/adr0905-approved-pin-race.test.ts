/**
 * ADR 0905 follow-up (ADR 0922/0924, a0's required addition): an edit that lands
 * AFTER a send passed its approval check but BEFORE the pin must never go out
 * unapproved. `pinSend` compares the approval's {templateVersion, contentHash} with
 * the template row inside the same CAS that sets the send hold, and refuses with a
 * typed 409 `approval_stale` (the campaign goes back to draft and loses its approval).
 *
 * The window is forced deterministically with the before-pin test hook.
 *
 * Sabotage-witnessed: dropping the approved-hash compare in `holdTemplateForSend`
 * reds both cases (the edited template is delivered).
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import {
  createTemplate, createCampaign, sendCampaign, setSenderAddress, updateTemplate, getCampaign,
  __setBeforePinHookForTests, type EmailMessage, type EmailTemplate,
} from '../src/features/email/emailService.js';
import { submitForReview } from '../src/features/email/sendApproval.js';
import { getEmailSendApprovalHandler, getApproval } from '../src/host/approvalService.js';
import { createContact } from '../src/features/crm/contactsService.js';
import { createOrg } from '../src/host/accessControlService.js';
import { DurableCollection } from '../src/host/hostExtPersistence.js';

const T = 'tPinRace';
let ORG = '';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_EMAIL_LINK_BASE_URL = 'https://app.example';
  await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  ORG = (await createOrg({ tenantId: T, createdBy: 'owner', name: 'Acme', ownerSubject: 'owner' })).orgId;
  await setSenderAddress(T, ORG, 'sender@acme.test', 'owner');
  await createContact({ tenantId: T, name: 'A', email: 'a@x.com', stage: 'lead' });
  const d = getToggleDefault('email-approval-gate'); if (d) await saveConfig({ ...d, status: 'on' }, 'test');
});
afterEach(() => { __setBeforePinHookForTests(null); });

async function approved(): Promise<{ templateId: string; campaignId: string; approvalId: string }> {
  const tpl = await createTemplate({ tenantId: T, orgId: ORG, name: 'N', subject: 'Approved subject', body: 'B', createdBy: 'editor' });
  const c = await createCampaign({ tenantId: T, orgId: ORG, templateId: tpl.templateId, createdBy: 'editor' });
  const { approval } = await submitForReview(T, ORG, c.campaignId, 'editor');
  const decided = await getEmailSendApprovalHandler()!(T, approval.approvalId, 'approved', { decidedByUserId: 'owner', expectedContentHash: approval.emailSend?.reviewHash });
  expect(decided?.changed).toBe(true);
  expect((await getCampaign(T, ORG, c.campaignId))?.status).toBe('approved');
  return { templateId: tpl.templateId, campaignId: c.campaignId, approvalId: approval.approvalId };
}

describe('approve → edit (in the pin window) → pinSend refuses', () => {
  it('a normal edit in the window: approval_stale, nothing delivered, campaign back to draft', async () => {
    const { templateId, campaignId } = await approved();
    __setBeforePinHookForTests(async (id) => { if (id === campaignId) await updateTemplate(T, ORG, templateId, { subject: 'Sneaky' }); });
    const delivered: EmailMessage[] = [];
    await expect(sendCampaign(T, ORG, campaignId, { provider: { id: 'x', send: async (m: EmailMessage) => { delivered.push(m); } } }))
      .rejects.toMatchObject({ httpStatus: 409, details: { reason: 'approval_stale' } });
    expect(delivered).toHaveLength(0);
    expect((await getCampaign(T, ORG, campaignId))?.status).toBe('draft');
  });

  it('a raw edit that skips the back-to-draft reset (an old instance): still refused, the campaign loses its approval', async () => {
    const { templateId, campaignId, approvalId } = await approved();
    const raw = new DurableCollection<EmailTemplate>('email:template', (x) => x.templateId, undefined, (x) => x.tenantId);
    __setBeforePinHookForTests(async (id) => {
      if (id !== campaignId) return;
      const row = await raw.get(templateId);
      await raw.put({ ...row!, subject: 'Sneaky', version: 2, contentHash: 'changed' });
    });
    const delivered: EmailMessage[] = [];
    await expect(sendCampaign(T, ORG, campaignId, { provider: { id: 'x', send: async (m: EmailMessage) => { delivered.push(m); } } }))
      .rejects.toMatchObject({ httpStatus: 409, details: { reason: 'approval_stale' } });
    expect(delivered).toHaveLength(0);
    // The approval row was already decided (approved); the CAMPAIGN loses it.
    expect(await getCampaign(T, ORG, campaignId)).toMatchObject({ status: 'draft', review: { approvalId, outcome: 'closed' } });
    expect((await getApproval(approvalId))?.status).toBe('approved');
  });
});
