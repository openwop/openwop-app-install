/**
 * ADR 0130 Phase 5 / ADR 1016 — client for the model-router config (admin).
 *
 * ONE config per WORKSPACE (ADR 1016 D1): the active workspace's
 * `/host/openwop-app/model-router/config` GET/PUT + `/enable` + `/preview`. It used
 * to be per organization, and a config saved for any org but the workspace root
 * was never read by a chat. The backend is the authority (toggle + plan, then
 * BYOK-manage for writes); `canManage` says whether this caller may write.
 *
 * @see docs/adr/0130-rule-based-model-router.md
 * @see docs/adr/1016-model-router-workspace-per-turn-routing.md
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export interface RoutingTarget { provider: string; model: string }

export type RuleCondition =
  | { kind: 'always' }
  | { kind: 'attachment' }
  | { kind: 'tokensOver'; threshold: number }
  // ADR 0130 Phase 4 (`intentIs`) was RETIRED — CHAT-FIRST-PORT-AUDIT A8 (dead:
  // the ignition site never populated the intent + the classifier had zero
  // callers). The backend tolerates a legacy stored rule (drops it, inert).
  // ADR 0130 Phase 5 — composite difficulty tier (was backend-only until the
  // 2026-07-07 grade pass closed the FE drift: a stored rule rendered blank).
  | { kind: 'difficultyAtLeast'; level: 'low' | 'medium' | 'high' }
  // ADR 0130 Phase 6 — server-fed conversation kind ('group' = board/multi-agent
  // rooms): lets a tenant route those rooms to a stronger model.
  | { kind: 'conversationKind'; value: 'group' | 'workspace' | 'channel' };

export interface RoutingRule { when: RuleCondition; target: RoutingTarget }

export interface ModelRouterConfig {
  rules: RoutingRule[];
  /** ADR 1016 D5 — optional: absent ⇒ a message no rule matches keeps its own model. */
  fallback?: RoutingTarget;
  cooldownMs?: number;
}

/** The stored config the backend returns (subset the UI reads). */
export interface StoredRouterConfig {
  config: ModelRouterConfig;
  enabled: boolean;
  updatedBy?: string;
  updatedAt?: string;
}

/** `GET …/config` — the workspace's config (null when none saved yet) and
 *  whether this caller may change it. */
export interface RouterConfigView {
  stored: StoredRouterConfig | null;
  canManage: boolean;
}

/** `POST …/config/preview` — what a message would be routed to. */
export interface RoutePreviewInput {
  text: string;
  provider: string;
  hasAttachment?: boolean;
  conversationKind?: 'group' | 'workspace' | 'channel';
}
export interface RoutePreview {
  enabled: boolean;
  decision: { target: RoutingTarget; reason: 'rule' | 'fallback' | 'cooldown'; ruleIndex?: number } | null;
  why: 'no_config' | 'no_match' | 'routed';
}

const BASE = (): string => `${config.baseUrl}/host/openwop-app/model-router/config`;
const jsonHeaders = (): Record<string, string> => authedHeaders({ 'content-type': 'application/json' });

async function asJson<T>(res: Response, ctx: string): Promise<T> {
  if (!res.ok) {
    let detail = '';
    try { detail = ((await res.json()) as { message?: string })?.message ?? ''; } catch { /* non-JSON */ }
    throw new Error(detail || `${ctx} returned ${res.status}`);
  }
  return (await res.json()) as T;
}

/** GET the workspace's router config + the caller's write authority. */
export async function getRouterConfig(): Promise<RouterConfigView> {
  const res = await fetch(BASE(), fetchOpts({ headers: authedHeaders() }));
  const body = await asJson<{ config: StoredRouterConfig | null; canManage?: boolean }>(res, 'getRouterConfig');
  return { stored: body.config, canManage: body.canManage === true };
}

/** PUT the rules + optional fallback (server validates). Preserves `enabled`. */
export async function setRouterConfig(cfg: ModelRouterConfig): Promise<StoredRouterConfig> {
  const res = await fetch(BASE(), fetchOpts({ method: 'PUT', headers: jsonHeaders(), body: JSON.stringify(cfg) }));
  return (await asJson<{ config: StoredRouterConfig }>(res, 'setRouterConfig')).config;
}

/** Enable/disable routing for the workspace (404 if no config exists yet). */
export async function setRouterEnabled(enabled: boolean): Promise<StoredRouterConfig> {
  const res = await fetch(`${BASE()}/enable`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify({ enabled }) }));
  return (await asJson<{ config: StoredRouterConfig }>(res, 'setRouterEnabled')).config;
}

/** Ask the server which model a message would get — the same decision a chat makes. */
export async function previewRoute(input: RoutePreviewInput): Promise<RoutePreview> {
  const res = await fetch(`${BASE()}/preview`, fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return asJson<RoutePreview>(res, 'previewRoute');
}
