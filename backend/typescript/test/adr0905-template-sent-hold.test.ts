/**
 * ADR 0905 follow-up for ADR 0922 (the campaign-ops email adapter):
 *
 *  1. `updateTemplate(…, { refuseIfSent: true })` refuses ATOMICALLY with a typed 409
 *     `template_sent` once a send has pinned the template — the hold is CAS-set on the
 *     TEMPLATE row before the campaign's pin, and the refusal is checked inside the
 *     edit's own CAS on that row, so an edit and a send start cannot both win.
 *     Without the option, 0905's own lanes keep versioning (D1).
 *  2. `campaignsUsingTemplate` is the one in-use lookup (statuses included).
 *  3. Every template / version / campaign read and write is keyed by (tenant, org):
 *     another org's id is not-found.
 *
 * Sabotage-witnessed: dropping the hold write in `pinSend`, or the hold check in
 * `updateTemplate`, reds the "refusal comes from the hold" case (a campaign scan alone
 * cannot refuse once the campaign is gone); dropping the legacy backfill reds the
 * pre-hold case. The race case forces BOTH orders with the before-pin hook (an
 * unforced `Promise.allSettled` need not interleave at all — w73 round 1): pinning
 * from the stale pre-hook read instead of the held row reds its edit-first leg.
 * The in-use lookup has a campaign on a SECOND template that must be excluded, so
 * dropping its `templateId` filter reds it (the w73 round-1 fixture used one
 * template only, and that probe was vacuous).
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import {
  __resetEmailStore, createTemplate, createCampaign, sendCampaign, setSenderAddress, updateTemplate, getTemplate,
  getTemplateVersion, listTemplateVersions, restoreTemplateVersion, deleteTemplate, getCampaign, campaignsUsingTemplate,
  __setBeforePinHookForTests,
  type EmailMessage, type EmailTemplate,
} from '../src/features/email/emailService.js';
import { createContact, __resetCrmStore } from '../src/features/crm/contactsService.js';
import { __resetConsentStore } from '../src/features/consent/consentService.js';
import { DurableCollection } from '../src/host/hostExtPersistence.js';

const T = 'tHold';
const ORG = 'o1';
const delivered: EmailMessage[] = [];
const provider = { id: 'test-transport', send: async (m: EmailMessage) => { delivered.push(m); } };

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
}, 120_000);
afterEach(() => { __setBeforePinHookForTests(null); });

beforeEach(async () => {
  process.env.OPENWOP_EMAIL_LINK_BASE_URL = 'https://app.example';
  await __resetEmailStore(); await __resetCrmStore(); await __resetConsentStore();
  delivered.length = 0;
  await setSenderAddress(T, ORG, 'sender@acme.test', 'u1');
  for (const x of ['a', 'b']) await createContact({ tenantId: T, name: x, email: `${x}@x.com`, stage: 'lead' });
});

async function draft(): Promise<{ templateId: string; campaignId: string }> {
  const tpl = await createTemplate({ tenantId: T, orgId: ORG, name: 'N', subject: 'Original', body: 'B', createdBy: 'u1' });
  const c = await createCampaign({ tenantId: T, orgId: ORG, templateId: tpl.templateId, createdBy: 'u1' });
  return { templateId: tpl.templateId, campaignId: c.campaignId };
}

describe('template_sent — the atomic refusal', () => {
  it('after a send starts, a refuseIfSent edit is a typed 409; a plain edit still versions', async () => {
    const { templateId, campaignId } = await draft();
    await sendCampaign(T, ORG, campaignId, { provider, limit: 1 });
    await expect(updateTemplate(T, ORG, templateId, { subject: 'Changed' }, { refuseIfSent: true, expectedVersion: 1 }))
      .rejects.toMatchObject({ httpStatus: 409, details: { reason: 'template_sent', templateId } });
    expect((await getTemplate(T, ORG, templateId))?.subject).toBe('Original');
    const plain = await updateTemplate(T, ORG, templateId, { subject: 'New wave' });
    expect(plain?.version).toBe(2);
  });

  it('the refusal comes from the hold on the template row, not from a campaign scan', async () => {
    const { templateId, campaignId } = await draft();
    await sendCampaign(T, ORG, campaignId, { provider });
    const { deleteCampaign } = await import('../src/features/email/emailService.js');
    await deleteCampaign(T, ORG, campaignId); // no campaign references it any more…
    expect(await campaignsUsingTemplate(T, ORG, templateId)).toEqual([]);
    await expect(updateTemplate(T, ORG, templateId, { subject: 'X' }, { refuseIfSent: true }))
      .rejects.toMatchObject({ httpStatus: 409, details: { reason: 'template_sent' } }); // …the held row still refuses
  });

  it('before any send, a refuseIfSent edit succeeds', async () => {
    const { templateId } = await draft();
    expect((await updateTemplate(T, ORG, templateId, { subject: 'Draft 2' }, { refuseIfSent: true }))?.version).toBe(2);
  });

  it('an edit and a send start racing: exactly one wins, and the send pins what it saw', async () => {
    // Edit first: the edit lands inside the send, after its template read and before
    // the hold. The send must pin the row it HELD (the edited one), not its stale read.
    const first = await draft();
    let editLanded = false;
    __setBeforePinHookForTests(async (id) => {
      if (id !== first.campaignId) return;
      await updateTemplate(T, ORG, first.templateId, { subject: 'Edited' }, { refuseIfSent: true });
      editLanded = true;
    });
    await sendCampaign(T, ORG, first.campaignId, { provider, limit: 1 });
    expect(editLanded, 'the edit ran in the window').toBe(true);
    expect((await getCampaign(T, ORG, first.campaignId))?.sendPin?.subject, 'edit first ⇒ the send pins the edited content').toBe('Edited');
    expect(delivered.map((m) => m.subject)).toEqual(['Edited']);
    __setBeforePinHookForTests(null);

    // Send first: the hold is on the row, so the edit is refused and the original stays pinned.
    const second = await draft();
    await sendCampaign(T, ORG, second.campaignId, { provider, limit: 1 });
    await expect(updateTemplate(T, ORG, second.templateId, { subject: 'Edited' }, { refuseIfSent: true }))
      .rejects.toMatchObject({ httpStatus: 409, details: { reason: 'template_sent', templateId: second.templateId } });
    expect((await getCampaign(T, ORG, second.campaignId))?.sendPin?.subject, 'send first ⇒ the edit was refused, the original went out').toBe('Original');
    expect((await getTemplate(T, ORG, second.templateId))?.subject).toBe('Original');
  });

  it('a template sent before the hold existed is held on the first refuseIfSent call', async () => {
    const { templateId, campaignId } = await draft();
    await sendCampaign(T, ORG, campaignId, { provider });
    // Simulate a pre-hold row: strip the hold off the template.
    const raw = new DurableCollection<EmailTemplate>('email:template', (x) => x.templateId, undefined, (x) => x.tenantId);
    const row = await raw.get(templateId);
    const { sendHold: _h, ...legacy } = row!;
    await raw.put(legacy);
    await expect(updateTemplate(T, ORG, templateId, { subject: 'X' }, { refuseIfSent: true })).rejects.toMatchObject({ httpStatus: 409 });
    expect((await raw.get(templateId))?.sendHold, 'the backfill adds the hold').toBeTruthy();
  });
});

describe('campaignsUsingTemplate', () => {
  it('lists the campaigns that reference the template, with their status, in this org only', async () => {
    const { templateId, campaignId } = await draft();
    const second = await createCampaign({ tenantId: T, orgId: ORG, templateId, createdBy: 'u1' });
    // A campaign on ANOTHER template in the same org: it must not be listed.
    const otherTpl = await createTemplate({ tenantId: T, orgId: ORG, name: 'Other', subject: 'Other', body: 'B', createdBy: 'u1' });
    const unrelated = await createCampaign({ tenantId: T, orgId: ORG, templateId: otherTpl.templateId, createdBy: 'u1' });
    await sendCampaign(T, ORG, campaignId, { provider });
    const using = await campaignsUsingTemplate(T, ORG, templateId);
    expect(using.map((c) => [c.campaignId, c.status]).sort()).toEqual([[campaignId, 'sent'], [second.campaignId, 'draft']].sort());
    expect(using.map((c) => c.campaignId)).not.toContain(unrelated.campaignId);
    expect(await campaignsUsingTemplate(T, ORG, otherTpl.templateId)).toEqual([{ campaignId: unrelated.campaignId, status: 'draft' }]);
    expect(await campaignsUsingTemplate(T, 'other-org', templateId)).toEqual([]);
  });
});

describe('cross-org: another org\'s ids are not-found', () => {
  it('every template, version and campaign read/write', async () => {
    const { templateId, campaignId } = await draft();
    const OTHER = 'o2';
    expect(await getTemplate(T, OTHER, templateId)).toBeNull();
    expect(await updateTemplate(T, OTHER, templateId, { subject: 'x' })).toBeNull();
    expect(await getTemplateVersion(T, OTHER, templateId, 1)).toBeNull();
    expect(await listTemplateVersions(T, OTHER, templateId)).toBeNull();
    expect(await restoreTemplateVersion(T, OTHER, templateId, 1, { actor: 'u2' })).toBeNull();
    expect(await deleteTemplate(T, OTHER, templateId)).toBe(false);
    expect(await getCampaign(T, OTHER, campaignId)).toBeNull();
    expect(await sendCampaign(T, OTHER, campaignId, { provider })).toBeNull();
    expect((await getTemplate(T, ORG, templateId))?.subject, 'the real row is untouched').toBe('Original');
    // Another TENANT, same org id, too.
    expect(await getTemplate('tOther', ORG, templateId)).toBeNull();
  });
});
