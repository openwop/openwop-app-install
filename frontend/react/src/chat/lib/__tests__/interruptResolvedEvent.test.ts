import { describe, expect, it } from 'vitest';

import { isInterruptResolvedEvent } from '../interruptResolvedEvent';

/**
 * ADR 0688. Five call sites matched this by hand and all five matched the SAME
 * single spelling, so the two things this predicate fixes were invisible in
 * every one of them.
 */
describe('isInterruptResolvedEvent', () => {
  it('matches the CODEMAP type — which is what a rejection has always been', () => {
    // The bigger half of the bug, and it predates the vendor rename. The reject
    // path in `routes/interrupts.ts` has emitted `interrupt.resolved` all
    // along, and NO SPA matcher named it — so every rejected interrupt was
    // invisible: the analytics panel counted accepts and called the number
    // "interrupts resolved", the run detail page never refreshed on one, and
    // the builder left the node showing suspended.
    expect(isInterruptResolvedEvent('interrupt.resolved')).toBe(true);
  });

  it('matches both legacy spellings, so old rows do not vanish from a run', () => {
    // ADR 0682 renamed the writer without touching these matchers, which
    // retroactively emptied panels of the ~17 rows written before it. A run's
    // event list is history; dropping a spelling from a matcher is a silent
    // deletion from every view built on it.
    expect(isInterruptResolvedEvent('openwop-app.node.interrupt-resolved')).toBe(true);
    expect(isInterruptResolvedEvent('node.interrupt.resolved')).toBe(true);
  });

  it('matches nothing else', () => {
    // Non-vacuity in the dangerous direction: a predicate returning true for
    // everything satisfies both legs above while marking every node resolved.
    for (const t of ['interrupt.requested', 'node.suspended', 'run.completed', 'interrupt.resolve', '', undefined]) {
      expect(isInterruptResolvedEvent(t), `${String(t)} must not read as a resolution`).toBe(false);
    }
  });
});
