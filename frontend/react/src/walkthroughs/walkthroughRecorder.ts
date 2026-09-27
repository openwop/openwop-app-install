/**
 * Walkthrough recorder core (ADR 0368 Phase 6a) — record-mode capture.
 *
 * While recording, a global capture-phase listener maps each user interaction
 * to a SEMANTIC tour action id via the registry reverse-lookup
 * (`findWalkthroughActionForElement`) — never a CSS selector (the anti-rot boundary
 * from the research verdict). The output is a `WalkthroughRecording`: an ordered list
 * of steps that Phase 6b synthesizes into a transient `ui.tour.step` workflow.
 *
 * Boundaries baked in:
 *  - **NO input values are captured** (PII): a `fill`/`select` records only
 *    THAT it happened on action X, never what was typed/selected.
 *  - **Tier-2** (an interaction no registered action resolves) records a
 *    describe-only stub (role + trimmed text + nearest `data-walkthrough`) as a
 *    PROPOSAL for a human to turn into a registration — it is never a runtime
 *    selector, and a recording containing one yields a non-promotable draft
 *    (the player `needs-update`s on it → no successful run → OQ5 blocks
 *    promotion; the existing gate protects broken recorded tours).
 *  - **Mutual exclusion** with the player is enforced by the caller (the bus):
 *    the app cannot drive a tour and record one simultaneously.
 */

import { findWalkthroughActionForElement } from './actionRegistry.js';

export interface RecordedStep {
  /** Tier-1: the matched registry action id. Absent ⇒ Tier-2 (unmatched). */
  actionId?: string;
  /** The route the interaction happened on. */
  route: string;
  /** The verb, inferred from the DOM event (click / fill / select / focus). */
  verb: 'click' | 'fill' | 'select' | 'focus';
  /** Tier-2 only: a human-readable describe of the target for a registration
   *  stub proposal (role · trimmed text · nearest data-walkthrough). NEVER a value. */
  describe?: string;
}

export interface WalkthroughRecording {
  startedAt: string;
  steps: RecordedStep[];
}

type RecordingListener = (rec: WalkthroughRecording) => void;

let active: WalkthroughRecording | null = null;
let listener: RecordingListener | null = null;
const currentRoute = (): string => window.location.pathname;

function describeTarget(el: Element): string {
  const role = el.getAttribute('role') ?? el.tagName.toLowerCase();
  const dataWalkthrough = el.closest('[data-walkthrough]')?.getAttribute('data-walkthrough');
  const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
  return [role, dataWalkthrough ? `[data-walkthrough=${dataWalkthrough}]` : null, text || null].filter(Boolean).join(' · ');
}

function verbFor(el: Element, type: string): RecordedStep['verb'] {
  if (type === 'change' || type === 'input') {
    if (el instanceof HTMLSelectElement) return 'select';
    return 'fill';
  }
  return 'click';
}

function onInteraction(e: Event): void {
  if (!active) return;
  const el = e.target;
  if (!(el instanceof Element)) return;
  // Ignore the recorder's own chrome (marked data-walkthrough-recorder).
  if (el.closest('[data-walkthrough-recorder]')) return;
  const route = currentRoute();
  const actionId = findWalkthroughActionForElement(el, route);
  // Cut Tier-2 noise: an unmatched CLICK on a non-interactive element (bare
  // text/heading/layout) is almost never a tour step. Keep it only if it's an
  // interactive control or inside a data-walkthrough region (a real anchor a dev could
  // register). Matched (Tier-1) interactions are always kept.
  if (!actionId && e.type === 'click') {
    const interactive = el.closest('button, a, [role="button"], [role="tab"], [role="link"], [role="menuitem"], input, select, textarea, [data-walkthrough]');
    if (!interactive) return;
  }
  const verb = verbFor(el, e.type);
  const step: RecordedStep = actionId
    ? { actionId, route, verb }
    : { route, verb, describe: describeTarget(el) };
  // De-dupe an immediately-repeated identical step (focus→click on the same
  // target fires two events; keep the click).
  const last = active.steps[active.steps.length - 1];
  if (last && last.actionId === step.actionId && last.describe === step.describe && last.verb !== 'click' && step.verb === 'click') {
    active.steps[active.steps.length - 1] = step;
  } else if (!(last && last.actionId === step.actionId && last.describe === step.describe && last.route === step.route && last.verb === step.verb)) {
    active.steps.push(step);
  }
  listener?.({ ...active, steps: [...active.steps] });
}

const EVENTS: readonly string[] = ['click', 'change']; // NOT focusin — route-focus for a11y is noise, not a step

export function startRecording(onChange?: RecordingListener): void {
  if (active) return;
  active = { startedAt: new Date().toISOString(), steps: [] };
  listener = onChange ?? null;
  for (const ev of EVENTS) document.addEventListener(ev, onInteraction, true);
}

export function stopRecording(): WalkthroughRecording | null {
  if (!active) return null;
  for (const ev of EVENTS) document.removeEventListener(ev, onInteraction, true);
  const rec = active;
  active = null;
  listener = null;
  return rec;
}

export function isRecording(): boolean {
  return active !== null;
}

/**
 * ADR 0489 D4 — turn a Tier-2 (unmatched) step into a COPY-PASTEABLE
 * `registerWalkthroughAction` stub.
 *
 * The ratchet (D3) tells you a screen is uninstrumented; this tells you exactly
 * what to paste to fix it. Anchors are only "set and forget" infrastructure if
 * adding one is trivial — otherwise the debt just sits on the exemption list.
 *
 * Two shapes, because the fix differs:
 *  - the target already sits inside a `data-walkthrough` region ⇒ the stub
 *    resolves through THAT anchor and is complete as written;
 *  - it does not ⇒ the stub carries a TODO to add the anchor first, because a
 *    registration that resolves nothing is worse than none (the player would
 *    `needs-update` at runtime instead of failing in review).
 *
 * Never emits a CSS selector derived from live DOM — that is the anti-rot
 * boundary the recorder exists to hold.
 */
export function buildRegistrationStub(step: RecordedStep, index: number): string | null {
  if (step.actionId) return null; // Tier-1 — already registered
  const anchor = step.describe?.match(/\[data-walkthrough=([^\]]+)\]/)?.[1];
  const slug = (anchor ?? `todo-anchor-${index + 1}`).replace(/[^a-zA-Z0-9.-]/g, '-');
  const suggestedId = `${slug}.${step.verb}`;
  const lines = [
    `// Recorded step ${index + 1} on ${step.route} — ${step.describe ?? 'unknown target'}`,
  ];
  if (!anchor) {
    lines.push(
      `// TODO: add \`data-walkthrough="${slug}"\` to the target element FIRST —`,
      `//       a registration that resolves nothing pauses the walkthrough at runtime.`,
    );
  }
  lines.push(
    `registerWalkthroughAction('${suggestedId}', {`,
    `  route: '${step.route}',`,
    `  resolve: () => document.querySelector<HTMLElement>('[data-walkthrough="${slug}"]'),`,
    `  verb: '${step.verb}',`,
    `});`,
  );
  return lines.join('\n');
}

/** All stubs for a recording, in step order. Empty ⇒ every step was Tier-1. */
export function buildRegistrationStubs(rec: WalkthroughRecording): string[] {
  return rec.steps.map((s, i) => buildRegistrationStub(s, i)).filter((s): s is string => s !== null);
}

/** Test-only. */
export function __resetRecorderForTests(): void {
  if (active) for (const ev of EVENTS) document.removeEventListener(ev, onInteraction, true);
  active = null;
  listener = null;
}
