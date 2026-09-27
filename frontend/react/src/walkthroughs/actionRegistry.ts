/**
 * Walkthrough action registry (ADR 0368 — the chassis seam).
 *
 * Workflow tour payloads never carry CSS selectors: they reference SEMANTIC
 * action ids ('campaign-studio.new-brief.click') that features register here,
 * alongside the component they target — so a UI refactor moves the
 * registration with the component, and a conventions test can pin that every
 * actionId a shipped tour references exists.
 *
 * The registry drives BOTH halves of the player: spotlight geometry
 * (`resolve()` → the live element) and execution (`verb` or the custom
 * `perform`). HITL actions additionally declare `hitlComplete` — how the
 * player knows the real user finished (e.g. the file input fired) — because
 * scripted resolution is forbidden for them by design.
 */

export type WalkthroughVerb = 'click' | 'fill' | 'select' | 'focus';

export interface WalkthroughAction {
  /** Route the player must be on (navigate first when elsewhere). Supports
   *  `:params` only insofar as the tour supplies them via prefill.route. */
  route: string;
  /** The live target element (called after route settle; null ⇒ not ready —
   *  the player retries briefly, then pauses the tour honestly). */
  resolve(): HTMLElement | null;
  /** What the player does for a scripted step. Ignored for HITL steps. */
  verb: WalkthroughVerb;
  /** Optional custom executor (drag, multi-part gestures). Overrides `verb`. */
  perform?(el: HTMLElement, prefill?: Record<string, unknown>): Promise<void> | void;
  /** HITL only: subscribe to "the user did it"; call `done` with a summary
   *  value (NEVER file contents). Returns the unsubscribe, or NULL when it
   *  could not attach (companion element missing) — the chrome then falls
   *  back to the manual "I did it" button. */
  hitlComplete?(el: HTMLElement, done: (value: unknown) => void): (() => void) | null;
}

/**
 * ADR 0489 D1 — a checkpoint verdict is THREE-valued, not two:
 *  - `null`                        → PASS: the step's expected state holds because the
 *                                    walkthrough just produced it. Resolve and continue.
 *  - `string`                      → FAIL: divergence detail. The player cancels the run
 *                                    (honest in run history) — unchanged behaviour.
 *  - `{ satisfied, because }`      → ALREADY SATISFIED: the state this step would produce
 *                                    ALREADY held before we got here. Resolve as done +
 *                                    SKIPPED, narrate `because`, and NEVER cancel.
 *
 * The `null | string` arms are the pre-0489 contract verbatim, so every existing
 * checkpoint keeps working untouched (regression-pinned in actionRegistry.test.ts).
 */
export interface CheckpointSatisfied {
  satisfied: true;
  /** Learner-facing reason, e.g. "You already connected a provider." Narrated aloud. */
  because: string;
}
export type CheckpointVerdict = null | string | CheckpointSatisfied;

export interface WalkthroughCheckpoint {
  /** Evaluate expected app state. See `CheckpointVerdict` for the three arms. */
  evaluate(): Promise<CheckpointVerdict> | CheckpointVerdict;
}

/**
 * FAIL-CLOSED narrowing (ADR 0489 D1). A checkpoint is app-authored code; a
 * malformed return MUST NOT be read as "already satisfied" — silently skipping a
 * step on garbage is exactly the dishonesty this engine exists to avoid. Anything
 * that is not `null`, a non-empty string, or a well-formed `{satisfied:true,
 * because:<non-empty string>}` is treated as a FAILURE with an explicit detail.
 */
export function narrowCheckpointVerdict(raw: unknown): CheckpointVerdict {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'string') return raw || 'checkpoint returned an empty failure detail';
  if (typeof raw === 'object' && (raw as CheckpointSatisfied).satisfied === true) {
    const because = (raw as CheckpointSatisfied).because;
    return typeof because === 'string' && because.trim()
      ? { satisfied: true, because }
      : 'checkpoint reported already-satisfied without a reason';
  }
  return 'checkpoint returned an unrecognized verdict';
}

const actions = new Map<string, WalkthroughAction>();
const checkpoints = new Map<string, WalkthroughCheckpoint>();

export function registerWalkthroughAction(id: string, action: WalkthroughAction): void {
  actions.set(id, action);
}
export function getWalkthroughAction(id: string): WalkthroughAction | undefined {
  return actions.get(id);
}
export function registerWalkthroughCheckpoint(id: string, cp: WalkthroughCheckpoint): void {
  checkpoints.set(id, cp);
}
export function getWalkthroughCheckpoint(id: string): WalkthroughCheckpoint | undefined {
  return checkpoints.get(id);
}
/** For the conventions test: every actionId a shipped tour references must
 *  resolve here (and for the player's "this tour needs an update" state). */
export function listWalkthroughActionIds(): string[] {
  return [...actions.keys()];
}

/**
 * ADR 0368 Phase 6 (record-mode) — the ANTI-ROT reverse lookup: given a live
 * element the user interacted with on `route`, find the registered action
 * whose `resolve()` currently returns that element. The recorder speaks ONLY
 * in the actionId this returns; it NEVER reads a CSS selector. A null result
 * is a Tier-2 (unmatched) interaction — the recorder proposes a registration
 * stub for a human, it does not invent a runtime selector.
 */
export function findWalkthroughActionForElement(el: Element, route: string): string | null {
  for (const [id, action] of actions) {
    if (action.route !== route) continue;
    let resolved: HTMLElement | null = null;
    try { resolved = action.resolve(); } catch { resolved = null; }
    // Match the interacted element OR an ancestor the action targets (a click
    // often lands on an inner <span>; the registered target is the button).
    if (resolved && (resolved === el || resolved.contains(el))) return id;
  }
  return null;
}

/** Test-only. */
export function __resetWalkthroughRegistryForTests(): void {
  actions.clear();
  checkpoints.clear();
}
