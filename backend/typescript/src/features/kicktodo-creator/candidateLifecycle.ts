/**
 * Candidate-death lifecycle seam (ADR 0458 grade-pass I2/I4) — the hook by which
 * kicktodo-creator's OWN sidecar rows (the candidate's outline canvas + lesson-media
 * pointers/assets) are cleaned up when a candidate reaches its terminal `withdrawn`
 * state. Same house contract as the enrollment / roster / media-asset lifecycle seams
 * (`enrollmentLifecycle.ts`, `host/rosterLifecycle.ts`, `host/mediaAssetLifecycle.ts`):
 * KEYED registration (a repeat boot overwrites the same key rather than stacking),
 * idempotent bounded handlers, best-effort fan-out that NEVER throws, FIRED AFTER the
 * state flip is durably committed.
 *
 * Motivation: a candidate accretes rows OTHER stores own — a `challenge-outline` canvas
 * (host.canvas, incl. its version snapshots) and `kicktodo-lesson-media` pointers to
 * generated Media assets. The kill switch flips the candidate to `withdrawn` but left
 * those behind, orphaning canvases + media bytes with no candidate to reach them by.
 * This seam fires on the single withdraw owner (`__setCandidateWithdrawn`) so the
 * cleanup happens exactly once, on the real transition, without the state-flip owner
 * importing the media/canvas layers itself.
 */

export interface CandidateDeathEvent {
  tenantId: string;
  /** The withdrawn candidate's id. Sidecar rows key on `(tenant, candidate)`. */
  candidateId: string;
}

type CandidateDeathHandler = (e: CandidateDeathEvent) => Promise<void>;

const handlers = new Map<string, CandidateDeathHandler>();

/** A consumer registers (idempotently, keyed) its cleanup at boot. */
export function onCandidateDeath(key: string, fn: CandidateDeathHandler): void {
  handlers.set(key, fn);
}

/** Fired by the single withdraw owner AFTER the `withdrawn` flip commits. Runs each
 *  registrant best-effort — a consumer's cleanup failure must never block or reverse
 *  the kill. Never throws. Returns how many handlers ran. */
export async function fireCandidateDeath(e: CandidateDeathEvent): Promise<number> {
  if (!e.tenantId || !e.candidateId) return 0;
  let ran = 0;
  for (const h of handlers.values()) {
    try { await h(e); ran += 1; } catch { /* a consumer's cleanup failure must not block the kill */ }
  }
  return ran;
}

/** Test-only: drop all registrations so suites don't leak handlers across files. */
export function __resetCandidateLifecycleHooks(): void {
  handlers.clear();
}
