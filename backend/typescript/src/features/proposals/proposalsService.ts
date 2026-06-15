/**
 * Reviewable-learning proposals service (RFC 0096) — host-sample, best-effort.
 *
 * Persisted via a tenant-prefixed DurableCollection. The two SECURITY invariants
 * this service upholds:
 *   - `proposal-inert-until-applied` — a proposal is an inert record; only
 *     `apply()` transitions it to `applied` and installs anything.
 *   - `proposal-no-resynthesis` — `apply()` installs the byte image already
 *     stored on `proposal.artifact` VERBATIM. It imports nothing that could
 *     synthesize/regenerate the artifact (no LLM, no prompt, no agent call);
 *     the installed ref is a pure function of the stored bytes. Asserted by
 *     `test/proposals.test.ts`.
 */

import { createHash, randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { createApproval } from '../../host/approvalService.js';
import { PROPOSAL_KINDS, type Proposal, type ProposalKind, type ProposalState } from './types.js';

// Row key is `${tenant}::${id}` so the collection is tenant-partitioned and a
// prefix scan lists exactly one tenant's slice (no cross-tenant read).
const proposals = new DurableCollection<Proposal>('proposals', (p) => `${p.owner.tenant}::${p.id}`);

const nowIso = (): string => new Date().toISOString();

/** Advertised activation mode (RFC 0096 §C). Default `direct-rbac`; `approval-gate`
 *  routes apply through an RFC 0051 approval before install. */
export function activationMode(): 'direct-rbac' | 'approval-gate' {
  return process.env.OPENWOP_PROPOSALS_ACTIVATION === 'approval-gate' ? 'approval-gate' : 'direct-rbac';
}

function tenantKeyPrefix(tenant: string): string {
  return `${tenant}::`;
}

export async function listProposals(
  tenant: string,
  filter?: { state?: ProposalState; kind?: ProposalKind },
): Promise<Proposal[]> {
  const rows = await proposals.listByPrefix(tenantKeyPrefix(tenant));
  return rows
    .filter((p) => p.owner.tenant === tenant)
    .filter((p) => (filter?.state ? p.state === filter.state : true))
    .filter((p) => (filter?.kind ? p.kind === filter.kind : true))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function getProposal(tenant: string, id: string): Promise<Proposal | null> {
  const p = await proposals.get(`${tenant}::${id}`);
  // Tenant guard: never serve a row whose owner.tenant differs from the caller.
  return p && p.owner.tenant === tenant ? p : null;
}

/** Revise a draft proposal. MUST NOT activate (no state→applied here). */
export async function reviseProposal(
  tenant: string,
  id: string,
  patch: { title?: string; rationale?: string; artifact?: Record<string, unknown> },
): Promise<Proposal | null> {
  const p = await getProposal(tenant, id);
  if (!p) return null;
  if (p.state === 'applied' || p.state === 'archived') return p; // terminal — no-op
  const next: Proposal = {
    ...p,
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.rationale !== undefined ? { rationale: patch.rationale } : {}),
    ...(patch.artifact !== undefined ? { artifact: patch.artifact } : {}),
    state: 'revised',
    updatedAt: nowIso(),
  };
  await proposals.put(next);
  return next;
}

export async function rejectProposal(tenant: string, id: string): Promise<Proposal | null> {
  const p = await getProposal(tenant, id);
  if (!p) return null;
  const next: Proposal = { ...p, state: 'rejected', updatedAt: nowIso() };
  await proposals.put(next);
  return next;
}

export async function archiveProposal(tenant: string, id: string): Promise<Proposal | null> {
  const p = await getProposal(tenant, id);
  if (!p) return null;
  const next: Proposal = { ...p, state: 'archived', updatedAt: nowIso() };
  await proposals.put(next);
  return next;
}

/** Thrown when the stored artifact is not shaped for its kind (→ 422 at the route). */
export class MalformedForKindError extends Error {
  constructor(public readonly kind: ProposalKind) {
    super(`Proposal artifact is malformed for kind \`${kind}\`.`);
  }
}

/**
 * `proposal-no-resynthesis`: the installed ref is a pure, deterministic function
 * of the bytes ALREADY on `proposal.artifact` — a JCS-ish stable hash. No
 * synthesizer is consulted; applying the same stored bytes twice yields the same
 * ref. (This module imports nothing that could regenerate the artifact.)
 */
function installedRefFor(p: Proposal): string {
  const bytes = JSON.stringify(p.artifact);
  const digest = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  return `installed:${p.kind}:${p.id}:${digest}`;
}

/** Light per-kind shape check — a real host would validate against the pack/template schema. */
function artifactWellFormed(p: Proposal): boolean {
  if (!p.artifact || typeof p.artifact !== 'object' || Object.keys(p.artifact).length === 0) return false;
  return PROPOSAL_KINDS.includes(p.kind);
}

export interface ApplyResult {
  proposal: Proposal;
  installedArtifactRef: string;
  /** Set when `activation: approval-gate` — apply is pending an RFC 0051 release. */
  pendingApprovalId?: string;
}

/**
 * Apply a proposal. Caller MUST already be scope-checked at the route (403).
 * Installs the stored byte image verbatim (no re-synthesis) and routes through
 * the advertised activation mode.
 */
export async function applyProposal(tenant: string, id: string): Promise<ApplyResult | null> {
  const p = await getProposal(tenant, id);
  if (!p) return null;
  if (!artifactWellFormed(p)) throw new MalformedForKindError(p.kind);

  const installedArtifactRef = installedRefFor(p);

  if (activationMode() === 'approval-gate') {
    // RFC 0051: mint an approval; the proposal is NOT installed until released.
    const appr = await createApproval({
      tenantId: tenant,
      rosterId: 'reviewable-learning',
      persona: 'reviewable-learning',
      workflowId: p.id,
      proposal: `apply proposal ${p.id} (${p.kind})`,
    });
    const next: Proposal = { ...p, activation: { approvalId: appr.approvalId, installedArtifactRef }, updatedAt: nowIso() };
    await proposals.put(next);
    return { proposal: next, installedArtifactRef, pendingApprovalId: appr.approvalId };
  }

  // direct-rbac: install inline.
  const next: Proposal = {
    ...p,
    state: 'applied',
    activation: { approvalId: null, installedArtifactRef },
    updatedAt: nowIso(),
  };
  await proposals.put(next);
  return { proposal: next, installedArtifactRef };
}

/** Test/seed helper — upsert a proposal directly. */
export async function putProposal(p: Proposal): Promise<void> {
  await proposals.put(p);
}

/**
 * Idempotently ensure a canonical demo draft exists for `tenant`, so the
 * conformance `proposal-reviewable-learning` behavioral leg is non-vacuous for
 * whatever tenant the driver authenticates as (it soft-skips on an empty list).
 * Fixed id ⇒ at most one demo row per tenant.
 */
export async function ensureDemoProposal(tenant: string): Promise<void> {
  const id = 'demo-reviewable-learning';
  if (await getProposal(tenant, id)) return;
  await proposals.put({
    id,
    kind: 'prompt-template',
    state: 'draft',
    title: 'Tighten the weekly-summary prompt',
    artifact: { template: 'Summarize {{week}} in <=5 bullets, no preamble.', variables: ['week'] },
    provenance: { sourceRunIds: ['demo-run-1'] },
    duplicateOf: null,
    owner: { tenant },
    createdAt: nowIso(),
  });
}

export const __test = { collection: proposals, randomId: () => `prop:${randomUUID()}` };
