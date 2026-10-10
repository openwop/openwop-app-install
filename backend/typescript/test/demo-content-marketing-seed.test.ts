/**
 * `demo-content-marketing` round-trip (app-seeding-strategy.md §4 Phase 9).
 *
 * Verifies the marketing surface: brand kit, 6-page CMS site (with a publish
 * transition + experiment), forms + submissions, email templates + campaigns +
 * engagement, the campaign cluster (a confirmed brief with a kernel), and a
 * document library — seeded idempotently and cleared clean.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { initInMemorySurfaces } from '../src/host/inMemorySurfaces.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { openStorage } from '../src/storage/index.js';
import { seedDemoPeople } from '../src/host/demoPeopleSeed.js';
import { seedDemoMedia } from '../src/host/demoMediaSeed.js';
import { seedDemoCrm } from '../src/host/demoCrmSeed.js';
import { seedDemoContentMarketing, clearDemoContentMarketing, countDemoContentMarketing } from '../src/host/demoContentMarketingSeed.js';
import { listBrands } from '../src/features/brand/brandService.js';
import { listPages } from '../src/features/cms/cmsService.js';
import { listForms } from '../src/features/forms/formsService.js';
import { listTemplates, listCampaigns } from '../src/features/email/emailService.js';
import { listBriefs } from '../src/features/campaign-brief/briefService.js';
import { listDocuments } from '../src/features/documents/documentsService.js';

const ON = { status: 'on' as const, bucketUnit: 'tenant' as const };

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  initInMemorySurfaces({ dataDir: mkdtempSync(join(tmpdir(), 'owp-demo-cm-')) });
  for (const id of ['crm', 'forms', 'email', 'campaign-brief', 'campaign-orchestration', 'documents']) {
    registerToggleDefault({ id, salt: id, ...ON });
  }
});

describe('demo-content-marketing seeder', () => {
  it('seeds brand/cms/forms/email/campaign/docs, idempotent; clears clean', async () => {
    const tenantId = 'demo-cm-t1';
    await seedDemoPeople(tenantId);
    await seedDemoMedia(tenantId);
    await seedDemoCrm(tenantId);
    const orgId = (await (await import('../src/host/accessControlService.js')).listOrgs(tenantId))[0]!.orgId;

    const first = await seedDemoContentMarketing(tenantId);
    expect(first.created).toBeGreaterThan(20);

    // Brand + a 6-page CMS site with a published page.
    expect((await listBrands(tenantId, orgId)).some((b) => b.id === 'brand-solstice')).toBe(true);
    const pages = (await listPages(tenantId, orgId)).filter((p) => p.createdBy === 'demo:content-marketing');
    expect(pages).toHaveLength(6);
    expect(pages.some((p) => p.status === 'published')).toBe(true);
    expect(pages.some((p) => p.status === 'in_review')).toBe(true);
    expect(pages.some((p) => p.scheduledPublishAt)).toBe(true);

    // Forms, email, campaign cluster (a confirmed brief), documents.
    expect((await listForms(tenantId, orgId)).filter((f) => f.createdBy === 'demo:content-marketing')).toHaveLength(4);
    expect((await listTemplates(tenantId, orgId)).filter((t) => t.createdBy === 'demo:content-marketing')).toHaveLength(8);
    expect((await listCampaigns(tenantId, orgId)).filter((c) => c.createdBy === 'demo:content-marketing')).toHaveLength(6);
    const briefs = (await listBriefs(tenantId, orgId)).filter((b) => b.createdBy === 'demo:content-marketing');
    expect(briefs).toHaveLength(3);
    expect(briefs.some((b) => b.status === 'confirmed' && b.kernel)).toBe(true);
    expect((await listDocuments(tenantId, orgId)).filter((d) => d.createdBy === 'demo:content-marketing')).toHaveLength(12);

    // Idempotent re-seed.
    const before = await countDemoContentMarketing(tenantId);
    const second = await seedDemoContentMarketing(tenantId);
    expect(second.created).toBe(0);
    expect(await countDemoContentMarketing(tenantId)).toBe(before);

    // Clear.
    await clearDemoContentMarketing(tenantId);
    expect(await countDemoContentMarketing(tenantId)).toBe(0);
    expect((await listBrands(tenantId, orgId)).filter((b) => b.createdBy === 'demo:content-marketing')).toHaveLength(0);
    expect((await listDocuments(tenantId, orgId)).filter((d) => d.createdBy === 'demo:content-marketing')).toHaveLength(0);
    expect((await listBriefs(tenantId, orgId)).filter((b) => b.createdBy === 'demo:content-marketing')).toHaveLength(0);

    // Round-trips.
    const third = await seedDemoContentMarketing(tenantId);
    expect(third.created).toBeGreaterThan(20);
  });

  // ADR 0838 D1 — the seeder used the SAME `doc:demo-cm-<slug>` (and email
  // `tpl:`/`cmp:`) ids in every tenant, over stores keyed by id alone, so the
  // second tenant to seed took the first tenant's rows. RED on `764883b6c`:
  // tenant A was left with 0 of its 12 documents.
  it('two tenants seeded in turn each keep their own documents and email rows', async () => {
    const { listOrgs } = await import('../src/host/accessControlService.js');
    const owned = async (t: string) => {
      const o = (await listOrgs(t))[0]!.orgId;
      return {
        docs: (await listDocuments(t, o)).filter((d) => d.createdBy === 'demo:content-marketing').length,
        tpls: (await listTemplates(t, o)).filter((x) => x.createdBy === 'demo:content-marketing').length,
        cmps: (await listCampaigns(t, o)).filter((x) => x.createdBy === 'demo:content-marketing').length,
      };
    };
    for (const t of ['demo-cm-two-a', 'demo-cm-two-b']) {
      await seedDemoPeople(t);
      await seedDemoMedia(t);
      await seedDemoCrm(t);
      await seedDemoContentMarketing(t);
    }
    expect(await owned('demo-cm-two-a')).toEqual({ docs: 12, tpls: 8, cmps: 6 });
    expect(await owned('demo-cm-two-b')).toEqual({ docs: 12, tpls: 8, cmps: 6 });
  });

  // ADR 0838 — the ids changed, so a tenant seeded BEFORE the change holds its
  // rows under the legacy `doc:demo-cm-<slug>` / `cmp:demo-cm-<slug>` ids. An
  // explicit re-seed must treat those as "already seeded", never mint a second
  // demo library beside them (the seed-on-visit duplication class, #1896).
  it('a tenant holding the LEGACY-id rows gets no duplicates on re-seed', async () => {
    const t = 'demo-cm-legacy';
    const { listOrgs } = await import('../src/host/accessControlService.js');
    const { createDocument, deleteDocument } = await import('../src/features/documents/documentsService.js');
    const { createCampaign, deleteCampaign } = await import('../src/features/email/emailService.js');
    await seedDemoPeople(t);
    await seedDemoMedia(t);
    await seedDemoCrm(t);
    await seedDemoContentMarketing(t);
    const o = (await listOrgs(t))[0]!.orgId;
    const ACTOR = 'demo:content-marketing';
    // Rewrite the seeded rows to the pre-ADR 0838 ids (what prod tenants hold).
    for (const d of (await listDocuments(t, o)).filter((x) => x.createdBy === ACTOR)) {
      const legacy = d.documentId.replace(/^doc:demo-cm-[0-9a-f]{10}-/, 'doc:demo-cm-');
      expect(legacy).not.toBe(d.documentId);
      await deleteDocument(t, o, d.documentId);
      await createDocument({ tenantId: t, orgId: o, title: d.title, kind: d.kind, format: d.format, createdBy: ACTOR, documentId: legacy, provenance: { producedBy: { kind: 'user', id: ACTOR } } });
    }
    for (const c of (await listCampaigns(t, o)).filter((x) => x.createdBy === ACTOR)) {
      const legacy = c.campaignId.replace(/^cmp:demo-cm-[0-9a-f]{10}-/, 'cmp:demo-cm-');
      expect(legacy).not.toBe(c.campaignId);
      await deleteCampaign(t, o, c.campaignId);
      await createCampaign({ tenantId: t, orgId: o, templateId: c.templateId, ...(c.audience.segmentId ? { segmentId: c.audience.segmentId } : { stage: c.audience.stage ?? 'lead' }), createdBy: ACTOR, campaignId: legacy });
    }
    const before = {
      docs: (await listDocuments(t, o)).filter((d) => d.createdBy === ACTOR).length,
      tpls: (await listTemplates(t, o)).filter((x) => x.createdBy === ACTOR).length,
      cmps: (await listCampaigns(t, o)).filter((x) => x.createdBy === ACTOR).length,
    };
    expect(before).toEqual({ docs: 12, tpls: 8, cmps: 6 });
    await seedDemoContentMarketing(t);
    expect({
      docs: (await listDocuments(t, o)).filter((d) => d.createdBy === ACTOR).length,
      tpls: (await listTemplates(t, o)).filter((x) => x.createdBy === ACTOR).length,
      cmps: (await listCampaigns(t, o)).filter((x) => x.createdBy === ACTOR).length,
    }).toEqual(before);
  });
});
