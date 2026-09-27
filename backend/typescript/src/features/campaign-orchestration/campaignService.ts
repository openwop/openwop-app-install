/**
 * Marketing Campaign service (ADR 0158). CRUD on `DurableCollection`, tenant+org
 * keyed (CTI-1). `finalizeFromBrief` upserts ONE campaign per brief (keyed by
 * briefId) so re-finalizing updates rather than duplicates. A foreign-tenant id
 * reads `null` (the route maps that to 404).
 *
 * Composes the brief (ADR 0156) by reading it — the cross-feature read precedent
 * (priority-matrix → documents/projects). No parallel brief store.
 *
 * @see docs/adr/0158-campaign-studio-orchestration.md
 */

import { randomUUID } from 'node:crypto';
import { DurableCollection, hostExtStorage } from '../../host/hostExtPersistence.js';
import { fireCampaignDeleted } from '../../host/campaignLifecycle.js';
import { cleanString } from '../../host/boundedStrings.js';
import { createLogger } from '../../observability/logger.js';
import { emitHostEvent } from '../../host/hostEventDispatcher.js';
import { clearUsageForRef, getAsset, syncUsageRefs } from '../media/mediaService.js';
import type { CampaignBrief } from '../campaign-brief/types.js';
import type { CampaignStatus, CampaignVersion, MarketingCampaign } from './types.js';

const log = createLogger('campaign-orchestration');

const campaigns = new DurableCollection<MarketingCampaign>('campaign-orchestration:campaign', (c) => `${c.tenantId}::${c.id}`);
const campaignVersions = new DurableCollection<CampaignVersion>('campaign-orchestration:campaignversion', (v) => v.versionId);

/** Cap snapshots per campaign (the CMS `MAX_VERSIONS` precedent). */
const MAX_CAMPAIGN_VERSIONS = 50;

// ── Lifecycle bookkeeping (campaign gap plan §5B B1/B2; the ADR 0204 C1/C5
//    `recordCmsAction` precedent) ─────────────────────────────────────────────

/** Campaign action → the `host.campaign.campaign.*` lifecycle event (vendor
 *  pattern per RFC 0086 §E — schema-legal, no RFC). Fans out through
 *  `emitHostEvent` (host/hostEventDispatcher, ADR 0208): signed webhooks + the
 *  event→workflow trigger bindings, so a campaign event can start a chain. */
const CAMPAIGN_EVENT_FOR_ACTION: Record<string, string> = {
  finalized: 'host.campaign.campaign.finalized',
  'status-changed': 'host.campaign.campaign.status-changed',
  deleted: 'host.campaign.campaign.deleted',
};

/**
 * Record a campaign action: an audit row (`payload.tenantId` REQUIRED — the
 * tenant-scoped governance read withholds rows without it) and, when mapped, a
 * lifecycle webhook through the ONE delivery pipeline. Best-effort — never
 * fails the write it describes. Ids/status only — no kernel copy, no content.
 */
function recordCampaignAction(action: string, campaign: MarketingCampaign, actor: string, extra?: Record<string, unknown>): void {
  const at = new Date().toISOString();
  const base = { tenantId: campaign.tenantId, orgId: campaign.orgId, campaignId: campaign.id, briefId: campaign.briefId, status: campaign.status, version: campaign.version ?? 1, actor, at, ...extra };
  try {
    void hostExtStorage()
      .appendAudit({ timestamp: at, principalId: actor, action: `campaign.campaign.${action}`, resource: campaign.id, outcome: 'success', payload: base })
      .catch((err) => log.warn('campaign audit append failed', { action, campaignId: campaign.id, error: err instanceof Error ? err.message : String(err) }));
  } catch { /* storage unwired (unit tests) */ }
  const eventType = CAMPAIGN_EVENT_FOR_ACTION[action];
  if (eventType) {
    void emitHostEvent({ type: eventType, tenantId: campaign.tenantId, payload: { ...base, name: campaign.name } });
  }
}

/** Snapshot a campaign revision (dedup by `version`). */
async function snapshotCampaign(campaign: MarketingCampaign, actor: string): Promise<void> {
  try {
    const existing = await listCampaignVersions(campaign.tenantId, campaign.id);
    const version = campaign.version ?? 1;
    if (existing.some((v) => v.version === version)) return;
    const seq = existing.length === 0 ? 1 : Math.max(...existing.map((v) => v.seq)) + 1;
    await campaignVersions.put({
      versionId: `${campaign.tenantId}::${campaign.id}::v${version}`,
      tenantId: campaign.tenantId,
      orgId: campaign.orgId,
      campaignId: campaign.id,
      version,
      snapshot: {
        name: campaign.name, objective: campaign.objective, brandId: campaign.brandId,
        personaIds: [...campaign.personaIds], channels: [...campaign.channels],
        kernel: campaign.kernel, status: campaign.status,
      },
      actor,
      at: new Date().toISOString(),
      seq,
    });
    if (existing.length + 1 > MAX_CAMPAIGN_VERSIONS) {
      const oldest = [...existing].sort((a, b) => a.seq - b.seq).slice(0, existing.length + 1 - MAX_CAMPAIGN_VERSIONS);
      for (const v of oldest) await campaignVersions.delete(v.versionId);
    }
  } catch (err) {
    log.warn('campaign snapshot failed', { campaignId: campaign.id, error: err instanceof Error ? err.message : String(err) });
  }
}

/** List a campaign's revision snapshots, newest-first. */
export async function listCampaignVersions(tenantId: string, campaignId: string): Promise<CampaignVersion[]> {
  const all = await campaignVersions.listByPrefix(`${tenantId}::${campaignId}::`);
  return all.filter((v) => v.tenantId === tenantId && v.campaignId === campaignId).sort((a, b) => b.seq - a.seq);
}

const tenantKey = (tenantId: string, id: string): string => `${tenantId}::${id}`;

export async function listCampaigns(tenantId: string, orgId?: string): Promise<MarketingCampaign[]> {
  const all = await campaigns.listByPrefix(`${tenantId}::`);
  return all.filter((c) => !orgId || c.orgId === orgId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getCampaign(tenantId: string, campaignId: string): Promise<MarketingCampaign | null> {
  const c = await campaigns.get(tenantKey(tenantId, campaignId));
  return c && c.tenantId === tenantId ? c : null;
}

export async function getCampaignByBrief(tenantId: string, briefId: string): Promise<MarketingCampaign | null> {
  const all = await campaigns.listByPrefix(`${tenantId}::`);
  return all.find((c) => c.briefId === briefId) ?? null;
}

/** Build a campaign payload from a confirmed/validated brief (pure). Optional
 *  fields are emitted with an EXPLICIT `undefined` when the brief lacks them
 *  (grade-code AUDIT-12) — so a re-finalize's `{ ...existing, ...payload }` merge
 *  CLEARS a field the brief removed (budget/brand/kernel/utm) instead of leaving
 *  a stale value; `undefined` keys drop on the JSON `put`. */
export function buildCampaignFromBrief(brief: CampaignBrief): Omit<MarketingCampaign, 'id' | 'createdAt' | 'updatedAt' | 'createdBy'> {
  return {
    tenantId: brief.tenantId,
    orgId: brief.orgId,
    briefId: brief.id,
    name: brief.name,
    objective: brief.objective,
    brandId: brief.brandId,
    personaIds: brief.personaIds,
    kbCollectionId: brief.kbCollectionId,
    channels: brief.channels.filter((c) => c.enabled).map((c) => c.type),
    kernel: brief.kernel,
    budget: brief.budget,
    utm: brief.utm,
    status: 'draft',
  };
}

/** Upsert a campaign from a brief — one campaign per brief (re-finalize updates). */
export async function finalizeFromBrief(tenantId: string, brief: CampaignBrief, createdBy: string, opts?: { productionPlanId?: string }): Promise<MarketingCampaign> {
  const payload = buildCampaignFromBrief(brief);
  const existing = await getCampaignByBrief(tenantId, brief.id);
  const now = new Date().toISOString();
  const campaign: MarketingCampaign = existing
    ? { ...existing, ...payload, status: existing.status, version: (existing.version ?? 1) + 1, updatedAt: now, ...(opts?.productionPlanId ? { productionPlanId: opts.productionPlanId } : {}) }
    : { ...payload, id: randomUUID(), version: 1, createdBy, createdAt: now, updatedAt: now, ...(opts?.productionPlanId ? { productionPlanId: opts.productionPlanId } : {}) };
  if (existing) await snapshotCampaign(existing, createdBy); // pin the pre-refinalize revision
  await campaigns.put(campaign);
  await snapshotCampaign(campaign, createdBy); // pin the finalized revision
  recordCampaignAction('finalized', campaign, createdBy, { refinalized: Boolean(existing) });
  return campaign;
}

export async function updateCampaignStatus(tenantId: string, campaignId: string, status: CampaignStatus, actor = 'system'): Promise<MarketingCampaign | null> {
  const existing = await getCampaign(tenantId, campaignId);
  if (!existing) return null;
  const next: MarketingCampaign = { ...existing, status, updatedAt: new Date().toISOString() };
  await campaigns.put(next);
  if (status !== existing.status) recordCampaignAction('status-changed', next, actor, { from: existing.status });
  return next;
}

export async function renameCampaign(tenantId: string, campaignId: string, name: string, actor = 'system'): Promise<MarketingCampaign | null> {
  const existing = await getCampaign(tenantId, campaignId);
  if (!existing) return null;
  const clean = cleanString(name, 160);
  const next: MarketingCampaign = { ...existing, name: clean || existing.name, updatedAt: new Date().toISOString() };
  await campaigns.put(next);
  if (next.name !== existing.name) recordCampaignAction('renamed', next, actor, { from: existing.name });
  return next;
}

/** Set/clear a campaign's parent (C8 hierarchy — plain reference). The route
 *  validates same-org + existence; this stays a dumb write. */
export async function setCampaignParent(tenantId: string, campaignId: string, parentCampaignId: string | undefined, actor = 'system'): Promise<MarketingCampaign | null> {
  const existing = await getCampaign(tenantId, campaignId);
  if (!existing) return null;
  const next: MarketingCampaign = { ...existing, updatedAt: new Date().toISOString() };
  if (parentCampaignId) next.parentCampaignId = parentCampaignId;
  else delete next.parentCampaignId;
  await campaigns.put(next);
  if ((existing.parentCampaignId ?? '') !== (parentCampaignId ?? '')) {
    recordCampaignAction('parent-changed', next, actor, { from: existing.parentCampaignId ?? null, to: parentCampaignId ?? null });
  }
  return next;
}

/** Attach media assets to a campaign — the durable campaign→asset edge
 *  (CS-DATA-5). UNIONS `assetIds` into `campaign.assetIds` (dedupe, stable
 *  order) so a re-render adds concepts without dropping earlier ones, then
 *  stamps the media "used in N campaigns" graph best-effort (the
 *  `stampMoodBoardUsage` precedent): resolve each assetId → serveToken and
 *  reconcile the FULL set for this campaign via `syncUsageRefs`. Cleared in
 *  `deleteCampaign`. Returns the updated campaign, or null if it is absent. */
export async function attachCampaignAssets(tenantId: string, campaignId: string, assetIds: string[], actor = 'workflow'): Promise<MarketingCampaign | null> {
  const existing = await getCampaign(tenantId, campaignId);
  if (!existing) return null;
  const merged: string[] = [];
  const seen = new Set<string>();
  for (const id of [...(existing.assetIds ?? []), ...assetIds]) {
    const clean = typeof id === 'string' ? id.trim() : '';
    if (clean && !seen.has(clean)) { seen.add(clean); merged.push(clean); }
  }
  const next: MarketingCampaign = { ...existing, assetIds: merged, updatedAt: new Date().toISOString() };
  await campaigns.put(next);
  // Stamp the media usage graph best-effort — never fail the attach because
  // bookkeeping did (the `stampMoodBoardUsage` precedent). Reconcile the FULL
  // set (syncUsageRefs adds + removes), so a stale ref self-corrects.
  try {
    const tokens: string[] = [];
    for (const id of merged) {
      const a = await getAsset(tenantId, next.orgId, id);
      if (a) tokens.push(a.serveToken);
    }
    await syncUsageRefs(tenantId, next.orgId, { kind: 'campaign', id: campaignId, label: next.name }, tokens);
  } catch (err) {
    log.warn('campaign asset usage stamping failed', { campaignId, error: err instanceof Error ? err.message : String(err) });
  }
  recordCampaignAction('assets-attached', next, actor, { attached: assetIds.length, total: merged.length });
  return next;
}

export async function deleteCampaign(tenantId: string, campaignId: string, actor = 'system'): Promise<boolean> {
  const existing = await getCampaign(tenantId, campaignId);
  if (!existing) return false;
  // Cascade the campaign→asset usage graph (CS-DATA-5) before the row is gone —
  // best-effort, mirrors the media clear-on-referencing-document-delete path.
  try {
    await clearUsageForRef(tenantId, existing.orgId, 'campaign', campaignId);
  } catch (err) {
    log.warn('campaign asset usage clear failed', { campaignId, error: err instanceof Error ? err.message : String(err) });
  }
  const deleted = await campaigns.delete(tenantKey(tenantId, campaignId));
  if (deleted) {
    recordCampaignAction('deleted', existing, actor);
    for (const v of await listCampaignVersions(tenantId, campaignId)) await campaignVersions.delete(v.versionId);
    // Fire the delete seam AFTER the row is gone so sibling campaign-* features
    // (connectors → perf, intel → pacing memo) prune their own per-campaign rows
    // without campaign-orchestration importing them (crmRecordLifecycle pattern).
    await fireCampaignDeleted({ tenantId, orgId: existing.orgId, campaignId });
  }
  return deleted;
}

/** Test-only: drop every campaign. */
export async function __clearCampaigns(): Promise<void> {
  await campaigns.__clear();
}
