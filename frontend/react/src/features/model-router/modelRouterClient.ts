/**
 * ADR 0130 Phase 5 — client for the rule-based model-router config (admin).
 * Backend is authority (toggle + `requireOrgScope`); a 404 means the feature is off.
 * Wraps the existing `/v1/host/openwop-app/model-router/orgs/:orgId/config` GET/PUT
 * + `/enable` surface (Phase 2). No new backend.
 *
 * @see docs/adr/0130-rule-based-model-router.md
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export interface RoutingTarget { provider: string; model: string }

export type RuleCondition =
  | { kind: 'always' }
  | { kind: 'attachment' }
  | { kind: 'tokensOver'; threshold: number }
  | { kind: 'intentIs'; intent: string };

export interface RoutingRule { when: RuleCondition; target: RoutingTarget }

export interface ModelRouterConfig {
  rules: RoutingRule[];
  fallback: RoutingTarget;
  cooldownMs?: number;
}

/** The stored config the backend returns (subset the UI reads). */
export interface StoredRouterConfig {
  config: ModelRouterConfig;
  enabled: boolean;
  updatedBy?: string;
  updatedAt?: string;
}

export interface Org { orgId: string; name: string }

const baseFor = (orgId: string): string =>
  `${config.baseUrl}/v1/host/openwop-app/model-router/orgs/${encodeURIComponent(orgId)}/config`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { message?: string })?.message ?? ''; } catch { /* non-JSON */ }
    throw new Error(detail || `${ctx} returned ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function listOrgs(): Promise<Org[]> {
  const res = await fetch(`${config.baseUrl}/v1/host/openwop-app/orgs`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ orgs: Org[] }>(res, 'listOrgs')).orgs;
}

/** GET the org's router config (null when none set yet). */
export async function getRouterConfig(orgId: string): Promise<StoredRouterConfig | null> {
  const res = await fetch(baseFor(orgId), fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ config: StoredRouterConfig | null }>(res, 'getRouterConfig')).config;
}

/** PUT the rules + fallback (server validates). Preserves `enabled`. */
export async function setRouterConfig(orgId: string, cfg: ModelRouterConfig): Promise<StoredRouterConfig> {
  const res = await fetch(baseFor(orgId), fetchOpts({ method: 'PUT', headers: jsonHeaders(), body: JSON.stringify(cfg) }));
  return (await asJson<{ config: StoredRouterConfig }>(res, 'setRouterConfig')).config;
}

/** Enable/disable routing for the org (404 if no config exists yet). */
export async function setRouterEnabled(orgId: string, enabled: boolean): Promise<StoredRouterConfig> {
  const res = await fetch(`${baseFor(orgId)}/enable`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ enabled }) }));
  return (await asJson<{ config: StoredRouterConfig }>(res, 'setRouterEnabled')).config;
}
