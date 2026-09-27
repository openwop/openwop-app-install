/**
 * Campaign Studio SHOWCASE seeder (campaign gap-analysis Phase A / A4).
 *
 * Seeds one coherent fictional brand ("Solstice Roasters" — see
 * `seed-data/campaignShowcase.ts`) end-to-end across the Campaign Studio
 * cluster: Brand (voice + guardrails, ADR 0155) → two Personas + a CONFIRMED
 * CampaignBrief carrying a messaging kernel (ADR 0156) → the finalized
 * MarketingCampaign (ADR 0158) → a two-platform, 14-day performance series
 * linked to that campaign (ADR 0159), which lights up the KPI cards and the
 * campaign-intel budget/forecast surfaces (ADR 0160).
 *
 * Follows the `strategyShowcaseSeed` contract exactly: gated on the cluster's
 * toggles (skips `'toggle-off'` — it NEVER flips the server-authoritative
 * toggles; enabling the cluster stays an explicit admin action), idempotent
 * + all-or-nothing (the cross-references only line up built together), and
 * `clear()` removes only the canonical showcase entities (matched by the
 * `demo:campaign-showcase` actor / the linked campaignId), never user data.
 */
import type { Storage } from '../storage/storage.js';
import { createLogger } from '../observability/logger.js';
import { resolveOne } from './featureToggles/service.js';
import { listOrgs } from './accessControlService.js';
import { createBrand, listBrands, updateBrand, deleteBrand } from '../features/brand/brandService.js';
import { createPersona, listPersonas, deletePersona } from '../features/campaign-brief/personaService.js';
import { createBrief, updateBrief, setKernel, listBriefs, deleteBrief } from '../features/campaign-brief/briefService.js';
import {
  createBrief as createCreativeBrief,
  listBriefs as listCreativeBriefs,
  deleteBrief as deleteCreativeBrief,
} from '../features/creative-briefs/creativeBriefsService.js';
import { listAssets, updateAsset } from '../features/media/mediaService.js';
import { finalizeFromBrief, listCampaigns, deleteCampaign } from '../features/campaign-orchestration/campaignService.js';
import { persistRecords, deleteRecordsByCampaign } from '../features/campaign-connectors/performanceService.js';
import { computeDerived, type ParsedRow } from '../features/campaign-connectors/csvImport.js';
import { CAMPAIGN_SHOWCASE } from './seed-data/campaignShowcase.js';
import { DEMO_MEDIA_ACTOR } from './seed-data/solsticeDemo.js';

const log = createLogger('seed.campaignShowcase');

/** Marks every entity this seeder creates (for count + clear). */
export const CAMPAIGN_SHOWCASE_SEED_ACTOR = 'demo:campaign-showcase';

async function gatesOpen(tenantId: string): Promise<boolean> {
  // brand is always-on (ADR 0170); gate on the toggled cluster members whose
  // data this showcase writes.
  const [brief, orchestration, connectors] = await Promise.all([
    resolveOne('campaign-brief', { tenantId }),
    resolveOne('campaign-orchestration', { tenantId }),
    resolveOne('campaign-connectors', { tenantId }),
  ]);
  return Boolean(brief?.enabled && orchestration?.enabled && connectors?.enabled);
}

async function orgIdFor(tenantId: string): Promise<string> {
  return (await listOrgs(tenantId))[0]?.orgId ?? tenantId;
}

/** Deterministic 14-day, two-platform series linked to the showcase campaign. */
function performanceRows(): ParsedRow[] {
  const { adSet, days, platforms } = CAMPAIGN_SHOWCASE.performance;
  const campaignName = CAMPAIGN_SHOWCASE.brief.name;
  const rows: ParsedRow[] = [];
  const today = new Date();
  for (let i = 0; i < days; i++) {
    const d = new Date(today);
    d.setUTCDate(d.getUTCDate() - (days - i));
    const date = d.toISOString().slice(0, 10);
    for (const p of platforms) {
      // A gentle deterministic wobble + upward trend so charts have a shape.
      const wobble = 1 + 0.08 * Math.sin(i * 1.7) + 0.015 * i;
      const spend = Number((p.spend * wobble).toFixed(2));
      const impressions = Math.round(p.impressions * wobble);
      const clicks = Math.round(p.clicks * wobble);
      const conversions = Math.round(p.conversions * (1 + 0.02 * i));
      const revenue = Number((p.revenue * (1 + 0.025 * i)).toFixed(2));
      const base = { spend, impressions, clicks, conversions, revenue };
      rows.push({ platform: p.platform, campaignName, adSet, date, ...base, ...computeDerived(base) });
    }
  }
  return rows;
}

export interface CampaignShowcaseSeedResult {
  created: number;
  skipped?: 'toggle-off' | 'already-seeded';
  details?: { brand: number; personas: number; briefs: number; campaigns: number; performanceRows: number; creativeBriefs: number; assetPersonaStamps: number };
  /** FU-CODE-3 — fill-if-absent counts from the already-seeded retrofit leg
   *  (SEED-1/SEED-3 additions applied to a tenant seeded before they shipped). */
  retrofitted?: { compliancePolicy: number; groundingPolicy: number; competitors: number; assetPersonaStamps: number };
}

/**
 * SEED-3 — stamp the runtime persona ids onto the demo-media assets each persona
 * targets (`marketing.personaIds`, via the real update path). Fill-if-absent +
 * merge (existing facet fields always win); an unseeded/partial library just
 * skips. Shared by the seed leg and the FU-CODE-3 retrofit leg.
 */
async function stampPersonaMedia(tenantId: string, orgId: string, personaIdByName: ReadonlyMap<string, string>): Promise<number> {
  let stamps = 0;
  for (const [personaName, keys] of Object.entries(CAMPAIGN_SHOWCASE.personaMediaKeys)) {
    const personaId = personaIdByName.get(personaName);
    if (!personaId) continue;
    for (const key of keys) {
      const asset = (await listAssets(tenantId, orgId, { tag: key })).find((a) => a.uploadedBy === DEMO_MEDIA_ACTOR);
      if (!asset) continue;
      const ids = asset.marketing?.personaIds ?? [];
      if (ids.includes(personaId)) continue;
      await updateAsset(tenantId, orgId, asset.assetId, {
        marketing: { ...(asset.marketing ?? {}), personaIds: [...ids, personaId] },
      });
      stamps += 1;
    }
  }
  return stamps;
}

/**
 * FU-CODE-3 — the already-seeded RETROFIT leg (mirrors demoMediaSeed's facet
 * retrofit): a tenant seeded before the SEED-1/SEED-3 additions shipped gets
 * ONLY its missing pieces filled, through the real update paths —
 * `governance.compliance` on the brand, `groundingPolicy` + `competitors` on
 * the brief, persona stamps on the mapped demo assets. Strictly fill-if-absent:
 * a non-demo edit (a tuned policy, a user competitor list) is never overwritten.
 * Neither brief field is PROTECTED content, so the update never demotes a
 * confirmed brief nor stales its kernel.
 */
async function retrofitCampaignShowcase(
  tenantId: string,
): Promise<{ compliancePolicy: number; groundingPolicy: number; competitors: number; assetPersonaStamps: number }> {
  const orgId = await orgIdFor(tenantId);
  const S = CAMPAIGN_SHOWCASE;
  const out = { compliancePolicy: 0, groundingPolicy: 0, competitors: 0, assetPersonaStamps: 0 };

  const brand = (await listBrands(tenantId)).find((b) => b.createdBy === CAMPAIGN_SHOWCASE_SEED_ACTOR);
  if (brand && !brand.governance.compliance) {
    await updateBrand(tenantId, brand.id, {
      governance: { ...brand.governance, compliance: S.brand.governance.compliance },
    }, CAMPAIGN_SHOWCASE_SEED_ACTOR);
    out.compliancePolicy = 1;
  }

  const brief = (await listBriefs(tenantId)).find((b) => b.createdBy === CAMPAIGN_SHOWCASE_SEED_ACTOR);
  if (brief) {
    const patch: { groundingPolicy?: string; competitors?: string[] } = {};
    if (!brief.groundingPolicy) patch.groundingPolicy = S.brief.groundingPolicy;
    if (!brief.competitors || brief.competitors.length === 0) patch.competitors = [...S.brief.competitors];
    if (Object.keys(patch).length > 0) {
      await updateBrief(tenantId, brief.id, patch, CAMPAIGN_SHOWCASE_SEED_ACTOR);
      if (patch.groundingPolicy) out.groundingPolicy = 1;
      if (patch.competitors) out.competitors = 1;
    }
  }

  const personaIdByName = new Map(
    (await listPersonas(tenantId)).filter((p) => p.createdBy === CAMPAIGN_SHOWCASE_SEED_ACTOR).map((p) => [p.name, p.id]),
  );
  out.assetPersonaStamps = await stampPersonaMedia(tenantId, orgId, personaIdByName);
  return out;
}

/** Count the canonical showcase entities present for a tenant. */
export async function countCampaignShowcase(tenantId: string): Promise<number> {
  const orgId = await orgIdFor(tenantId);
  const [brands, personas, briefs, campaigns, creativeBriefs] = await Promise.all([
    listBrands(tenantId),
    listPersonas(tenantId),
    listBriefs(tenantId),
    listCampaigns(tenantId),
    listCreativeBriefs(tenantId, orgId),
  ]);
  return (
    brands.filter((b) => b.createdBy === CAMPAIGN_SHOWCASE_SEED_ACTOR).length +
    personas.filter((p) => p.createdBy === CAMPAIGN_SHOWCASE_SEED_ACTOR).length +
    briefs.filter((b) => b.createdBy === CAMPAIGN_SHOWCASE_SEED_ACTOR).length +
    campaigns.filter((c) => c.createdBy === CAMPAIGN_SHOWCASE_SEED_ACTOR).length +
    creativeBriefs.filter((b) => b.createdBy === CAMPAIGN_SHOWCASE_SEED_ACTOR).length
  );
}

export async function seedCampaignShowcase(tenantId: string, _storage: Storage): Promise<CampaignShowcaseSeedResult> {
  if (!(await gatesOpen(tenantId))) {
    log.debug('campaign_showcase_skipped_toggle_off', { tenantId });
    return { created: 0, skipped: 'toggle-off' };
  }
  // Idempotency: skip if ANY showcase entity already exists — check the brand
  // (created first) AND the brief, so a re-seed never duplicates even if a
  // prior run died part-way.
  const [existingBrands, existingBriefs] = await Promise.all([listBrands(tenantId), listBriefs(tenantId)]);
  if (
    existingBrands.some((b) => b.createdBy === CAMPAIGN_SHOWCASE_SEED_ACTOR) ||
    existingBriefs.some((b) => b.createdBy === CAMPAIGN_SHOWCASE_SEED_ACTOR)
  ) {
    // FU-CODE-3 — bounded fill-if-absent retrofit so an already-seeded tenant
    // still receives the SEED-1/SEED-3 additions (never overwrites edits).
    const retrofitted = await retrofitCampaignShowcase(tenantId);
    if (Object.values(retrofitted).some((n) => n > 0)) {
      log.info('campaign_showcase_retrofitted', { tenantId, ...retrofitted });
    }
    return { created: 0, skipped: 'already-seeded', retrofitted };
  }

  const orgId = await orgIdFor(tenantId);
  const S = CAMPAIGN_SHOWCASE;

  // 1) Brand (voice profile + guardrails — always-on feature, ADR 0155/0170).
  //    SEED-1: governance carries a REAL compliance policy (threshold/60) so the
  //    ADR 0354 ads-dispatch gate demos — see the seed-data rationale.
  const brand = await createBrand(tenantId, orgId, CAMPAIGN_SHOWCASE_SEED_ACTOR, {
    name: S.brand.name,
    description: S.brand.description,
    voiceProfile: S.brand.voiceProfile,
    positioning: S.brand.positioning,
    keyPhrases: S.brand.keyPhrases,
    governance: S.brand.governance,
  });

  // 2) Personas, tied to the brand.
  const personaIds: string[] = [];
  const personaIdByName = new Map<string, string>();
  for (const p of S.personas) {
    const persona = await createPersona(tenantId, orgId, CAMPAIGN_SHOWCASE_SEED_ACTOR, { ...p, brandId: brand.id });
    personaIds.push(persona.id);
    personaIdByName.set(p.name, persona.id);
  }

  // 2b) SEED-3 — stamp the runtime persona ids onto the demo-media assets each
  //     persona targets (`marketing.personaIds`, via the real update path), so
  //     `assets/select` scores the persona dimension against REAL ids on demo
  //     data. Best-effort: an unseeded/partial library just skips (same
  //     no-ordering-dependency stance as the mood board below); existing facet
  //     fields are preserved (merge, never replace). `clear()` scrubs these ids
  //     back off so a deleted persona never leaves orphan references.
  const assetPersonaStamps = await stampPersonaMedia(tenantId, orgId, personaIdByName);

  // 3) A brief carrying the setup → kernel → CONFIRMED (the post-approval state
  //    the orchestration finalizes from).
  const brief = await createBrief(tenantId, orgId, CAMPAIGN_SHOWCASE_SEED_ACTOR, {
    name: S.brief.name,
    objective: S.brief.objective,
    brandId: brand.id,
    personaIds,
    productName: S.brief.productName,
    productDescription: S.brief.productDescription,
    industryVertical: S.brief.industryVertical,
    // SEED-1 — grounding posture (ADR 0351 P2) + competitors (ADR 0355 P5),
    // through the same validated create path the routes use.
    groundingPolicy: S.brief.groundingPolicy,
    competitors: [...S.brief.competitors],
    channels: S.brief.channels,
    messaging: S.brief.messaging,
  });
  await setKernel(tenantId, brief.id, { ...S.kernel, channelTones: { ...S.kernel.channelTones }, proofPoints: [...S.kernel.proofPoints], sourceDocIds: [...S.kernel.sourceDocIds], generatedAt: new Date().toISOString() });
  const confirmed = await updateBrief(tenantId, brief.id, { status: 'confirmed' });

  // 4) The finalized MarketingCampaign (one per brief — upsert semantics).
  const campaign = await finalizeFromBrief(tenantId, confirmed ?? brief, CAMPAIGN_SHOWCASE_SEED_ACTOR);

  // 5) Performance series linked to the campaign (feeds KPI + campaign-intel).
  const rows = performanceRows();
  await persistRecords(tenantId, orgId, rows, 'csv', campaign.id);

  // 6) ADR 0353 / DG-SEED-5 — ONE showcase VISUAL creative brief tied to the
  //    campaign brief, through the REAL create path (versions + mood-board
  //    usage stamping). Gated on its OWN toggle so the core showcase (which
  //    never depended on creative-briefs) still seeds when it is off — the
  //    toggle is never flipped here, same as the cluster gates.
  let creativeBriefCount = 0;
  const creativeBriefsToggle = await resolveOne('creative-briefs', { tenantId });
  if (creativeBriefsToggle?.enabled) {
    // Mood board: reference up to two seeded demo images — demo-media runs
    // earlier in EXAMPLE_DATA_SEEDERS, so they usually exist; an empty library
    // just seeds an empty board (best-effort, no ordering dependency).
    const images = (await listAssets(tenantId, orgId)).filter((a) => a.contentType.startsWith('image/')).slice(0, 2);
    await createCreativeBrief(tenantId, orgId, CAMPAIGN_SHOWCASE_SEED_ACTOR, {
      ...S.creativeBrief,
      campaignBriefId: brief.id,
      moodBoard: images.map((a) => ({ mediaAssetId: a.assetId, note: 'seeded reference' })),
    });
    creativeBriefCount = 1;
  }

  const details = { brand: 1, personas: personaIds.length, briefs: 1, campaigns: 1, performanceRows: rows.length, creativeBriefs: creativeBriefCount, assetPersonaStamps };
  log.info('campaign_showcase_seeded', { tenantId, ...details });
  // `assetPersonaStamps` are UPDATES to demo-media-owned assets, not entities
  // this seeder created — reported in details, excluded from `created`.
  return { created: 1 + personaIds.length + 1 + 1 + rows.length + creativeBriefCount, details };
}

export async function clearCampaignShowcase(
  tenantId: string,
  _storage: Storage,
): Promise<{ cleared: number; details: { brand: number; personas: number; briefs: number; campaigns: number; performanceRows: number; creativeBriefs: number; assetPersonaUnstamps: number } }> {
  let brandCount = 0, personaCount = 0, briefCount = 0, campaignCount = 0, perfCount = 0, creativeBriefCount = 0, assetPersonaUnstamps = 0;

  // Reverse dependency order: creative brief → performance rows → campaign →
  // brief → personas → brand.
  const orgId = await orgIdFor(tenantId);
  for (const cb of await listCreativeBriefs(tenantId, orgId)) {
    if (cb.createdBy !== CAMPAIGN_SHOWCASE_SEED_ACTOR) continue;
    if (await deleteCreativeBrief(tenantId, orgId, cb.briefId)) creativeBriefCount += 1;
  }
  for (const c of await listCampaigns(tenantId)) {
    if (c.createdBy !== CAMPAIGN_SHOWCASE_SEED_ACTOR) continue;
    perfCount += await deleteRecordsByCampaign(tenantId, c.orgId, c.id);
    if (await deleteCampaign(tenantId, c.id)) campaignCount += 1;
  }
  for (const b of await listBriefs(tenantId)) {
    if (b.createdBy !== CAMPAIGN_SHOWCASE_SEED_ACTOR) continue;
    if (await deleteBrief(tenantId, b.id)) briefCount += 1;
  }
  // SEED-3 clear leg: scrub the showcase persona ids this seeder stamped onto
  // demo-media asset facets BEFORE deleting the personas — a deleted persona
  // must never leave orphan `marketing.personaIds` references. Only the
  // demo-media-owned assets are touched (the only ones the seeder stamps);
  // every other facet field is preserved (`cleanMarketing` drops an emptied
  // personaIds list on write).
  const showcasePersonaIds = new Set(
    (await listPersonas(tenantId)).filter((p) => p.createdBy === CAMPAIGN_SHOWCASE_SEED_ACTOR).map((p) => p.id),
  );
  if (showcasePersonaIds.size > 0) {
    for (const a of await listAssets(tenantId, orgId)) {
      if (a.uploadedBy !== DEMO_MEDIA_ACTOR) continue;
      const ids = a.marketing?.personaIds ?? [];
      if (!ids.some((id) => showcasePersonaIds.has(id))) continue;
      await updateAsset(tenantId, orgId, a.assetId, {
        marketing: { ...(a.marketing ?? {}), personaIds: ids.filter((id) => !showcasePersonaIds.has(id)) },
      });
      assetPersonaUnstamps += 1;
    }
  }
  for (const p of await listPersonas(tenantId)) {
    if (p.createdBy !== CAMPAIGN_SHOWCASE_SEED_ACTOR) continue;
    if (await deletePersona(tenantId, p.id)) personaCount += 1;
  }
  for (const b of await listBrands(tenantId)) {
    if (b.createdBy !== CAMPAIGN_SHOWCASE_SEED_ACTOR) continue;
    if (await deleteBrand(tenantId, b.id)) brandCount += 1;
  }

  return {
    cleared: brandCount + personaCount + briefCount + campaignCount + perfCount + creativeBriefCount,
    details: { brand: brandCount, personas: personaCount, briefs: briefCount, campaigns: campaignCount, performanceRows: perfCount, creativeBriefs: creativeBriefCount, assetPersonaUnstamps },
  };
}
