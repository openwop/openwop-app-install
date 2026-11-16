/**
 * CC-ORCH-3 — interrupt kinds that wait on something other than a person: an
 * outside event (a parent waiting on its child runs, a webhook) or a timer.
 * They resume on their own, so no surface may say "awaiting your input" for them,
 * render a developer placeholder, or offer buttons. One list, read by the chat
 * card registry, the run bubble, the progress panel and the interrupt renderer.
 */
export const SELF_RESUMING_INTERRUPT_KINDS: ReadonlySet<string> = new Set(['external-event', 'timer']);

/** True when a person must act for the run to continue. */
export function needsPersonInput(kind: string): boolean {
  return !SELF_RESUMING_INTERRUPT_KINDS.has(kind);
}
