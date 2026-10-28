/**
 * ADR 0941 P1 — a campaign's links to the records it is about: catalog
 * products (ADR 0410), and the read projection that fans out to every owner
 * (`GET …/campaigns/:id/links`).
 *
 * - **Products.** `productRefs` name products of the campaign's OWN org. The
 *   route validates each ref against commerce before any write. A reverse index
 *   (`campaign-orchestration:product-ref`, `tenant::productId::campaignId`)
 *   makes the product-delete hook a point lookup. Its rows are written BEFORE
 *   the campaign CAS. Stale rows remain as harmless candidates: the hook
 *   validates the forward ref before acting. Removing one after a write could
 *   remove the marker of a concurrent reattachment.
 * - **Product deleted.** The ref is detached and the campaign gets an
 *   `attention` flag (the `needs_attention` state). A campaign is never
 *   cascade-deleted.
 * - **Funnels** are NOT stored here. The edge is the funnel's own
 *   `campaignId` (ADR 0948 owns it; children point up, D1), so the campaign
 *   keeps no funnel list; ADR 0948 adds the `funnels` section below.
 * - **Links read.** Each section is read through its owner and reported as
 *   `ok`, `unavailable` (the owning feature is off) or `failed` (the read threw).
 *   A failed read is never shown as "not linked" (the ADR 0570 D3 read-back rule).
 *
 * @see docs/adr/0941-campaign-studio-program-and-canonical-campaign.md
 */

import { DurableCollection } from '../../host/hostExtPersistence.js';
import { createLogger } from '../../observability/logger.js';
import { onProductDeleted } from '../commerce/productLifecycleSeam.js';
import { getProduct } from '../commerce/commerceService.js';
import { getAsset } from '../media/mediaService.js';
import { listSendsForMarketingCampaign } from '../email/emailService.js';
import { listPlansForCampaign } from '../campaign-studio/planLinks.js';
import { listAssets as listOpsAssets } from '../campaign-ops/assetService.js';
import { listCampaignDispatchRecords } from '../../host/adsAdapter.js';
import { getCampaign, mutateCampaign } from './campaignService.js';
import { getCampaignProjectId } from './campaignProject.js';
import { listCampaignRuns } from './campaignRunTag.js';
import type { CampaignAttention, CampaignProductRef, CampaignRunIndexRow, MarketingCampaign } from './types.js';

const log = createLogger('campaign-orchestration.links');

export const MAX_PRODUCT_REFS = 20;
const MAX_ATTENTION = 20;
const LINKS_RUN_LIMIT = 50;
/** Asset ids grow with every render; the projection reads at most this many. */
const LINKS_ASSET_LIMIT = 100;

interface ProductRefRow { tenantId: string; productId: string; campaignId: string }

const productRefIndex = new DurableCollection<ProductRefRow>(
  'campaign-orchestration:product-ref',
  (r) => `${r.tenantId}::${r.productId}::${r.campaignId}`,
  undefined,
  (r) => r.tenantId,
);

export interface CampaignLinksPatch {
  productRefs?: CampaignProductRef[];
  /** Clear every attention flag (a person has looked). */
  clearAttention?: boolean;
}

/**
 * Write a campaign's links. The caller has validated every ref (same org,
 * exists, bounds); this keeps the reverse index in step with the CAS write.
 */
export async function setCampaignLinks(tenantId: string, campaignId: string, patch: CampaignLinksPatch): Promise<MarketingCampaign | null> {
  if (patch.productRefs) {
    for (const ref of patch.productRefs) await productRefIndex.put({ tenantId, productId: ref.productId, campaignId });
  }
  const written = await mutateCampaign(tenantId, campaignId, (c) => {
    const next: MarketingCampaign = { ...c, updatedAt: new Date().toISOString() };
    if (patch.productRefs) {
      if (patch.productRefs.length > 0) next.productRefs = patch.productRefs.map((r) => ({ productId: r.productId, role: r.role }));
      else delete next.productRefs;
    }
    if (patch.clearAttention) delete next.attention;
    return next;
  });
  if (!written) return null;
  if (patch.productRefs) {
    // The product may have been deleted after route validation, before the
    // reverse marker or campaign CAS became visible. Close that gap after the
    // write; a later deletion sees the retained reverse marker itself.
    for (const ref of patch.productRefs) {
      if (!(await getProduct(tenantId, written.after.orgId, ref.productId))) {
        await detachDeletedProduct({ tenantId, orgId: written.after.orgId, productId: ref.productId });
      }
    }
    return getCampaign(tenantId, campaignId);
  }
  return written.after;
}

/** Product-delete hook: detach the ref and flag the campaign. Idempotent. */
export async function detachDeletedProduct(e: { tenantId: string; orgId: string; productId: string }): Promise<number> {
  let flagged = 0;
  for (const row of await productRefIndex.listByPrefix(`${e.tenantId}::${e.productId}::`)) {
    if (row.tenantId !== e.tenantId || row.productId !== e.productId) continue;
    const at = new Date().toISOString();
    const written = await mutateCampaign(e.tenantId, row.campaignId, (c) => {
      if (c.orgId !== e.orgId || !(c.productRefs ?? []).some((r) => r.productId === e.productId)) return null;
      const refs = (c.productRefs ?? []).filter((r) => r.productId !== e.productId);
      const flag: CampaignAttention = { reason: 'product_deleted', productId: e.productId, at };
      const attention = [...(c.attention ?? []).filter((a) => !(a.reason === flag.reason && a.productId === flag.productId)), flag].slice(-MAX_ATTENTION);
      const next: MarketingCampaign = { ...c, attention, updatedAt: at };
      if (refs.length > 0) next.productRefs = refs;
      else delete next.productRefs;
      return next;
    });
    if (written && written.after !== written.before) flagged += 1;
    // Keep the marker: a concurrent attachment may already depend on it.
  }
  return flagged;
}

export function registerCampaignLinkHooks(): void {
  onProductDeleted('campaign-orchestration', async (e) => {
    const flagged = await detachDeletedProduct(e);
    if (flagged > 0) log.info('campaign_product_detached', { tenantId: e.tenantId, productId: e.productId, campaigns: flagged });
  });
}

// ── Links read projection ──────────────────────────────────────────────────

export type LinkSection<T> =
  | { status: 'ok'; items: T[] }
  | { status: 'unavailable'; reason: 'feature_off' }
  | { status: 'failed'; error: 'read_failed' };

type LinkState = 'linked' | 'missing';

export interface CampaignLinks {
  products: LinkSection<{ productId: string; role: CampaignProductRef['role']; state: LinkState; name?: string }>;
  project: LinkSection<{ projectId: string }>;
  assets: LinkSection<{ assetId: string; state: LinkState; name?: string }>;
  runs: LinkSection<Pick<CampaignRunIndexRow, 'runId' | 'workflowId' | 'startedAt' | 'role' | 'forkOf' | 'parentRunId'>>;
  /** ADR 0941 P2 — the children that point up at the campaign. */
  emailSends: LinkSection<{ sendId: string; status: string; templateId: string; legacy?: true }>;
  adDispatches: LinkSection<{ platform: string; platformCampaignId: string; createdAt: string; legacy?: true }>;
  plans: LinkSection<{ canvasId: string; linkedAt: string }>;
  opsAssets: LinkSection<{ assetId: string; label: string; destination: string }>;
  /** How many asset ids the campaign holds (the `assets` section lists the first 100). */
  assetTotal: number;
}

async function section<T>(name: string, campaignId: string, enabled: boolean, read: () => Promise<T[]>): Promise<LinkSection<T>> {
  if (!enabled) return { status: 'unavailable', reason: 'feature_off' };
  try {
    return { status: 'ok', items: await read() };
  } catch (err) {
    log.warn('campaign_links_read_failed', { section: name, campaignId, error: err instanceof Error ? err.message : String(err) });
    return { status: 'failed', error: 'read_failed' };
  }
}

/**
 * Read every link of a campaign through its owner. The caller has checked
 * `workspace:read` on the campaign's org; every owner read is scoped to that
 * org, and only display fields leave this function (never product cost,
 * inventory or download tokens).
 */
export async function readCampaignLinks(campaign: MarketingCampaign, isEnabled: (featureId: string) => Promise<boolean>): Promise<CampaignLinks> {
  const { tenantId, orgId, id } = campaign;
  const [commerceOn, emailOn, plansOn, opsOn] = await Promise.all([
    isEnabled('commerce'), isEnabled('email'), isEnabled('campaign-studio'), isEnabled('campaign-ops'),
  ]);
  const { briefId } = campaign;
  const [products, project, assets, runs, emailSends, adDispatches, plans, opsAssets] = await Promise.all([
    section('products', id, commerceOn, async () => Promise.all((campaign.productRefs ?? []).map(async (ref) => {
      const p = await getProduct(tenantId, orgId, ref.productId);
      return p ? { productId: ref.productId, role: ref.role, state: 'linked' as const, name: p.name } : { productId: ref.productId, role: ref.role, state: 'missing' as const };
    }))),
    section('project', id, true, async () => {
      const projectId = await getCampaignProjectId(tenantId, id);
      return projectId ? [{ projectId }] : [];
    }),
    // Media is always on (ADR 0027).
    section('assets', id, true, async () => Promise.all((campaign.assetIds ?? []).slice(0, LINKS_ASSET_LIMIT).map(async (assetId) => {
      const a = await getAsset(tenantId, orgId, assetId);
      return a ? { assetId, state: 'linked' as const, name: a.name } : { assetId, state: 'missing' as const };
    }))),
    section('runs', id, true, async () => (await listCampaignRuns(tenantId, id)).slice(0, LINKS_RUN_LIMIT).map((r) => ({
      runId: r.runId, workflowId: r.workflowId, startedAt: r.startedAt,
      ...(r.role ? { role: r.role } : {}), ...(r.forkOf ? { forkOf: r.forkOf } : {}), ...(r.parentRunId ? { parentRunId: r.parentRunId } : {}),
    }))),
    // Rows written before the back-link match by the campaign's brief and say so.
    section('emailSends', id, emailOn, async () => (await listSendsForMarketingCampaign(tenantId, orgId, id, briefId)).map((c) => ({
      sendId: c.campaignId, status: c.status, templateId: c.templateId, ...(c.marketingCampaignId ? {} : { legacy: true as const }),
    }))),
    // The ads ledger is the host's (the adsAdapter chokepoint), not a toggled feature.
    section('adDispatches', id, true, async () => (await listCampaignDispatchRecords(tenantId, orgId, id, briefId)).map((d) => ({
      platform: d.platform, platformCampaignId: d.platformCampaignId, createdAt: d.createdAt, ...(d.campaignId ? {} : { legacy: true as const }),
    }))),
    section('plans', id, plansOn, async () => (await listPlansForCampaign(tenantId, id)).filter((l) => l.orgId === orgId).map((l) => ({ canvasId: l.canvasId, linkedAt: l.linkedAt }))),
    section('opsAssets', id, opsOn, async () => (await listOpsAssets(tenantId, orgId, id)).map((a) => ({ assetId: a.assetId, label: a.label, destination: a.destination }))),
  ]);
  return { products, project, assets, runs, emailSends, adDispatches, plans, opsAssets, assetTotal: (campaign.assetIds ?? []).length };
}
