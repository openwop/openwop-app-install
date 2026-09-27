/**
 * ctx.features.crm mutation surface (ADR 0208 §2) — the write verbs added
 * alongside the existing read reference (ADR 0014 Phase 4). Exercises the
 * surface build fn directly (mirrors kb-surface.test.ts / brand-surface.test.ts):
 * the SAME service functions the HTTP routes call, the tenant guard on contact
 * ops (`contactsService.getContact` carries no tenant guard of its own — the
 * surface re-verifies before every mutation, mirroring `routes.ts`), tombstone
 * refusal, ADR 0162 deterministic-id idempotency, and the moveDealStage
 * won/lost verb derivation the org route also applies.
 */

import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { buildHostSurfaceBundle } from '../src/host/inMemorySurfaces.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createContact, tombstoneContact, __resetCrmStore } from '../src/features/crm/contactsService.js';
import { getOrCreateDefaultPipeline, listCompanies, listActivities, __resetCrmEntities } from '../src/features/crm/crmEntitiesService.js';
import { convertContact, __resetConvertClaims } from '../src/features/crm/convertService.js';

let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', res); });
  const crm = getToggleDefault('crm');
  if (crm) await saveConfig({ ...crm, status: 'on' }, 'test');
  await __resetCrmStore();
  await __resetCrmEntities();
  await __resetConvertClaims();
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

const crmSurface = (tenantId: string, runId = 'test-run') => {
  const features = buildHostSurfaceBundle({ tenantId, runId }).features;
  return features.crm!;
};

describe('ctx.features.crm mutation surface', () => {
  it('updateContactStage is tenant-guarded — a foreign-tenant contactId 404s', async () => {
    const foreign = await createContact({ tenantId: 'tenant-foreign-1', name: 'Foreign Contact' });
    const surface = crmSurface('tenant-mine-1');
    await expect(surface.updateContactStage!({ contactId: foreign.contactId, stage: 'qualified' }))
      .rejects.toMatchObject({ code: 'not_found' });
  });

  it('updateContactOwner refuses a tombstoned (merged-away) contact', async () => {
    const tenantId = 'tenant-tomb-1';
    const c = await createContact({ tenantId, name: 'Merged Away' });
    await tombstoneContact(c.contactId, tenantId, 'crm:survivor');
    const surface = crmSurface(tenantId);
    await expect(surface.updateContactOwner!({ contactId: c.contactId, owner: 'user:bob' }))
      .rejects.toMatchObject({ code: 'not_found' });
  });

  it('updateContactStage/Owner apply to a same-tenant, non-tombstoned contact', async () => {
    const tenantId = 'tenant-ok-1';
    const c = await createContact({ tenantId, name: 'Real Contact', stage: 'lead' });
    const surface = crmSurface(tenantId);
    const staged = (await surface.updateContactStage!({ contactId: c.contactId, stage: 'qualified' })) as { contact: { stage: string } };
    expect(staged.contact.stage).toBe('qualified');
    const owned = (await surface.updateContactOwner!({ contactId: c.contactId, owner: 'user:carol' })) as { contact: { owner?: string } };
    expect(owned.contact.owner).toBe('user:carol');
  });

  it('createContact is idempotent by explicit contactId (ADR 0162) — a re-call with the same id short-circuits to the original row', async () => {
    const tenantId = 'tenant-idem-1';
    const surface = crmSurface(tenantId);
    const first = (await surface.createContact!({ contactId: 'crm:fixed-1', name: 'Ada' })) as { contact: { contactId: string; name: string } };
    const second = (await surface.createContact!({ contactId: 'crm:fixed-1', name: 'Different Name' })) as { contact: { contactId: string; name: string } };
    expect(second.contact.contactId).toBe(first.contact.contactId);
    expect(second.contact.name).toBe('Ada'); // not overwritten — the ADR 0162 short-circuit
  });

  it('createCompany → createDeal → moveDealStage derives won/lost the same way orgRoutes.ts does', async () => {
    const tenantId = 'tenant-deal-1';
    const orgId = 'org-1';
    const surface = crmSurface(tenantId);
    const company = (await surface.createCompany!({ orgId, name: 'Acme' })) as { company: { companyId: string } };
    const deal = (await surface.createDeal!({ orgId, title: 'Acme deal', companyId: company.company.companyId })) as { deal: { dealId: string } };
    const pipeline = await getOrCreateDefaultPipeline(tenantId, orgId);
    const wonStage = pipeline.stages.find((s) => s.name === 'Won')!;
    const moved = (await surface.moveDealStage!({ orgId, dealId: deal.deal.dealId, stageId: wonStage.stageId })) as { deal: { status?: string } };
    expect(moved.deal.status).toBe('won');
  });

  it('createTask → completeTask; logActivity appends', async () => {
    const tenantId = 'tenant-task-1';
    const orgId = 'org-1';
    const surface = crmSurface(tenantId);
    const task = (await surface.createTask!({ orgId, title: 'Call back' })) as { task: { taskId: string; status: string } };
    expect(task.task.taskId.startsWith('task:')).toBe(true);
    const done = (await surface.completeTask!({ orgId, taskId: task.task.taskId })) as { task: { status: string } };
    expect(done.task.status).toBe('done');
    const activity = (await surface.logActivity!({ orgId, kind: 'note', body: 'Left a voicemail' })) as { activity: { activityId: string; kind: string } };
    expect(activity.activity.activityId.startsWith('act:')).toBe(true);
    expect(activity.activity.kind).toBe('note');
  });

  it('logGmailActivity back-dates to the email time, persists threadId, and refuses a phantom contact (ADR 0252 §1/§6)', async () => {
    const tenantId = 'tenant-gmail-surface-1';
    const orgId = 'org-1';
    const contact = await createContact({ tenantId, name: 'Ada Known' });
    const surface = crmSurface(tenantId);

    const at = '2020-01-02T03:04:05.000Z'; // firmly in the past — proves it's the email's time, not nowIso().
    await surface.logGmailActivity!({ orgId, contactId: contact.contactId, messageId: 'm-1', threadId: 'th-1', direction: 'in', at });
    const acts = await listActivities(tenantId, orgId, { contactId: contact.contactId });
    expect(acts).toHaveLength(1);
    expect(acts[0].createdAt).toBe(at);   // back-dated, not sync time (MEDIUM-2)
    expect(acts[0].threadId).toBe('th-1'); // opaque thread ref persisted (MEDIUM-2)
    expect(acts[0].kind).toBe('email');

    // A phantom contactId is refused by the real link validator — best-effort
    // swallows the throw, so NO dangling-link row is written (MEDIUM-4).
    await surface.logGmailActivity!({ orgId, contactId: 'crm:does-not-exist', messageId: 'm-2', threadId: 'th-2', direction: 'out', at });
    expect(await listActivities(tenantId, orgId, { contactId: 'crm:does-not-exist' })).toHaveLength(0);
  });

  it('convertContact get-or-creates a company + deal and advances the contact stage', async () => {
    const tenantId = 'tenant-convert-1';
    const orgId = 'org-1';
    const contact = await createContact({ tenantId, name: 'Lead One', company: 'Acme Co', stage: 'lead' });
    const surface = crmSurface(tenantId);
    const result = (await surface.convertContact!({ contactId: contact.contactId, orgId })) as {
      created: { company: boolean; deal: boolean };
      contact: { stage: string };
    };
    expect(result.created.company).toBe(true);
    expect(result.created.deal).toBe(true);
    expect(result.contact.stage).toBe('qualified');
  });

  // CRMGAP-8 — TOCTOU: two contacts sharing the SAME email domain, converted
  // concurrently, must settle on exactly ONE company (the CAS claim-and-
  // reconcile pattern in convertService.getOrCreateCompanyForConvert) rather
  // than a plain find-then-create racing into two rows for the same domain.
  it('convertContact: two parallel converts for the same email domain settle on exactly ONE company', async () => {
    const tenantId = 'tenant-convert-race-1';
    const orgId = 'org-1';
    const contactA = await createContact({ tenantId, name: 'Race A', email: 'a@racecorp.example', stage: 'lead' });
    const contactB = await createContact({ tenantId, name: 'Race B', email: 'b@racecorp.example', stage: 'lead' });

    const [resultA, resultB] = await Promise.all([
      convertContact({ tenantId, orgId, contactId: contactA.contactId, actor: 'user:a' }),
      convertContact({ tenantId, orgId, contactId: contactB.contactId, actor: 'user:b' }),
    ]);

    // Both converts resolve to the SAME company id — no duplicate.
    expect(resultA.company.companyId).toBe(resultB.company.companyId);
    // Exactly one of the two calls actually created it; the other adopted the winner.
    expect([resultA.created.company, resultB.created.company].filter(Boolean)).toHaveLength(1);
    const companies = await listCompanies(tenantId, orgId);
    const racecorpCompanies = companies.filter((c) => c.domain === 'racecorp.example');
    expect(racecorpCompanies).toHaveLength(1);

    // Each contact still gets its OWN deal (different contactId ⇒ different
    // dedup key), both settled to a single deal each — no duplicate per-contact
    // deal either.
    expect(resultA.deal.dealId).not.toBe(resultB.deal.dealId);
    expect(resultA.deal.contactId).toBe(contactA.contactId);
    expect(resultB.deal.contactId).toBe(contactB.contactId);
  });
});
