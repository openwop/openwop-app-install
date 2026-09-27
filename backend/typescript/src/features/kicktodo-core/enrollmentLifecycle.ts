/**
 * Enrollment-lifecycle seam (ADR 0458 Phase 0) — the hook by which OTHER KickTodo
 * packages react when kicktodo-core deletes an enrollment row, WITHOUT core importing
 * them (core never imports features). Same house contract as the roster / CRM-record /
 * connection / product lifecycle seams (`host/rosterLifecycle.ts` et al.): KEYED
 * registration (a repeat boot overwrites the same key rather than stacking), idempotent
 * bounded handlers, best-effort fan-out that NEVER throws, FIRED AFTER the enrollment
 * row is gone.
 *
 * Motivation: enrollment-keyed rows owned by other packages (e.g. kicktodo-integrations'
 * wearable rules) resolve their subject via `listEnrollmentsFor` — if a subject-erasure
 * deletes the enrollment first (eraser fan-out order is unguaranteed), those rows would
 * orphan with no subject to resolve them by. This seam lets the owning package prune on
 * the delete signal instead of racing the eraser. Consumers subscribe in a follow-up;
 * core fires the event and wires nothing here.
 */

export interface EnrollmentDeletedEvent {
  tenantId: string;
  /** The deleted enrollment's id (`enr:<hex>`). Enrollment-keyed rows key on it. */
  enrollmentId: string;
}

type EnrollmentDeletedHandler = (e: EnrollmentDeletedEvent) => Promise<void>;

const handlers = new Map<string, EnrollmentDeletedHandler>();

/** A consumer package registers (idempotently, keyed) its cleanup at boot. */
export function onEnrollmentDeleted(key: string, fn: EnrollmentDeletedHandler): void {
  handlers.set(key, fn);
}

/** Fired by every path that deletes an enrollment row, AFTER the row is gone. Runs
 *  each registrant best-effort — a consumer's cleanup failure must never block the
 *  deletion. Never throws. Returns how many handlers ran. */
export async function fireEnrollmentDeleted(e: EnrollmentDeletedEvent): Promise<number> {
  if (!e.tenantId || !e.enrollmentId) return 0;
  let ran = 0;
  for (const h of handlers.values()) {
    try { await h(e); ran += 1; } catch { /* a consumer's cleanup failure must not block the delete */ }
  }
  return ran;
}

/** Test-only: drop all registrations so suites don't leak handlers across files. */
export function __resetEnrollmentLifecycleHooks(): void {
  handlers.clear();
}
