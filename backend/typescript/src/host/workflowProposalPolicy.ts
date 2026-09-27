/**
 * ADR 0473 Phase 5 — scoped auto-approval policy for composed-workflow
 * proposals. Per-(tenant, agent), SUPER-ADMIN set (the ADR 0104 override-store
 * pattern), and deliberately narrow:
 *
 *  - auto-approve fires ONLY when EVERY node's pack-declared role is in the
 *    read-only class (`pure` | `read`) — `gate`, `action`, `side-effect`,
 *    `streaming-output`, and UNDECLARED (`unclassified`) all block it
 *    (fail-closed: unknown is not read-only);
 *  - the approval row is still created and resolved through the ONE decision
 *    core (`claimApproval` — audit + announce + the hash re-verify pipeline),
 *    attributed `decidedBy: policy:<tenant>:<agent>` — the trail never thins;
 *  - no time-based auto-approve, no model-decides mode (the ADR's explicit
 *    rejections).
 */

import { DurableCollection } from './hostExtPersistence.js';
import { registerSubjectEraser } from './subjectErasure.js';
import { subjectKeyForms } from './subjectErasureRedaction.js';

export interface ProposalAutoApprovePolicy {
  /** `${tenantId}:${agentProfileId}` — the store key. */
  key: string;
  tenantId: string;
  agentProfileId: string;
  /** Who enabled it (superadmin subject) — audit context. */
  createdBy: string;
  createdAt: string;
}

const store = new DurableCollection<ProposalAutoApprovePolicy>(
  'workflow-proposal-autoapprove',
  (r) => r.key,
  undefined,
  (r) => r.tenantId,
);

// Grade-code C3 — tenant ids themselves contain ':' (`org:*`, `anon:*`), so
// raw `${tenantId}:${agentProfileId}` keys are delimiter-ambiguous and prefix
// listings can over-match. Encode each component; ':' stays the separator.
const keyOf = (tenantId: string, agentProfileId: string): string =>
  `${encodeURIComponent(tenantId)}:${encodeURIComponent(agentProfileId)}`;

/** The read-only node-role class — the ONLY roles auto-approval accepts. */
export const AUTO_APPROVABLE_ROLES: ReadonlySet<string> = new Set(['pure', 'read']);

export async function getProposalAutoApprovePolicy(tenantId: string, agentProfileId: string): Promise<ProposalAutoApprovePolicy | null> {
  return store.get(keyOf(tenantId, agentProfileId));
}

export async function setProposalAutoApprovePolicy(input: { tenantId: string; agentProfileId: string; createdBy: string }): Promise<ProposalAutoApprovePolicy> {
  const policy: ProposalAutoApprovePolicy = {
    key: keyOf(input.tenantId, input.agentProfileId),
    tenantId: input.tenantId,
    agentProfileId: input.agentProfileId,
    createdBy: input.createdBy,
    createdAt: new Date().toISOString(),
  };
  await store.put(policy);
  return policy;
}

export async function clearProposalAutoApprovePolicy(tenantId: string, agentProfileId: string): Promise<boolean> {
  const existing = await store.get(keyOf(tenantId, agentProfileId));
  if (!existing) return false;
  await store.delete(existing.key);
  return true;
}

export async function listProposalAutoApprovePolicies(tenantId: string): Promise<ProposalAutoApprovePolicy[]> {
  return store.listByPrefix(`${encodeURIComponent(tenantId)}:`);
}

/** The audit/attribution ref an auto-approved decision carries as `decidedBy`. */
export function policyDeciderRef(policy: ProposalAutoApprovePolicy): string {
  return `policy:workflow-proposal-autoapprove:${policy.key}`;
}

/**
 * ADR 0464 §2.1 — DSAR subject-eraser for the auto-approve policy store. The row's
 * only subject-bearing field is `createdBy` (the superadmin who enabled auto-approval
 * for a (tenant, agent) pair). On erasure the policy that subject created is DELETED
 * — the pair reverts to MANUAL approval (fail-safe: an auto-approver with no
 * accountable owner must not keep firing), and the row's identity is inseparable from
 * its creator so a scrub-in-place would leave an unaccountable policy. Tenant-scoped;
 * subject expanded to its linked identity forms (ADR 0381).
 */
export async function eraseSubjectProposalPolicies(tenantId: string, subjectKey: string): Promise<void> {
  if (!tenantId || !subjectKey) return;
  const { forms } = subjectKeyForms(subjectKey);
  for (const p of await store.listByPrefix(`${encodeURIComponent(tenantId)}:`)) {
    if (forms.has(p.createdBy)) await store.delete(p.key);
  }
}

/** Boot wiring (ADR 0464 Phase 2) — registered from the ONE `hostSubjectErasers` list. */
export function registerProposalPolicyErasure(): void {
  registerSubjectEraser(eraseSubjectProposalPolicies);
}
