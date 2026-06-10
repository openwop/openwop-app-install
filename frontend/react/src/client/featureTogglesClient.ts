/**
 * Feature-toggle host-extension client (non-normative).
 *
 * Wraps /v1/host/sample/feature-toggles/*. The backend is the authority
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
}

export interface ResolvedAssignment {
  id: string;
  status: FeatureToggleStatus;
  enabled: boolean;
  variant: string | null;
  bindings?: VariantBinding[];
}

const base = `${config.baseUrl}/v1/host/sample/feature-toggles`;
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
export async function fetchAssignments(): Promise<ResolvedAssignment[]> {
  const res = await fetch(`${base}/assignments`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ assignments: ResolvedAssignment[] }>(res, 'fetchAssignments')).assignments;
}

/** Admin: every effective toggle config (superadmin only). */
export async function listToggleConfigs(): Promise<ToggleConfig[]> {
  const res = await fetch(`${base}/admin/configs`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ configs: ToggleConfig[] }>(res, 'listToggleConfigs')).configs;
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
