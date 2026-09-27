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

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try {
      const body = (await res.json()) as { error?: { message?: string }; message?: string };
      detail = body?.error?.message ?? body?.message ?? '';
    } catch {
      /* non-JSON error body */
    }
    throw new Error(detail || `${ctx} returned ${res.status}`);
  }
  return (await res.json()) as T;
}

/** The caller's resolved assignments (every toggle). */
/** ADR 0419 — the caller's plan/bundle entitlements (billing-owned). `allowedFeatures`
 *  is `'*'` (unrestricted — billing off or an all-access plan) or the allowlist of
 *  entitled feature ids. 404 when the billing feature is off ⇒ unrestricted. Feeds the
 *  feature-access `locked` signal (toggle on, but the plan/bundles don't include it). */
export async function fetchEntitlements(): Promise<'*' | string[]> {
  const res = await fetch(`${config.baseUrl}/host/openwop-app/billing/entitlements`, fetchOpts({ headers: authedHeaders() }));
  if (!res.ok) return '*'; // billing off / not resolvable ⇒ unrestricted (nothing locked)
  const body = (await res.json()) as { allowedFeatures?: '*' | string[] };
  return body.allowedFeatures ?? '*';
}

export async function fetchAssignments(): Promise<ResolvedAssignment[]> {
  const res = await fetch(`${base}/assignments`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ assignments: ResolvedAssignment[] }>(res, 'fetchAssignments')).assignments;
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
export async function deleteToggleConfig(id: string): Promise<ToggleConfig> {
  const res = await fetch(`${config.baseUrl}/host/openwop-app/feature-toggles/admin/configs/${encodeURIComponent(id)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() }));
  if (!res.ok) throw new Error(`delete_toggle_${res.status}`);
  return (await res.json()) as ToggleConfig;
}
