/**
 * Reviewable-learning proposals service (RFC 0096) — host-sample.
 *
 * Persisted via a tenant-prefixed DurableCollection. What this service upholds:
 *   - `proposal-inert-until-applied` — a proposal is an inert record; nothing
 *     here reaches a run.
 *   - `proposal-no-resynthesis` — `apply()` hands the byte image already stored
 *     on `proposal.artifact` to the kind's installer. It imports nothing that
 *     could synthesize/regenerate the artifact (no LLM, no prompt, no agent).
 *   - ADR 0938 D1 — `apply()` installs only through a registered installer. This
 *     host registers NONE today (ADR 0938 D7 says what each kind would need), so
 *     every apply is refused `proposal_not_installable`. Until 2026-10-19 it
 *     returned an `installed:<kind>:<id>:<sha>` string and set `applied` while
 *     installing nothing.
 *   - ADR 0938 D4 — one transition table, and every write is a CAS on the row
 *     read, with a per-row `revision`.
 *   - ADR 0938 D5 — apply names the `{revision, artifactDigest}` its caller saw.
 */

import { createHash, randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { canonicalJSON } from '../../host/jcs.js';
import { OpenwopError } from '../../types.js';
import type { InstalledArtifact, Proposal, ProposalKind, ProposalState } from './types.js';

// Row key is `${tenant}::${id}` so the collection is tenant-partitioned and a
// prefix scan lists exactly one tenant's slice (no cross-tenant read).
// PROPC-ERASURE-TEARDOWN — the tenant lives NESTED at `owner.tenant`, not as a
// top-level `tenantId`, so without an explicit `tenantOf` resolver
// `purgeTenantRows` falls back to the `jsonTenantId` top-level probe → `undefined`
// → every proposals row (subject PII: `owner.principal`, AI content, sourceRunIds)
// is SKIPPED on account-deletion teardown and SURVIVES tenant deletion. The 4th
// arg makes teardown reach the rows (matches the sibling `suggestionStore.ts`).
const proposals = new DurableCollection<Proposal>('proposals', (p) => `${p.owner.tenant}::${p.id}`, undefined, (p) => p.owner.tenant);

const nowIso = (): string => new Date().toISOString();

/**
 * ADR 0938 D8 — the id the deleted list-time seeder wrote into every workspace
 * that listed (4 rows in prod, measured 2026-10-19). It cites a run that does not
 * exist, so no read lane serves it: the rows stay in storage for the operator.
 */
export const DEMO_PROPOSAL_ID = 'demo-reviewable-learning';

// ── ADR 0938 D1 — the installer seam ─────────────────────────────────────────

export interface ProposalInstaller {
  /**
   * Install `proposal.artifact` verbatim; return a ref to what was really written.
   * `rollback` undoes exactly that write; `applyProposal` calls it when the
   * proposal's own CAS loses, so `applied` and an install only exist together
   * (ADR 0972 D5).
   */
  install(tenant: string, proposal: Proposal): Promise<{
    installedArtifactRef: string;
    installedArtifact?: InstalledArtifact;
    rollback?: () => Promise<void>;
  }>;
}

const installers = new Map<ProposalKind, ProposalInstaller>();

/** Register the ONE installer for a kind. A kind with none cannot be applied. */
export function registerProposalInstaller(kind: ProposalKind, installer: ProposalInstaller): void {
  installers.set(kind, installer);
}

/** The kinds a proposal can actually be applied as on this host (ADR 0938 D3). */
export function installableProposalKinds(): ProposalKind[] {
  return [...installers.keys()].sort();
}

// ── ADR 0938 D4 — the transition table ───────────────────────────────────────

export type ProposalAction = 'revise' | 'apply' | 'reject' | 'archive';

const TRANSITIONS: Readonly<Record<ProposalState, Partial<Record<ProposalAction, ProposalState>>>> = {
  draft: { revise: 'revised', apply: 'applied', reject: 'rejected', archive: 'archived' },
  revised: { revise: 'revised', apply: 'applied', reject: 'rejected', archive: 'archived' },
  rejected: { archive: 'archived' },
  applied: {},
  archived: {},
};

const PAST: Readonly<Record<ProposalAction, string>> = { revise: 'revised', apply: 'applied', reject: 'rejected', archive: 'archived' };

function nextState(p: Proposal, action: ProposalAction): ProposalState {
  const to = TRANSITIONS[p.state]?.[action];
  if (!to) {
    throw new OpenwopError('conflict', `This proposal is ${p.state}, so it cannot be ${PAST[action]}.`, 409, {
      reason: 'proposal_state_conflict', state: p.state, action,
    });
  }
  return to;
}

// ── ADR 0938 D5 — what a reviewer saw ────────────────────────────────────────

export function revisionOf(p: Proposal): number {
  return typeof p.revision === 'number' ? p.revision : 0;
}

/** `sha256:` + hex SHA-256 of the artifact's RFC 8785 (JCS) bytes, so a storage
 *  backend that reorders keys cannot move it (ADR 0938 A3). The prefixed form is
 *  RFC 0249 §C's (ADR 0972 D7); clients bind to the value they read. */
export function artifactDigestOf(artifact: Record<string, unknown>): string {
  let bytes: string;
  try {
    bytes = canonicalJSON(artifact);
  } catch {
    // A stored artifact JCS refuses (a lone surrogate JSON.parse accepted before PATCH
    // validated it) must not 500 every list it sits in (PROP2CD-1). Still a pure
    // function of the stored bytes, in a separate domain so it never equals a JCS digest.
    bytes = `raw:${JSON.stringify(artifact)}`;
  }
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** The read projection: the stored row plus the two values a decision binds to. */
export type ProposalView = Proposal & { revision: number; artifactDigest: string };

export function viewOf(p: Proposal): ProposalView {
  return { ...p, revision: revisionOf(p), artifactDigest: artifactDigestOf(p.artifact) };
}

function staleError(p: Proposal): OpenwopError {
  return new OpenwopError('conflict', 'This proposal changed since it was read. Re-read it and decide again.', 409, {
    reason: 'proposal_stale', revision: revisionOf(p), artifactDigest: artifactDigestOf(p.artifact),
  });
}

function assertExpectedRevision(p: Proposal, expected: number | undefined): void {
  if (expected !== undefined && expected !== revisionOf(p)) throw staleError(p);
}

/** CAS `next` over exactly the row read; a lost race is `proposal_stale`. */
async function commit(read: Proposal, next: Proposal): Promise<Proposal> {
  const written: Proposal = { ...next, revision: revisionOf(read) + 1, updatedAt: nowIso() };
  if (!(await proposals.compareAndSwap(read, written))) {
    const now = await proposals.get(`${read.owner.tenant}::${read.id}`);
    throw staleError(now ?? read);
  }
  return written;
}

// ── reads ────────────────────────────────────────────────────────────────────

export async function listProposals(
  tenant: string,
  filter?: { state?: ProposalState; kind?: ProposalKind },
): Promise<Proposal[]> {
  const rows = await proposals.listByPrefix(`${tenant}::`);
  return rows
    .filter((p) => p.owner.tenant === tenant)
    .filter((p) => p.id !== DEMO_PROPOSAL_ID)
    .filter((p) => (filter?.state ? p.state === filter.state : true))
    .filter((p) => (filter?.kind ? p.kind === filter.kind : true))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function getProposal(tenant: string, id: string): Promise<Proposal | null> {
  if (id === DEMO_PROPOSAL_ID) return null;
  const p = await proposals.get(`${tenant}::${id}`);
  // Tenant guard: never serve a row whose owner.tenant differs from the caller.
  return p && p.owner.tenant === tenant ? p : null;
}

// ── writes ───────────────────────────────────────────────────────────────────

/** Revise a draft/revised proposal. MUST NOT activate. */
export async function reviseProposal(
  p: Proposal,
  patch: { title?: string; rationale?: string; artifact?: Record<string, unknown> },
  expectedRevision?: number,
): Promise<Proposal> {
  assertExpectedRevision(p, expectedRevision);
  const state = nextState(p, 'revise');
  return commit(p, {
    ...p,
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.rationale !== undefined ? { rationale: patch.rationale } : {}),
    ...(patch.artifact !== undefined ? { artifact: patch.artifact } : {}),
    state,
  });
}

export async function rejectProposal(p: Proposal, expectedRevision?: number): Promise<Proposal> {
  assertExpectedRevision(p, expectedRevision);
  return commit(p, { ...p, state: nextState(p, 'reject') });
}

export async function archiveProposal(p: Proposal, expectedRevision?: number): Promise<Proposal> {
  assertExpectedRevision(p, expectedRevision);
  return commit(p, { ...p, state: nextState(p, 'archive') });
}

/**
 * Apply a proposal (ADR 0938 D1/D4/D5). The caller is scope-checked at the route.
 * Order: state → binding → installer, so a refusal never depends on whether an
 * installer exists. With no installer for the kind: 409 `proposal_not_installable`
 * and the row is untouched. The host-extension route binds `revision` and the
 * digest; the v2 route binds the digest alone (ADR 0972 D7), which covers every
 * byte that gets installed.
 */
export async function applyProposal(
  p: Proposal,
  seen: { revision?: number; artifactDigest: string },
): Promise<{ proposal: Proposal; installedArtifactRef: string }> {
  nextState(p, 'apply');
  if ((seen.revision !== undefined && seen.revision !== revisionOf(p)) || seen.artifactDigest !== artifactDigestOf(p.artifact)) throw staleError(p);
  const installer = installers.get(p.kind);
  if (!installer) {
    throw new OpenwopError('conflict', `This host cannot install a \`${p.kind}\` proposal, so it cannot be applied. Nothing was changed.`, 409, {
      reason: 'proposal_not_installable', kind: p.kind,
    });
  }
  const { installedArtifactRef, installedArtifact, rollback } = await installer.install(p.owner.tenant, p);
  let applied: Proposal;
  try {
    applied = await commit(p, {
      ...p,
      state: 'applied',
      activation: { approvalId: null, installedArtifactRef, ...(installedArtifact ? { installedArtifact } : {}) },
    });
  } catch (err) {
    await rollback?.();
    throw err;
  }
  return { proposal: applied, installedArtifactRef };
}

/**
 * RFC 0249 §B — a client-submitted draft (ADR 0972 D1). Held to every RFC 0096
 * rule a synthesized draft is: inert, and installed only by `applyProposal`. It
 * carries no run provenance, because no run produced it.
 */
export async function submitProposal(
  tenant: string,
  draft: { kind: ProposalKind; artifact: Record<string, unknown>; title?: string; rationale?: string },
  principal?: string,
): Promise<Proposal> {
  const proposal: Proposal = {
    id: `p:${randomUUID()}`,
    kind: draft.kind,
    state: 'draft',
    ...(draft.title !== undefined ? { title: draft.title } : {}),
    ...(draft.rationale !== undefined ? { rationale: draft.rationale } : {}),
    artifact: draft.artifact,
    provenance: { sourceRunIds: [] },
    duplicateOf: null,
    owner: { tenant, ...(principal ? { principal } : {}) },
    revision: 0,
    createdAt: nowIso(),
  };
  if (!(await proposals.compareAndSwap(null, proposal))) throw staleError(proposal);
  return proposal;
}

/** Test/seed helper — upsert a proposal directly. */
export async function putProposal(p: Proposal): Promise<void> {
  await proposals.put(p);
}

/**
 * The ONE producer (RFC 0096) — a proposal minted from an ACCEPTED
 * ambient-work-graph pattern.
 *
 * The signal is honest: the work graph found a recurring tool-call pattern in one
 * person's own runs (ADR 0137, ADR 0930) and that person, holding `workspace:write`,
 * ACCEPTED turning it into a workflow. That accept is recorded here as a durable,
 * INERT proposal the workspace can read, revise, reject or archive, so
 * `openwop:proposals.list`'s "check before proposing again" reads real history.
 *
 * The artifact is the tool-name skeleton plus its occurrence count. It is NOT an
 * RFC 0013 chain manifest (`PROP2WF-9`), and no installer would take it: the real
 * "make it a workflow" path is the Workflow Architect hand-off the accept route
 * returns. (The comment here used to say apply "installs it verbatim"; nothing ever
 * did — ADR 0938 A7.)
 *
 * DETERMINISTIC DEDUP: the proposal id is derived from the (hash-derived,
 * tenant-scoped) `suggestionId`, so re-accepting the same suggestion returns the
 * existing row untouched (its own revise/reject state is preserved).
 */
export async function createProposalFromAcceptedPattern(
  tenant: string,
  pattern: {
    suggestionId: string;
    toolSequence: string[];
    count: number;
    exampleRunIds: string[];
    sampleGoal?: string;
  },
  principal?: string,
): Promise<Proposal> {
  const id = `wg:${pattern.suggestionId}`;
  const existing = await getProposal(tenant, id);
  if (existing) return existing; // idempotent — the accepted signal produces at most one proposal

  const skeleton = pattern.toolSequence.join(' → ');
  const proposal: Proposal = {
    id,
    kind: 'workflow-chain-pack',
    state: 'draft',
    title: pattern.sampleGoal
      ? `Automate a recurring pattern: ${pattern.sampleGoal}`
      : `Automate a recurring ${pattern.count}× pattern`,
    rationale:
      `This tool pattern (${skeleton}) recurred across ${pattern.count} runs and was accepted for automation. `
      + 'Turning it into a workflow chain removes the repeated manual steps.',
    artifact: {
      toolSequence: pattern.toolSequence,
      occurrences: pattern.count,
      ...(pattern.sampleGoal ? { sampleGoal: pattern.sampleGoal } : {}),
    },
    provenance: { sourceRunIds: pattern.exampleRunIds },
    duplicateOf: null,
    owner: { tenant, ...(principal ? { principal } : {}) },
    revision: 0,
    createdAt: nowIso(),
  };
  // Insert-only CAS (never a get→put): two concurrent accepts of the SAME
  // suggestion can both clear the `getProposal` pre-check above, but only the
  // writer that wins the create-if-absent installs the row. The loser re-reads and
  // returns the winner's row, so a racing accept can never clobber a concurrent
  // revise/reject the workspace made between the pre-check and the write.
  if (!(await proposals.compareAndSwap(null, proposal))) {
    const won = await getProposal(tenant, id);
    if (won) return won;
  }
  return proposal;
}

export const __test = { collection: proposals, installers };
