/**
 * ADR 0535 P1 — the global run-terminal seam (`onAnyRunTerminal`).
 *
 * `executor/runLifecycle.ts` is the SINGLE owner of "a run reached terminal".
 * P1 adds a global keyed subscription beside the existing per-run one, because
 * ADR 0535's consumer cannot know the runId in advance and must still react
 * when ANOTHER instance's sweeper terminally fails the run.
 *
 * What these assert, and why each would have caught a real regression:
 *  - keyed registration OVERWRITES (repeat boots must not accumulate handlers —
 *    the `host/*Lifecycle.ts` family contract; an accumulating map would fire a
 *    card restore N times after N boots);
 *  - a throwing/rejecting handler cannot fault the terminal path NOR suppress
 *    its siblings (the run's own terminal state must land regardless — ADR 0532
 *    ordering);
 *  - the terminal STATUS reaches the handler (ADR 0535 D4 restores on failure
 *    and deliberately does nothing on success; a handler that cannot tell them
 *    apart would auto-close completed work);
 *  - the per-run sync path still fires and still auto-unsubscribes (the
 *    rate-limit slot release depends on both).
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  onRunTerminal,
  onAnyRunTerminal,
  notifyRunTerminal,
  fireAnyRunTerminal,
  _resetRunLifecycle,
  type RunTerminalStatus,
} from '../src/executor/runLifecycle.js';

afterEach(() => _resetRunLifecycle());

describe('ADR 0535 P1 — global run-terminal seam', () => {
  it('keyed registration overwrites rather than accumulates across repeat boots', async () => {
    const calls: string[] = [];
    onAnyRunTerminal('kanban', () => { calls.push('first'); });
    onAnyRunTerminal('kanban', () => { calls.push('second'); });

    await fireAnyRunTerminal('run-1', 'failed');

    expect(calls, 'a re-registered key must REPLACE, not add — otherwise N boots fire N restores').toEqual(['second']);
  });

  it('distinct keys each fire once', async () => {
    const calls: string[] = [];
    onAnyRunTerminal('a', () => { calls.push('a'); });
    onAnyRunTerminal('b', () => { calls.push('b'); });

    const ran = await fireAnyRunTerminal('run-1', 'completed');

    expect(ran).toBe(2);
    expect(calls.sort()).toEqual(['a', 'b']);
  });

  it('carries the terminal status so a consumer can distinguish failure from success', async () => {
    const seen: Array<[string, RunTerminalStatus]> = [];
    onAnyRunTerminal('probe', (runId, status) => { seen.push([runId, status]); });

    await fireAnyRunTerminal('r-fail', 'failed');
    await fireAnyRunTerminal('r-ok', 'completed');
    await fireAnyRunTerminal('r-cancel', 'cancelled');

    expect(seen).toEqual([
      ['r-fail', 'failed'],
      ['r-ok', 'completed'],
      ['r-cancel', 'cancelled'],
    ]);
  });

  it('a throwing handler neither faults the fan-out nor suppresses its siblings', async () => {
    const survivors: string[] = [];
    onAnyRunTerminal('throws', () => { throw new Error('consumer bug'); });
    onAnyRunTerminal('rejects', () => Promise.reject(new Error('async consumer bug')));
    onAnyRunTerminal('healthy', () => { survivors.push('healthy'); });

    const ran = await fireAnyRunTerminal('run-1', 'failed');

    expect(survivors, 'one bad consumer must not stop the others').toEqual(['healthy']);
    expect(ran, 'only the handler that completed counts as run').toBe(1);
  });

  it('notifyRunTerminal never throws even when a global consumer does', () => {
    onAnyRunTerminal('throws', () => { throw new Error('consumer bug'); });

    // The run's own terminal state must land regardless — this is the ADR 0532
    // ordering rule applied to the seam: the sink must not endanger the event.
    expect(() => notifyRunTerminal('run-1', 'failed')).not.toThrow();
  });

  it('the per-run sync path still fires and still auto-unsubscribes', () => {
    let fired = 0;
    onRunTerminal('run-1', () => { fired += 1; });

    notifyRunTerminal('run-1', 'completed');
    expect(fired, 'the rate-limit slot release depends on this firing').toBe(1);

    notifyRunTerminal('run-1', 'completed');
    expect(fired, 'terminal is fire-once — a second announce must not re-fire').toBe(1);
  });

  it('a per-run listener that throws does not prevent the global fan-out', async () => {
    const globals: string[] = [];
    onRunTerminal('run-1', () => { throw new Error('sync listener bug'); });
    onAnyRunTerminal('kanban', (runId) => { globals.push(runId); });

    notifyRunTerminal('run-1', 'failed');
    // The global dispatch is fire-and-forget; drain the microtask queue.
    await new Promise((r) => setImmediate(r));

    expect(globals).toEqual(['run-1']);
  });
});
