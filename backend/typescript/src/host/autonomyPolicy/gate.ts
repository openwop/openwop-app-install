/**
 * ADR 0942 D5 — what an `autonomy-gate` node does, decided host-side from the
 * RUN (never from a policy in its arguments).
 *
 * - `legacy` — the run is not campaign-bound, or it is bound but unstamped while
 *   the toggle is OFF: the node suspends exactly like `core.approvalGate` today
 *   (the toggle contract: OFF ⇒ today's posture). A stamped run is never legacy;
 *   replay never reads toggles.
 * - `proceed` — auto / notify-after (the notice and the veto window are P4).
 * - `approve` — suspend as `kind:'approval'` with the compiled approvers plus the
 *   host-written `data.autonomy` block (self-approval refusal keys on it).
 * - `blocked` — a typed failure.
 * - `lane_unavailable` — `approve` on a PendingApproval-lane class: that lane
 *   (the owning kind + `resumeRunsAwaitingApproval`) is P3.
 */
import { compileApproverSpec, factsDigest, laneOf, type CompiledInterruptApprovers } from './compile.js';
import { resolveCampaignAction, type ResolveInput, type ResolutionLayer } from './resolve.js';
import { AUTONOMY_STAMP_KEY, autonomyOrgOf, runAutonomyOf } from './frozen.js';
import { ACTION_CLASSES, REVIEW_STAGES, FACT_TYPES, type ActionClass, type Decision, type ReviewStage, type RiskFact, type RiskFacts } from './types.js';
import { OpenwopError } from '../../types.js';

export interface AutonomyGateBlock {
  actionClass: ActionClass;
  stage?: ReviewStage;
  ruleId: string;
  layer: ResolutionLayer;
  policyId: string;
  policyVersion: number;
  policyHash: string;
  factsDigest: string;
  /** The facts this approval was asked on (the covering-grant ceiling, P3). */
  facts: RiskFacts;
  /** sha256 of the content the approval binds to, when the chain supplied it. */
  contentHash?: string;
  reasons: string[];
  sla?: { remindAfterMs?: number; escalateAfterMs?: number; expireAfterMs?: number };
  escalateTo?: { roleRefs: string[] };
  delegation: 'allowed' | 'none';
}

export type GateVerdict =
  | { mode: 'legacy' }
  | { mode: 'proceed'; outcome: 'auto' | 'notify-after'; decision: Decision; ruleId: string; layer: ResolutionLayer; policyHash: string; reasons: string[] }
  /** ADR 0942 P4b — notify-after with a veto window: wait on a TIMER the notified people may veto. */
  | { mode: 'veto-window'; decision: Extract<Decision, { outcome: 'notify-after' }>; windowMs: number; ruleId: string; layer: ResolutionLayer; policyHash: string; reasons: string[] }
  | { mode: 'approve'; interruptData: CompiledInterruptApprovers & { autonomy: AutonomyGateBlock } }
  | { mode: 'blocked'; reason: string; ruleId: string; layer: ResolutionLayer; reasons: string[] }
  | { mode: 'lane_unavailable'; actionClass: ActionClass; ruleId: string };

/** Parse the node's arguments into a closed shape; unknown facts/classes are typed failures. */
export function parseGateArgs(args: Record<string, unknown>): { actionClass: ActionClass; stage?: ReviewStage; facts: RiskFacts; contentHash?: string } {
  const actionClass = args.actionClass;
  if (typeof actionClass !== 'string' || !(ACTION_CLASSES as readonly string[]).includes(actionClass)) {
    throw new OpenwopError('validation_error', `actionClass must be one of the ADR 0942 action classes (got ${String(actionClass)}).`, 400, { field: 'actionClass' });
  }
  let stage: ReviewStage | undefined;
  if (args.stage !== undefined && args.stage !== null && args.stage !== '') {
    if (actionClass !== 'creative.review' || !(REVIEW_STAGES as readonly unknown[]).includes(args.stage)) {
      throw new OpenwopError('validation_error', 'stage applies to creative.review only (internal, compliance or client).', 400, { field: 'stage' });
    }
    stage = args.stage as ReviewStage;
  }
  const facts: RiskFacts = {};
  const raw = args.facts;
  if (raw !== undefined && raw !== null) {
    if (typeof raw !== 'object' || Array.isArray(raw)) throw new OpenwopError('validation_error', 'facts must be an object.', 400, { field: 'facts' });
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!(k in FACT_TYPES)) throw new OpenwopError('validation_error', `facts.${k} is not a known risk fact.`, 400, { field: `facts.${k}` });
      const type = FACT_TYPES[k as RiskFact];
      if (v === undefined || v === null) continue;
      if (typeof v !== type || (type === 'number' && !Number.isFinite(v as number))) {
        throw new OpenwopError('validation_error', `facts.${k} must be a ${type}.`, 400, { field: `facts.${k}` });
      }
      (facts as Record<string, unknown>)[k] = v;
    }
  }
  let contentHash: string | undefined;
  if (args.contentHash !== undefined && args.contentHash !== null && args.contentHash !== '') {
    if (typeof args.contentHash !== 'string' || !/^[0-9a-f]{64}$/.test(args.contentHash)) {
      throw new OpenwopError('validation_error', 'contentHash must be a sha256 hex digest.', 400, { field: 'contentHash' });
    }
    contentHash = args.contentHash;
  }
  return { actionClass: actionClass as ActionClass, ...(stage ? { stage } : {}), facts, ...(contentHash ? { contentHash } : {}) };
}

export function decideGate(input: {
  run: { metadata?: unknown; forkMode?: 'replay' | 'branch' };
  actionClass: ActionClass;
  stage?: ReviewStage;
  facts: RiskFacts;
  contentHash?: string;
  /** `campaign-orchestration` AND `campaign-orchestration.autonomy` ON for the tenant. */
  toggleOn: boolean;
  /** Read live; omitted on a replay (a replay re-derives nothing from the live overlay, D4). */
  live?: ResolveInput['live'];
}): GateVerdict {
  const ra = runAutonomyOf(input.run);
  const metadata = input.run.metadata && typeof input.run.metadata === 'object' && !Array.isArray(input.run.metadata)
    ? input.run.metadata as Record<string, unknown> : {};
  if (!ra.bound || (!ra.stamp && metadata[AUTONOMY_STAMP_KEY] === undefined && !input.toggleOn)) return { mode: 'legacy' };
  // D2: approver roles resolve on the stamp's client org (ADR 0075 §D3 reads
  // `run.metadata.approverOrgId`). If the two disagree the roles would resolve on
  // the wrong org, so the gate refuses rather than ask the wrong people.
  if (!autonomyOrgOf(metadata, ra.stamp)) {
    return { mode: 'blocked', reason: 'approver_org_mismatch', ruleId: 'floor:approver-org', layer: 'floor', reasons: ['floor:approver_org_mismatch'] };
  }
  const r = resolveCampaignAction({
    policy: ra.policy, actionClass: input.actionClass, ...(input.stage ? { stage: input.stage } : {}), facts: input.facts,
    floors: ra.floors, ...(input.live ? { live: input.live } : {}),
  });
  const d = r.decision;
  if (d.outcome === 'blocked') return { mode: 'blocked', reason: d.reason, ruleId: r.ruleId, layer: r.layer, reasons: r.reasons };
  if (d.outcome === 'notify-after' && typeof d.notify.vetoWindowMs === 'number' && d.notify.vetoWindowMs > 0) {
    return { mode: 'veto-window', decision: d, windowMs: d.notify.vetoWindowMs, ruleId: r.ruleId, layer: r.layer, policyHash: r.policyHash, reasons: r.reasons };
  }
  if (d.outcome === 'auto' || d.outcome === 'notify-after') {
    return { mode: 'proceed', outcome: d.outcome, decision: d, ruleId: r.ruleId, layer: r.layer, policyHash: r.policyHash, reasons: r.reasons };
  }
  if (laneOf(input.actionClass) === 'approval') return { mode: 'lane_unavailable', actionClass: input.actionClass, ruleId: r.ruleId };
  const compiled = compileApproverSpec(d.approver, { actionClass: input.actionClass, lane: 'interrupt' });
  return {
    mode: 'approve',
    interruptData: {
      ...compiled.interruptData,
      autonomy: {
        actionClass: input.actionClass,
        ...(input.stage ? { stage: input.stage } : {}),
        ruleId: r.ruleId,
        layer: r.layer,
        policyId: r.policyId,
        policyVersion: r.policyVersion,
        policyHash: r.policyHash,
        factsDigest: factsDigest(input.facts),
        facts: input.facts,
        ...(input.contentHash ? { contentHash: input.contentHash } : {}),
        reasons: r.reasons,
        ...(d.approver.sla ? { sla: d.approver.sla } : {}),
        ...(d.approver.escalateTo ? { escalateTo: d.approver.escalateTo } : {}),
        delegation: d.approver.delegation,
      },
    },
  };
}
