/**
 * Ad-angle service (ADR 0403 Phase 2) — positioning angles grounded in stored
 * VOC evidence. The grounding invariant, one layer up: an angle MUST carry a
 * non-empty `proofRefs` whose every id resolves to a stored `voc-evidence` row
 * of the SAME brief — an ungrounded angle is a typed validation finding, never
 * persisted. Validation happens at the surface write (closed-world against the
 * live evidence set), not on trust of the node/model.
 *
 * Store: `campaign-brief:ad-angle`, tenant+brief keyed (the vocService
 * precedent). Cascades with the brief (wired by briefService.deleteBrief).
 *
 * @see docs/adr/0403-market-intel-pipeline.md
 */

import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { cleanString } from '../../host/boundedStrings.js';

export interface HookVariant {
  /** The hook line itself (the scroll-stopper). */
  text: string;
  /** Free-form format label v1 (question, bold-claim, statistic, story…). */
  format: string;
}

export interface AdAngle {
  id: string;
  tenantId: string;
  orgId: string;
  briefId: string;
  /** The positioning claim the angle commits to. */
  claim: string;
  /** The lens the claim is argued through (cost, speed, trust, status…). */
  positioningLens: string;
  /** Non-empty; every id resolves to a stored voc-evidence row of this brief. */
  proofRefs: string[];
  hookVariants: HookVariant[];
  createdBy: string;
  createdAt: string;
}

const angles = new DurableCollection<AdAngle>('campaign-brief:ad-angle', (a) => `${a.tenantId}::${a.briefId}::${a.id}`);

const CLAIM_MAX = 500;
const LENS_MAX = 200;
const HOOK_TEXT_MAX = 300;
const FORMAT_MAX = 60;
const MAX_HOOKS_PER_ANGLE = 8;
const MAX_PROOF_REFS = 20;
const MAX_PER_GENERATION = 20;

/** Bounds the artifact-type pack schema mirrors (the VOC_LIMITS precedent). */
export const ANGLE_LIMITS = {
  claimMax: CLAIM_MAX, lensMax: LENS_MAX, hookTextMax: HOOK_TEXT_MAX, formatMax: FORMAT_MAX,
  maxHooksPerAngle: MAX_HOOKS_PER_ANGLE, maxProofRefs: MAX_PROOF_REFS, maxPerGeneration: MAX_PER_GENERATION,
} as const;

export interface AngleCandidateInput {
  claim?: unknown;
  positioningLens?: unknown;
  proofRefs?: unknown;
  hookVariants?: unknown;
}

export interface AngleValidationFinding {
  index: number;
  field: string;
  message: string;
}

/**
 * Closed-world validation of ONE candidate against the brief's LIVE evidence
 * ids. An empty or unresolvable proofRef set is a finding — the caller decides
 * drop-with-finding vs typed failure (all-dropped fails typed upstream).
 */
export function validateAngleCandidate(raw: AngleCandidateInput, index: number, validEvidenceIds: ReadonlySet<string>):
  | { ok: true; item: Pick<AdAngle, 'claim' | 'positioningLens' | 'proofRefs' | 'hookVariants'> }
  | { ok: false; finding: AngleValidationFinding } {
  const claim = cleanString(raw.claim, CLAIM_MAX);
  if (!claim) return { ok: false, finding: { index, field: 'claim', message: 'An angle needs a non-empty positioning claim.' } };
  const positioningLens = cleanString(raw.positioningLens, LENS_MAX);
  if (!positioningLens) return { ok: false, finding: { index, field: 'positioningLens', message: 'A positioning lens is required.' } };
  const rawRefs = Array.isArray(raw.proofRefs) ? raw.proofRefs.filter((r): r is string => typeof r === 'string' && r.length > 0) : [];
  const proofRefs = [...new Set(rawRefs)].slice(0, MAX_PROOF_REFS);
  if (proofRefs.length === 0) {
    return { ok: false, finding: { index, field: 'proofRefs', message: 'An angle with no proofRefs is ungrounded — cite at least one stored voc-evidence id.' } };
  }
  const unresolvable = proofRefs.filter((r) => !validEvidenceIds.has(r));
  if (unresolvable.length > 0) {
    return { ok: false, finding: { index, field: 'proofRefs', message: `proofRefs do not resolve to stored evidence of this brief: ${unresolvable.slice(0, 5).join(', ')}.` } };
  }
  const hookVariants: HookVariant[] = (Array.isArray(raw.hookVariants) ? raw.hookVariants : [])
    .slice(0, MAX_HOOKS_PER_ANGLE)
    .flatMap((h) => {
      const hv = (h ?? {}) as Record<string, unknown>;
      const text = cleanString(hv.text, HOOK_TEXT_MAX);
      if (!text) return [];
      return [{ text, format: cleanString(hv.format, FORMAT_MAX) || 'unspecified' }];
    });
  return { ok: true, item: { claim, positioningLens, proofRefs, hookVariants } };
}

/** Persist a batch of VALIDATED angles (the node's narrow write, via the surface). */
export async function persistAngles(
  tenantId: string,
  orgId: string,
  briefId: string,
  createdBy: string,
  items: ReadonlyArray<Pick<AdAngle, 'claim' | 'positioningLens' | 'proofRefs' | 'hookVariants'>>,
): Promise<AdAngle[]> {
  if (items.length === 0) {
    throw new OpenwopError('validation_error', 'No valid angles to persist (every candidate failed the grounding invariant).', 422);
  }
  if (items.length > MAX_PER_GENERATION) {
    throw new OpenwopError('validation_error', `A generation persists at most ${MAX_PER_GENERATION} angles.`, 413, { max: MAX_PER_GENERATION });
  }
  const now = new Date().toISOString();
  const rows: AdAngle[] = items.map((item) => ({ id: randomUUID(), tenantId, orgId, briefId, ...item, createdBy, createdAt: now }));
  for (const row of rows) await angles.put(row);
  return rows;
}

export async function listAngles(tenantId: string, briefId: string): Promise<AdAngle[]> {
  const all = await angles.listByPrefix(`${tenantId}::${briefId}::`);
  return all.filter((a) => a.tenantId === tenantId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getAngle(tenantId: string, briefId: string, angleId: string): Promise<AdAngle | null> {
  const a = await angles.get(`${tenantId}::${briefId}::${angleId}`);
  return a && a.tenantId === tenantId ? a : null;
}

/** The angles of a brief citing one evidence id (drives the 409 `evidence_cited`
 *  guard on evidence curation-delete — a delete must not silently break
 *  "resolvable"). */
export async function anglesCiting(tenantId: string, briefId: string, evidenceId: string): Promise<AdAngle[]> {
  return (await listAngles(tenantId, briefId)).filter((a) => a.proofRefs.includes(evidenceId));
}

/** Curation: prune an angle (uniform 404 on a foreign row). */
export async function deleteAngle(tenantId: string, briefId: string, angleId: string): Promise<boolean> {
  const a = await getAngle(tenantId, briefId, angleId);
  if (!a) return false;
  await angles.delete(`${tenantId}::${briefId}::${angleId}`);
  return true;
}

/** Cascade owner: a deleted brief takes its angles with it (wired by briefService). */
export async function deleteAnglesForBrief(tenantId: string, briefId: string): Promise<number> {
  const all = await angles.listByPrefix(`${tenantId}::${briefId}::`);
  for (const a of all) await angles.delete(`${a.tenantId}::${a.briefId}::${a.id}`);
  return all.length;
}

/** Test-only. */
export async function __resetAngleStore(): Promise<void> {
  await angles.__clear();
}
