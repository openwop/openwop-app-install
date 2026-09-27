/**
 * Per-agent memory adapter — back-compat shim (ADR 0041).
 *
 * The memory port + namespace now live in `host/subjectMemory.ts`, the single
 * owner that serves BOTH agents (`agent:<id>`) and humans (`user:<id>`). This
 * module re-exports the agent specialization so every pre-existing importer
 * (dispatch, the `agent-knowledge` feature, the advisory board, agent routes)
 * keeps the same symbols with IDENTICAL behavior — the no-fork guarantee.
 *
 * Originally A4/A5 (RFC 0004 + RAG); see `subjectMemory.ts` for the contract.
 *
 * @see docs/adr/0041-subject-memory.md
 * @see docs/adr/0038-per-agent-knowledge-memory.md
 */

import { subjectMemoryScope, createSubjectMemoryPort, countSubjectMemoryByTag } from './subjectMemory.js';
import { personSubject } from './subject.js';
import type { AgentProfile } from '../types.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.agentMemoryAdapter');

/**
 * AGMEM-12 warn dedupe (review finding F7).
 *
 * The sentinel warn below fires from `resolveAgentMemoryScope`, which is called
 * PER RETRIEVE (`agentKnowledgeComposition.ts:199`). A misconfigured `per-user`
 * agent on an actor-less lane therefore emits one line per retrieve, forever, all
 * of them carrying identical content — which buries the signal it was added to
 * provide and costs money in a log sink. The condition it reports is a
 * CONFIGURATION fact about a profile, not an event: it is either true for that
 * profile or it is not, so once is the honest cardinality.
 *
 * Keyed by `profileId`, not by tenant, deliberately: the misconfiguration lives on
 * the profile. Bounded so a long-lived instance cycling through many profiles
 * cannot grow this without limit — at the cap the set is cleared rather than
 * evicted one entry at a time, which trades a rare repeat warn (the correct
 * failure direction for a diagnostic) for a hard memory ceiling.
 */
const WARNED_PER_USER_NO_ACTOR = new Set<string>();
const WARNED_CAP = 1000;
function warnPerUserNoActorOnce(profileId: string): void {
  if (WARNED_PER_USER_NO_ACTOR.has(profileId)) return;
  if (WARNED_PER_USER_NO_ACTOR.size >= WARNED_CAP) WARNED_PER_USER_NO_ACTOR.clear();
  WARNED_PER_USER_NO_ACTOR.add(profileId);
  log.warn('agent_memory_per_user_no_actor', {
    profileId,
    detail:
      'per-user agent resolved with no acting participant; recall will be EMPTY (fail-closed sentinel), not the shared agent scope. Logged ONCE per profile per process — the condition is a profile misconfiguration, not a per-retrieve event.',
  });
}

/** TEST SEAM — reset the once-per-profile warn dedupe so a test can assert the
 *  warn fires, and assert that a SECOND call does not. Never called in prod. */
export function __resetPerUserNoActorWarnDedupe(): void {
  WARNED_PER_USER_NO_ACTOR.clear();
}

/** Stable per-agent memory namespace within a tenant — `agent:<id>`, the agent
 *  specialization of `subjectMemoryScope`. */
export function agentMemoryScope(agentId: string): string {
  return subjectMemoryScope({ kind: 'agent', id: agentId });
}

/**
 * ADR 0442 P3 — the ONE decision point for "which memory scope does this agent
 * recall from this turn." GENERIC (David's law): the choice keys off the
 * profile's host-local `memoryScope` field, never an agent id.
 *
 *  - default / `'agent'`  → the shared `agent:<profileId>` scope (every existing
 *    agent — byte-identical to the pre-P3 `agentMemoryScope(profileId)`).
 *  - `'per-user'` + actor → the acting participant's OWN `user:<id>` scope, so a
 *    standing agent shared across a cohort tenant recalls each participant's own
 *    memory and NEVER another user's (the F1 isolation invariant). The scope is
 *    the participant's namespace — which the participant OWNS and outlives the
 *    agent, so there is no agent-owned per-user scope to orphan on teardown
 *    (rosterCascade correctly leaves it alone).
 *  - `'per-user'` + NO actor → a fail-closed sentinel that no writer ever targets
 *    (so a read is always empty). It MUST NOT fall back to the shared
 *    `agent:<id>` scope — that would re-open F1 whenever the actor is missing.
 */
export function resolveAgentMemoryScope(
  profile: Pick<AgentProfile, 'profileId' | 'memoryScope'>,
  actor?: { userId?: string | undefined } | undefined,
): string {
  if (profile.memoryScope === 'per-user') {
    if (actor?.userId) return subjectMemoryScope(personSubject(actor.userId));
    // Fail-closed: agent-unique, deterministic, and NEVER written to (no writer
    // forms this scope) — so recall is empty rather than leaking the shared scope.
    //
    // AGMEM-12 (ADR 0587) — the sentinel is CORRECT and was SILENT. An agent
    // misconfigured to `per-user` in an actor-less lane (the REST retrieve preview
    // and the workflow-node path both call without an actor) recalls empty
    // FOREVER with no signal at all, and an empty recall is indistinguishable from
    // an agent with nothing stored. The behaviour is unchanged — only the silence.
    //
    // ONCE per profile per process (review finding F7): this runs per retrieve, and
    // an unbounded repeat of an identical line buries the very signal it adds. See
    // `warnPerUserNoActorOnce`.
    warnPerUserNoActorOnce(profile.profileId);
    return `${agentMemoryScope(profile.profileId)}:no-actor`;
  }
  return agentMemoryScope(profile.profileId);
}

/** Build an `AgentMemoryPort` bound to one tenant (the dispatch read/write port). */
export const createAgentMemoryPort = createSubjectMemoryPort;

/** Count entries in a scope carrying `tag` (tenant-scoped, tag-aware). */
export async function countAgentMemoryByTag(tenantId: string, scope: string, tag: string): Promise<number> {
  return countSubjectMemoryByTag(tenantId, scope, tag);
}
