/**
 * Board "Shared knowledge" (ADR 0100 D2) — share a KB with a Board of Advisors by
 * binding it to EVERY advisor agent (the per-agent knowledge binding, ADR 0038)
 * applied board-wide. RAG then rides each advisor's per-turn query.
 *
 * The set of shareable KBs is NOT hard-coded here: each KB-owning feature registers
 * a provider into the core `shareableKb` registry at boot (strategy / priority-matrix
 * / projects today). This feature only knows how to (a) ask the registry for a
 * kind's collection ids and (b) bind/unbind them to advisors — so it imports NONE of
 * those features' internals, and a new shareable-KB kind is purely additive (register
 * a provider; the board picks it up). The carve-outs (managed pre-create + backfill,
 * project visibility filtering) live in each provider, not here.
 *
 * @see docs/adr/0100-planning-knowledge-base.md (D2)
 * @see host/shareableKb.ts
 */

import { getAgentProfile } from '../../host/agentProfileService.js';
import { getShareableKbProvider, shareableKbKinds } from '../../host/shareableKb.js';
import { bindCollection, unbindCollection } from '../agent-knowledge/service.js';
// ADR 0643 R3 (Blocker 2) — this reconciler binds ONLY share-kind PROVIDER collections
// (managed org KBs that never carry a `boundSubject`), and it resolved the share at
// its own door; it is the one sanctioned `PREAUTHORIZED_CALLER` bind lane.
import { PREAUTHORIZED_CALLER } from '../../host/subjectAccess.js';
import type { AdvisoryBoard } from './types.js';

/** The kinds a board can share (whatever features have registered). */
export function sharedKbKinds(): string[] {
  return shareableKbKinds();
}

/** Runtime validator + narrower for an untrusted `kind` against the registry. */
export function isSharedKbKind(v: unknown): v is string {
  return typeof v === 'string' && shareableKbKinds().includes(v);
}

export interface BoardSharedKnowledge {
  kind: string;
  /** Bound to EVERY current advisor (the share action's invariant). */
  shared: boolean;
  /** Something exists to share (≥1 resolvable collection for this org+kind). */
  exists: boolean;
  /** How many collections back this kind for the org. */
  count: number;
  /**
   * Can this kind be toggled ON right now? A MANAGED kind (strategy/priority-matrix)
   * is always shareable — toggling on pre-creates its collection. A non-managed kind
   * (project) is only shareable when ≥1 collection already exists; with none there is
   * nothing to bind, so the UI disables the chip + explains instead of a silent no-op.
   */
  shareable: boolean;
}

/** Is every one of `ids` bound to EVERY advisor? (false for an empty cohort/set.) */
async function allAdvisorsBound(tenantId: string, advisors: string[], ids: string[]): Promise<boolean> {
  if (advisors.length === 0 || ids.length === 0) return false;
  for (const advisorId of advisors) {
    const bound = (await getAgentProfile(tenantId, advisorId))?.knowledge?.collectionIds ?? [];
    if (!ids.every((id) => bound.includes(id))) return false;
  }
  return true;
}

/** Per-kind sharing status for a board, across every registered shareable-KB kind.
 *  ADR 0277 P2 — `shared` now reports the STORED intent (`board.sharedKbKinds`),
 *  falling back to the legacy derived check (all advisors bound) for boards that
 *  shared before the field existed, so their toggles don't read as OFF. */
export async function getBoardSharedKnowledge(
  tenantId: string,
  board: AdvisoryBoard,
  /** GRADE-D2 — optional REQUEST-scoped memo (`${kind}|${orgId}` → ids): the
   *  cohort-change protection loops call this per relevant board, and the
   *  project provider's resolveCollectionIds does a full-tenant listProjects
   *  each time. Request-scoped by design — zero staleness/invalidation surface. */
  resolveMemo?: Map<string, string[]>,
): Promise<BoardSharedKnowledge[]> {
  const out: BoardSharedKnowledge[] = [];
  for (const kind of shareableKbKinds()) {
    const provider = getShareableKbProvider(kind);
    if (!provider) continue;
    const memoKey = `${kind}|${board.orgId}`;
    const memoized = resolveMemo?.get(memoKey);
    const ids = memoized ?? await provider.resolveCollectionIds(tenantId, board.orgId);
    if (!memoized && resolveMemo) resolveMemo.set(memoKey, ids);
    // Managed kinds (have `ensureCollectionIds`) can always be shared — toggling on
    // pre-creates the collection. Non-managed kinds need ≥1 existing collection.
    const shareable = Boolean(provider.ensureCollectionIds) || ids.length > 0;
    const shared = (board.sharedKbKinds ?? []).includes(kind) || await allAdvisorsBound(tenantId, board.advisors, ids);
    out.push({ kind, shared, exists: ids.length > 0, count: ids.length, shareable });
  }
  return out;
}

/** Share (bind) or unshare (unbind) a kind's collection(s) across ALL advisors.
 *  Share uses the provider's `ensureCollectionIds` (managed pre-create) when present;
 *  unshare resolves with `forUnshare` so it cleans up collections that are no longer
 *  shareable (e.g. a project that went private after being shared). `bindCollection`
 *  is idempotent + grants the knowledge capability; unbind tolerates a never-bound id. */
/** Returns the collection ids the operation actually applied, so the route can
 *  record STORED intent only when a share was meaningful (ADR 0277 P2 — a kind
 *  with zero resolvable collections, e.g. only a PRIVATE project, must not be
 *  recorded as shared: the visibility carve-out stays authoritative). */
export async function setBoardSharedKnowledge(tenantId: string, board: AdvisoryBoard, kind: string, shared: boolean, actor: string): Promise<{ ids: string[] }> {
  const provider = getShareableKbProvider(kind);
  if (!provider) return { ids: [] };
  const ids = shared
    ? (provider.ensureCollectionIds ? await provider.ensureCollectionIds(tenantId, board.orgId, actor) : await provider.resolveCollectionIds(tenantId, board.orgId))
    : await provider.resolveCollectionIds(tenantId, board.orgId, { forUnshare: true });
  for (const advisorId of board.advisors) {
    for (const id of ids) {
      if (shared) await bindCollection(tenantId, advisorId, id, PREAUTHORIZED_CALLER);
      else { try { await unbindCollection(tenantId, advisorId, id); } catch { /* not bound — ignore */ } }
    }
  }
  return { ids: [...ids] };
}

/**
 * ADR 0608 D5 (`CPC-3`) — reconcile ONE board after its SOURCE's shareable set
 * changed (a project flipped `org` <-> `private`).
 *
 * Symmetric on purpose, and this is the decision worth recording. The obvious fix
 * is "unbind on going private". But `shared` reports STORED INTENT (ADR 0277 P2),
 * so if the board keeps its intent while its only project is private, the honest
 * behaviour on the way BACK to `org` is to re-bind — otherwise the panel would say
 * "shared" forever over an advisor that holds nothing, which is the same lie in
 * the other direction. Hence: unbind what is no longer resolvable, bind what now
 * is, both idempotent.
 *
 * `stale` is computed as `forUnshare \ shareable` rather than "this project's
 * collections", so a collection ALSO reachable through a still-org-visible
 * project is correctly retained.
 *
 * Every call is fault-isolated for the reason `reconcileCohortBindings` documents:
 * a throwing bind must never abort the unbinds — that is the shape that turned a
 * cohort edit into a permanent grant leak.
 */
export async function reconcileBoardForSourceChange(tenantId: string, board: AdvisoryBoard, kind: string): Promise<void> {
  const provider = getShareableKbProvider(kind);
  if (!provider) return;
  const shareable = await provider.resolveCollectionIds(tenantId, board.orgId);
  const all = await provider.resolveCollectionIds(tenantId, board.orgId, { forUnshare: true });
  const shareableSet = new Set(shareable);
  const stale = all.filter((id) => !shareableSet.has(id));
  for (const advisorId of board.advisors) {
    for (const id of stale) {
      try { await unbindCollection(tenantId, advisorId, id); } catch { /* not bound — ignore */ }
    }
    for (const id of shareable) {
      try { await bindCollection(tenantId, advisorId, id, PREAUTHORIZED_CALLER); } catch { /* cap/vanished — never block the unbinds */ }
    }
  }
}

/**
 * ADR 0277 P2 — reconcile bindings after an advisor-cohort change, driven by the
 * board's STORED shared kinds. Added advisors are bound (they previously got
 * nothing — the toggle silently read OFF); removed advisors are unbound (they
 * previously kept org strategy/priority/project KBs forever — a grant leak),
 * UNLESS another board still grants them that kind (`isProtected`, computed by
 * the caller from the board store — conservative: over-retain, never
 * over-remove; the protecting board's own reconcile manages its ids). Bind is
 * idempotent and unbind tolerates never-bound ids, so re-running is safe.
 */
export async function reconcileCohortBindings(
  tenantId: string,
  board: AdvisoryBoard,
  removedAdvisors: readonly string[],
  addedAdvisors: readonly string[],
  isProtected: (advisorId: string, kind: string) => boolean,
): Promise<void> {
  for (const kind of board.sharedKbKinds ?? []) {
    const provider = getShareableKbProvider(kind);
    if (!provider) continue;
    // GRADE-11 — REMOVALS FIRST, and every call fault-isolated. A bind throw
    // (collection cap, vanished collection) previously aborted the whole
    // reconcile BEFORE removals ran — and since `updateBoard` had already
    // persisted the new cohort, no retry ever recomputed the removals: the
    // removed advisor kept the org KBs forever (the exact leak this exists to
    // close). Unbind-before-bind + per-call catches make any partial failure
    // re-convergent (both primitives are idempotent).
    const removable = await provider.resolveCollectionIds(tenantId, board.orgId, { forUnshare: true });
    for (const advisorId of removedAdvisors) {
      if (isProtected(advisorId, kind)) continue;
      for (const id of removable) {
        try { await unbindCollection(tenantId, advisorId, id); } catch { /* not bound — ignore */ }
      }
    }
    const ids = await provider.resolveCollectionIds(tenantId, board.orgId);
    for (const advisorId of addedAdvisors) {
      for (const id of ids) {
        try { await bindCollection(tenantId, advisorId, id, PREAUTHORIZED_CALLER); } catch { /* cap/vanished — the next share toggle re-binds; never block removals */ }
      }
    }
  }
}
