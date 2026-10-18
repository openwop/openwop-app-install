/**
 * Feature-toggle host-extension client (non-normative).
 *
 * Wraps /host/openwop-app/feature-toggles/*. The backend is the authority
 * (ADR 0001 §3.4) — the FE only READS its resolved assignments and (for a
 * superadmin) the admin config list / save endpoint.
 *
 * @see ../../../backend/typescript/src/routes/featureToggles.ts
 */
import { authedHeaders, config, fetchOpts } from './config.js';
import { readErrorDetail, readErrorMessage } from './errorEnvelope.js';

export type FeatureToggleStatus = 'on' | 'off' | 'beta';
export type BucketUnit = 'user' | 'tenant';

export interface VariantBinding {
  slot: string;
  ref: { kind: 'agent' | 'node' | 'prompt'; name: string; version: string };
}

export interface Variant {
  key: string;
  weight: number;
  bindings?: VariantBinding[];
}

export interface ToggleOverride {
  status?: FeatureToggleStatus;
  variants?: Variant[];
}

export interface ToggleConfig {
  id: string;
  label?: string;
  description?: string;
  category?: string;
  status: FeatureToggleStatus;
  bucketUnit: BucketUnit;
  salt: string;
  variants?: Variant[];
  betaCohort?: string[];
  tenantOverrides?: Record<string, ToggleOverride>;
  updatedAt?: string;
  updatedBy?: string;
  /** Admin provenance (architect 2026-07-13): a stored row pins this toggle. */
  overridden?: boolean;
  /** The compiled default changed UNDER the pin — a code-default flip is a
   *  no-op while the row exists; revert or re-save to acknowledge. */
  defaultDrift?: boolean;
  /** ADR 0819 §3 — the kill switch: OFF for everyone, ahead of overrides. */
  killed?: boolean;
  /** ADR 0819 §5 — the optimistic-concurrency token from the last read (`null`
   *  = no stored row). Echoed on save so a stale edit is a 409, not an overwrite. */
  revision?: string | null;
}

/** One audited change to a toggle (ADR 0819 §4). The payload is a SHAPE of
 *  the admin choices — never cohort or tenant ids. */
export interface ToggleChange {
  at: string;
  action: 'feature-toggle.saved' | 'feature-toggle.reverted' | 'feature-toggle.tenant-enabled' | string;
  principalId?: string;
  payload: {
    before?: { status: FeatureToggleStatus; killed: boolean; betaCohortSize: number; tenantOverrideCount: number } | null;
    after?: { status: FeatureToggleStatus; killed: boolean; betaCohortSize: number; tenantOverrideCount: number } | null;
  };
}

export interface ResolvedAssignment {
  id: string;
  status: FeatureToggleStatus;
  enabled: boolean;
  variant: string | null;
  bindings?: VariantBinding[];
}

const base = `${config.baseUrl}/host/openwop-app/feature-toggles`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

/** A failed toggle-admin call. `reason` carries the server's machine reason
 *  (ADR 0819 §5: `revision_conflict` when the row moved since it was read). */
export class ToggleAdminError extends Error {
  constructor(message: string, readonly status: number, readonly reason?: string) {
    super(message);
    this.name = 'ToggleAdminError';
  }
}

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    let reason: string | undefined;
    try {
      const body: unknown = await res.json();
      detail = readErrorMessage(body) ?? '';
      const r = readErrorDetail(body, 'reason');
      reason = typeof r === 'string' ? r : undefined;
    } catch {
      /* non-JSON error body */
    }
    throw new ToggleAdminError(detail || `${ctx} returned ${res.status}`, res.status, reason);
  }
  return (await res.json()) as T;
}

/** The caller's resolved assignments (every toggle). */
/** ADR 0419 — the caller's plan/bundle entitlements (billing-owned). `allowedFeatures`
 *  is `'*'` (unrestricted — billing off or an all-access plan) or the allowlist of
 *  entitled feature ids. 404 when the billing feature is off ⇒ unrestricted. Feeds the
 *  feature-access `locked` signal (toggle on, but the plan/bundles don't include it).
 *  Throws `ToggleAdminError` on any other non-OK status, and rejects on a network failure. */
export async function fetchEntitlements(): Promise<'*' | string[]> {
  const res = await fetch(`${config.baseUrl}/host/openwop-app/billing/entitlements`, fetchOpts({ headers: authedHeaders() }));
  if (res.status === 404) return '*'; // billing off ⇒ unrestricted (nothing locked)
  // ADR 0873 D12 — any other failure is NOT an answer: the caller still degrades
  // it to '*' for presentation, but must not record it as a last-known offline
  // grant, and a 401/403 deletes the grants it holds. So it throws with the status.
  if (!res.ok) throw new ToggleAdminError(`fetchEntitlements returned ${res.status}`, res.status);
  const body = (await res.json()) as { allowedFeatures?: '*' | string[] };
  return body.allowedFeatures ?? '*';
}

/** Who the assignments were resolved FOR: the ACTIVE tenant (not `/me`'s home
 *  tenant) and the principal. ADR 0873 D12 keys last-known offline grants on it.
 *  Absent from a backend older than D12. */
export interface AssignmentsCaller {
  tenantId: string;
  principalId?: string;
}

export async function fetchAssignments(): Promise<{ assignments: ResolvedAssignment[]; caller?: AssignmentsCaller }> {
  const res = await fetch(`${base}/assignments`, fetchOpts({ headers: authedHeaders() }));
  return asJson<{ assignments: ResolvedAssignment[]; caller?: AssignmentsCaller }>(res, 'fetchAssignments');
}

/** Admin: every effective toggle config (superadmin only). */
export async function listToggleConfigs(): Promise<ToggleConfig[]> {
  const res = await fetch(`${base}/admin/configs`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ configs: ToggleConfig[] }>(res, 'listToggleConfigs')).configs;
}

/** On-disk presence tier for a feature's pinned pack (ADR 0194 Phase 2). */
export type PackPresence = 'installed' | 'mounted' | 'missing' | 'tombstoned';

/** One feature's row in the Plugins-console projection (ADR 0194 Phase 2):
 *  dependency graph + live disable-lock + declared packs with presence.
 *  `blockedByDependents` non-empty ⇒ turning this feature OFF is locked
 *  (would orphan those enabled dependents). */
export interface FeatureConsoleEntry {
  id: string;
  dependsOn: string[];
  dependents: string[];
  blockedByDependents: string[];
  /** Soft deps (ADR 0194 Phase 5): works-better-with, advisory only.
   *  `recommendedOff` = the subset currently disabled (the actionable suggestions). */
  recommends: string[];
  recommendedOff: string[];
  /** `onDiskVersion` present ⇒ the pack is on disk at a DIFFERENT version than pinned. */
  packs: { name: string; version: string; status: PackPresence; onDiskVersion?: string }[];
}

/** Admin: the Plugins-console projection (superadmin only). */
export async function listFeatureConsole(): Promise<FeatureConsoleEntry[]> {
  const res = await fetch(`${base}/admin/features`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ features: FeatureConsoleEntry[] }>(res, 'listFeatureConsole')).features;
}

/** Admin: upsert one toggle config (superadmin only). `input` is the config
 *  minus its id (the id is the path param). */
export async function saveToggleConfig(id: string, input: Omit<ToggleConfig, 'id'>): Promise<ToggleConfig> {
  const res = await fetch(`${base}/admin/configs/${encodeURIComponent(id)}`, fetchOpts({
    method: 'PUT',
    headers: jsonHeaders(),
    body: JSON.stringify(input),
  }));
  return asJson<ToggleConfig>(res, 'saveToggleConfig');
}

/** Revert a toggle to its code default: deletes the stored admin override
 *  (architect 2026-07-13, finding 2 — formerly psql row surgery). */
export async function deleteToggleConfig(id: string, revision?: string | null): Promise<ToggleConfig> {
  // ADR 0819 §5 — the revision precondition; a stale revert is a 409.
  const q = revision !== undefined ? `?revision=${encodeURIComponent(revision ?? 'null')}` : '';
  const res = await fetch(`${config.baseUrl}/host/openwop-app/feature-toggles/admin/configs/${encodeURIComponent(id)}${q}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  return asJson<ToggleConfig>(res, 'deleteToggleConfig');
}

/** Admin: a toggle's audited change history, newest first (ADR 0819 §4). */
export async function listToggleHistory(id: string): Promise<ToggleChange[]> {
  const res = await fetch(`${base}/admin/configs/${encodeURIComponent(id)}/history`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ changes: ToggleChange[] }>(res, 'listToggleHistory')).changes;
}
