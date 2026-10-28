/**
 * ADR 0922 P0b / D5 — the `openwop.email.template` adapter over ADR 0905 template
 * versions, at the adapter seam campaign-ops execution (ADR 0925) calls.
 *
 * Pins: the source identity is 0905's version and content hash; another client's
 * template reads as none (so it cannot be registered); an edit outside subject and
 * body is refused; a stale expected version is a version conflict, never a blind
 * write; the write needs `workspace:write` on the client org; a template a campaign
 * is sending or has sent is refused `email_already_sent` (PRD scenario 10) and left
 * unchanged; and the email toggle being off refuses `destination_unavailable`.
 *
 * Sabotage notes (each run, 2026-10-19):
 *  - drop the `alreadySent` check → red (the sent template is rewritten);
 *  - drop the adapter's own expected-version compare → STAYS GREEN, correctly:
 *    0905's `updateTemplate` enforces the same pin. Dropping both the compare and
 *    the `expectedVersion` passed to `updateTemplate` → red (the stale write lands);
 *  - drop the `assertOrgScope` check → red (a viewer's write lands);
 *  - read the template across every org of the tenant → red (client B’s template
 *    registers on A).
 */
import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { hostExtStorage } from '../src/host/hostExtPersistence.js';
import { createContact } from '../src/features/crm/contactsService.js';
import { recordConsent } from '../src/features/consent/consentService.js';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createMember, createOrg, createWorkspace } from '../src/host/accessControlService.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';
import {
  createCampaign, createTemplate, getTemplate, templateContentHash, templateVersionOf, updateCampaignRow, updateTemplate, sendCampaign, setSenderAddress, getTemplateVersion, type EmailTemplate, type EmailMessage,
} from '../src/features/email/emailService.js';
import { createClient } from '../src/features/campaign-ops/clientService.js';
import { addAsset } from '../src/features/campaign-ops/assetService.js';
import { emailTemplateAdapter } from '../src/features/campaign-ops/adapters/emailTemplate.js';
import { adapterFor } from '../src/features/campaign-ops/adapters/registry.js';
import type { CampaignAsset } from '../src/features/campaign-ops/types.js';

let TENANT: string;
let orgA: string;
let orgB: string;
let editor: string;
let viewer: string;

const emailToggle = async (status: 'on' | 'off') => {
  const d = getToggleDefault('email');
  if (d) await saveConfig({ ...d, status }, 'test');
};

async function emailAsset(orgId = orgA, body = 'Join us Tuesday, Nov 3 at https://example.test/register-old'): Promise<{ asset: CampaignAsset; templateId: string }> {
  const t = await createTemplate({ tenantId: TENANT, orgId, name: `Invite ${randomBytes(3).toString('hex')}`, subject: 'Webinar: Tuesday, Nov 3', body, createdBy: 'seed' });
  const asset = await addAsset({
    tenantId: TENANT, orgId, destination: 'openwop.email.template', locator: { templateId: t.templateId },
    label: 'Webinar invite', editableFields: ['subject', 'body'], createdBy: 'seed',
  });
  return { asset, templateId: t.templateId };
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  for (const id of ['cms', 'email', 'campaign-ops']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
  TENANT = (await createWorkspace({ name: 'Agency', ownerSubject: 'oidc:email-owner' })).tenantId;
  editor = (await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:email-editor', source: 'oidc' })).userId;
  viewer = (await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:email-viewer', source: 'oidc' })).userId;
  orgA = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client A' })).orgId;
  orgB = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client B' })).orgId;
  await createMember({ tenantId: TENANT, orgId: orgA, subject: editor, displayName: 'Editor', roles: ['editor'] });
  await createMember({ tenantId: TENANT, orgId: orgA, subject: viewer, displayName: 'Viewer', roles: ['viewer'] });
  await createClient({ tenantId: TENANT, orgId: orgA, name: 'Client A', createdBy: 'seed' });
  await createClient({ tenantId: TENANT, orgId: orgB, name: 'Client B', createdBy: 'seed' });
});

describe('ADR 0922 D5 — read and registration', () => {
  it('is registered and reads the template through 0905 version and content hash', async () => {
    expect(adapterFor('openwop.email.template')).toBe(emailTemplateAdapter);
    const { asset, templateId } = await emailAsset();
    const t = (await getTemplate(TENANT, orgA, templateId))!;
    const snap = await emailTemplateAdapter.read(asset, { tenantId: TENANT });
    expect(snap).toMatchObject({ version: templateVersionOf(t), contentHash: templateContentHash(t), fields: { subject: t.subject, body: t.body } });
    expect(asset.lastKnown).toMatchObject({ version: templateVersionOf(t), contentHash: templateContentHash(t) });
  });

  it('another client’s template reads as none and cannot be registered', async () => {
    const t = await createTemplate({ tenantId: TENANT, orgId: orgB, name: 'B only', subject: 'B', body: 'B', createdBy: 'seed' });
    expect(await emailTemplateAdapter.read({ orgId: orgA, locator: { templateId: t.templateId } }, { tenantId: TENANT })).toBeNull();
    await expect(addAsset({
      tenantId: TENANT, orgId: orgA, destination: 'openwop.email.template', locator: { templateId: t.templateId },
      label: 'x', editableFields: ['subject'], createdBy: 'seed',
    })).rejects.toMatchObject({ httpStatus: 404 });
  });

  it('only subject and body are editable fields', async () => {
    const t = await createTemplate({ tenantId: TENANT, orgId: orgA, name: 'N', subject: 'S', body: 'B', createdBy: 'seed' });
    await expect(addAsset({
      tenantId: TENANT, orgId: orgA, destination: 'openwop.email.template', locator: { templateId: t.templateId },
      label: 'x', editableFields: ['name'], createdBy: 'seed',
    })).rejects.toMatchObject({ httpStatus: 400 });
  });
});

describe('ADR 0922 D5 — preview and write', () => {
  const edits = [{ field: 'subject', find: 'Tuesday, Nov 3', replace: 'Thursday, Nov 5' }];

  it('preview shows the change without writing; write lands one new version', async () => {
    const { asset, templateId } = await emailAsset();
    const v1 = templateVersionOf((await getTemplate(TENANT, orgA, templateId))!);
    const p = await emailTemplateAdapter.preview(asset, edits, { tenantId: TENANT });
    expect(p).toMatchObject({ sourceVersion: v1, before: { subject: 'Webinar: Tuesday, Nov 3' }, after: { subject: 'Webinar: Thursday, Nov 5' } });
    expect(templateVersionOf((await getTemplate(TENANT, orgA, templateId))!)).toBe(v1);
    const w = await emailTemplateAdapter.write(asset, edits, { expectedVersion: v1 }, { tenantId: TENANT, actingUserId: editor });
    expect(w).toEqual({ kind: 'written', version: v1 + 1 });
    expect((await getTemplate(TENANT, orgA, templateId))!.subject).toBe('Webinar: Thursday, Nov 5');
  });

  it('a stale expected version is a version conflict and writes nothing', async () => {
    const { asset, templateId } = await emailAsset();
    const v1 = templateVersionOf((await getTemplate(TENANT, orgA, templateId))!);
    await updateTemplate(TENANT, orgA, templateId, { body: 'A human edited this.' }, { actor: 'human' });
    const w = await emailTemplateAdapter.write(asset, edits, { expectedVersion: v1 }, { tenantId: TENANT, actingUserId: editor });
    expect(w).toMatchObject({ kind: 'version_conflict', currentVersion: v1 + 1 });
    expect((await getTemplate(TENANT, orgA, templateId))!.subject).toBe('Webinar: Tuesday, Nov 3');
  });

  it('needs workspace:write on the client org', async () => {
    const { asset, templateId } = await emailAsset();
    const v1 = templateVersionOf((await getTemplate(TENANT, orgA, templateId))!);
    const w = await emailTemplateAdapter.write(asset, edits, { expectedVersion: v1 }, { tenantId: TENANT, actingUserId: viewer });
    expect(w).toMatchObject({ kind: 'refused', reason: 'not_authorized' });
    expect(templateVersionOf((await getTemplate(TENANT, orgA, templateId))!)).toBe(v1);
  });

  it('a field outside the asset’s editable fields, or a find that no longer matches, is refused', async () => {
    const { asset, templateId } = await emailAsset();
    const v1 = templateVersionOf((await getTemplate(TENANT, orgA, templateId))!);
    const narrowed = { ...asset, editableFields: ['body'] };
    expect(await emailTemplateAdapter.write(narrowed, edits, { expectedVersion: v1 }, { tenantId: TENANT, actingUserId: editor }))
      .toMatchObject({ kind: 'refused', reason: 'not_editable', detail: 'subject' });
    expect(await emailTemplateAdapter.write(asset, [{ field: 'body', find: 'not there', replace: 'x' }], { expectedVersion: v1 }, { tenantId: TENANT, actingUserId: editor }))
      .toMatchObject({ kind: 'refused', reason: 'edit_mismatch', detail: 'body' });
  });

  it('scenario 10: a template a campaign is sending or has sent is never changed', async () => {
    for (const status of ['sending', 'sent'] as const) {
      const { asset, templateId } = await emailAsset();
      const c = await createCampaign({ tenantId: TENANT, orgId: orgA, templateId, createdBy: 'seed' });
      await updateCampaignRow(TENANT, orgA, c.campaignId, (row) => ({ ...row, status }));
      const before = (await getTemplate(TENANT, orgA, templateId))!;
      const w = await emailTemplateAdapter.write(asset, edits, { expectedVersion: templateVersionOf(before) }, { tenantId: TENANT, actingUserId: editor });
      expect(w, status).toMatchObject({ kind: 'refused', reason: 'email_already_sent' });
      expect((w as { detail?: string }).detail).toContain('create a new draft');
      const after = (await getTemplate(TENANT, orgA, templateId))!;
      expect(templateContentHash(after), status).toBe(templateContentHash(before));
    }
  });

  it('a draft campaign does not block the write', async () => {
    const { asset, templateId } = await emailAsset();
    await createCampaign({ tenantId: TENANT, orgId: orgA, templateId, createdBy: 'seed' });
    const v1 = templateVersionOf((await getTemplate(TENANT, orgA, templateId))!);
    expect(await emailTemplateAdapter.write(asset, edits, { expectedVersion: v1 }, { tenantId: TENANT, actingUserId: editor }))
      .toMatchObject({ kind: 'written' });
  });

  it('refuses destination_unavailable while the email toggle is off', async () => {
    const { asset, templateId } = await emailAsset();
    const v1 = templateVersionOf((await getTemplate(TENANT, orgA, templateId))!);
    await emailToggle('off');
    try {
      expect(await emailTemplateAdapter.preview(asset, edits, { tenantId: TENANT })).toMatchObject({ refused: 'destination_unavailable' });
      expect(await emailTemplateAdapter.write(asset, edits, { expectedVersion: v1 }, { tenantId: TENANT, actingUserId: editor }))
        .toMatchObject({ kind: 'refused', reason: 'destination_unavailable' });
    } finally {
      await emailToggle('on');
    }
    expect(templateVersionOf((await getTemplate(TENANT, orgA, templateId))!)).toBe(v1);
  });

  it('a send winning after the adapter precheck makes its real template CAS refuse without changing delivered bytes', async () => {
    const { asset, templateId } = await emailAsset();
    const original = (await getTemplate(TENANT, orgA, templateId))!;
    const campaign = await createCampaign({ tenantId: TENANT, orgId: orgA, templateId, createdBy: editor });
    await setSenderAddress(TENANT, orgA, 'news@client.test', editor);
    const contact = await createContact({ tenantId: TENANT, name: 'Recipient', email: 'recipient@client.test', stage: 'lead' });
    await recordConsent({ tenantId: TENANT, subjectKey: contact.contactId, categories: { marketing: true, 'marketing.email': true }, source: 'test' });
    const priorLinkBase = process.env.OPENWOP_EMAIL_LINK_BASE_URL;
    process.env.OPENWOP_EMAIL_LINK_BASE_URL = 'https://app.example';
    const gate = getToggleDefault('email-approval-gate');
    if (gate) await saveConfig({ ...gate, status: 'off' }, 'test');
    const db = hostExtStorage(); const cas = db.kvCompareAndSwap.bind(db);
    const delivered: EmailMessage[] = [];
    let raced = false;
    const spy = vi.spyOn(db, 'kvCompareAndSwap').mockImplementation(async (key, before, after) => {
      if (!raced && key === `hostext:email:template:${templateId}` && after) {
        const proposed = JSON.parse(after) as EmailTemplate;
        if (templateVersionOf(proposed) > templateVersionOf(original)) {
          raced = true;
          expect((await sendCampaign(TENANT, orgA, campaign.campaignId, { provider: { id: 'test', send: async (message) => { delivered.push(message); } } }))?.status).toBe('sent');
        }
      }
      return cas(key, before, after);
    });
    try {
      expect(await emailTemplateAdapter.write(asset, edits, { expectedVersion: templateVersionOf(original) }, { tenantId: TENANT, actingUserId: editor })).toMatchObject({ kind: 'refused', reason: 'email_already_sent' });
      expect(raced).toBe(true);
      const final = (await getTemplate(TENANT, orgA, templateId))!;
      expect(templateVersionOf(final)).toBe(templateVersionOf(original));
      expect(templateContentHash(final)).toBe(templateContentHash(original));
      expect(await getTemplateVersion(TENANT, orgA, templateId, templateVersionOf(original) + 1)).toBeNull();
      expect(delivered).toHaveLength(1);
      expect(delivered[0].subject).toBe(original.subject);
      expect(delivered[0].body).toContain('Join us Tuesday, Nov 3 at');
    } finally {
      spy.mockRestore();
      if (priorLinkBase === undefined) delete process.env.OPENWOP_EMAIL_LINK_BASE_URL;
      else process.env.OPENWOP_EMAIL_LINK_BASE_URL = priorLinkBase;
    }
  });

});
