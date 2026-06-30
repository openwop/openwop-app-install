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
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { cleanString } from '../../host/boundedStrings.js';
import type { CampaignBrief } from '../campaign-brief/types.js';
import type { CampaignStatus, MarketingCampaign } from './types.js';

const campaigns = new DurableCollection<MarketingCampaign>('campaign-orchestration:campaign', (c) => `${c.tenantId}::${c.id}`);

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

/** Build a campaign payload from a confirmed/validated brief (pure). */
export function buildCampaignFromBrief(brief: CampaignBrief): Omit<MarketingCampaign, 'id' | 'createdAt' | 'updatedAt' | 'createdBy'> {
  return {
    tenantId: brief.tenantId,
    orgId: brief.orgId,
    briefId: brief.id,
    name: brief.name,
    objective: brief.objective,
    ...(brief.brandId ? { brandId: brief.brandId } : {}),
    personaIds: brief.personaIds,
    ...(brief.kbCollectionId ? { kbCollectionId: brief.kbCollectionId } : {}),
    channels: brief.channels.filter((c) => c.enabled).map((c) => c.type),
    ...(brief.kernel ? { kernel: brief.kernel } : {}),
    status: 'draft',
  };
}

/** Upsert a campaign from a brief — one campaign per brief (re-finalize updates). */
export async function finalizeFromBrief(tenantId: string, brief: CampaignBrief, createdBy: string): Promise<MarketingCampaign> {
  const payload = buildCampaignFromBrief(brief);
  const existing = await getCampaignByBrief(tenantId, brief.id);
  const now = new Date().toISOString();
  const campaign: MarketingCampaign = existing
    ? { ...existing, ...payload, status: existing.status, updatedAt: now }
    : { ...payload, id: randomUUID(), createdBy, createdAt: now, updatedAt: now };
  await campaigns.put(campaign);
  return campaign;
}

export async function updateCampaignStatus(tenantId: string, campaignId: string, status: CampaignStatus): Promise<MarketingCampaign | null> {
  const existing = await getCampaign(tenantId, campaignId);
  if (!existing) return null;
  const next: MarketingCampaign = { ...existing, status, updatedAt: new Date().toISOString() };
  await campaigns.put(next);
  return next;
}

export async function renameCampaign(tenantId: string, campaignId: string, name: string): Promise<MarketingCampaign | null> {
  const existing = await getCampaign(tenantId, campaignId);
  if (!existing) return null;
  const clean = cleanString(name, 160);
  const next: MarketingCampaign = { ...existing, name: clean || existing.name, updatedAt: new Date().toISOString() };
  await campaigns.put(next);
  return next;
}

export async function deleteCampaign(tenantId: string, campaignId: string): Promise<boolean> {
  const existing = await getCampaign(tenantId, campaignId);
  if (!existing) return false;
  return campaigns.delete(tenantKey(tenantId, campaignId));
}

/** Test-only: drop every campaign. */
export async function __clearCampaigns(): Promise<void> {
  await campaigns.__clear();
}
