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

/** Per-kind sharing status for a board, across every registered shareable-KB kind. */
export async function getBoardSharedKnowledge(tenantId: string, board: AdvisoryBoard): Promise<BoardSharedKnowledge[]> {
  const out: BoardSharedKnowledge[] = [];
  for (const kind of shareableKbKinds()) {
    const provider = getShareableKbProvider(kind);
    if (!provider) continue;
    const ids = await provider.resolveCollectionIds(tenantId, board.orgId);
    // Managed kinds (have `ensureCollectionIds`) can always be shared — toggling on
    // pre-creates the collection. Non-managed kinds need ≥1 existing collection.
    const shareable = Boolean(provider.ensureCollectionIds) || ids.length > 0;
    out.push({ kind, shared: await allAdvisorsBound(tenantId, board.advisors, ids), exists: ids.length > 0, count: ids.length, shareable });
  }
  return out;
}

/** Share (bind) or unshare (unbind) a kind's collection(s) across ALL advisors.
 *  Share uses the provider's `ensureCollectionIds` (managed pre-create) when present;
 *  unshare resolves with `forUnshare` so it cleans up collections that are no longer
 *  shareable (e.g. a project that went private after being shared). `bindCollection`
 *  is idempotent + grants the knowledge capability; unbind tolerates a never-bound id. */
export async function setBoardSharedKnowledge(tenantId: string, board: AdvisoryBoard, kind: string, shared: boolean, actor: string): Promise<void> {
  const provider = getShareableKbProvider(kind);
  if (!provider) return;
  const ids = shared
    ? (provider.ensureCollectionIds ? await provider.ensureCollectionIds(tenantId, board.orgId, actor) : await provider.resolveCollectionIds(tenantId, board.orgId))
    : await provider.resolveCollectionIds(tenantId, board.orgId, { forUnshare: true });
  for (const advisorId of board.advisors) {
    for (const id of ids) {
      if (shared) await bindCollection(tenantId, advisorId, id);
      else { try { await unbindCollection(tenantId, advisorId, id); } catch { /* not bound — ignore */ } }
    }
  }
}
