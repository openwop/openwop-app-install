/**
 * Digital-twin authorization (ADR 0044, Phase 1) — host-owned. The single owner
 * of the twin LINK + the user-issued consent GRANT that, in Phase 2, will gate an
 * agent recalling its owner's `user:<id>` memory. It lives in the HOST (not a
 * feature) because Phase-2 dispatch must read the grant, and core must not import
 * a feature (ADR 0001). Phase 1 ships the link + grant state + audit ONLY — there
 * is NO cross-subject read yet.
 *
 * Two-step authority (ADR 0044 §1–2):
 *   - the LINK ("agent X is user Y's twin") is operational — set by an admin/owner
 *     on `agentProfile.twin`; it grants NO access.
 *   - the GRANT (a `TwinGrant`) is the authorization — issued/revoked ONLY by the
 *     linked user (`grantedByUserId == twin.userId`). Fail-closed: no active grant
 *     ⇒ no cross read.
 *
 * Tenant isolation (CTI-1): every key/record is tenant-scoped; `tenantId` is bound
 * from the principal, never a query value.
 *
 * @see docs/adr/0044-twin-cross-subject-recall.md
 */

import { DurableCollection } from './hostExtPersistence.js';
import { OpenwopError } from '../types.js';
import type { Storage } from '../storage/storage.js';
import { getAgentProfile, setAgentTwin } from './agentProfileService.js';
import { getRosterEntry } from './rosterService.js';
import { registerSubjectEraser } from './subjectErasure.js';
import { subjectKeyForms } from './subjectErasureRedaction.js';

export type TwinScope = 'memory' | 'knowledge';
const ALL_SCOPES: TwinScope[] = ['memory', 'knowledge'];

/** The ONE membership test for a scope string (TWIN-20). Exported so the route
 *  layer VALIDATES instead of casting — a `as TwinScope[]` over unvalidated JSON
 *  was safe only by accident, because `grantTwin` re-filters below. */
export function isTwinScope(v: unknown): v is TwinScope {
  return typeof v === 'string' && (ALL_SCOPES as string[]).includes(v);
}

/** A user-issued consent grant: agent `agentId` may recall the granting user's
 *  corpus for `scopes` while `status === 'active'`. `version` bumps on each
 *  (re)issue.
 *
 *  CORRECTED (ADR 0666 D6 / `PKWF-6`) — this line used to end "Phase 2 stamps it on a run for
 *  replay (ADR 0044 §4)". That design was superseded and is now explicitly FORBIDDEN: the
 *  grant is re-read LIVE per dispatch and per retrieval, with NO run stamp anywhere, and that
 *  is precisely why revocation survives a `:fork` (`host/agentRunnerNode.ts` — "do NOT
 *  'optimize' in a grant/run stamp: either would freeze borrowed content past revocation";
 *  pinned behaviourally by `test/twin-fork-revoke.test.ts` and structurally by
 *  `test/twin-replay-classification.test.ts`). `version` is audit attribution only — it appears
 *  on the consent-ledger payload and nowhere on `run.metadata`. Left as a correction rather
 *  than a silent edit because this is the docblock a maintainer reads before "restoring" the
 *  optimization. */
export interface TwinGrant {
  /** Collection key `${tenantId}:${agentId}:${userId}` — one grant per pair. */
  key: string;
  tenantId: string;
  agentId: string;
  grantedByUserId: string;
  grantedAt: string;
  scopes: TwinScope[];
  status: 'active' | 'revoked';
  revokedAt?: string;
  version: number;
}

// WF-TWIN-8 / GEN-TWIN-1 — `tenantOf` ARMS the tenant secondary index. Without
// it `indexed:false` (`hostExtPersistence.ts:288`), `listForTenantIndexed` throws
// (`:538`), and that enumeration is the one every `registerRetentionPurger` uses
// — so NO reclaim path existed at all. That is what makes a mis-partitioned row
// unrecoverable rather than merely wrong, and it is why ADR 0508's migration 19
// had to be written by hand. Armed in the same change as the tenancy fix, per the
// GEN-TWIN-1 ordering constraint.
const grants = new DurableCollection<TwinGrant>('twin-grant', (g) => g.key, undefined, (g) => g.tenantId);
const grantKey = (tenantId: string, agentId: string, userId: string): string => `${tenantId}:${agentId}:${userId}`;

function nowIso(): string { return new Date().toISOString(); }

async function audit(storage: Storage, action: string, principalId: string, resource: string, payload: unknown): Promise<void> {
  try {
    await storage.appendAudit({ timestamp: nowIso(), principalId, action, resource, outcome: 'ok', payload });
  } catch {
    /* audit is best-effort; never block the operation */
  }
}

// ── the LINK (admin/owner) ──────────────────────────────────────────────────

/** The twin link on an agent, or null. Tenant fail-closed (a cross-tenant agent
 *  reads as no link). */
export async function getTwinLink(tenantId: string, agentId: string): Promise<AgentTwin | null> {
  const entry = await getRosterEntry(tenantId, agentId);
  if (!entry || entry.tenantId !== tenantId) return null;
  const profile = await getAgentProfile(tenantId, agentId);
  return profile?.twin ?? null;
}
export type AgentTwin = NonNullable<Awaited<ReturnType<typeof getAgentProfile>>>['twin'];

/** Link an agent to a user (admin/owner). The agent MUST exist in the tenant.
 *  Setting a NEW link auto-revokes any prior user's active grant on this agent
 *  (the old twin's authorization must not carry to a re-linked agent). */
export async function linkTwin(storage: Storage, tenantId: string, agentId: string, userId: string, linkedBy: string): Promise<void> {
  const entry = await getRosterEntry(tenantId, agentId);
  if (!entry || entry.tenantId !== tenantId) {
    throw new OpenwopError('not_found', 'Agent not found.', 404, { agentId });
  }
  const prior = await getAgentProfile(tenantId, agentId);
  if (prior?.twin && prior.twin.userId !== userId) {
    // Re-linking to a different user: revoke the previous twin's grant.
    await revokeByOwner(storage, tenantId, agentId, prior.twin.userId, 'relink');
  }
  await setAgentTwin(tenantId, agentId, { userId, linkedBy, linkedAt: nowIso() }, { roleKey: entry.roleKey ?? 'unknown', autonomy: { specLevel: 'draft-only' } });
  await audit(storage, 'twin.link', linkedBy, `agent:${agentId}`, { userId });
}

/** Remove the twin link (admin/owner) AND revoke the linked user's grant — the
 *  link is gone, so its authorization must be too.
 *
 *  TWIN-UX-3 (unlink lane) — returns whether a link EXISTED, mirroring
 *  `revokeTwin`. This used to be `void` with an unconditional `twin.unlink`
 *  audit row, so a stale second tab that unlinked nothing recorded the same
 *  consent-destroying act as a real unlink — a fabricated row in the one log
 *  consent is reviewed from. A no-op now writes nothing and audits nothing. */
export async function unlinkTwin(storage: Storage, tenantId: string, agentId: string, actor: string): Promise<boolean> {
  const profile = await getAgentProfile(tenantId, agentId);
  const entry = await getRosterEntry(tenantId, agentId);
  if (!entry || entry.tenantId !== tenantId) {
    throw new OpenwopError('not_found', 'Agent not found.', 404, { agentId });
  }
  if (!profile?.twin) return false;
  await revokeByOwner(storage, tenantId, agentId, profile.twin.userId, 'unlink');
  await setAgentTwin(tenantId, agentId, null, { roleKey: entry.roleKey ?? 'unknown', autonomy: { specLevel: 'draft-only' } });
  await audit(storage, 'twin.unlink', actor, `agent:${agentId}`, { userId: profile.twin.userId });
  return true;
}

// ── the GRANT (the linked user only) ────────────────────────────────────────

/** Grant (or re-issue) the caller's consent for `agentId` to recall their corpus.
 *  ONLY the user the agent is linked to may grant (fail-closed otherwise). Bumps
 *  `version`. Idempotent-ish: a re-grant updates scopes + reactivates. */
export async function grantTwin(storage: Storage, tenantId: string, agentId: string, byUserId: string, scopes: TwinScope[]): Promise<TwinGrant> {
  const link = await getTwinLink(tenantId, agentId);
  if (!link || link.userId !== byUserId) {
    // No existence leak: a non-linked caller gets the same 404 as a missing agent.
    throw new OpenwopError('not_found', 'No twin link to your account for this agent.', 404, { agentId });
  }
  const clean = scopes.filter((s): s is TwinScope => ALL_SCOPES.includes(s));
  if (clean.length === 0) {
    throw new OpenwopError('validation_error', `\`scopes\` must include at least one of: ${ALL_SCOPES.join(', ')}.`, 400, { field: 'scopes' });
  }
  const existing = await grants.get(grantKey(tenantId, agentId, byUserId));
  const next: TwinGrant = {
    key: grantKey(tenantId, agentId, byUserId),
    tenantId,
    agentId,
    grantedByUserId: byUserId,
    grantedAt: nowIso(),
    scopes: clean,
    status: 'active',
    version: (existing?.version ?? 0) + 1,
  };
  await grants.put(next);
  await audit(storage, 'twin.grant', byUserId, `agent:${agentId}`, { scopes: clean, version: next.version });
  return next;
}

/** Revoke the caller's own grant for `agentId`. Fail-closed: returns false when
 *  the caller has no grant on that agent. */
export async function revokeTwin(storage: Storage, tenantId: string, agentId: string, byUserId: string): Promise<boolean> {
  return revokeByOwner(storage, tenantId, agentId, byUserId, 'user');
}

async function revokeByOwner(storage: Storage, tenantId: string, agentId: string, userId: string, reason: string): Promise<boolean> {
  const existing = await grants.get(grantKey(tenantId, agentId, userId));
  if (!existing || existing.tenantId !== tenantId || existing.status === 'revoked') return false;
  await grants.put({ ...existing, status: 'revoked', revokedAt: nowIso() });
  await audit(storage, 'twin.revoke', userId, `agent:${agentId}`, { reason });
  return true;
}

/** Every grant the caller has issued (active + revoked), newest first. For the
 *  user's "who can recall my memory" view. */
export async function listGrantsForUser(tenantId: string, userId: string): Promise<TwinGrant[]> {
  const all = await grants.listByPrefix(`${tenantId}:`);
  return all
    .filter((g) => g.grantedByUserId === userId)
    .sort((a, b) => b.grantedAt.localeCompare(a.grantedAt));
}

/** Drop ALL twin grants for a deleted agent (the roster cascade) — the grants
 *  outlive the `agentProfile.twin` link otherwise. Tenant-scoped. Returns the
 *  number cleared. */
export async function clearTwinGrantsForAgent(tenantId: string, agentId: string): Promise<number> {
  const all = await grants.listByPrefix(`${tenantId}:${agentId}:`);
  for (const g of all) await grants.delete(g.key);
  return all.length;
}

// ── ADR 0464 P2 — DSAR subject erasure ───────────────────────────────────────
// A twin GRANT is the granting user's OWN consent record — issued and revocable
// ONLY by that user (`grantedByUserId`). It carries no one else's personal data
// (the agent it grants to is a roster agent, not a person), so a DSAR DELETES
// every grant the subject issued, tenant-wide (the `agentProfile.twin` LINK is a
// separate store, owned by agentProfileService — reported for coverage, not
// touched here). Tenant-scoped prefix scan; idempotent.

/** DSAR eraser — delete every twin grant the subject issued, tenant-wide.
 *  Reports `rowsTouched` (WF-TWIN-3): a fan-out that reached nothing anywhere must
 *  not be recorded as `erasure_complete`. */
export async function eraseSubjectTwinGrants(tenantId: string, subjectKey: string): Promise<{ rowsTouched: number }> {
  if (!tenantId || !subjectKey) return { rowsTouched: 0 };
  const { forms } = subjectKeyForms(subjectKey);
  let rowsTouched = 0;
  for (const g of await grants.listByPrefix(`${tenantId}:`)) {
    if (forms.has(g.grantedByUserId)) { await grants.delete(g.key); rowsTouched += 1; }
  }
  return { rowsTouched };
}

/** Register the twin-grant DSAR eraser (idempotent — the seam dedupes by
 *  reference). Called from the host-erasers boot step (host/hostSubjectErasers.ts). */
export function registerTwinErasure(): void {
  registerSubjectEraser(eraseSubjectTwinGrants);
}

/** The ACTIVE grant for (agent, user), or null. The fail-closed gate Phase-2
 *  dispatch reads before any cross-subject recall.
 *
 *  TWIN-3 / TWIN-DEBT-2 correction (2026-08-20). This used to claim a revocation
 *  "takes effect immediately — even on a fork", full stop. Two-thirds true, and
 *  the third was the one the consent screen promised in four locales. What is
 *  actually guaranteed, now that `borrowedRecall` re-reads this per RETRIEVAL:
 *    - the next dispatch, the next turn, and any `:fork`  → no recall  (yes)
 *    - a retrieval inside a turn ALREADY in flight        → no recall  (yes, new)
 *    - content already borrowed into a COMPLETED turn's transcript, and any
 *      summary persisted from it                          → NOT retracted
 *  Revocation is PROSPECTIVE. The locale copy now says so. */
export async function getActiveGrant(tenantId: string, agentId: string, userId: string): Promise<TwinGrant | null> {
  const g = await grants.get(grantKey(tenantId, agentId, userId));
  if (!g || g.tenantId !== tenantId || g.status !== 'active') return null;
  return g;
}
