/**
 * ADR 0942 — the campaign autonomy policy client. Two scopes over one read model:
 * a campaign's override (`campaign-orchestration`) and a client's default
 * (`campaign-ops`). The server owns the class vocabulary, each class's effective
 * rule and the tighten/loosen authority; this module only moves them.
 */
import { authedHeaders, config, fetchOpts } from '../../../client/config.js';

export type Outcome = 'auto' | 'notify-after' | 'approve' | 'blocked';
export type RiskFact = 'spendMinor' | 'spendDeltaPct' | 'audienceSize' | 'findingsCritical' | 'findingsHigh' | 'regulatedCategory' | 'confidence' | 'firstForDestination';
export type ReviewStage = 'internal' | 'compliance' | 'client';
export type PresetId = 'review-everything@1' | 'guarded@1' | 'autopilot@1';

export interface Condition { fact: RiskFact; op: '>=' | '>' | '<=' | '<' | '=='; value: number | boolean }
export interface ApproverSpec {
  roleRefs?: string[]; groupRefs?: string[]; subjectRefs?: string[]; clientApprover?: boolean;
  requiredApprovals: 1 | 2 | 3; rejectionPolicy?: 'any' | 'majority'; delegation: 'allowed' | 'none';
  sla?: { remindAfterMs?: number; escalateAfterMs?: number; expireAfterMs?: number }; escalateTo?: { roleRefs: string[] };
}
export interface NotifySpec { roleRefs?: string[]; subjectRefs?: string[]; channels: Array<'inbox' | 'email' | 'teams' | 'push'>; digest: 'immediate' | 'daily'; vetoWindowMs?: number }
export type Decision =
  | { outcome: 'auto' }
  | { outcome: 'notify-after'; notify: NotifySpec }
  | { outcome: 'approve'; approver: ApproverSpec; notify?: NotifySpec }
  | { outcome: 'blocked'; reason: string };
export interface ActionRule { actionClass: string; stage?: ReviewStage; default: Decision; escalations?: Array<{ when: Condition[]; then: Decision }> }
export interface EffectiveRule { actionClass: string; stage?: ReviewStage; rule: ActionRule; from: 'policy' | 'preset' | 'fallback' }

export interface PolicyView {
  source: 'campaign' | 'client' | 'default';
  dangling: boolean;
  etag: string;
  policy: { policyId: string; version: number; name: string; basePreset?: PresetId; rules: ActionRule[]; hash: string };
  actionClasses: string[];
  effective: EffectiveRule[];
  presets: Array<{ id: PresetId; name: string }>;
  clientDefault?: { source: string; policyId: string; version: number; name: string };
  direction?: 'tighten' | 'loosen';
  loosened?: string[];
}

export type AutonomyScope = { kind: 'campaign'; campaignId: string } | { kind: 'client'; orgId: string };

export class AutonomyDisabledError extends Error {}
/** A save the server refused because it loosens the policy and the caller may not (D9). */
export class LoosenRefusedError extends Error {
  constructor(message: string, readonly loosened: string[]) { super(message); }
}
/** The policy changed since it was loaded (a stale `ifMatch`). */
export class PolicyConflictError extends Error {}

const base = `${config.baseUrl}/host/openwop-app`;
const pathOf = (scope: AutonomyScope): string => scope.kind === 'campaign'
  ? `${base}/campaign-orchestration/campaigns/${encodeURIComponent(scope.campaignId)}/autonomy`
  : `${base}/campaign-ops/clients/${encodeURIComponent(scope.orgId)}/autonomy-default`;

async function read(res: Response): Promise<PolicyView> {
  if (res.ok) return (await res.json()) as PolicyView;
  let body: { message?: string; details?: { reason?: string; loosened?: unknown; feature?: unknown } } = {};
  try { body = (await res.json()) as typeof body; } catch { /* non-JSON */ }
  const message = body.message ?? `Request failed (${res.status})`;
  if (res.status === 404 && (typeof body.details?.feature === 'string' || /not enabled/i.test(message))) throw new AutonomyDisabledError(message);
  if (res.status === 403 && body.details?.reason === 'loosen_requires_admin') {
    const loosened = Array.isArray(body.details.loosened) ? body.details.loosened.filter((x): x is string => typeof x === 'string') : [];
    throw new LoosenRefusedError(message, loosened);
  }
  if (res.status === 409) throw new PolicyConflictError(message);
  throw new Error(message);
}

export async function getAutonomy(scope: AutonomyScope): Promise<PolicyView> {
  return read(await fetch(pathOf(scope), fetchOpts({ headers: authedHeaders() })));
}

export type PolicySave = { preset: PresetId } | { name: string; basePreset?: PresetId; rules: ActionRule[] };

export async function saveAutonomy(scope: AutonomyScope, body: PolicySave, ifMatch: string): Promise<PolicyView> {
  return read(await fetch(pathOf(scope), fetchOpts({
    method: 'PUT', headers: authedHeaders({ 'content-type': 'application/json' }), body: JSON.stringify({ ...body, ifMatch }),
  })));
}

/** Campaign scope only: drop the override so the client default applies again. */
export async function clearCampaignAutonomy(campaignId: string, ifMatch: string): Promise<PolicyView> {
  return read(await fetch(`${pathOf({ kind: 'campaign', campaignId })}?ifMatch=${encodeURIComponent(ifMatch)}`, fetchOpts({ method: 'DELETE', headers: authedHeaders() })));
}

/** ADR 0942 P4b — a notify-after step waiting out its veto window. */
export interface VetoWindow { vetoId: string; actionClass: string; ruleId: string; deadline: string; runId: string; canVeto: boolean }

export async function listVetoWindows(campaignId: string): Promise<VetoWindow[]> {
  const res = await fetch(`${base}/campaign-orchestration/campaigns/${encodeURIComponent(campaignId)}/vetoes`, fetchOpts({ headers: authedHeaders() }));
  if (res.ok) return ((await res.json()) as { windows: VetoWindow[] }).windows;
  let body: { message?: string; details?: { feature?: unknown } } = {};
  try { body = (await res.json()) as typeof body; } catch { /* non-JSON */ }
  const message = body.message ?? `Request failed (${res.status})`;
  if (res.status === 404 && (typeof body.details?.feature === 'string' || /not enabled/i.test(message))) throw new AutonomyDisabledError(message);
  throw new Error(message);
}

/** Veto one window. 409 when it has already ended or closed. */
export async function castVeto(campaignId: string, vetoId: string, reason: string): Promise<void> {
  const res = await fetch(`${base}/campaign-orchestration/campaigns/${encodeURIComponent(campaignId)}/vetoes/${encodeURIComponent(vetoId)}`, fetchOpts({
    method: 'POST', headers: authedHeaders({ 'content-type': 'application/json' }), body: JSON.stringify(reason ? { reason } : {}),
  }));
  if (res.ok) return;
  let body: { message?: string } = {};
  try { body = (await res.json()) as typeof body; } catch { /* non-JSON */ }
  throw new Error(body.message ?? `Request failed (${res.status})`);
}
