/**
 * ADV-UX-4 + L3 — the halt disclosure names the RIGHT surface and a REAL exit.
 *
 * `useBoardroomCadence.start(turns, config, question, handle = '')` is driven by
 * two callers: the board `@@<handle>` summon passes the handle, and
 * `runProjectConvene` calls it with THREE arguments. So a failed project-team
 * convene emitted the boardroom sentence with an empty handle — *"The boardroom
 * stopped … re-summon @@ to run it again"* — which names the wrong surface and a
 * dangling token. That is exactly the half-disclosure ADV-UX-4's own stated
 * principle forbids ("a disclosure naming no exit is half a disclosure").
 */
import { describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useBoardroomCadence } from '../useBoardroomCadence.js';
import type { BoardroomTurn } from '../boardroomCadence.js';
import type { BYOKActiveConfig } from '../../../byok/lib/useBYOKConfig.js';

const CONFIG = { provider: 'mock', model: 'mock-1', credentialRef: 'managed:test' } as unknown as BYOKActiveConfig;
const personaOf = (agentId: string): string => `Persona ${agentId}`;
const turn = (agentId: string): BoardroomTurn => ({ agentId, kind: 'advisor', round: 0 });

function setup() {
  const send = vi.fn().mockResolvedValue(undefined);
  const emitSystem = vi.fn();
  const hook = renderHook(
    ({ isSending, errored }: { isSending: boolean; errored: boolean }) =>
      useBoardroomCadence({ isSending, errored, send, personaOf, emitSystem }),
    { initialProps: { isSending: false, errored: false } },
  );
  const fail = (): void => {
    hook.rerender({ isSending: true, errored: false });
    hook.rerender({ isSending: false, errored: true });
  };
  return { hook, emitSystem, fail };
}

describe('L3 — the halt message matches the surface that halted', () => {
  it('a BOARD convene names the boardroom and the board’s own @@handle', () => {
    const { hook, emitSystem, fail } = setup();
    act(() => hook.result.current.start([turn('a'), turn('b')], CONFIG, 'q', 'titans'));
    fail();
    const said = emitSystem.mock.calls[0]?.[0] as string;
    expect(said).toContain('boardroom');
    expect(said).toContain('@@titans');
  });

  it('a PROJECT convene names the project team and a bare @@ — never "boardroom"', () => {
    const { hook, emitSystem, fail } = setup();
    // Exactly how `runProjectConvene` calls it: three arguments, no handle.
    act(() => hook.result.current.start([turn('a'), turn('b')], CONFIG, 'q'));
    fail();
    const said = emitSystem.mock.calls[0]?.[0] as string;
    expect(said, 'a project convene must not claim the boardroom stopped').not.toContain('boardroom');
    expect(said).toContain('project team');
    // The exit is real: `buildProjectConveneInterceptor` matches /^@@(\s|$)/, so
    // a bare `@@` genuinely re-runs this lane.
    expect(said).toContain('@@');
    // …and it must not trail a dangling handle placeholder.
    expect(said).not.toMatch(/@@\w/);
  });
});

/**
 * ADR 0608 D7 (`CPWF-2`) — UNMOUNT is a halt too, and it was silent.
 *
 * The disclosure fired only on the `errored` path (`useBoardroomCadence.ts:110-124`),
 * so a route change / session switch / closing the tab-deck panel mid-cadence
 * dropped the remaining cohort AND the synthesis with nothing said. Same defect the
 * `errored` arm exists to prevent, reached through a different door.
 */
describe('CPWF-2 — a cadence abandoned by UNMOUNT discloses what was lost', () => {
  it('unmounting mid-queue emits the halt line naming the remaining advisors', () => {
    const { hook, emitSystem } = setup();
    act(() => hook.result.current.start([turn('a'), turn('b'), turn('c')], CONFIG, 'q'));
    expect(emitSystem).not.toHaveBeenCalled(); // nothing said yet — the control
    hook.unmount();
    expect(emitSystem).toHaveBeenCalledTimes(1);
    const said = emitSystem.mock.calls[0]?.[0] as string;
    expect(said).toContain('project team');
    expect(said).toContain('3');
  });

  it('unmounting with an EMPTY queue says nothing — a completed cadence must not claim a halt', () => {
    // The positive control that stops the fix from becoming its own defect: a
    // disclosure that fires on every teardown is noise, and would announce a halt
    // to every user who finished a convene and navigated away.
    const { hook, emitSystem } = setup();
    hook.unmount();
    expect(emitSystem).not.toHaveBeenCalled();
  });
});
