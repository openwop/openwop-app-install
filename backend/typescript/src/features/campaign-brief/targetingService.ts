/**
 * Targeting-pack service (ADR 0403 Phase 3) — platform-keyed audience /
 * interest / keyword recommendations, each citing the VOC evidence it derives
 * from (`evidenceRefs` resolve at persist time — the angle proofRefs
 * precedent). ONE pack per brief+platform (deterministic upsert — a re-run
 * replaces, never duplicates).
 *
 * Store: `campaign-brief:targeting-pack`, `tenant::brief::platform` keyed.
 * Cascades with the brief (wired by briefService.deleteBrief).
 *
 * @see docs/adr/0403-market-intel-pipeline.md
 */

import { DurableCollection } from '../../host/hostExtPersistence.js';
import { cleanString } from '../../host/boundedStrings.js';

export const TARGETING_PLATFORMS = ['meta', 'google', 'linkedin', 'tiktok'] as const;
export type TargetingPlatform = (typeof TARGETING_PLATFORMS)[number];

export interface TargetingPack {
  id: string;
  tenantId: string;
  orgId: string;
  briefId: string;
  platform: TargetingPlatform;
  audiences: string[];
  interests: string[];
  keywords: string[];
  rationale: string;
  /** Every id resolves to a stored voc-evidence row of this brief. */
  evidenceRefs: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

const packs = new DurableCollection<TargetingPack>('campaign-brief:targeting-pack', (p) => `${p.tenantId}::${p.briefId}::${p.platform}`);

const ITEM_MAX = 200;
const LIST_MAX = 40;
const RATIONALE_MAX = 4000;
const MAX_EVIDENCE_REFS = 30;

export const TARGETING_LIMITS = {
  itemMax: ITEM_MAX, listMax: LIST_MAX, rationaleMax: RATIONALE_MAX, maxEvidenceRefs: MAX_EVIDENCE_REFS,
} as const;

const strList = (raw: unknown): string[] =>
  Array.isArray(raw) ? raw.slice(0, LIST_MAX).map((v) => cleanString(v, ITEM_MAX)).filter((v) => v.length > 0) : [];

export interface TargetingCandidateInput {
  platform?: unknown;
  audiences?: unknown;
  interests?: unknown;
  keywords?: unknown;
  rationale?: unknown;
  evidenceRefs?: unknown;
}

export interface TargetingValidationFinding {
  field: string;
  message: string;
}

/** Closed-world validation against the brief's LIVE evidence ids. */
export function validateTargetingCandidate(raw: TargetingCandidateInput, validEvidenceIds: ReadonlySet<string>):
  | { ok: true; item: Pick<TargetingPack, 'platform' | 'audiences' | 'interests' | 'keywords' | 'rationale' | 'evidenceRefs'> }
  | { ok: false; finding: TargetingValidationFinding } {
  const platform = typeof raw.platform === 'string' && (TARGETING_PLATFORMS as readonly string[]).includes(raw.platform)
    ? (raw.platform as TargetingPlatform) : null;
  if (!platform) return { ok: false, finding: { field: 'platform', message: `platform must be one of: ${TARGETING_PLATFORMS.join(', ')}.` } };
  const audiences = strList(raw.audiences);
  const interests = strList(raw.interests);
  const keywords = strList(raw.keywords);
  if (audiences.length + interests.length + keywords.length === 0) {
    return { ok: false, finding: { field: 'audiences', message: 'A targeting pack needs at least one audience, interest, or keyword.' } };
  }
  const rationale = cleanString(raw.rationale, RATIONALE_MAX);
  if (!rationale) return { ok: false, finding: { field: 'rationale', message: 'A rationale citing the evidence is required.' } };
  const rawRefs = Array.isArray(raw.evidenceRefs) ? raw.evidenceRefs.filter((r): r is string => typeof r === 'string' && r.length > 0) : [];
  const evidenceRefs = [...new Set(rawRefs)].slice(0, MAX_EVIDENCE_REFS);
  if (evidenceRefs.length === 0) {
    return { ok: false, finding: { field: 'evidenceRefs', message: 'An ungrounded targeting pack is not persisted — cite at least one stored voc-evidence id.' } };
  }
  const unresolvable = evidenceRefs.filter((r) => !validEvidenceIds.has(r));
  if (unresolvable.length > 0) {
    return { ok: false, finding: { field: 'evidenceRefs', message: `evidenceRefs do not resolve to stored evidence of this brief: ${unresolvable.slice(0, 5).join(', ')}.` } };
  }
  return { ok: true, item: { platform, audiences, interests, keywords, rationale, evidenceRefs } };
}

/** Upsert THE pack for brief+platform (deterministic key — re-runs replace). */
export async function persistTargetingPack(
  tenantId: string,
  orgId: string,
  briefId: string,
  createdBy: string,
  item: Pick<TargetingPack, 'platform' | 'audiences' | 'interests' | 'keywords' | 'rationale' | 'evidenceRefs'>,
): Promise<TargetingPack> {
  const now = new Date().toISOString();
  const existing = await packs.get(`${tenantId}::${briefId}::${item.platform}`);
  const row: TargetingPack = {
    id: `${briefId}:${item.platform}`,
    tenantId, orgId, briefId,
    ...item,
    createdBy: existing?.createdBy ?? createdBy,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await packs.put(row);
  return row;
}

export async function getTargetingPack(tenantId: string, briefId: string, platform: TargetingPlatform): Promise<TargetingPack | null> {
  const p = await packs.get(`${tenantId}::${briefId}::${platform}`);
  return p && p.tenantId === tenantId ? p : null;
}

export async function listTargetingPacks(tenantId: string, briefId: string): Promise<TargetingPack[]> {
  const all = await packs.listByPrefix(`${tenantId}::${briefId}::`);
  return all.filter((p) => p.tenantId === tenantId).sort((a, b) => a.platform.localeCompare(b.platform));
}

export async function deleteTargetingPack(tenantId: string, briefId: string, platform: TargetingPlatform): Promise<boolean> {
  const p = await getTargetingPack(tenantId, briefId, platform);
  if (!p) return false;
  await packs.delete(`${tenantId}::${briefId}::${platform}`);
  return true;
}

/** Cascade owner: a deleted brief takes its targeting packs with it. */
export async function deleteTargetingForBrief(tenantId: string, briefId: string): Promise<number> {
  const all = await packs.listByPrefix(`${tenantId}::${briefId}::`);
  for (const p of all) await packs.delete(`${p.tenantId}::${p.briefId}::${p.platform}`);
  return all.length;
}

/** Guard helper for evidence curation-delete (mirrors anglesCiting). */
export async function targetingCiting(tenantId: string, briefId: string, evidenceId: string): Promise<TargetingPack[]> {
  return (await listTargetingPacks(tenantId, briefId)).filter((p) => p.evidenceRefs.includes(evidenceId));
}

/** Test-only. */
export async function __resetTargetingStore(): Promise<void> {
  await packs.__clear();
}

export function isTargetingPlatform(raw: unknown): raw is TargetingPlatform {
  return typeof raw === 'string' && (TARGETING_PLATFORMS as readonly string[]).includes(raw);
}
