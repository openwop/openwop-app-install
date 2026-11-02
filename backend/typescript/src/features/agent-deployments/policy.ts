/**
 * ADR 1005 D12 — the operator promotion policy.
 *
 * One stored row per `(tenant, agentId)`, CAS on the row read. A reserved
 * conformance agent's policy is the fixed code floor and cannot be written: a
 * certification cut depends on it (D7, D8). For every other agent the stored
 * row is the whole policy, and no row means no gate (the P1 behaviour).
 */

import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';

export interface PromotionPolicy {
  /** D7 — a promote must cite a passed eval of this agent. */
  requiredEval?: { requiredPassScore?: number };
  /** D13 — a promote that leaves the record `active` waits for a human approval. */
  approval?: { onActivate: true };
}

export interface StoredPolicy extends PromotionPolicy {
  tenant: string;
  agentId: string;
  revision: number;
  updatedAt: string;
  updatedBy: string;
  /** A delete leaves a tombstone, so the revision never restarts (no ABA on `If-Match`). */
  deleted?: true;
}

const policies = new DurableCollection<StoredPolicy>(
  'agent-deployment-policies',
  (p) => policyId(p.tenant, p.agentId),
  undefined,
  (p) => p.tenant,
);

const policyId = (tenant: string, agentId: string): string => `${tenant}::${agentId}`;

/** The fixed floor of the reserved agents. This row is what listing `conformance-eval-gate-failing` states. */
const RESERVED_POLICIES: Readonly<Record<string, PromotionPolicy>> = {
  'core.conformance.agents.scripted': { requiredEval: {} },
  'core.conformance.channel-agent': {},
};

export function isFixedPolicy(agentId: string): boolean {
  return Object.hasOwn(RESERVED_POLICIES, agentId);
}

export async function getStoredPolicy(tenant: string, agentId: string): Promise<StoredPolicy | null> {
  const row = await policies.get(policyId(tenant, agentId));
  return row && row.tenant === tenant && row.agentId === agentId ? row : null;
}

/** The policy a transition is judged by. */
export async function effectivePolicy(tenant: string, agentId: string): Promise<PromotionPolicy> {
  if (isFixedPolicy(agentId)) return RESERVED_POLICIES[agentId]!;
  const row = await getStoredPolicy(tenant, agentId);
  if (!row || row.deleted) return {};
  return {
    ...(row.requiredEval ? { requiredEval: row.requiredEval } : {}),
    ...(row.approval ? { approval: row.approval } : {}),
  };
}

function field(message: string, name: string): OpenwopError {
  return new OpenwopError('validation_error', message, 400, { field: name });
}

/** The PUT body, closed. */
export function parsePolicy(raw: unknown): PromotionPolicy {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw field('The request body must be a JSON object.', 'body');
  const b = raw as Record<string, unknown>;
  for (const k of Object.keys(b)) if (k !== 'requiredEval' && k !== 'approval') throw field(`Unknown field \`${k}\`.`, k);
  const out: PromotionPolicy = {};
  if (b.requiredEval !== undefined) {
    const e = b.requiredEval;
    if (typeof e !== 'object' || e === null || Array.isArray(e)) throw field('`requiredEval` must be an object.', 'requiredEval');
    const ev = e as Record<string, unknown>;
    for (const k of Object.keys(ev)) if (k !== 'requiredPassScore') throw field(`Unknown field \`requiredEval.${k}\`.`, `requiredEval.${k}`);
    const s = ev.requiredPassScore;
    if (s !== undefined && (typeof s !== 'number' || !Number.isFinite(s) || s < 0 || s > 1)) {
      throw field('`requiredEval.requiredPassScore` must be a number from 0 to 1.', 'requiredEval.requiredPassScore');
    }
    out.requiredEval = s !== undefined ? { requiredPassScore: s } : {};
  }
  if (b.approval !== undefined) {
    const a = b.approval;
    if (typeof a !== 'object' || a === null || Array.isArray(a) || Object.keys(a).length !== 1 || (a as Record<string, unknown>).onActivate !== true) {
      throw field('`approval` must be `{ "onActivate": true }`.', 'approval');
    }
    out.approval = { onActivate: true };
  }
  return out;
}

function fixed(agentId: string): OpenwopError {
  return new OpenwopError('forbidden', `The promotion policy of ${agentId} is fixed by this host.`, 403, { reason: 'policy_fixed' });
}

function staleRevision(): OpenwopError {
  return new OpenwopError('conflict', 'The policy changed since it was read; read it again and retry.', 409, { reason: 'stale' });
}

/** Create or replace, CAS on `expectedRevision` (0 = must not exist yet; undefined = unconditional). */
export async function putPolicy(tenant: string, agentId: string, policy: PromotionPolicy, by: string, expectedRevision?: number): Promise<StoredPolicy> {
  if (isFixedPolicy(agentId)) throw fixed(agentId);
  const current = await getStoredPolicy(tenant, agentId);
  if (expectedRevision !== undefined && (current?.revision ?? 0) !== expectedRevision) throw staleRevision();
  const next: StoredPolicy = { tenant, agentId, ...policy, revision: (current?.revision ?? 0) + 1, updatedAt: new Date().toISOString(), updatedBy: by };
  if (!(await policies.compareAndSwap(current, next))) throw staleRevision();
  return next;
}

export async function deletePolicy(tenant: string, agentId: string, by: string, expectedRevision?: number): Promise<StoredPolicy | null> {
  if (isFixedPolicy(agentId)) throw fixed(agentId);
  const current = await getStoredPolicy(tenant, agentId);
  if (!current || current.deleted) return null;
  if (expectedRevision !== undefined && current.revision !== expectedRevision) throw staleRevision();
  const tombstone: StoredPolicy = { tenant, agentId, deleted: true, revision: current.revision + 1, updatedAt: new Date().toISOString(), updatedBy: by };
  if (!(await policies.compareAndSwap(current, tombstone))) throw staleRevision();
  return tombstone;
}
