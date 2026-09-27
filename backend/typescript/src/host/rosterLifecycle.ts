/**
 * Roster-lifecycle seam (ADR 0288) — the hook by which FEATURE-owned surfaces
 * react when a standing roster member is deleted, without the host cascade
 * importing features (core never imports features). Completes the lifecycle-seam
 * family (`commerce/productLifecycleSeam.ts`, `host/crmRecordLifecycle.ts` ADR
 * 0283, `host/connectionLifecycle.ts` ADR 0285) — identical contract: KEYED
 * registration (repeat boots overwrite), idempotent bounded handlers,
 * best-effort fan-out that never throws, FIRED AT THE END of the host cascade
 * (`rosterCascade.ts` keeps its hand-rolled host-internal cleanups — this seam
 * exists only for feature-owned refs the cascade cannot reach).
 *
 * Disposition taxonomy (per the ADR): AUTHORED CONFIGS bound to the agent are
 * DISABLED (scheduled chats, public widgets — visible breakage, re-assignable);
 * LIVE MEMBERSHIP is PRUNED (advisory boards); HISTORICAL PROVENANCE (evals
 * rows, proposals, ambient suggestions, comment authorship) is TOLERATED ON
 * READ — recorded in the ADR, not cleaned.
 */
export interface RosterMemberDeletedEvent {
  tenantId: string;
  /** The standing-member id (`host:<slug>-<hex>`). Advisory membership keys on it. */
  rosterId: string;
  /** The member's chat-callable inventory agent id (`user.<tenant>.<slug>`), when it
   *  had one. Configs may store EITHER id form — consumers should match both. */
  agentId?: string;
}

type RosterMemberDeletedHandler = (e: RosterMemberDeletedEvent) => Promise<void>;

const handlers = new Map<string, RosterMemberDeletedHandler>();

/** A consumer feature registers (idempotently, keyed) its cleanup at boot. */
export function onRosterMemberDeleted(key: string, fn: RosterMemberDeletedHandler): void {
  handlers.set(key, fn);
}

/** Called by `deleteRosterMemberCascade` AFTER the host-internal cascade; runs
 *  every registrant best-effort. Never throws. Returns how many handlers ran. */
export async function fireRosterMemberDeleted(e: RosterMemberDeletedEvent): Promise<number> {
  let ran = 0;
  for (const h of handlers.values()) {
    try { await h(e); ran += 1; } catch { /* a consumer's cleanup failure must not block the delete */ }
  }
  return ran;
}

/** Test-only: drop all registrations so suites don't leak handlers across files. */
export function __resetRosterLifecycleHooks(): void {
  handlers.clear();
}
