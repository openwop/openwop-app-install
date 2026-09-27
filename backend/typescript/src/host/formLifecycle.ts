/**
 * Form-lifecycle seam (ADR 0404 grade-data WEB-2) — the dependency-safe hook by
 * which OTHER features clean up their SOFT references to a `FormDef` when it is
 * deleted, WITHOUT forms importing them (and without them importing forms' delete
 * path). The exact sibling of `crmRecordLifecycle.ts` (ADR 0283): forms owns the
 * delete, consumers register a keyed, best-effort cleanup at boot.
 *
 * Contract (identical to the CRM seam): registrations are KEYED so a repeated boot
 * (a feature's `registerRoutes` runs per test `createApp`) overwrites the same slot
 * instead of stacking — idempotent by construction. Handlers MUST be idempotent,
 * MUST bound their work (indexed/point reads — never a cross-tenant scan), and run
 * best-effort: `fireFormDeleted` swallows a handler's error so one registrant's
 * cleanup can neither block the delete nor another registrant's cleanup. Fired
 * AFTER the form row is deleted, so a mid-way handler failure fails CLOSED (the
 * parent is already unreachable; leftover soft refs remain re-prunable orphans).
 * Deletes happen on REST paths outside runs — nothing here touches `run.metadata`
 * or replay. Default = no handlers ⇒ the forms delete path is byte-identical when
 * nothing is wired.
 */

export interface FormDeletedEvent {
  tenantId: string;
  orgId: string;
  formId: string;
}

type FormDeletedHandler = (e: FormDeletedEvent) => Promise<void>;

const handlers = new Map<string, FormDeletedHandler>();

/** A consumer feature registers (idempotently, keyed) its per-form cleanup at boot. */
export function onFormDeleted(key: string, fn: FormDeletedHandler): void {
  handlers.set(key, fn);
}

/** Called by the forms delete path AFTER the row is gone; runs every registrant
 *  best-effort. Never throws. Returns how many handlers ran (observability). */
export async function fireFormDeleted(e: FormDeletedEvent): Promise<number> {
  let ran = 0;
  for (const h of handlers.values()) {
    try { await h(e); ran += 1; } catch { /* a registrant's cleanup failure must not block the delete */ }
  }
  return ran;
}

/** Test-only: drop all registrations so suites don't leak handlers across files. */
export function __resetFormLifecycleHooks(): void {
  handlers.clear();
}
