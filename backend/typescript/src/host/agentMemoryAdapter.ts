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

import { agentStorageId } from '../executor/agentIdAliases.js';
import { subjectMemoryScope, createSubjectMemoryPort, countSubjectMemoryByTag } from './subjectMemory.js';
import { personSubject, orgSubject } from './subject.js';
import type { AgentProfile } from '../types.js';
import { createLogger } from '../observability/logger.js';
import { memorySentinelScope } from './memoryScopeSentinel.js';

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
  // ADR 0763 — one namespace per agent across both spellings of its id.
  return subjectMemoryScope({ kind: 'agent', id: agentStorageId(agentId) });
}

/**
 * What a lane knows about WHO and WHICH CLIENT a dispatch is for (ADR 0944 D2).
 * `userId` is the acting participant (ADR 0442 P3, the shape every existing
 * caller already passes). `client` is the run's or conversation's host-written
 * client binding, resolved by the lane BEFORE it calls in (`host/runClientOrg.ts`
 * on the run lane): `{orgId}` once the person behind it holds scope on that org,
 * `{refused}` when the binding exists but could not be honoured. Absent ⇒ the
 * dispatch is for no client. Never taken from tool or node arguments.
 */
export interface AgentMemoryScopeContext {
  userId?: string | undefined;
  client?: { orgId: string } | { refused: ClientMemoryRefusal } | undefined;
}

/** Why a client binding could not be honoured. */
export type ClientMemoryRefusal = 'wrong_client' | 'forbidden' | 'unreadable';

/** The resolved memory binding for one dispatch (ADR 0944 D3). */
export interface AgentMemoryResolution {
  /** The namespace recall reads (and, when `writable`, the turn summary writes). */
  scope: string;
  /** `false` for every fail-closed sentinel — no writer may ever target one. */
  writable: boolean;
  /** Set when the scope is a sentinel the MODEL should be told about (a client
   *  run whose client memory could not be read). Absent for the silent per-user
   *  sentinel, whose behaviour predates ADR 0944 and is unchanged. */
  unavailable?: 'client-memory';
}

export { isSentinelMemoryScope } from './memoryScopeSentinel.js';

const WARNED_NO_ORG = new Set<string>();
function warnNoOrgOnce(profileId: string, reason: string): void {
  const key = `${profileId}:${reason}`;
  if (WARNED_NO_ORG.has(key)) return;
  if (WARNED_NO_ORG.size >= WARNED_CAP) WARNED_NO_ORG.clear();
  WARNED_NO_ORG.add(key);
  log.warn('agent_memory_client_unavailable', {
    profileId, reason,
    detail: 'client memory resolved to the fail-closed sentinel; recall is EMPTY, never the shared agent scope. Logged ONCE per profile and reason per process.',
  });
}

/**
 * ADR 0442 P3 + ADR 0944 D1/D3 — the ONE decision point for "which memory scope
 * does this agent recall from (and write to) this turn", on EVERY lane: chat,
 * run, ad-hoc dispatch and the retrieve preview. GENERIC (David's law): it keys
 * off the profile's host-local `memoryScope` and the lane's client binding,
 * never an agent id.
 *
 *  1. A dispatch FOR A CLIENT (`ctx.client` present) uses that client's shared
 *     `org:<orgId>` scope, whatever the profile says (ADR 0944 Q6, decided by the
 *     P0 architect review): a client run must never write client A's facts into
 *     a scope a client-B run reads, and an `agent`- or `per-user`-scoped agent
 *     would. A refused binding is the `:no-org` sentinel — NEVER a fallback.
 *  2. No client + `'per-org'` → the `:no-org` sentinel (the agent only has
 *     memory inside a client's work).
 *  3. No client + `'per-user'` → the acting participant's own `user:<id>` scope
 *     (ADR 0442 F1: a standing agent shared across a cohort tenant never recalls
 *     another participant's memory). The participant OWNS that scope and outlives
 *     the agent, so roster teardown correctly leaves it alone. With no actor, the
 *     silent `:no-actor` sentinel — never the shared scope, which would re-open F1.
 *  4. Otherwise the shared `agent:<profileId>` scope (byte-identical to before).
 */
export function resolveAgentMemory(
  profile: Pick<AgentProfile, 'profileId' | 'memoryScope'>,
  ctx?: AgentMemoryScopeContext | undefined,
): AgentMemoryResolution {
  const client = ctx?.client;
  if (client) {
    if ('orgId' in client && client.orgId) return { scope: subjectMemoryScope(orgSubject(client.orgId)), writable: true };
    warnNoOrgOnce(profile.profileId, 'refused' in client ? client.refused : 'empty-org');
    return { scope: memorySentinelScope(agentMemoryScope(profile.profileId), 'no-org'), writable: false, unavailable: 'client-memory' };
  }
  if (profile.memoryScope === 'per-org') {
    warnNoOrgOnce(profile.profileId, 'no-client');
    return { scope: memorySentinelScope(agentMemoryScope(profile.profileId), 'no-org'), writable: false, unavailable: 'client-memory' };
  }
  if (profile.memoryScope === 'per-user') {
    if (ctx?.userId) return { scope: subjectMemoryScope(personSubject(ctx.userId)), writable: true };
    // Fail-closed: agent-unique, deterministic, and NEVER written to (no writer
    // forms this scope) — so recall is empty rather than leaking the shared scope.
    //
    // AGMEM-12 (ADR 0587) — the sentinel is CORRECT and was SILENT. An agent
    // misconfigured to `per-user` in an actor-less lane recalls empty FOREVER with
    // no signal at all, and an empty recall is indistinguishable from an agent
    // with nothing stored. ONCE per profile per process (review finding F7).
    warnPerUserNoActorOnce(profile.profileId);
    return { scope: memorySentinelScope(agentMemoryScope(profile.profileId), 'no-actor'), writable: false };
  }
  return { scope: agentMemoryScope(profile.profileId), writable: true };
}

/** The scope half of `resolveAgentMemory` — for read-only callers. */
export function resolveAgentMemoryScope(
  profile: Pick<AgentProfile, 'profileId' | 'memoryScope'>,
  ctx?: AgentMemoryScopeContext | undefined,
): string {
  return resolveAgentMemory(profile, ctx).scope;
}

/** Build an `AgentMemoryPort` bound to one tenant (the dispatch read/write port). */
export const createAgentMemoryPort = createSubjectMemoryPort;

/** Count entries in a scope carrying `tag` (tenant-scoped, tag-aware). */
export async function countAgentMemoryByTag(tenantId: string, scope: string, tag: string): Promise<number> {
  return countSubjectMemoryByTag(tenantId, scope, tag);
}
