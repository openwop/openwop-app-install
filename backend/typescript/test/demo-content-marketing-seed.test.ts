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
});
