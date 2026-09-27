/**
 * Canvas-lifecycle seam (ADR 0288 family / ADR 0334 DATA-1) — the hook by which
 * FEATURE-owned sidecars react when a canvas (`host.canvas` row) is deleted,
 * without the shared canvas-editor delete route importing features. Identical
 * contract to the other lifecycle seams (conversation/roster/connection/crm/
 * product): KEYED registration (repeat boots overwrite), idempotent bounded
 * handlers, best-effort fan-out that never throws, FIRED AFTER the canvas row is
 * gone. The event carries `canvasTypeId` so a consumer can gate (comments only
 * exist for `canvas.document`).
 *
 * @see host/conversationLifecycle.ts (the sibling this mirrors)
 * @see docs/adr/0334-canvas-document-rich-text-editor.md (DATA-1)
 */
export interface CanvasDeletedEvent {
  tenantId: string;
  canvasId: string;
  /** The deleted canvas's type (e.g. 'canvas.document') — lets a consumer gate. */
  canvasTypeId: string;
}

type CanvasDeletedHandler = (e: CanvasDeletedEvent) => Promise<void>;

const handlers = new Map<string, CanvasDeletedHandler>();

/** A consumer feature registers (idempotently, keyed) its cleanup at boot. */
export function onCanvasDeleted(key: string, fn: CanvasDeletedHandler): void {
  handlers.set(key, fn);
}

/** Called by the canvas-editor delete route AFTER the canvas row is gone; runs
 *  every registrant best-effort. Never throws (a consumer's cleanup failure must
 *  not block the delete). Returns how many ran. */
export async function fireCanvasDeleted(e: CanvasDeletedEvent): Promise<number> {
  let ran = 0;
  for (const h of handlers.values()) {
    try { await h(e); ran += 1; } catch { /* a consumer's cleanup failure must not block the delete */ }
  }
  return ran;
}

// ── State-write hooks (ADR 0359 Phase 6 / D6) ───────────────────────────────
// The seam by which the collaboration transport keeps host.canvas and the CRDT
// from becoming two silent authorities: EVERY external state write (editor CAS
// save, AI authoring, run write, version restore) flows through
// `updateCanvasForTenant`, which fires these. `before` MAY THROW to veto (the
// document-type 409 `room_live` while a room is live); `after` runs best-effort
// (apply-into-room for element types; CRDT-store invalidation when no room is
// live). Collab's own derive writes bypass via `source: 'collab'`.

export interface CanvasStateWriteEvent {
  tenantId: string;
  canvasId: string;
  canvasTypeId: string;
  /** The FULL post-merge state (after), or the raw mutation (before). */
  state: Record<string, unknown>;
}

export interface CanvasStateWriteHooks {
  /** MAY throw a typed OpenwopError to veto the write (fails the request). */
  before?: (e: CanvasStateWriteEvent) => Promise<void>;
  /** Best-effort, after the row committed — never fails the write. */
  after?: (e: CanvasStateWriteEvent) => Promise<void>;
}

const writeHooks = new Map<string, CanvasStateWriteHooks>();

/** Keyed (repeat boots overwrite), same contract as `onCanvasDeleted`. */
export function onCanvasStateWrite(key: string, hooks: CanvasStateWriteHooks): void {
  writeHooks.set(key, hooks);
}

/** Veto pass — a hook's throw PROPAGATES (that is the point). */
export async function fireBeforeCanvasStateWrite(e: CanvasStateWriteEvent): Promise<void> {
  for (const h of writeHooks.values()) if (h.before) await h.before(e);
}

/** Post-commit pass — best-effort; a consumer failure never fails the write. */
export async function fireAfterCanvasStateWrite(e: CanvasStateWriteEvent): Promise<void> {
  for (const h of writeHooks.values()) {
    if (!h.after) continue;
    try { await h.after(e); } catch { /* best-effort */ }
  }
}

/** Test-only: drop all registrations so suites don't leak handlers across files. */
export function __resetCanvasLifecycleHooks(): void {
  handlers.clear();
  writeHooks.clear();
}
