/**
 * Twin borrowed-recall seam (ADR 0044 Phase 2) — host registry, mirroring the
 * `KnowledgeBackend` seam (`knowledgeSurface.ts`). The `twin` feature FILLS this
 * at boot with a resolver that reads the live grant + composes the owner's corpus;
 * core dispatch wiring (`routes/agents.ts`) READS it via `getBorrowedRecallResolver`
 * — so core never imports the feature (ADR 0001), yet a granted twin agent can
 * recall its owner's memory.
 *
 * The resolver is the LIVE authorization gate (ADR 0044 §4 + ADR 0589 §D2): it
 * re-checks the toggle + link + AUDIENCE + active grant on every dispatch, returns
 * `undefined` when any is absent (fail-closed), and returns a retriever whose
 * output dispatch fences structurally (`borrowedRetrieve`).
 *
 * Nothing is stamped on a run. That is load-bearing, not incidental: because
 * recall is a live read never frozen into the event log, revocation takes effect
 * on the NEXT read — forks included — and the retriever re-reads the grant per
 * retrieval, so the turn in flight is cut off too (ADR 0589 / TWIN-3). Content
 * already borrowed into a COMPLETED turn's transcript is not retracted, and the
 * consent copy says so.
 *
 * @see docs/adr/0044-twin-cross-subject-recall.md
 * @see docs/adr/0589-twin-tenancy-and-recall-audience.md
 */

import type { AgentKnowledgeRetrieve } from './agentDispatch.js';

/**
 * Who is asking, and on what run (ADR 0589 §D2 / WF-TWIN-6).
 *
 * The seam used to be `(tenantId, agentId)`, which made two things structurally
 * impossible: any per-caller authorization (so every tenant member addressing a
 * granted twin got answers grounded in one person's private memory), and the
 * `runId` ADR 0044 §5 specifies for the audit row. Both are the same widening.
 *
 * `callerUserId` is the stable `User.userId` of the HUMAN whose turn this is —
 * NOT the agent, and never a principal id that could vary per auth channel. All
 * three dispatch lanes can supply it: chat has `callerUserId`, the ad-hoc route
 * has `req.userId`, and a run has `ctx.actingUserId` (ADR 0324). Absent ⇒ DENY.
 */
export interface BorrowedRecallContext {
  callerUserId?: string;
  runId?: string;
  /**
   * PR #3409 review fold-in (F1) — the PER-DISPATCH identity WITHIN the run,
   * for the consent-ledger replay guard. `runId` alone is not a dispatch
   * identity on two lanes: a conversation is ONE run resolved per TURN, and a
   * chain can hold several agent nodes — deduping the ADR 0044 §5 audit row
   * on bare `runId` suppressed every genuine recall after the first (the
   * ledger undercounted BY DESIGN on the primary lane). Semantics: stable
   * across a re-execution of the SAME dispatch (crash-resume replay of a node,
   * a retried exchange recomputing the same turn index), different across
   * genuinely distinct dispatches under one run. Suppliers: chat passes
   * `turn:<turnIndex>`, the run lane passes `node:<nodeId>`; the ad-hoc route
   * omits it (its runId is minted per dispatch, so runId IS the dispatch
   * identity there). Absent ⇒ the guard dedupes on runId alone.
   */
  dispatchId?: string;
}

/**
 * RCL-6 / WF-RCL-5 — the resolved borrowed source: the retriever PLUS the
 * owner's identity, so the composition sites can put a labeled, owner-NAMING
 * preamble inside the untrusted fence ("recalled from <owner>'s shared
 * memory"). The owner's name is already consented disclosure — the link UI
 * names them — and post-ADR 0589 §D2 the acting caller IS the owner, so the
 * label is first-party attribution, not a leak. Widened from a bare
 * `AgentKnowledgeRetrieve` (which left borrowed chunks indistinguishable from
 * any other fenced content, to the model and to every reader).
 */
export interface BorrowedRecallSource {
  /** The retriever over the owner's granted corpus. Always forward the
   *  `onSourceError` sink (WF-TWIN-2 — do not re-narrow the arity). */
  retrieve: AgentKnowledgeRetrieve;
  /** The owner's stable `User.userId`. */
  ownerUserId: string;
  /** The owner's display name, when the user row carries one. Compositions
   *  fall back to a generic second-person label when absent. */
  ownerName?: string;
}

/** Resolve a granted twin agent's BORROWED source over its owner's corpus, or
 *  `undefined` when not toggled-on / not linked / not granted / the caller is not
 *  the owner. */
export type BorrowedRecallResolver = (
  tenantId: string,
  agentId: string,
  ctx?: BorrowedRecallContext,
) => Promise<BorrowedRecallSource | undefined>;

let _resolver: BorrowedRecallResolver | null = null;

/** Install the resolver (the `twin` feature, at boot). `null` clears it. */
export function setBorrowedRecallResolver(resolver: BorrowedRecallResolver | null): void {
  _resolver = resolver;
}

/** The installed resolver, or `null` when the twin feature isn't composed. */
export function getBorrowedRecallResolver(): BorrowedRecallResolver | null {
  return _resolver;
}
