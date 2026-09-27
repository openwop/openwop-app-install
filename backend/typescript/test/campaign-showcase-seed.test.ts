/**
 * Campaign Studio showcase seeder (campaign gap-analysis Phase A / A4) — proves
 * the cross-feature demo:
 *   - seeds a Brand (voice + guardrails) → 2 Personas → a CONFIRMED brief with a
 *     messaging kernel → the finalized MarketingCampaign → a linked 14-day,
 *     two-platform performance series;
 *   - the intelligence surfaces can read it (KPI summary sees the spend; the
 *     budget optimizer ranks the two platforms);
 *   - it is toggle-gated (skips 'toggle-off' — never flips toggles), idempotent,
 *     and clears cleanly without touching user-authored data.
 */
import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { __hostExtStorage } from '../src/host/hostExtPersistence.js';
import {
  seedCampaignShowcase,
  clearCampaignShowcase,
  countCampaignShowcase,
  CAMPAIGN_SHOWCASE_SEED_ACTOR,
} from '../src/host/campaignShowcaseSeed.js';
import { listBrands, updateBrand } from '../src/features/brand/brandService.js';
import { scoreComplianceDeterministic } from '../src/features/brand/scoring.js';
import { listPersonas } from '../src/features/campaign-brief/personaService.js';
import { listBriefs, updateBrief, validateBrief } from '../src/features/campaign-brief/briefService.js';
import { listBriefs as listCreativeBriefs } from '../src/features/creative-briefs/creativeBriefsService.js';
import { listCampaigns } from '../src/features/campaign-orchestration/campaignService.js';
import { listRecords, kpiSummary } from '../src/features/campaign-connectors/performanceService.js';
import { listAssets, selectAssets, updateAsset } from '../src/features/media/mediaService.js';
import { seedDemoPeople } from '../src/host/demoPeopleSeed.js';
import { seedDemoMedia } from '../src/host/demoMediaSeed.js';
import { listOrgs } from '../src/host/accessControlService.js';
import { CAMPAIGN_SHOWCASE } from '../src/host/seed-data/campaignShowcase.js';

let server: http.Server;
const TENANT = 'user:campaign-showcase-test';
const GATED_TOGGLES = ['campaign-brief', 'campaign-orchestration', 'campaign-connectors', 'campaign-channels', 'campaign-intel', 'creative-briefs'];

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_DEMO_MODE = 'true';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => res()); });
});
afterAll(async () => {
  delete process.env.OPENWOP_DEMO_MODE;
  await new Promise<void>((res) => server.close(() => res()));
});

function storageOrThrow() {
  const s = __hostExtStorage();
  if (!s) throw new Error('host-ext storage not initialized');
  return s;
}

async function setToggles(status: 'on' | 'off') {
  for (const id of GATED_TOGGLES) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status }, 'test');
  }
}

describe('campaign showcase seeder', () => {
  it('skips toggle-off without creating anything (and never flips toggles)', async () => {
    await setToggles('off');
    const r = await seedCampaignShowcase(TENANT, storageOrThrow());
    expect(r.skipped).toBe('toggle-off');
    expect(r.created).toBe(0);
    expect(await countCampaignShowcase(TENANT)).toBe(0);
  });

  it('seeds brand → personas → confirmed brief + kernel → campaign → performance, readable by the intel surfaces', async () => {
    await setToggles('on');
    const storage = storageOrThrow();
    // The real seeder ordering: demo-people (org substrate) → demo-media
    // (library + marketing facets) → campaign-showcase (which stamps its
    // persona ids onto the mapped demo assets — SEED-3).
    await seedDemoPeople(TENANT);
    await seedDemoMedia(TENANT);
    const orgId = (await listOrgs(TENANT))[0]!.orgId;
    const result = await seedCampaignShowcase(TENANT, storage);

    expect(result.skipped).toBeUndefined();
    const expectedStamps = Object.values(CAMPAIGN_SHOWCASE.personaMediaKeys).reduce((n, keys) => n + keys.length, 0);
    expect(result.details).toMatchObject({ brand: 1, personas: 2, briefs: 1, campaigns: 1, performanceRows: 28, creativeBriefs: 1, assetPersonaStamps: expectedStamps });

    // Brand carries real guardrails (banned phrases → the compliance scorer has teeth).
    const brand = (await listBrands(TENANT)).find((b) => b.createdBy === CAMPAIGN_SHOWCASE_SEED_ACTOR)!;
    expect(brand.name).toBe('Solstice Roasters');
    expect(brand.keyPhrases.bannedPhrases.length).toBeGreaterThan(0);
    expect(brand.voiceProfile.formalityLevel).toBe(2);

    // SEED-1a: the governance.compliance policy exists (ADR 0354 gate demos),
    // and it INTERLOCKS with the guardrails — a banned phrase caps the
    // deterministic score below the block threshold (requires-approval), while
    // the brand's own clean kernel copy scores above it (allow).
    expect(brand.governance.compliance).toEqual({ blockPublish: 'threshold', blockThreshold: 60 });
    const bannedScore = scoreComplianceDeterministic('Our world-class beans are revolutionary.', brand).deterministicScore;
    expect(bannedScore).toBeLessThan(brand.governance.compliance!.blockThreshold!);
    const cleanScore = scoreComplianceDeterministic('Roasted Tuesday. On your counter Thursday.', brand).deterministicScore;
    expect(cleanScore).toBeGreaterThanOrEqual(brand.governance.compliance!.blockThreshold!);

    // Personas tied to the brand.
    const personas = (await listPersonas(TENANT)).filter((p) => p.createdBy === CAMPAIGN_SHOWCASE_SEED_ACTOR);
    expect(personas).toHaveLength(2);
    expect(personas.every((p) => p.brandId === brand.id)).toBe(true);

    // Brief: confirmed, kernel present + not stale, and VALID per brief.validate
    // with the selective channel set (creative_briefs deliberately disabled).
    const brief = (await listBriefs(TENANT)).find((b) => b.createdBy === CAMPAIGN_SHOWCASE_SEED_ACTOR)!;
    expect(brief.status).toBe('confirmed');
    expect(brief.kernel?.headline).toContain('Roasted Tuesday');
    expect(brief.kernelStale).toBe(false);
    // SEED-1b: grounding posture (ADR 0351 P2) + competitors (ADR 0355 P5)
    // survived the validated create path.
    expect(brief.groundingPolicy).toBe('best-effort');
    expect(brief.competitors).toEqual(['Trade Coffee', 'Atlas Coffee Club', 'Blue Bottle Coffee']);
    const validation = validateBrief(brief);
    expect(validation.valid).toBe(true);
    expect(validation.enabledChannels).toEqual(['landing_page', 'ad_variants', 'email_sequence', 'social_posts']);

    // Campaign finalized from the brief, carrying the kernel snapshot.
    const campaign = (await listCampaigns(TENANT)).find((c) => c.createdBy === CAMPAIGN_SHOWCASE_SEED_ACTOR)!;
    expect(campaign.briefId).toBe(brief.id);
    expect(campaign.kernel?.headline).toBe(brief.kernel?.headline);
    expect(campaign.channels).toEqual(validation.enabledChannels);

    // ADR 0353 / DG-SEED-5 — the showcase VISUAL creative brief, created via
    // the real service path and tied back to the campaign brief.
    const creative = (await listCreativeBriefs(TENANT, campaign.orgId)).find((b) => b.createdBy === CAMPAIGN_SHOWCASE_SEED_ACTOR)!;
    expect(creative).toBeDefined();
    expect(creative.campaignBriefId).toBe(brief.id);
    expect(creative.title).toContain('Hero shot');
    expect(creative.status).toBe('draft');
    expect(creative.directions.length).toBeGreaterThan(0);

    // Performance series linked to the campaign; KPI projection sees it.
    const rows = await listRecords(TENANT, campaign.orgId, campaign.id);
    expect(rows).toHaveLength(28);
    expect(new Set(rows.map((r) => r.platform))).toEqual(new Set(['meta', 'google']));
    const kpi = await kpiSummary(TENANT, campaign.orgId, campaign.id);
    expect(kpi.recordCount).toBe(28);
    expect(kpi.totals.spend).toBeGreaterThan(0);
    expect(kpi.totals.roas).toBeGreaterThan(0);
    expect(kpi.byPlatform).toHaveLength(2);

    // SEED-3: the seeder stamped its REAL persona ids onto the mapped demo
    // assets, so `assets/select` with showcase-persona criteria returns a
    // facet-matched asset at level 0 — not the terminal fallback.
    const homePersona = personas.find((p) => p.name === 'Home-brew upgrader')!;
    const officePersona = personas.find((p) => p.name === 'Office coffee buyer')!;
    const subBox = (await listAssets(TENANT, orgId, { tag: 'subscription-box' }))[0]!;
    expect(subBox.marketing?.personaIds).toContain(homePersona.id);
    expect(subBox.marketing?.product).toBe(brief.productName); // facet fields preserved by the merge
    const sel = await selectAssets(TENANT, orgId, {
      product: brief.productName,
      industry: brief.industryVertical,
      personaIds: [homePersona.id],
    });
    expect(sel.fallbackLevel).toBe(0);
    expect(sel.needsAsset).toBeUndefined();
    expect(sel.assets[0]!.asset.name).toBe('Coffee Subscription.png');
    expect(sel.assets[0]!.matched).toEqual(expect.arrayContaining(['product', 'industry', 'persona']));

    // A demo-media re-seed after stamping must not clobber the persona ids
    // (the retrofit merge lets existing facet values win).
    await seedDemoMedia(TENANT);
    const subBoxAfter = (await listAssets(TENANT, orgId, { tag: 'subscription-box' }))[0]!;
    expect(subBoxAfter.marketing?.personaIds).toContain(homePersona.id);

    // Idempotent: a re-seed is a no-op (the FU-CODE-3 retrofit finds nothing missing).
    const again = await seedCampaignShowcase(TENANT, storage);
    expect(again.skipped).toBe('already-seeded');
    expect(again.created).toBe(0);
    expect(again.retrofitted).toEqual({ compliancePolicy: 0, groundingPolicy: 0, competitors: 0, assetPersonaStamps: 0 });

    // FU-CODE-3 — the already-seeded RETROFIT leg: strip the SEED-1/SEED-3
    // additions (the state of a tenant seeded before they shipped), then
    // re-seed — the retrofit fills ONLY the missing pieces via the real
    // update paths, without demoting the confirmed brief or staling the kernel.
    await updateBrand(TENANT, brand.id, {
      governance: { lockLevel: brand.governance.lockLevel, allowedEditors: brand.governance.allowedEditors, requireApproval: brand.governance.requireApproval },
    });
    await updateBrief(TENANT, brief.id, { groundingPolicy: '', competitors: [] }); // both sanitize to "absent"
    const stamped = (await listAssets(TENANT, orgId, { tag: 'subscription-box' }))[0]!;
    await updateAsset(TENANT, orgId, stamped.assetId, {
      marketing: { ...(stamped.marketing ?? {}), personaIds: (stamped.marketing?.personaIds ?? []).filter((id) => id !== homePersona.id) },
    });

    const retro = await seedCampaignShowcase(TENANT, storage);
    expect(retro.skipped).toBe('already-seeded');
    expect(retro.retrofitted).toEqual({ compliancePolicy: 1, groundingPolicy: 1, competitors: 1, assetPersonaStamps: 1 });
    const brandAfter = (await listBrands(TENANT)).find((b) => b.createdBy === CAMPAIGN_SHOWCASE_SEED_ACTOR)!;
    expect(brandAfter.governance.compliance).toEqual({ blockPublish: 'threshold', blockThreshold: 60 });
    expect(brandAfter.governance.lockLevel).toBe(brand.governance.lockLevel); // rest of governance untouched
    const briefAfter = (await listBriefs(TENANT)).find((b) => b.createdBy === CAMPAIGN_SHOWCASE_SEED_ACTOR)!;
    expect(briefAfter.groundingPolicy).toBe('best-effort');
    expect(briefAfter.competitors).toEqual([...CAMPAIGN_SHOWCASE.brief.competitors]);
    expect(briefAfter.status).toBe('confirmed'); // neither field is PROTECTED content
    expect(briefAfter.kernelStale).toBe(false);
    const restamped = (await listAssets(TENANT, orgId, { tag: 'subscription-box' }))[0]!;
    expect(restamped.marketing?.personaIds).toContain(homePersona.id);
    expect(restamped.marketing?.product).toBe(brief.productName); // merge, never replace

    // Fill-if-absent ONLY: a user-tuned value survives the next retrofit pass.
    await updateBrief(TENANT, brief.id, { groundingPolicy: 'strict' });
    const retro2 = await seedCampaignShowcase(TENANT, storage);
    expect(retro2.retrofitted).toEqual({ compliancePolicy: 0, groundingPolicy: 0, competitors: 0, assetPersonaStamps: 0 });
    expect((await listBriefs(TENANT)).find((b) => b.createdBy === CAMPAIGN_SHOWCASE_SEED_ACTOR)!.groundingPolicy).toBe('strict');

    // Clears cleanly — only its own entities (incl. the linked perf rows), and
    // scrubs the stamped persona ids off the demo assets (no orphan refs to
    // deleted personas — the facet's other fields survive).
    expect(await countCampaignShowcase(TENANT)).toBeGreaterThan(0);
    const cleared = await clearCampaignShowcase(TENANT, storage);
    expect(cleared.details).toMatchObject({ brand: 1, personas: 2, briefs: 1, campaigns: 1, performanceRows: 28, creativeBriefs: 1, assetPersonaUnstamps: expectedStamps });
    expect(await countCampaignShowcase(TENANT)).toBe(0);
    expect(await listRecords(TENANT, campaign.orgId, campaign.id)).toHaveLength(0);
    const deletedIds = new Set([homePersona.id, officePersona.id]);
    for (const a of await listAssets(TENANT, orgId)) {
      expect(a.marketing?.personaIds?.some((id) => deletedIds.has(id)) ?? false).toBe(false);
    }
    const subBoxCleared = (await listAssets(TENANT, orgId, { tag: 'subscription-box' }))[0]!;
    expect(subBoxCleared.marketing?.product).toBe(brief.productName);
  });
});
