/**
 * Governance policy (ADR 0028) — admin-set, tenant-scoped rules that
 * CONFIGURE the enforcement points that already exist; this module is never
 * a second evaluator:
 *
 *   - `isProviderAllowed()` is consulted at BOTH connections seams — the
 *     connect/authorize routes AND the node-exec credential resolver (one
 *     predicate, the `webhookEgressGuard` no-drift discipline);
 *   - `actionPolicyOf()` is consulted at the assistant's enqueue (disabled ⇒
 *     no drafts) and execution (draft-only ⇒ the human decision is recorded,
 *     nothing egresses) seams.
 *
 * Defaults are the T6 posture: every kind `approval-required` — the human
 * approval claim IS the gate; execution follows it. (Correction vs. ADR 0028
 * §"Decision", which sketched draft-only defaults for send kinds: a default
 * under which the Approve button silently does nothing is a UX trap — the
 * restrictive postures exist for admins to opt INTO.)
 *
 * Host-layer module (not a feature): both the connections and assistant
 * features consult it, and features must not import each other (ADR 0001).
 */

import { DurableCollection } from './hostExtPersistence.js';

export type ActionKindPolicy = 'disabled' | 'draft-only' | 'approval-required';

export interface GovernancePolicy {
  tenantId: string;
  /** Absent ⇒ every registry provider is connectable/resolvable. */
  providerAllowlist?: string[];
  /** Per assistant-action kind; absent kinds default `approval-required`. */
  actionPolicy?: Record<string, ActionKindPolicy>;
  /** Retention windows (days). Stored now; the sweep daemon is ADR 0029's. */
  retention?: { assistantGraphDays?: number; sourceDerivedDays?: number };
  updatedAt: string;
  updatedByUserId?: string;
}

const policies = new DurableCollection<GovernancePolicy>('governance:policy', (p) => p.tenantId);

export async function getGovernancePolicy(tenantId: string): Promise<GovernancePolicy | null> {
  return policies.get(tenantId);
}

export async function setGovernancePolicy(
  tenantId: string,
  patch: Pick<GovernancePolicy, 'providerAllowlist' | 'actionPolicy' | 'retention'>,
  updatedByUserId?: string,
): Promise<GovernancePolicy> {
  const next: GovernancePolicy = {
    tenantId,
    updatedAt: new Date().toISOString(),
    ...(patch.providerAllowlist !== undefined ? { providerAllowlist: patch.providerAllowlist } : {}),
    ...(patch.actionPolicy !== undefined ? { actionPolicy: patch.actionPolicy } : {}),
    ...(patch.retention !== undefined ? { retention: patch.retention } : {}),
    ...(updatedByUserId !== undefined ? { updatedByUserId } : {}),
  };
  await policies.put(next);
  return next;
}

/** ONE allowlist predicate for both the connect routes and the resolver. */
export async function isProviderAllowed(tenantId: string, provider: string): Promise<boolean> {
  const policy = await policies.get(tenantId);
  if (!policy?.providerAllowlist) return true;
  return policy.providerAllowlist.includes(provider);
}

/** Per-kind action policy; unset ⇒ `approval-required` (the T6 posture). */
export async function actionPolicyOf(tenantId: string, kind: string): Promise<ActionKindPolicy> {
  const policy = await policies.get(tenantId);
  const v = policy?.actionPolicy?.[kind];
  return v === 'disabled' || v === 'draft-only' || v === 'approval-required' ? v : 'approval-required';
}

/** Test-only. */
export async function __resetGovernanceStore(): Promise<void> {
  await policies.__clear();
}
