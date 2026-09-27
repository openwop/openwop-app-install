/**
 * Does a run event say "an interrupt was resolved"?
 *
 * ONE predicate, because five call sites were matching this by hand and every
 * one of them matched the same single spelling (ADR 0688).
 *
 * **Three spellings, and each was written by a different decision.**
 *
 * | spelling | who writes it | why it is here |
 * | --- | --- | --- |
 * | `interrupt.resolved` | the host, today, both outcomes | the codemap type — the only one a v2 reader understands |
 * | `openwop-app.node.interrupt-resolved` | ADR 0682, one day | a vendor rename that should have been this |
 * | `node.interrupt.resolved` | the host, historically | the pre-ADR-0682 spelling; ~17 rows |
 *
 * The legacy two are read-only: nothing emits them any more. They stay because
 * a run's event list is history, and dropping a spelling from a matcher
 * retroactively empties panels that used to show something. ADR 0682 did
 * exactly that — it renamed the writer without touching these matchers, so the
 * older rows fell out of the run detail page, the analytics count and the
 * builder's node-status derivation on the day it merged.
 *
 * **What this ALSO fixes, which is the bigger half:** the reject path has
 * emitted the codemap `interrupt.resolved` all along, and no matcher named it.
 * So every REJECTED interrupt was invisible to the SPA — the analytics panel
 * counted accepts and called them "interrupts resolved", the run detail page
 * never refreshed on one, and the builder left the node showing suspended. That
 * predates ADR 0682; the split-by-outcome writer is what hid it.
 */
const INTERRUPT_RESOLVED_TYPES: ReadonlySet<string> = new Set([
  'interrupt.resolved',
  'openwop-app.node.interrupt-resolved',
  'node.interrupt.resolved',
]);

export function isInterruptResolvedEvent(type: string | undefined): boolean {
  return type !== undefined && INTERRUPT_RESOLVED_TYPES.has(type);
}
