/**
 * ADR 0942 D5 — `compileApproverSpec`: ONE compiler for both approval lanes.
 * The interrupt lane (`core.approvalGate`-shaped `interrupt.data`) and the
 * PendingApproval lane (`ApprovalPolicy`) share their field names, so one
 * function produces both and they cannot drift.
 *
 * D10.1: every compiled approval names role-based approvers. A gate naming no
 * approver is decidable by any holder of its token, and the MCP MRTR lane
 * resolves exactly those; with role refs `gateAclOf(data).declared` is true, so
 * `needsNamedApprover` sends it to the inbox instead.
 */
import { createHash } from 'node:crypto';
import { OpenwopError } from '../../types.js';
import { canonicalJSON } from '../jcs.js';
import type { ApprovalPolicy } from '../approvalService.js';
import type { ActionClass, ApproverSpec, RiskFacts } from './types.js';

export type ApprovalLane = 'interrupt' | 'approval';

/** D1: the classes decided on the PendingApproval lane (their owning kind holds the state). */
export const PENDING_APPROVAL_LANE_CLASSES: ReadonlySet<ActionClass> = new Set<ActionClass>([
  'content.publish', 'ads.publish', 'ads.launch', 'ads.budget', 'email.campaign-send', 'journey.publish',
  'email.resume-sending', 'asset.accept-vendor', 'playbook.rollout', 'campaign.change-set.apply',
]);

export function laneOf(actionClass: ActionClass): ApprovalLane {
  return PENDING_APPROVAL_LANE_CLASSES.has(actionClass) ? 'approval' : 'interrupt';
}

/** The approver fields of `interrupt.data` (the `core.approvalGate` names). */
export interface CompiledInterruptApprovers {
  approverRoleRefs?: string[];
  approverGroupRefs?: string[];
  approverRefs?: string[];
  requiredApprovals?: number;
  rejectionPolicy?: 'any' | 'majority';
  /** D7 — delegation off (read only by `approverResolution`). */
  allowDelegation?: false;
  /** D7 — the expire rung, as the gate's own deadline: RFC 0093 makes expiry a
   *  rejection, applied by the existing gate-timeout sweep (no second expiry path). */
  timeoutMs?: number;
}

export interface CompiledApprovers {
  interruptData: CompiledInterruptApprovers;
  approvalPolicy: ApprovalPolicy;
}

function refuse(message: string, reason: string): never {
  throw new OpenwopError('validation_error', message, 400, { reason });
}

export function compileApproverSpec(spec: ApproverSpec, opts: { actionClass: ActionClass; lane: ApprovalLane }): CompiledApprovers {
  const roleRefs = [...new Set(spec.roleRefs ?? [])];
  const groupRefs = [...new Set(spec.groupRefs ?? [])];
  const subjectRefs = [...new Set(spec.subjectRefs ?? [])];
  if (roleRefs.length === 0 && groupRefs.length === 0) {
    // A client-approver-only spec is a grant-backed named stakeholder (validate.ts),
    // but no lane can carry that grant yet: the ADR 0958 portal decides change sets
    // on its own kind. Until then it is refused here, never compiled to an open gate.
    refuse(`An approval for ${opts.actionClass} must name approver roles or groups (ADR 0942 D10.1).`, 'autonomy_approvers_unnamed');
  }
  if (spec.clientApprover && opts.lane === 'interrupt') {
    refuse(`Client approvers cannot decide an in-run gate for ${opts.actionClass} yet (ADR 0942 Q4).`, 'autonomy_client_approver_unsupported');
  }
  if (spec.perParty && opts.lane === 'interrupt') {
    refuse(`A per-party quorum needs the change-set approval lane, not an in-run gate (${opts.actionClass}).`, 'autonomy_per_party_unsupported');
  }
  const interruptData: CompiledInterruptApprovers = {
    ...(roleRefs.length ? { approverRoleRefs: roleRefs } : {}),
    ...(groupRefs.length ? { approverGroupRefs: groupRefs } : {}),
    ...(subjectRefs.length ? { approverRefs: subjectRefs } : {}),
    ...(spec.requiredApprovals > 1 ? { requiredApprovals: spec.requiredApprovals } : {}),
    ...(spec.rejectionPolicy ? { rejectionPolicy: spec.rejectionPolicy } : {}),
    ...(spec.delegation === 'none' ? { allowDelegation: false as const } : {}),
    ...(spec.sla?.expireAfterMs ? { timeoutMs: spec.sla.expireAfterMs } : {}),
  };
  const approvalPolicy: ApprovalPolicy = {
    requiredApprovals: spec.requiredApprovals,
    ...(subjectRefs.length ? { approverRefs: subjectRefs } : {}),
    ...(groupRefs.length ? { approverGroupRefs: groupRefs } : {}),
    ...(roleRefs.length ? { approverRoleRefs: roleRefs } : {}),
    ...(spec.rejectionPolicy ? { rejectionPolicy: spec.rejectionPolicy } : {}),
    ...(spec.sla && Object.keys(spec.sla).length ? { sla: { ...spec.sla } } : {}),
    ...(spec.escalateTo ? { escalateTo: { roleRefs: [...spec.escalateTo.roleRefs] } } : {}),
    ...(spec.delegation === 'none' ? { allowDelegation: false } : {}),
  };
  return { interruptData, approvalPolicy };
}

/** The facts a decision was made on, as a stable digest (the P3 covering-grant key). */
export function factsDigest(facts: RiskFacts): string {
  return createHash('sha256').update(canonicalJSON(facts)).digest('hex');
}
