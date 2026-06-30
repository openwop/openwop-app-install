/**
 * Campaign Brief service (ADR 0156 Phase 2). Owns the `CampaignBrief` entity —
 * CRUD on `DurableCollection`, tenant + org keyed (CTI-1). A brief references a
 * brand / personas / KB collection by id; cross-org reference integrity is the
 * route layer's job (it loads each in the caller's org). `validate` computes the
 * enabled channel set that drives the orchestration fan-out (ADR 0158).
 *
 * @see docs/adr/0156-campaign-studio-personas-brief.md
 */

import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { cleanString, optionalCleanString } from '../../host/boundedStrings.js';
import {
  CAMPAIGN_CHANNELS, EMPTY_MESSAGING, defaultChannels,
  type BriefChannel, type BriefMessaging, type BriefValidationResult, type CampaignBrief,
  type CampaignChannel, type MessagingKernel,
} from './types.js';

const briefs = new DurableCollection<CampaignBrief>('campaign-brief:brief', (b) => `${b.tenantId}::${b.id}`);

const NAME_MAX = 160;
const TEXT_MAX = 2000;
const ITEM_MAX = 400;
const LIST_MAX = 50;

export interface BriefInput {
  name?: unknown;
  objective?: unknown;
  brandId?: unknown;
  personaIds?: unknown;
  kbCollectionId?: unknown;
  productName?: unknown;
  productDescription?: unknown;
  industryVertical?: unknown;
  channels?: unknown;
  messaging?: unknown;
  status?: unknown;
}

const idList = (raw: unknown): string[] =>
  Array.isArray(raw) ? raw.slice(0, LIST_MAX).map((v) => cleanString(v, NAME_MAX)).filter((v) => v.length > 0) : [];
const strList = (raw: unknown): string[] =>
  Array.isArray(raw) ? raw.slice(0, LIST_MAX).map((v) => cleanString(v, ITEM_MAX)).filter((v) => v.length > 0) : [];

const CHANNEL_SET = new Set<string>(CAMPAIGN_CHANNELS);

function sanitizeChannels(raw: unknown): BriefChannel[] {
  const base = defaultChannels();
  if (!Array.isArray(raw)) return base;
  const byType = new Map(base.map((c) => [c.type, c]));
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const type = cleanString(r.type, 40);
    if (!CHANNEL_SET.has(type)) continue;
    byType.set(type as CampaignChannel, {
      type: type as CampaignChannel,
      enabled: r.enabled === true,
      config: r.config && typeof r.config === 'object' ? (r.config as Record<string, unknown>) : {},
    });
  }
  return CAMPAIGN_CHANNELS.map((t) => byType.get(t)!);
}

function sanitizeMessaging(raw: unknown): BriefMessaging {
  if (!raw || typeof raw !== 'object') return { ...EMPTY_MESSAGING };
  const m = raw as Record<string, unknown>;
  return {
    primaryValueProp: cleanString(m.primaryValueProp, TEXT_MAX),
    toneOverride: cleanString(m.toneOverride, NAME_MAX),
    proofPoints: strList(m.proofPoints),
    ctaStrategy: cleanString(m.ctaStrategy, NAME_MAX),
  };
}

const tenantKey = (tenantId: string, id: string): string => `${tenantId}::${id}`;

export async function listBriefs(tenantId: string, orgId?: string): Promise<CampaignBrief[]> {
  const all = await briefs.listByPrefix(`${tenantId}::`);
  return all.filter((b) => !orgId || b.orgId === orgId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function getBrief(tenantId: string, briefId: string): Promise<CampaignBrief | null> {
  const b = await briefs.get(tenantKey(tenantId, briefId));
  return b && b.tenantId === tenantId ? b : null;
}

export async function createBrief(tenantId: string, orgId: string, createdBy: string, input: BriefInput): Promise<CampaignBrief> {
  const name = cleanString(input.name, NAME_MAX);
  if (!name) throw new OpenwopError('validation_error', 'A brief name is required.', 400, { field: 'name' });
  const now = new Date().toISOString();
  const brief: CampaignBrief = {
    id: randomUUID(),
    tenantId,
    orgId,
    name,
    objective: cleanString(input.objective, TEXT_MAX),
    brandId: optionalCleanString(input.brandId, NAME_MAX),
    personaIds: idList(input.personaIds),
    kbCollectionId: optionalCleanString(input.kbCollectionId, NAME_MAX),
    productName: cleanString(input.productName, NAME_MAX),
    productDescription: cleanString(input.productDescription, TEXT_MAX),
    industryVertical: cleanString(input.industryVertical, NAME_MAX),
    channels: sanitizeChannels(input.channels),
    messaging: sanitizeMessaging(input.messaging),
    status: 'draft',
    kernelStale: false,
    createdBy,
    createdAt: now,
    updatedAt: now,
  };
  await briefs.put(brief);
  return brief;
}

/** Patch a brief. Any content change to a brief that already has a kernel marks
 *  it stale (the kernel must be regenerated). */
export async function updateBrief(tenantId: string, briefId: string, input: BriefInput): Promise<CampaignBrief | null> {
  const existing = await getBrief(tenantId, briefId);
  if (!existing) return null;
  const next: CampaignBrief = {
    ...existing,
    name: input.name !== undefined ? cleanString(input.name, NAME_MAX) || existing.name : existing.name,
    objective: input.objective !== undefined ? cleanString(input.objective, TEXT_MAX) : existing.objective,
    brandId: input.brandId !== undefined ? optionalCleanString(input.brandId, NAME_MAX) : existing.brandId,
    personaIds: input.personaIds !== undefined ? idList(input.personaIds) : existing.personaIds,
    kbCollectionId: input.kbCollectionId !== undefined ? optionalCleanString(input.kbCollectionId, NAME_MAX) : existing.kbCollectionId,
    productName: input.productName !== undefined ? cleanString(input.productName, NAME_MAX) : existing.productName,
    productDescription: input.productDescription !== undefined ? cleanString(input.productDescription, TEXT_MAX) : existing.productDescription,
    industryVertical: input.industryVertical !== undefined ? cleanString(input.industryVertical, NAME_MAX) : existing.industryVertical,
    channels: input.channels !== undefined ? sanitizeChannels(input.channels) : existing.channels,
    messaging: input.messaging !== undefined ? sanitizeMessaging(input.messaging) : existing.messaging,
    status: input.status === 'confirmed' || input.status === 'validated' || input.status === 'draft' ? input.status : existing.status,
    updatedAt: new Date().toISOString(),
  };
  // Any content edit invalidates an existing kernel.
  if (existing.kernel && !input.status) next.kernelStale = true;
  await briefs.put(next);
  return next;
}

export async function deleteBrief(tenantId: string, briefId: string): Promise<boolean> {
  const existing = await getBrief(tenantId, briefId);
  if (!existing) return false;
  return briefs.delete(tenantKey(tenantId, briefId));
}

/** Persist a generated kernel (called from the Phase-3 surface). Clears stale. */
export async function setKernel(tenantId: string, briefId: string, kernel: MessagingKernel): Promise<CampaignBrief | null> {
  const existing = await getBrief(tenantId, briefId);
  if (!existing) return null;
  const next: CampaignBrief = { ...existing, kernel, kernelStale: false, status: 'validated', updatedAt: new Date().toISOString() };
  await briefs.put(next);
  return next;
}

/** Validate brief completeness + compute the enabled channel set. Pure. */
export function validateBrief(brief: CampaignBrief): BriefValidationResult {
  const issues: BriefValidationResult['issues'] = [];
  if (!brief.name.trim()) issues.push({ field: 'name', message: 'A campaign name is required.' });
  if (!brief.productName.trim()) issues.push({ field: 'productName', message: 'A product is required.' });
  if (brief.personaIds.length === 0) issues.push({ field: 'personaIds', message: 'At least one persona is required.' });
  if (!brief.messaging.primaryValueProp.trim()) issues.push({ field: 'messaging.primaryValueProp', message: 'A primary value proposition is required.' });
  const enabledChannels: CampaignChannel[] = brief.channels.filter((c) => c.enabled).map((c) => c.type);
  if (enabledChannels.length === 0) issues.push({ field: 'channels', message: 'Enable at least one channel.' });
  return { valid: issues.length === 0, issues, enabledChannels };
}

/** Test-only: drop every brief. */
export async function __clearBriefs(): Promise<void> {
  await briefs.__clear();
}
