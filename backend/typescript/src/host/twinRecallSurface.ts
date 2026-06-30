/**
 * Twin borrowed-recall seam (ADR 0044 Phase 2) — host registry, mirroring the
 * `KnowledgeBackend` seam (`knowledgeSurface.ts`). The `twin` feature FILLS this
 * at boot with a resolver that reads the live grant + composes the owner's corpus;
 * core dispatch wiring (`routes/agents.ts`) READS it via `getBorrowedRecallResolver`
 * — so core never imports the feature (ADR 0001), yet a granted twin agent can
 * recall its owner's memory.
 *
 * The resolver is the LIVE authorization gate (ADR 0044 §4): it re-checks the
 * toggle + link + active grant on every dispatch, returns `undefined` when any is
 * absent (fail-closed), and returns a retriever whose output dispatch fences
 * structurally (`borrowedRetrieve`). Nothing is stamped on a run — because recall
 * is a live read never frozen into the event log, revocation takes effect
 * immediately everywhere, forks included.
 *
 * @see docs/adr/0044-twin-cross-subject-recall.md
 */

import type { AgentKnowledgeRetrieve } from './agentDispatch.js';

/** Resolve a granted twin agent's BORROWED retriever over its owner's corpus, or
 *  `undefined` when not toggled-on / not linked / not granted. */
export type BorrowedRecallResolver = (tenantId: string, agentId: string) => Promise<AgentKnowledgeRetrieve | undefined>;

let _resolver: BorrowedRecallResolver | null = null;

/** Install the resolver (the `twin` feature, at boot). `null` clears it. */
export function setBorrowedRecallResolver(resolver: BorrowedRecallResolver | null): void {
  _resolver = resolver;
}

/** The installed resolver, or `null` when the twin feature isn't composed. */
export function getBorrowedRecallResolver(): BorrowedRecallResolver | null {
  return _resolver;
}
