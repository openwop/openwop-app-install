/**
 * CS-GB-5 (conversation-stack audit) — cadence re-entrancy. The boardroom
 * cadence is self-clocking off the true→false edge of `isSending`; these
 * tests pin the race-prone legs: cancel mid-queue must not fire the stale
 * tail, a rapid restart must march ONLY the new queue, an errored turn stops
 * the cohort, and a held `isSending` never double-fires.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useBoardroomCadence } from '../useBoardroomCadence.js';
import type { BoardroomTurn } from '../boardroomCadence.js';
import type { BYOKActiveConfig } from '../../../byok/lib/useBYOKConfig.js';

const CONFIG = { provider: 'mock', model: 'mock-1', credentialRef: 'managed:test' } as unknown as BYOKActiveConfig;
const personaOf = (agentId: string) => `Persona ${agentId}`;
const turn = (agentId: string): BoardroomTurn => ({ agentId, kind: 'advisor', round: 0 });

function setup() {
  const send = vi.fn().mockResolvedValue(undefined);
  const hook = renderHook(
    ({ isSending, errored }: { isSending: boolean; errored: boolean }) =>
      useBoardroomCadence({ isSending, errored, send, personaOf }),
    { initialProps: { isSending: false, errored: false } },
  );
  /** Simulate one turn completing: isSending rises then falls. Bare
   *  rerenders (each is act-wrapped by testing-library) — wrapping BOTH in
   *  one act() would defer the intermediate passive effect and the hook
   *  would never observe the rising edge. */
  const edge = () => {
    hook.rerender({ isSending: true, errored: false });
    hook.rerender({ isSending: false, errored: false });
  };
  return { hook, send, edge };
}

describe('useBoardroomCadence — re-entrancy (CS-GB-5)', () => {
  it('cancel mid-queue: the stale tail never fires on the next idle edge', () => {
    const { hook, send, edge } = setup();
    act(() => hook.result.current.start([turn('a'), turn('b')], CONFIG, 'q'));
    edge(); // turn completion → dispatch advisor a
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[2]?.activeAgentId).toBe('a');
    act(() => hook.result.current.cancel());
    expect(hook.result.current.active).toBe(false);
    edge(); // a's own send settling — must NOT march advisor b
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('rapid restart replaces the queue: only the NEW cohort marches', () => {
    const { hook, send, edge } = setup();
    act(() => hook.result.current.start([turn('a'), turn('b')], CONFIG, 'q1'));
    // Restart with a different cohort BEFORE any edge fires.
    act(() => hook.result.current.start([turn('x'), turn('y')], CONFIG, 'q2'));
    edge();
    edge();
    edge(); // one extra idle edge — queue exhausted, must not re-fire
    const agents = send.mock.calls.map((c) => c[2]?.activeAgentId);
    expect(agents).toEqual(['x', 'y']);
    expect(hook.result.current.active).toBe(false);
  });

  it('a held isSending never double-fires (edge-triggered, not level-triggered)', () => {
    const { hook, send } = setup();
    act(() => hook.result.current.start([turn('a')], CONFIG, 'q'));
    hook.rerender({ isSending: true, errored: false });
    hook.rerender({ isSending: true, errored: false }); // stream still in flight
    expect(send).not.toHaveBeenCalled();
    hook.rerender({ isSending: false, errored: false });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('an errored turn stops the march (no burst-firing the rest of the cohort)', () => {
    const { hook, send } = setup();
    act(() => hook.result.current.start([turn('a'), turn('b')], CONFIG, 'q'));
    hook.rerender({ isSending: true, errored: false });
    hook.rerender({ isSending: false, errored: true }); // the turn failed
    expect(send).not.toHaveBeenCalled();
    expect(hook.result.current.active).toBe(false);
    // A later clean edge must not resurrect the cancelled queue.
    hook.rerender({ isSending: true, errored: false });
    hook.rerender({ isSending: false, errored: false });
    expect(send).not.toHaveBeenCalled();
  });

  it('start with an empty plan is a no-op (never activates)', () => {
    const { hook, edge, send } = setup();
    act(() => hook.result.current.start([], CONFIG, 'q'));
    expect(hook.result.current.active).toBe(false);
    edge();
    expect(send).not.toHaveBeenCalled();
  });
});
