/**
 * Chat return-handoff seam (ADR 0334 5b-2).
 *
 * Lets a surface that deep-linked INTO the chat (e.g. the document editor's
 * "Improve with AI") offer to hand the chosen assistant response BACK to itself.
 * Because the launcher navigated away and is now unmounted, the handoff is
 * SERIALIZABLE DATA, not a live callback: the launcher stages a return-target
 * (where to go back + what range to act on); the chat, while a target is staged,
 * shows a generic "Apply" affordance on assistant messages that stashes the
 * chosen text as a one-shot pending-apply and navigates back; the launcher
 * consumes the pending-apply on mount.
 *
 * Leaf module — no React, no imports into chat/ or any feature — so both the chat
 * and any launching feature depend on it without a cycle (the 3b-3
 * commandContributions precedent). The chat stays generic: it never imports the
 * document editor; it only knows "there is a return-target with a label + path".
 */

export interface ReturnTarget {
  /** Human label for the affordance, e.g. the document title. */
  label: string;
  /** Route to navigate back to (the launcher's own path). */
  returnPath: string;
  /** Opaque payload the launcher needs to act (canvasId + the range to replace). */
  canvasId: string;
  from: number;
  to: number;
}

export interface PendingApply {
  canvasId: string;
  from: number;
  to: number;
  /** The assistant text the user chose to apply. */
  text: string;
}

let target: ReturnTarget | null = null;
let pending: PendingApply | null = null;
const listeners = new Set<() => void>();

function notify(): void { listeners.forEach((l) => l()); }

/** Stage a return-target (launcher, before navigating into the chat). */
export function stageReturnTarget(t: ReturnTarget): void { target = t; notify(); }

/** getSnapshot for useSyncExternalStore — stable reference until it changes. */
export function getReturnTarget(): ReturnTarget | null { return target; }

/** Clear the staged target (e.g. after applying, or on cancel). */
export function clearReturnTarget(): void { if (target) { target = null; notify(); } }

export function subscribeReturnTarget(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Stash the chosen text as a one-shot pending-apply (chat, on "Apply"). */
export function stagePendingApply(p: PendingApply): void { pending = p; }

/** Consume the pending-apply once (launcher, on mount). */
export function takePendingApply(): PendingApply | null { const p = pending; pending = null; return p; }

/** Test-only reset. */
export function __resetReturnTarget(): void { target = null; pending = null; listeners.clear(); }
