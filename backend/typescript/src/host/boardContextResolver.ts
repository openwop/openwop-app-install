/**
 * Board context resolver seam (ADR 0079 §Correction, Phase 5).
 *
 * Core declares the seam; a FEATURE (advisory-board) registers the resolver
 * (feature→core only — core never imports a feature). It turns a board's
 * selected context refs into a compact, RBAC-filtered strategy context block
 * for the advisors' system prompt. The result is SNAPSHOTTED onto the boardroom
 * `ConversationMeta` when the board group is formed (so it's stable for the
 * boardroom's life + replay-stable within the conversation), then injected
 * per-turn by `conversationExchange` via `composeAgentSystemPrompt`.
 *
 * Unregistered (or a resolver error) ⇒ `null` ⇒ no strategy block (fail-soft:
 * a boardroom must never break because strategy context can't be resolved).
 *
 * Host-extension, non-normative.
 */

/** (tenantId, boardId, convener) → a plain-text strategy context block, or null. */
export type BoardContextResolver = (
  tenantId: string,
  boardId: string,
  convener: string | undefined,
) => Promise<string | null>;

let resolver: BoardContextResolver | null = null;

/** Register the board-context resolver (called once at boot by the feature). */
export function registerBoardContextResolver(fn: BoardContextResolver): void {
  resolver = fn;
}

/** Test-only: drop the registered resolver. */
export function __resetBoardContextResolver(): void {
  resolver = null;
}

/** Resolve a board's context block, RBAC-filtered for `convener`. Fail-soft. */
export async function resolveBoardContext(
  tenantId: string,
  boardId: string,
  convener: string | undefined,
): Promise<string | null> {
  if (!resolver) return null;
  try {
    return await resolver(tenantId, boardId, convener);
  } catch {
    return null;
  }
}
