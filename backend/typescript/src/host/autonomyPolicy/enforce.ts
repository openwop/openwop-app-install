/**
 * ADR 0942 D5 / D8 — the ONE helper every effect chokepoint calls with its REAL
 * facts. Chokepoints are mandatory; the gate node is optional (a mis-declared or
 * missing gate can delay an approval, never skip one).
 *
 * - `unbound` — the run is not a campaign run (or there is no run: route lanes
 *   use synthetic `hostext:` ids), or it is bound but unstamped while the toggle
 *   is OFF. The chokepoint keeps today's behaviour.
 * - `proceed` / `blocked` / `approve` — the D3 resolution over the run's frozen
 *   stamp, the run's own floors (MCP origin, attended fork), the client floor and
 *   the live campaign status (both through seams; skipped on a replay), and the
 *   tenant ceiling the chokepoint read.
 *
 * Every bound resolution of an external-effect class, `auto` included, appends
 * `campaign.autonomy.decision` to the tenant audit chain (D8) — never on a replay.
 */
import { createHash } from 'node:crypto';
import type { Storage } from '../../storage/storage.js';
import { appendAudit } from '../auditChainService.js';
import { currentEffectContext } from '../runEffectContext.js';
import { createLogger } from '../../observability/logger.js';
import { factsDigest, laneOf } from './compile.js';
import { AUTONOMY_STAMP_KEY, autonomyOrgOf, clientBoundOrg, runAutonomyOf } from './frozen.js';
import { DEFAULT_APPROVER } from './presets.js';
import { resolveCampaignAction, type ResolveFloors, type ResolutionLayer } from './resolve.js';
import { NON_EXTERNAL_CLASSES, type ActionClass, type ApproverSpec, type Decision, type RiskFacts } from './types.js';

const log = createLogger('autonomy-enforce');

// ── seams (the host never imports the features that own these records) ──

/** The org's ADR 0921 client account, or `null` when the org is not an agency client (no client floor then). */
export type AutonomyClientResolver = (tenantId: string, orgId: string) => Promise<NonNullable<ResolveFloors['client']> | null>;
export type AutonomyCampaignStatusResolver = (tenantId: string, campaignId: string) => Promise<'draft' | 'active' | 'paused' | 'completed' | 'archived' | null>;
export type AutonomyToggleResolver = (tenantId: string) => Promise<boolean>;

let clientResolver: AutonomyClientResolver | null = null;
let campaignStatusResolver: AutonomyCampaignStatusResolver | null = null;
let toggleResolver: AutonomyToggleResolver | null = null;

/** campaign-ops registers this (it owns `ClientAccount`). */
export function setAutonomyClientResolver(fn: AutonomyClientResolver | null): void { clientResolver = fn; }
/** campaign-orchestration registers these (it owns `MarketingCampaign` and the toggle). */
export function setAutonomyCampaignStatusResolver(fn: AutonomyCampaignStatusResolver | null): void { campaignStatusResolver = fn; }
export function setAutonomyToggleResolver(fn: AutonomyToggleResolver | null): void { toggleResolver = fn; }

/** Classes whose effect chokepoint is wired (and so emits its own notify-after notice, D5). */
export const CHOKEPOINT_CLASSES: ReadonlySet<ActionClass> = new Set<ActionClass>(['ads.publish', 'ads.budget', 'sms.send']);

export type EnforceVerdict =
  | { kind: 'unbound' }
  | {
      kind: 'proceed'; outcome: 'auto' | 'notify-after'; decision: Decision; ruleId: string; layer: ResolutionLayer; policyHash: string; attended: boolean;
      /** For the notify-after notice the chokepoint's caller emits AFTER the effect succeeds. */
      orgId?: string; campaignId?: string; runId: string;
    }
  | { kind: 'blocked'; reason: string; ruleId: string; layer: ResolutionLayer; policyHash: string }
  | {
      kind: 'approve'; approver: ApproverSpec; ruleId: string; layer: ResolutionLayer; policyHash: string; attended: boolean; runId: string;
      /** The client org (approver roles resolve here) and the run's requesters (D10.2). */
      orgId?: string; requesters: string[]; requesterCauses: string[];
    };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The run tag's campaign + org (ADR 0941 D2b), by shape. */
function tagOf(metadata: unknown): { campaignId: string; orgId: string } | null {
  const tag = isObj(metadata) ? metadata.campaignOrchestration : undefined;
  return isObj(tag) && typeof tag.campaignId === 'string' && typeof tag.orgId === 'string' ? { campaignId: tag.campaignId, orgId: tag.orgId } : null;
}

export async function enforceCampaignAction(
  deps: { storage: Pick<Storage, 'getRun'>; tenantId: string; runId: string },
  args: { actionClass: ActionClass; facts: RiskFacts; ceiling?: 'none' | 'approve' | 'blocked'; contentHash?: string },
): Promise<EnforceVerdict> {
  const run = deps.runId.startsWith('hostext:') ? null : await deps.storage.getRun(deps.runId);
  if (!run || run.tenantId !== deps.tenantId) return { kind: 'unbound' };
  const ra = runAutonomyOf(run);
  if (!ra.bound) return { kind: 'unbound' };
  if (!ra.stamp && run.metadata?.[AUTONOMY_STAMP_KEY] === undefined && !(toggleResolver ? await toggleResolver(deps.tenantId) : false)) return { kind: 'unbound' };

  const replaying = currentEffectContext()?.replaying === true;
  const orgId = autonomyOrgOf(run.metadata, ra.stamp);
  const campaignId = tagOf(run.metadata)?.campaignId ?? ra.stamp?.campaignId;
  const tag = orgId ? { orgId, ...(campaignId ? { campaignId } : {}) } : null;
  const external = !NON_EXTERNAL_CLASSES.has(args.actionClass);
  const floors: ResolveFloors = { ...ra.floors };
  let live: { campaignStatus?: 'draft' | 'active' | 'paused' | 'completed' | 'archived' } | undefined;
  if (!replaying && tag) {
    const client = external && clientResolver ? await clientResolver(deps.tenantId, tag.orgId) : null;
    if (client) floors.client = client;
    else if (external && clientBoundOrg(run.metadata)) floors.client = 'missing';
    const status = campaignStatusResolver && tag.campaignId ? await campaignStatusResolver(deps.tenantId, tag.campaignId) : null;
    if (status) live = { campaignStatus: status };
  }
  let r = resolveCampaignAction({
    policy: ra.policy, actionClass: args.actionClass, facts: args.facts, floors,
    ...(args.ceiling ? { ceiling: args.ceiling } : {}), ...(live ? { live } : {}),
  });
  if (!orgId) r = { ...r, decision: { outcome: 'blocked', reason: 'approver_org_mismatch' }, ruleId: 'floor:approver-org', layer: 'floor', reasons: ['floor:approver_org_mismatch'] };
  const attended = ra.floors.forkPosture === 'attended';

  if (external && !replaying) {
    await appendAudit(deps.tenantId, 'campaign.autonomy.decision', {
      ...(tag ?? {}),
      runId: run.runId,
      actionClass: args.actionClass,
      factsDigest: factsDigest(args.facts),
      ...(args.contentHash ? { contentHash: args.contentHash } : {}),
      policyId: r.policyId, policyVersion: r.policyVersion, policyHash: r.policyHash,
      ruleId: r.ruleId, outcome: r.decision.outcome, layer: r.layer, reasons: r.reasons,
      lane: laneOf(args.actionClass),
    }).catch((err) => log.warn('autonomy_decision_audit_failed', { runId: run.runId, error: err instanceof Error ? err.message : String(err) }));
  }

  // ADR 0942 P4b — a chokepoint is synchronous and cannot wait out a veto window.
  // notify-after WITH a window, reached with no gate in front, resolves to the
  // STRICTER outcome (approve) — never silently to plain notify-after. The
  // approvers are the people the window would have asked, else the default.
  const raw = r.decision;
  const d: Decision = raw.outcome === 'notify-after' && typeof raw.notify.vetoWindowMs === 'number' && raw.notify.vetoWindowMs > 0
    ? { outcome: 'approve', approver: raw.notify.roleRefs?.length ? { ...DEFAULT_APPROVER, roleRefs: [...raw.notify.roleRefs] } : { ...DEFAULT_APPROVER } }
    : raw;
  if (d.outcome === 'blocked') return { kind: 'blocked', reason: d.reason, ruleId: r.ruleId, layer: r.layer, policyHash: r.policyHash };
  if (d.outcome === 'approve') {
    const metadata = run.metadata ?? {};
    const acting = typeof metadata.actingUserId === 'string' && metadata.actingUserId.trim() ? [metadata.actingUserId] : [];
    // Actor-else-cause, as in the central isAutonomyRequester check. Causes
    // only deny a vote; they gain no notification or credential authority.
    const causes = !acting.length && typeof metadata.orgScopeSubject === 'string' && metadata.orgScopeSubject.trim() ? [metadata.orgScopeSubject] : [];
    return {
      kind: 'approve', approver: d.approver, ruleId: r.ruleId, layer: r.layer, policyHash: r.policyHash, attended, runId: run.runId,
      ...(tag ? { orgId: tag.orgId } : {}), requesters: acting, requesterCauses: causes,
    };
  }
  return {
    kind: 'proceed', outcome: d.outcome, decision: d, ruleId: r.ruleId, layer: r.layer, policyHash: r.policyHash, attended, runId: run.runId,
    ...(tag ? { orgId: tag.orgId, campaignId: tag.campaignId } : {}),
  };
}

/** D7 — emit a proceed verdict's notify-after notice. Call it only after the effect SUCCEEDED. */
export async function noticeAfterEffect(tenantId: string, verdict: EnforceVerdict, actionClass: ActionClass, summary: string): Promise<void> {
  if (verdict.kind !== 'proceed' || verdict.decision.outcome !== 'notify-after') return;
  const { emitAutonomyNotice } = await import('./notify.js');
  await emitAutonomyNotice({
    tenantId, notify: verdict.decision.notify, actionClass, summary, runId: verdict.runId,
    ...(verdict.orgId ? { orgId: verdict.orgId } : {}), ...(verdict.campaignId ? { campaignId: verdict.campaignId } : {}),
  }).catch((err) => log.warn('autonomy_notice_failed', { tenantId, actionClass, error: err instanceof Error ? err.message : String(err) }));
}

/** sha256 of an effect's content, the covering-grant content key. */
export function contentHashOf(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
