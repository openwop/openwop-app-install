/**
 * ADR 0135 Phase 4 — client for the capability-firewall rule manager.
 * Backend is authority (toggle + authorizeOrgScope); a 404 means the feature is off.
 */
import { authedHeaders, config, fetchOpts } from '../../client/config.js';

export type SafetyTier = 'pure' | 'read' | 'write' | 'exec';
export type Egress = 'none' | 'safe-fetch' | 'host-mediated' | 'host-owned';
export type CapabilityClass = { safetyTier: SafetyTier } | { egress: Egress } | { scope: string } | { kind: 'fan-out' };

/** ADR 0135 Phase 5 — a composition-VOLUME predicate. */
export interface CountAtLeast { class: CapabilityClass; threshold: number; window: 'turn' }

export interface FirewallRule {
  id: string;
  description: string;
  /** Exactly one predicate kind: presence (`anyOf`/`with`), `countAtLeast` (P5), or
   *  `expression` (P6). */
  when: { anyOf?: CapabilityClass[]; with?: CapabilityClass[]; countAtLeast?: CountAtLeast; expression?: string };
  /** ADR 0397 — `'allow'` is an explicit allow-list rule (meaningful only under deny modes). */
  verdict: 'deny' | 'require-approval' | 'allow';
  reason: string;
}

export interface Org { orgId: string; name: string }

const baseFor = (orgId: string): string => `${config.baseUrl}/host/openwop-app/capability-firewall/orgs/${encodeURIComponent(orgId)}/rules`;
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
  const res = await fetch(`${config.baseUrl}/host/openwop-app/orgs`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ orgs: Org[] }>(res, 'listOrgs')).orgs;
}

export type UnknownToolPolicy = 'skip' | 'treat-as-risky';
/** ADR 0397 — the firewall's enforcement posture. */
export type FirewallMode = 'default-allow' | 'shadow' | 'enforce';
export interface FirewallPosture { mode?: FirewallMode; defaultDenyVerdict?: 'deny' | 'require-approval' }
export interface FirewallView { rules: FirewallRule[]; unknownToolPolicy: UnknownToolPolicy; mode: FirewallMode; defaultDenyVerdict: 'deny' | 'require-approval'; isDefault: boolean }

export async function getFirewallRules(orgId: string): Promise<FirewallView> {
  const res = await fetch(baseFor(orgId), fetchOpts({ headers: authedHeaders() }));
  return asJson<FirewallView>(res, 'getFirewallRules');
}

export async function setFirewallRules(orgId: string, rules: FirewallRule[], unknownToolPolicy: UnknownToolPolicy, posture: FirewallPosture = {}): Promise<FirewallView> {
  const res = await fetch(baseFor(orgId), fetchOpts({ method: 'PUT', headers: jsonHeaders(), body: JSON.stringify({ rules, unknownToolPolicy, ...posture }) }));
  return asJson<FirewallView>(res, 'setFirewallRules');
}

/** ADR 0397 Phase 1 — a recent firewall verdict (deny / require-approval) with
 *  matched-rule attribution. Server is authority; `decision` is the true tri-state. */
export interface FirewallDecision {
  decisionId: string;
  timestamp: string;
  decision: 'deny' | 'require-approval' | string;
  /** ADR 0397 — a shadow would-block: COMPUTED but not applied (the call proceeded). */
  shadow?: boolean;
  toolName?: string;
  ruleId?: string;
  reason?: string;
  conversationId?: string;
}

const decisionsBaseFor = (orgId: string): string => `${config.baseUrl}/host/openwop-app/capability-firewall/orgs/${encodeURIComponent(orgId)}/decisions`;

/** Recent firewall decisions for an org, newest first. */
export async function getFirewallDecisions(orgId: string, limit = 100): Promise<FirewallDecision[]> {
  const res = await fetch(`${decisionsBaseFor(orgId)}?limit=${encodeURIComponent(String(limit))}`, fetchOpts({ headers: authedHeaders() }));
  return (await asJson<{ decisions: FirewallDecision[] }>(res, 'getFirewallDecisions')).decisions;
}

/** ADR 0397 Phase 2 — the policy simulator. */
export type SimAction = CapabilityClass | { toolName: string };

export interface RuleTrace { ruleId: string; predicateKind: 'presence' | 'countAtLeast' | 'expression'; matched: boolean; why: string }

export interface SimulateResult {
  decision: 'allow' | 'deny' | 'require-approval';
  mode: FirewallMode;
  matchedRuleId?: string;
  matchedClause?: string;
  reason?: string;
  fellThroughToDefault: boolean;
  trace: RuleTrace[];
  /** ADR 0397 P5 — the superadmin platform-baseline rules that also applied (read-only). */
  platformBaseline?: RuleTrace[];
}

export interface SimulateInput {
  seen?: SimAction[];
  next: SimAction;
  modeOverride?: FirewallMode;
  context?: { unknownToolPolicy?: UnknownToolPolicy };
}

const simulateBaseFor = (orgId: string): string => `${config.baseUrl}/host/openwop-app/capability-firewall/orgs/${encodeURIComponent(orgId)}/simulate`;

/** Pre-flight a hypothetical action against the org's current rules (no side effects). */
export async function simulateFirewall(orgId: string, input: SimulateInput): Promise<SimulateResult> {
  const res = await fetch(simulateBaseFor(orgId), fetchOpts({ method: 'POST', headers: jsonHeaders(), body: JSON.stringify(input) }));
  return asJson<SimulateResult>(res, 'simulateFirewall');
}
