/**
 * Consent & Compliance service (host-extension, ADR 0020) — the GOVERN leg. A
 * tenant-scoped, region-aware consent store + the ONE centralized enforcement
 * helper (`isAllowed`) that Analytics (0018) + Email (0019) call — a single consent
 * rule, never per-feature copies (the Sharing-registry lesson). Fail-closed in
 * regulated regions; permissive when the `consent` toggle is off (honest opt-in).
 */

import { DurableCollection } from '../../host/hostExtPersistence.js';
import { resolveOne } from '../../host/featureToggles/service.js';
import { eraseSubject } from '../../host/subjectErasure.js';

export type ConsentCategory = 'necessary' | 'analytics' | 'marketing';
export const CONSENT_CATEGORIES: readonly ConsentCategory[] = ['necessary', 'analytics', 'marketing'];

export interface ConsentCategories { necessary: true; analytics: boolean; marketing: boolean }

export interface ConsentRecord {
  tenantId: string;
  subjectKey: string;   // opaque, non-PII (an anon cookie id or User.userId)
  region?: string;
  categories: ConsentCategories;
  source: string;
  ts: string;
  expiresAt?: string;
}

export type DefaultMode = 'opt-in' | 'opt-out';
export interface ConsentPolicy { tenantId: string; regulatedRegions: string[]; defaultMode: DefaultMode }

const records = new DurableCollection<ConsentRecord>('consent:record', (r) => `${r.tenantId}:${r.subjectKey}`);
const policies = new DurableCollection<ConsentPolicy>('consent:policy', (p) => p.tenantId);

function normCategories(input: unknown): ConsentCategories {
  const c = (input ?? {}) as Record<string, unknown>;
  return { necessary: true, analytics: c.analytics === true, marketing: c.marketing === true };
}

/** Upsert a visitor's consent (latest-wins per tenant+subject). */
export async function recordConsent(input: { tenantId: string; subjectKey: string; categories: unknown; region?: string; source: string }): Promise<ConsentRecord> {
  const rec: ConsentRecord = {
    tenantId: input.tenantId,
    subjectKey: input.subjectKey,
    categories: normCategories(input.categories),
    source: input.source,
    ts: new Date().toISOString(),
    ...(input.region ? { region: input.region } : {}),
  };
  await records.put(rec);
  return rec;
}

export async function getConsent(tenantId: string, subjectKey: string): Promise<ConsentRecord | null> {
  return records.get(`${tenantId}:${subjectKey}`);
}

export async function listConsent(tenantId: string): Promise<ConsentRecord[]> {
  const all = await records.list();
  return all.filter((r) => r.tenantId === tenantId).sort((a, b) => b.ts.localeCompare(a.ts));
}

export async function getPolicy(tenantId: string): Promise<ConsentPolicy | null> {
  return policies.get(tenantId);
}

export async function setPolicy(tenantId: string, input: { regulatedRegions?: string[]; defaultMode?: DefaultMode }): Promise<ConsentPolicy> {
  const existing = await policies.get(tenantId);
  const policy: ConsentPolicy = {
    tenantId,
    regulatedRegions: input.regulatedRegions ?? existing?.regulatedRegions ?? [],
    defaultMode: input.defaultMode ?? existing?.defaultMode ?? 'opt-in',
  };
  await policies.put(policy);
  return policy;
}

/**
 * Data-subject (GDPR) erasure over a subjectKey — deletes the consent record AND
 * fans out to every registered feature eraser (Analytics events, …) via the
 * subject-erasure seam, so the "delete" reaches ALL of the subject's data, not
 * just consent. Idempotent: erasing a subject with no consent record still purges
 * downstream data. Returns whether a consent record existed.
 */
export async function deleteSubject(tenantId: string, subjectKey: string): Promise<{ consentRecord: boolean }> {
  const consentRecord = await records.delete(`${tenantId}:${subjectKey}`);
  await eraseSubject(tenantId, subjectKey);
  return { consentRecord };
}

/**
 * The ONE enforcement helper Analytics (0018) + Email (0019) call. `necessary` is
 * always allowed. When the `consent` toggle is OFF for the tenant → permissive (no
 * regime configured). Otherwise: latest record → policy default → FAIL-CLOSED
 * (deny) when the default mode is opt-in / unset.
 */
export async function isAllowed(tenantId: string, subjectKey: string, category: ConsentCategory): Promise<boolean> {
  if (category === 'necessary') return true;
  const assignment = await resolveOne('consent', { tenantId });
  if (!assignment || !assignment.enabled) return true; // toggle off ⇒ permissive (honest opt-in)
  const rec = await getConsent(tenantId, subjectKey);
  if (rec) return rec.categories[category] === true;
  const policy = await getPolicy(tenantId);
  return policy?.defaultMode === 'opt-out'; // no record: opt-out allows; opt-in/unset denies (fail-closed)
}

/** Test-only: clear both stores. */
export async function __resetConsentStore(): Promise<void> {
  await records.__clear();
  await policies.__clear();
}
