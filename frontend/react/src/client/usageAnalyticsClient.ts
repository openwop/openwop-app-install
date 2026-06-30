/**
 * ADR 0118 Phase 3a — usage-analytics FE client. The data layer for the cost/usage
 * admin dashboard: fetch the per-model token rollup. Org-scoped, admin (workspace:read).
 */
import { authedHeaders, config, fetchOpts } from './config.js';

async function http<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${config.baseUrl}${path}`, {
    ...fetchOpts(init),
    headers: { ...(init.headers ?? {}), ...authedHeaders({ 'content-type': 'application/json' }) },
  });
  const body = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok) {
    const err = body as { error?: string; message?: string };
    throw new Error(`${err.error ?? 'http_error'}: ${err.message ?? `HTTP ${res.status}`}`);
  }
  return body as T;
}

export interface Org { orgId: string; name: string }

export interface UsageRollupRow {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  calls: number;
  updatedAt: string;
  /** ADR 0118 Phase 5 — estimated USD cost from the rate table (0 when unpriced). */
  costUsd?: number;
}

/** The caller's orgs (the dashboard org picker). */
export async function listOrgs(): Promise<Org[]> {
  return (await http<{ orgs: Org[] }>('/v1/host/openwop-app/orgs')).orgs ?? [];
}

export async function fetchUsageRollup(orgId: string): Promise<UsageRollupRow[]> {
  const r = await http<{ rollup: UsageRollupRow[] }>(`/v1/host/openwop-app/usage/orgs/${encodeURIComponent(orgId)}/rollup`);
  return r.rollup ?? [];
}
