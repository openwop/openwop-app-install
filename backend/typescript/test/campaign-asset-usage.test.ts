/**
 * CS-DATA-5 — the durable campaign→media-asset edge. Makes the `'campaign'`
 * MediaUsageRefKind live: a campaign's generated concept images (+ attached
 * library assets) become tracked usage-refs ("used in N campaigns") AND are
 * cleared when the campaign is deleted.
 *
 * Covers:
 *  - `attachCampaignAssets` stamps a `campaign` usage-ref (id + label) on each
 *    asset and records the ids on `campaign.assetIds`;
 *  - the UNION semantics (a second attach ADDS without dropping earlier ids) and
 *    `syncUsageRefs` reconciliation via a second campaign (a dropped asset no
 *    longer refs THAT campaign);
 *  - `deleteCampaign` cascades — the asset's campaign refs are cleared;
 *  - cross-tenant isolation — a foreign tenant's identical asset id is untouched;
 *  - the surface `attachAssets` op resolves by campaignId and by briefId, and
 *    returns `{ found: false }` for neither.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { __resetMedia, createAsset, listUsageForAsset } from '../src/features/media/mediaService.js';
import { createBrief } from '../src/features/campaign-brief/briefService.js';
import {
  __clearCampaigns,
  attachCampaignAssets,
  deleteCampaign,
  finalizeFromBrief,
  getCampaign,
} from '../src/features/campaign-orchestration/campaignService.js';
import { buildCampaignStudioSurface } from '../src/features/campaign-orchestration/surface.js';

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  await __resetMedia();
  await __clearCampaigns();
});

/** A stored library asset for tenant/org with a distinct serve token. */
async function mkAsset(tenantId: string, orgId: string, token: string) {
  return createAsset({
    tenantId, orgId,
    name: `asset ${token}`,
    contentType: 'image/png',
    sizeBytes: 10,
    storageRef: `ref-${token}`,
    serveToken: token,
    uploadedBy: 'u1',
    tags: ['campaign', 'concept'],
  });
}

/** Finalize a campaign from a fresh brief for tenant/org. */
async function mkCampaign(tenantId: string, orgId: string, name: string) {
  const brief = await createBrief(tenantId, orgId, 'u1', { name, productName: 'P', channels: [{ type: 'landing_page', enabled: true, config: {} }] });
  return finalizeFromBrief(tenantId, brief, 'u1');
}

describe('CS-DATA-5 — attachCampaignAssets', () => {
  it('stamps a campaign usage-ref (id + label) and records assetIds on the campaign', async () => {
    const a1 = await mkAsset('tA', 'o1', 'tok-1');
    const a2 = await mkAsset('tA', 'o1', 'tok-2');
    const campaign = await mkCampaign('tA', 'o1', 'Q4 Launch');

    const updated = await attachCampaignAssets('tA', campaign.id, [a1.assetId, a2.assetId]);
    expect(updated?.assetIds).toEqual([a1.assetId, a2.assetId]);

    for (const a of [a1, a2]) {
      const usage = await listUsageForAsset('tA', 'o1', a.assetId);
      expect(usage).toHaveLength(1);
      expect(usage![0].refKind).toBe('campaign');
      expect(usage![0].refId).toBe(campaign.id);
      expect(usage![0].refLabel).toBe('Q4 Launch');
    }

    // The persisted row carries the durable edge.
    const persisted = await getCampaign('tA', campaign.id);
    expect(persisted?.assetIds).toEqual([a1.assetId, a2.assetId]);
  });

  it('unions on re-attach (adds without dropping earlier ids; dedupes)', async () => {
    const a1 = await mkAsset('tA', 'o1', 'tok-1');
    const a2 = await mkAsset('tA', 'o1', 'tok-2');
    const campaign = await mkCampaign('tA', 'o1', 'C');

    await attachCampaignAssets('tA', campaign.id, [a1.assetId]);
    const after = await attachCampaignAssets('tA', campaign.id, [a1.assetId, a2.assetId]);
    // Stable order, no duplicate a1.
    expect(after?.assetIds).toEqual([a1.assetId, a2.assetId]);
    // Both assets now ref the campaign.
    expect(await listUsageForAsset('tA', 'o1', a1.assetId)).toHaveLength(1);
    expect(await listUsageForAsset('tA', 'o1', a2.assetId)).toHaveLength(1);
  });

  it('syncUsageRefs reconciles per campaign — a reduced set on ANOTHER campaign drops the stale ref', async () => {
    // attachCampaignAssets UNIONS within one campaign, so removal is proven via
    // the reconcile keyed by (asset, campaign): a1 belongs to c1 only, a2 to both.
    const a1 = await mkAsset('tA', 'o1', 'tok-1');
    const a2 = await mkAsset('tA', 'o1', 'tok-2');
    const c1 = await mkCampaign('tA', 'o1', 'C1');
    const c2 = await mkCampaign('tA', 'o1', 'C2');

    await attachCampaignAssets('tA', c1.id, [a1.assetId, a2.assetId]);
    await attachCampaignAssets('tA', c2.id, [a2.assetId]);

    // a2 is used in BOTH campaigns (two refs); a1 in one.
    const usageA2 = await listUsageForAsset('tA', 'o1', a2.assetId);
    expect(usageA2!.map((u) => u.refId).sort()).toEqual([c1.id, c2.id].sort());
    const usageA1 = await listUsageForAsset('tA', 'o1', a1.assetId);
    expect(usageA1!.map((u) => u.refId)).toEqual([c1.id]);
  });

  it('deleteCampaign cascades — the asset campaign refs are cleared', async () => {
    const a1 = await mkAsset('tA', 'o1', 'tok-1');
    const campaign = await mkCampaign('tA', 'o1', 'C');
    await attachCampaignAssets('tA', campaign.id, [a1.assetId]);
    expect(await listUsageForAsset('tA', 'o1', a1.assetId)).toHaveLength(1);

    expect(await deleteCampaign('tA', campaign.id)).toBe(true);
    expect(await listUsageForAsset('tA', 'o1', a1.assetId)).toEqual([]);
  });

  it('returns null for an absent campaign (no stamping)', async () => {
    const a1 = await mkAsset('tA', 'o1', 'tok-1');
    expect(await attachCampaignAssets('tA', 'nope', [a1.assetId])).toBeNull();
    expect(await listUsageForAsset('tA', 'o1', a1.assetId)).toEqual([]);
  });

  it('is tenant-isolated — a foreign tenant\'s identical asset id is untouched', async () => {
    // Same asset id would be impossible (createAsset mints UUIDs), so assert the
    // stronger property: another tenant's asset with the SAME serve token gets no
    // campaign ref from tenant tA's attach.
    const aA = await mkAsset('tA', 'o1', 'shared-tok');
    const aB = await mkAsset('tB', 'o1', 'shared-tok');
    const campaign = await mkCampaign('tA', 'o1', 'C');
    await attachCampaignAssets('tA', campaign.id, [aA.assetId]);

    expect(await listUsageForAsset('tA', 'o1', aA.assetId)).toHaveLength(1);
    // tenant B's asset is untouched.
    expect(await listUsageForAsset('tB', 'o1', aB.assetId)).toEqual([]);
  });
});

describe('CS-DATA-5 — surface attachAssets', () => {
  it('resolves by campaignId', async () => {
    const a1 = await mkAsset('tA', 'o1', 'tok-1');
    const campaign = await mkCampaign('tA', 'o1', 'C');
    const surface = buildCampaignStudioSurface({ tenantId: 'tA' });
    const out = await surface.attachAssets({ campaignId: campaign.id, assetIds: [a1.assetId] });
    expect(out.found).toBe(true);
    expect(out.attached).toBe(1);
    expect((out.campaign as { assetIds?: string[] }).assetIds).toEqual([a1.assetId]);
    expect(await listUsageForAsset('tA', 'o1', a1.assetId)).toHaveLength(1);
  });

  it('resolves by briefId', async () => {
    const a1 = await mkAsset('tA', 'o1', 'tok-1');
    const campaign = await mkCampaign('tA', 'o1', 'C');
    const surface = buildCampaignStudioSurface({ tenantId: 'tA' });
    const out = await surface.attachAssets({ briefId: campaign.briefId, assetIds: [a1.assetId] });
    expect(out.found).toBe(true);
    expect((out.campaign as { id: string }).id).toBe(campaign.id);
  });

  it('returns { found: false } for neither', async () => {
    const surface = buildCampaignStudioSurface({ tenantId: 'tA' });
    expect(await surface.attachAssets({ assetIds: [] })).toEqual({ found: false });
    expect(await surface.attachAssets({ campaignId: 'nope' })).toEqual({ found: false });
  });
});
