/**
 * ADR 0368 P2 — the player loop with mocked transports: launch stamps
 * run.metadata.guidedTour; a tour-step suspension fetches the payload and
 * performs the registry action then resolves; HITL steps wait for the user;
 * an unknown actionId lands needs-update (no silent hang); a failed
 * checkpoint cancels the run.
 *
 * w51 r2 (/grade-tests) — fixtures made able to fail, and two double guards named:
 *  - position: the open step is s2 (index 1) — at s1 a constant index 0 passed;
 *  - WALK-9 in-flight: a SECOND walkthrough's started row sits first, and a
 *    terminal in-flight run must start fresh — one row could not show either;
 *  - hitlAuto TRUE is asserted when hitlComplete attaches;
 *  - confirmHitl's `status !== 'waiting-user'` guard is driven by confirming while
 *    PAUSED (after Stop, teardown nulls activeRef first — the two guards overlap);
 *  - DOUBLE GUARD: stop() during a retry is caught by resolveElement's own `live()`
 *    check AND by the `live()` re-check after it returns; deleting either alone
 *    stays green by design, so the probe targets the shared `live` predicate;
 *  - the interrupt_gone (410) arm is owned by stepFailureIsVisible case 4;
 *  - real-clock sleeps → fake timers / the settle signal.
 *
 * WALK-PAUSE-HITL-1 (historically pinned with it.fails, grade-code row): the WT-1 §Correction
 * at useWalkthroughPlayer.ts:258 calls `stash()` at the end of the HITL branch to
 * let pause → resume come back to the step — but `stash()` writes only when
 * `pausedRef.current` is ALREADY true, which it never is there. A real pause
 * during `waiting-user` (Escape / the scrim → `player.pause`) leaves `pendingRef`
 * null, `resume()` lands on 'starting', the "I did it" control (shown for
 * `waiting-user` && !hitlAuto) disappears, and `confirmHitl` early-returns: the
 * step is stranded. The original it.fails case asserted the CORRECT behaviour; fix-probe
 * `w51g2-walk-pause-hitl-fix-r2` (stash the open HITL step unconditionally) flips it.
 * Correction 2026-11-07 (ADR 0368): ordinary-mode evidence received `starting`
 * instead of `waiting-user`. Retain the current waiting continuation and clear
 * it on resolution/advance/teardown; the same body is now an ordinary regression.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';

const createRun = vi.fn();
const cancelRun = vi.fn().mockResolvedValue(undefined);
// ADR 0730 C.4 — the resume-in-flight branch reads the run snapshot through
// `getRun` (major 2, tenant-bound) instead of a raw `GET /v1/runs/{id}`. This
// mock previously declared only createRun/cancelRun, so the new import resolved
// to `undefined`, the call threw, and the branch fell through to a fresh start —
// which looked exactly like the WALK-9 defect the test exists to catch.
const getRun = vi.fn();
vi.mock('../../client/runsClient.js', () => ({
  createRun: (...a: unknown[]) => createRun(...a),
  cancelRun: (...a: unknown[]) => cancelRun(...a),
  getRun: (...a: unknown[]) => getRun(...a),
}));

let onEvent: ((ev: Record<string, unknown>) => void) | null = null;
vi.mock('../../client/streamsClient.js', () => ({
  subscribeToRun: (_runId: string, opts: { onEvent: (ev: Record<string, unknown>) => void }) => {
    onEvent = opts.onEvent;
    return { close: () => { onEvent = null; } };
  },
}));

const resolveByRun = vi.fn().mockResolvedValue({});
vi.mock('../../client/interruptsClient.js', () => ({ resolveByRun: (...a: unknown[]) => resolveByRun(...a) }));

const getWorkflowDefinition = vi.fn().mockResolvedValue(null); // best-effort default: no def
vi.mock('../../client/workflowsClient.js', () => ({ getWorkflowDefinition: (...a: unknown[]) => getWorkflowDefinition(...a) }));

import { WopError } from '@openwop/openwop';
import { useWalkthroughPlayer } from '../useWalkthroughPlayer.js';
import { registerWalkthroughAction, registerWalkthroughCheckpoint, __resetWalkthroughRegistryForTests } from '../actionRegistry.js';

const wrapper = ({ children }: { children: ReactNode }) => <MemoryRouter>{children}</MemoryRouter>;

/** Route-aware: the launch's progress read gets NO in-flight row (it used to get
 *  `{interrupts}`, so `progress.find` threw and the fresh start ran via the catch). */
function stubInterrupts(rows: Array<Record<string, unknown>>): void {
  vi.stubGlobal('fetch', vi.fn((url: string) => Promise.resolve({
    ok: true,
    json: async () => (String(url).includes('/walkthroughs/progress') ? { progress: [] } : { interrupts: rows }),
  })));
}

beforeEach(() => {
  __resetWalkthroughRegistryForTests();
  createRun.mockReset().mockResolvedValue({ runId: 'run-1' });
  getRun.mockReset();
  resolveByRun.mockReset().mockResolvedValue({});
  getWorkflowDefinition.mockReset().mockResolvedValue(null);
  cancelRun.mockClear();
  sessionStorage.clear();
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('useWalkthroughPlayer', () => {
  it('launch stamps guidedTour metadata; a scripted step performs the registry action and resolves', async () => {
    const btn = document.createElement('button');
    const clicked = vi.fn();
    btn.addEventListener('click', clicked);
    registerWalkthroughAction('demo.first.click', { route: '/', resolve: () => btn, verb: 'click' });
    stubInterrupts([{ nodeId: 's1', kind: 'tour-step', data: { actionId: 'demo.first.click', narration: 'Click it.', hitl: false } }]);

    const { result } = renderHook(() => useWalkthroughPlayer(), { wrapper });
    await act(async () => { await result.current.launch('tour-demo'); });
    expect(createRun).toHaveBeenCalledWith(expect.objectContaining({ workflowId: 'tour-demo', metadata: { guidedTour: true, walkthroughId: 'tour-demo' } }));

    await waitFor(() => expect(resolveByRun).toHaveBeenCalledWith('run-1', 's1', { acked: true, actionId: 'demo.first.click' }));
    expect(clicked).toHaveBeenCalled();
  });

  it('an HITL step waits for the user; the completion subscription resolves with the value', async () => {
    const input = document.createElement('input');
    let fire: ((v: unknown) => void) | null = null;
    registerWalkthroughAction('demo.upload.file', {
      route: '/', resolve: () => input, verb: 'click',
      hitlComplete: (_el, done) => { fire = done; return () => { fire = null; }; },
    });
    stubInterrupts([{ nodeId: 's2', kind: 'tour-step', data: { actionId: 'demo.upload.file', hitl: { prompt: 'Pick a file' } } }]);

    const { result } = renderHook(() => useWalkthroughPlayer(), { wrapper });
    await act(async () => { await result.current.launch('tour-hitl'); });
    await waitFor(() => expect(result.current.status).toBe('waiting-user'));
    expect(resolveByRun).not.toHaveBeenCalled();
    expect(result.current.hitlAuto).toBe(true); // attached ⇒ no "I did it" fallback

    await act(async () => { fire!({ mediaRef: 'media:x' }); });
    await waitFor(() => expect(resolveByRun).toHaveBeenCalledWith('run-1', 's2', { acked: true, hitlValue: { mediaRef: 'media:x' } }));
  });

  it('an unknown actionId lands needs-update (never a silent hang); run.completed completes', async () => {
    stubInterrupts([{ nodeId: 's3', kind: 'tour-step', data: { actionId: 'gone.action', hitl: false } }]);
    const { result } = renderHook(() => useWalkthroughPlayer(), { wrapper });
    await act(async () => { await result.current.launch('tour-stale'); });
    await waitFor(() => expect(result.current.status).toBe('needs-update'));
    expect(resolveByRun).not.toHaveBeenCalled();

    await act(async () => { onEvent!({ type: 'run.completed' }); });
    expect(result.current.status).toBe('completed');
  });

  it('tolerates an already-resolved interrupt (interrupt_not_found) — the step performs, no error banner', async () => {
    // The benign race: a duplicate/late resolve finds no open interrupt, so the
    // server answers interrupt_not_found (404). The player must treat that as
    // done, NOT surface the hard error the un-tolerated resolve used to throw.
    const btn = document.createElement('button');
    const clicked = vi.fn();
    btn.addEventListener('click', clicked);
    registerWalkthroughAction('demo.dup.click', { route: '/', resolve: () => btn, verb: 'click' });
    resolveByRun.mockRejectedValueOnce(new WopError(404, '', { error: 'interrupt_not_found', message: 'no open interrupt for this node' }, undefined));
    stubInterrupts([{ nodeId: 's1', kind: 'tour-step', data: { actionId: 'demo.dup.click', hitl: false } }]);

    const { result } = renderHook(() => useWalkthroughPlayer(), { wrapper });
    await act(async () => { await result.current.launch('tour-dup'); });
    await waitFor(() => expect(resolveByRun).toHaveBeenCalledWith('run-1', 's1', { acked: true, actionId: 'demo.dup.click' }));
    expect(clicked).toHaveBeenCalled();
    expect(result.current.status).not.toBe('needs-update');
    expect(result.current.error).toBeNull();

    // The run advances normally afterward — the benign 404 did not wedge it.
    await act(async () => { onEvent!({ type: 'run.completed' }); });
    expect(result.current.status).toBe('completed');
  });

  it('derives steps + position from the fetched def; def-fetch failure leaves them empty (ADR 0378 P2a)', async () => {
    const btn = document.createElement('button');
    registerWalkthroughAction('demo.pos.click', { route: '/', resolve: () => btn, verb: 'click' });
    registerWalkthroughAction('demo.pos.fill', { route: '/', resolve: () => document.createElement('input'), verb: 'fill' });
    getWorkflowDefinition.mockResolvedValue({ nodes: [
      { nodeId: 's1', typeId: 'ui.walkthrough.step', config: { actionId: 'demo.pos.click', narration: 'One' } },
      { nodeId: 's2', typeId: 'ui.walkthrough.step', config: { actionId: 'demo.pos.fill', narration: 'Two', hitl: true } },
      { nodeId: 's3', typeId: 'ui.walkthrough.checkpoint', config: { expect: 'demo.pos.done' } },
    ] });
    // The OPEN step is s2 — the middle one — so a position stuck at 0 (or at the end) fails.
    stubInterrupts([{ nodeId: 's2', kind: 'walkthrough-step', data: { actionId: 'demo.pos.fill', hitl: true } }]);

    const { result } = renderHook(() => useWalkthroughPlayer(), { wrapper });
    await act(async () => { await result.current.launch('walkthrough-pos'); });
    await waitFor(() => expect(result.current.steps).toHaveLength(3));
    expect(result.current.steps[0]).toMatchObject({ nodeId: 's1', hitl: false, checkpoint: false, narration: 'One' });
    expect(result.current.steps[1]).toMatchObject({ nodeId: 's2', hitl: true, narration: 'Two' });
    expect(result.current.steps[2]).toMatchObject({ nodeId: 's3', checkpoint: true });
    await waitFor(() => expect(result.current.position).toEqual({ index: 1, total: 3 }));
  });

  it('confirmHitl resolves a manual HITL step through the ONE tolerant path (ADR 0378 P1)', async () => {
    // An HITL step with NO hitlComplete — the chrome's "I did it" drives it.
    const input = document.createElement('input');
    registerWalkthroughAction('demo.manual.step', { route: '/', resolve: () => input, verb: 'focus' });
    stubInterrupts([{ nodeId: 's9', kind: 'walkthrough-step', data: { actionId: 'demo.manual.step', hitl: true } }]);

    const { result } = renderHook(() => useWalkthroughPlayer(), { wrapper });
    await act(async () => { await result.current.launch('walkthrough-manual'); });
    await waitFor(() => expect(result.current.status).toBe('waiting-user'));
    expect(resolveByRun).not.toHaveBeenCalled();

    await act(async () => { await result.current.confirmHitl(); });
    expect(resolveByRun).toHaveBeenCalledWith('run-1', 's9', { acked: true });

    // Status guard: while PAUSED the step is still set and the run still active,
    // so only `status !== 'waiting-user'` stops an "I did it" from resolving it.
    resolveByRun.mockClear();
    act(() => { result.current.pause(); });
    await act(async () => { await result.current.confirmHitl(); });
    expect(resolveByRun).not.toHaveBeenCalled();

    // Idle/no-step guard: a second confirm after completion is a no-op.
    resolveByRun.mockClear();
    getWorkflowDefinition.mockReset().mockResolvedValue(null);
    await act(async () => { onEvent!({ type: 'run.completed' }); });
    await act(async () => { await result.current.confirmHitl(); });
    expect(resolveByRun).not.toHaveBeenCalled();
  });

  it('WALK-PAUSE-HITL-1: a pause during an HITL step, then resume, still lets the user confirm the step', async () => {
    // A manual HITL step (no hitlComplete): the chrome's "I did it" is the only way on.
    const input = document.createElement('input');
    registerWalkthroughAction('demo.pause.hitl', { route: '/', resolve: () => input, verb: 'focus' });
    stubInterrupts([{ nodeId: 's4', kind: 'walkthrough-step', data: { actionId: 'demo.pause.hitl', hitl: true } }]);

    const { result } = renderHook(() => useWalkthroughPlayer(), { wrapper });
    await act(async () => { await result.current.launch('walkthrough-pause-hitl'); });
    await waitFor(() => expect(result.current.status).toBe('waiting-user'));

    act(() => { result.current.pause(); }); // Escape / the scrim click
    expect(result.current.status).toBe('paused');
    act(() => { result.current.resume(); });

    // CORRECT behaviour: back on the same waiting step, "I did it" visible again…
    await waitFor(() => expect(result.current.status).toBe('waiting-user'), { timeout: 1000 });
    expect(result.current.step?.nodeId).toBe('s4');
    expect(result.current.hitlAuto).toBe(false); // ⇒ the chrome shows "I did it"
    // …and confirming it resolves the step.
    await act(async () => { await result.current.confirmHitl(); });
    expect(resolveByRun).toHaveBeenCalledWith('run-1', 's4', { acked: true });
  });

  it('repeated manual HITL pause/resume never confirms until the user acts', async () => {
    const input = document.createElement('input');
    registerWalkthroughAction('demo.repeat.hitl', { route: '/', resolve: () => input, verb: 'focus' });
    stubInterrupts([{ nodeId: 'repeat', kind: 'walkthrough-step', data: { actionId: 'demo.repeat.hitl', hitl: true } }]);
    const { result } = renderHook(() => useWalkthroughPlayer(), { wrapper });
    await act(async () => { await result.current.launch('walkthrough-repeat'); });
    await waitFor(() => expect(result.current.status).toBe('waiting-user'));
    for (let count = 0; count < 2; count++) {
      act(() => { result.current.pause(); });
      act(() => { result.current.resume(); });
      await waitFor(() => expect(result.current.status).toBe('waiting-user'));
      expect(result.current.step?.nodeId).toBe('repeat');
      expect(resolveByRun).not.toHaveBeenCalled();
    }
    await act(async () => { await result.current.confirmHitl(); });
    expect(resolveByRun).toHaveBeenCalledTimes(1);
    expect(resolveByRun).toHaveBeenCalledWith('run-1', 'repeat', { acked: true });
  });

  it('a retained manual confirmation cannot resolve in the same batch as pause', async () => {
    const input = document.createElement('input');
    registerWalkthroughAction('demo.same.batch', { route: '/', resolve: () => input, verb: 'focus' });
    stubInterrupts([{ nodeId: 'same-batch', kind: 'walkthrough-step', data: { actionId: 'demo.same.batch', hitl: true } }]);
    const { result } = renderHook(() => useWalkthroughPlayer(), { wrapper });
    await act(async () => { await result.current.launch('walkthrough-same-batch'); });
    await waitFor(() => expect(result.current.status).toBe('waiting-user'));
    const confirm = result.current.confirmHitl;
    await act(async () => { result.current.pause(); await confirm(); });
    expect(resolveByRun).not.toHaveBeenCalled();
    expect(result.current.status).toBe('paused');
  });

  it('a resolved manual step is not restored while awaiting the next interrupt', async () => {
    const input = document.createElement('input');
    registerWalkthroughAction('demo.resolved.hitl', { route: '/', resolve: () => input, verb: 'focus' });
    stubInterrupts([{ nodeId: 'resolved', kind: 'walkthrough-step', data: { actionId: 'demo.resolved.hitl', hitl: true } }]);
    const { result } = renderHook(() => useWalkthroughPlayer(), { wrapper });
    await act(async () => { await result.current.launch('walkthrough-resolved'); });
    await waitFor(() => expect(result.current.status).toBe('waiting-user'));
    await act(async () => { await result.current.confirmHitl(); });
    act(() => { result.current.pause(); });
    await act(async () => { result.current.resume(); });
    expect(result.current.status).toBe('starting');
    expect(resolveByRun).toHaveBeenCalledTimes(1);
  });

  it('advancing to another node drops the previous manual continuation', async () => {
    const input = document.createElement('input');
    const nextButton = document.createElement('button');
    const clicked = vi.fn();
    nextButton.addEventListener('click', clicked);
    registerWalkthroughAction('demo.advance.hitl', { route: '/', resolve: () => input, verb: 'focus' });
    registerWalkthroughAction('demo.advance.click', { route: '/', resolve: () => nextButton, verb: 'click' });
    stubInterrupts([{ nodeId: 'first', kind: 'walkthrough-step', data: { actionId: 'demo.advance.hitl', hitl: true } }]);
    const { result } = renderHook(() => useWalkthroughPlayer(), { wrapper });
    await act(async () => { await result.current.launch('walkthrough-advance'); });
    await waitFor(() => expect(result.current.status).toBe('waiting-user'));
    stubInterrupts([{ nodeId: 'next', kind: 'walkthrough-step', data: { actionId: 'demo.advance.click', hitl: false } }]);
    if (!onEvent) throw new Error('Run subscription is missing');
    const emit = onEvent;
    await act(async () => { emit({ type: 'node.suspended', payload: { kind: 'walkthrough-step' } }); });
    await waitFor(() => expect(clicked).toHaveBeenCalledTimes(1));
    act(() => { result.current.pause(); });
    await act(async () => { result.current.resume(); });
    expect(result.current.status).toBe('starting');
    expect(result.current.step?.nodeId).toBe('next');
    expect(resolveByRun).toHaveBeenCalledTimes(1);
    expect(resolveByRun).toHaveBeenCalledWith('run-1', 'next', { acked: true, actionId: 'demo.advance.click' });
  });

  it.each(['stop', 'terminal', 'replacement'] as const)('a %s clears paused continuation before a new run', async (end) => {
    const input = document.createElement('input');
    registerWalkthroughAction('demo.old.hitl', { route: '/', resolve: () => input, verb: 'focus' });
    stubInterrupts([{ nodeId: 'old', kind: 'walkthrough-step', data: { actionId: 'demo.old.hitl', hitl: true } }]);
    const { result } = renderHook(() => useWalkthroughPlayer(), { wrapper });
    await act(async () => { await result.current.launch('walkthrough-old'); });
    await waitFor(() => expect(result.current.status).toBe('waiting-user'));
    act(() => { result.current.pause(); });
    if (end === 'stop') await act(async () => { await result.current.stop(); });
    else if (end === 'terminal') {
      if (!onEvent) throw new Error('Run subscription is missing');
      const emit = onEvent;
      await act(async () => { emit({ type: 'run.completed' }); });
    }
    createRun.mockResolvedValueOnce({ runId: 'run-2' });
    stubInterrupts([]);
    await act(async () => { await result.current.launch('walkthrough-new'); });
    await act(async () => { result.current.resume(); });
    expect(result.current.status).toBe('starting');
    expect(result.current.step).toBeNull();
    expect(resolveByRun).not.toHaveBeenCalled();
  });

  it('an old manual resolve cannot clear the next node continuation', async () => {
    const input = document.createElement('input');
    registerWalkthroughAction('demo.late.resolve', { route: '/', resolve: () => input, verb: 'focus' });
    stubInterrupts([{ nodeId: 'first', kind: 'walkthrough-step', data: { actionId: 'demo.late.resolve', hitl: true } }]);
    let finish: (() => void) | undefined;
    resolveByRun.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const { result } = renderHook(() => useWalkthroughPlayer(), { wrapper });
    await act(async () => { await result.current.launch('walkthrough-late-resolve'); });
    await waitFor(() => expect(result.current.status).toBe('waiting-user'));
    let confirmation: Promise<void> | undefined;
    act(() => { confirmation = result.current.confirmHitl(); });
    stubInterrupts([{ nodeId: 'second', kind: 'walkthrough-step', data: { actionId: 'demo.late.resolve', hitl: true } }]);
    if (!onEvent || !finish || !confirmation) throw new Error('Deferred resolve or subscription is missing');
    const emit = onEvent;
    const complete = finish;
    const pending = confirmation;
    await act(async () => { emit({ type: 'node.suspended', payload: { kind: 'walkthrough-step' } }); });
    await waitFor(() => expect(result.current.step?.nodeId).toBe('second'));
    await act(async () => { complete(); await pending; });
    act(() => { result.current.pause(); });
    act(() => { result.current.resume(); });
    await waitFor(() => expect(result.current.status).toBe('waiting-user'));
    expect(result.current.step?.nodeId).toBe('second');
    await act(async () => { await result.current.confirmHitl(); });
    expect(resolveByRun).toHaveBeenCalledTimes(2);
    expect(resolveByRun).toHaveBeenLastCalledWith('run-1', 'second', { acked: true });
  });

  it('a pending same-node confirmation still clears its continuation after pause/resume', async () => {
    const input = document.createElement('input');
    registerWalkthroughAction('demo.same.node.resolve', { route: '/', resolve: () => input, verb: 'focus' });
    stubInterrupts([{ nodeId: 'same-node', kind: 'walkthrough-step', data: { actionId: 'demo.same.node.resolve', hitl: true } }]);
    let finish: (() => void) | undefined;
    resolveByRun.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const { result } = renderHook(() => useWalkthroughPlayer(), { wrapper });
    await act(async () => { await result.current.launch('walkthrough-same-node-resolve'); });
    await waitFor(() => expect(result.current.status).toBe('waiting-user'));
    let confirmation: Promise<void> | undefined;
    act(() => { confirmation = result.current.confirmHitl(); });
    act(() => { result.current.pause(); });
    act(() => { result.current.resume(); });
    await waitFor(() => expect(result.current.status).toBe('waiting-user'));
    if (!finish || !confirmation) throw new Error('Pending confirmation is missing');
    const complete = finish;
    const pending = confirmation;
    await act(async () => { complete(); await pending; });
    act(() => { result.current.pause(); });
    await act(async () => { result.current.resume(); });
    expect(result.current.status).toBe('starting');
    expect(resolveByRun).toHaveBeenCalledTimes(1);
    expect(resolveByRun).toHaveBeenCalledWith('run-1', 'same-node', { acked: true });
  });

  it('pause detaches automatic HITL completion and resume attaches a fresh user callback', async () => {
    const input = document.createElement('input');
    const callbacks: Array<(value: unknown) => void> = [];
    const detach = vi.fn();
    registerWalkthroughAction('demo.pause.auto', {
      route: '/', resolve: () => input, verb: 'focus',
      hitlComplete: (_el, done) => { callbacks.push(done); return detach; },
    });
    stubInterrupts([{ nodeId: 'auto', kind: 'walkthrough-step', data: { actionId: 'demo.pause.auto', hitl: true } }]);
    const { result } = renderHook(() => useWalkthroughPlayer(), { wrapper });
    await act(async () => { await result.current.launch('walkthrough-auto-pause'); });
    await waitFor(() => expect(result.current.hitlAuto).toBe(true));
    const first = callbacks[0];
    if (!first) throw new Error('Initial completion callback is missing');
    act(() => { result.current.pause(); });
    expect(detach).toHaveBeenCalledTimes(1);
    await act(async () => { first('paused'); });
    expect(resolveByRun).not.toHaveBeenCalled();
    act(() => { result.current.resume(); });
    await waitFor(() => expect(callbacks).toHaveLength(2));
    const resumed = callbacks[1];
    if (!resumed) throw new Error('Resumed completion callback is missing');
    await act(async () => { first('stale'); });
    expect(resolveByRun).not.toHaveBeenCalled();
    await act(async () => { resumed('actual-user'); });
    expect(resolveByRun).toHaveBeenCalledTimes(1);
    expect(resolveByRun).toHaveBeenCalledWith('run-1', 'auto', { acked: true, hitlValue: 'actual-user' });
  });

  it.each(['response', 'body'] as const)('ignores an old run interrupt %s after a new launch', async (phase) => {
    const input = document.createElement('input');
    registerWalkthroughAction('demo.old.response', { route: '/', resolve: () => input, verb: 'focus' });
    let finishResponse: ((value: unknown) => void) | undefined;
    let finishBody: ((value: unknown) => void) | undefined;
    const oldBody = { interrupts: [{ nodeId: 'old', kind: 'walkthrough-step', data: { actionId: 'demo.old.response', hitl: true } }] };
    vi.stubGlobal('fetch', vi.fn((url: string) => {
      if (String(url).includes('/walkthroughs/progress')) return Promise.resolve({ ok: true, json: async () => ({ progress: [] }) });
      if (String(url).includes('/runs/run-1/interrupts')) {
        if (phase === 'response') return new Promise((resolve) => { finishResponse = resolve; });
        return Promise.resolve({ ok: true, json: () => new Promise((resolve) => { finishBody = resolve; }) });
      }
      return Promise.resolve({ ok: true, json: async () => ({ interrupts: [] }) });
    }));
    const { result } = renderHook(() => useWalkthroughPlayer(), { wrapper });
    await act(async () => { await result.current.launch('walkthrough-old-response'); });
    createRun.mockResolvedValueOnce({ runId: 'run-2' });
    await act(async () => { await result.current.launch('walkthrough-current'); });
    if (phase === 'response') {
      if (!finishResponse) throw new Error('Old response was not requested');
      const complete = finishResponse;
      await act(async () => { complete({ ok: true, json: async () => oldBody }); });
    } else {
      if (!finishBody) throw new Error('Old response body was not requested');
      const complete = finishBody;
      await act(async () => { complete(oldBody); });
    }
    expect(result.current.step).toBeNull();
    expect(result.current.status).toBe('starting');
    expect(resolveByRun).not.toHaveBeenCalled();
  });

  it('a closed old subscription cannot tear down the new run continuation', async () => {
    const input = document.createElement('input');
    registerWalkthroughAction('demo.current.hitl', { route: '/', resolve: () => input, verb: 'focus' });
    stubInterrupts([{ nodeId: 'old', kind: 'walkthrough-step', data: { actionId: 'demo.current.hitl', hitl: true } }]);
    const { result } = renderHook(() => useWalkthroughPlayer(), { wrapper });
    await act(async () => { await result.current.launch('walkthrough-old-subscription'); });
    await waitFor(() => expect(result.current.status).toBe('waiting-user'));
    if (!onEvent) throw new Error('Old subscription is missing');
    const oldEvent = onEvent;
    createRun.mockResolvedValueOnce({ runId: 'run-2' });
    stubInterrupts([{ nodeId: 'current', kind: 'walkthrough-step', data: { actionId: 'demo.current.hitl', hitl: true } }]);
    await act(async () => { await result.current.launch('walkthrough-current-subscription'); });
    await waitFor(() => expect(result.current.step?.nodeId).toBe('current'));
    await act(async () => { oldEvent({ type: 'run.completed' }); });
    act(() => { result.current.pause(); });
    act(() => { result.current.resume(); });
    await waitFor(() => expect(result.current.status).toBe('waiting-user'));
    await act(async () => { await result.current.confirmHitl(); });
    expect(resolveByRun).toHaveBeenCalledTimes(1);
    expect(resolveByRun).toHaveBeenCalledWith('run-2', 'current', { acked: true });
  });

  it('stop() during an in-flight element retry NEVER performs the step afterward (grade-pass)', async () => {
    const btn = document.createElement('button');
    const clicked = vi.fn();
    btn.addEventListener('click', clicked);
    let available = false; // element not resolvable yet — the retry loop spins
    registerWalkthroughAction('demo.late.click', { route: '/', resolve: () => (available ? btn : null), verb: 'click' });
    stubInterrupts([{ nodeId: 's1', kind: 'walkthrough-step', data: { actionId: 'demo.late.click', hitl: false } }]);

    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { result } = renderHook(() => useWalkthroughPlayer(), { wrapper });
      await act(async () => { await result.current.launch('walkthrough-late'); });
      await act(async () => { await vi.advanceTimersByTimeAsync(300); }); // mid-retry (250 ms interval)
      await act(async () => { await result.current.stop(); });
      available = true; // the element appears AFTER stop
      await act(async () => { await vi.advanceTimersByTimeAsync(600); }); // past two more retry ticks
      expect(clicked).not.toHaveBeenCalled();        // the zombie perform is dead
      expect(resolveByRun).not.toHaveBeenCalled();   // and nothing resolved a dead run
      expect(result.current.status).toBe('idle');
    } finally {
      vi.useRealTimers();
    }
  });

  it('pause() then resume() preserves the checkpoint data (grade-pass — the stash carries data)', async () => {
    registerWalkthroughCheckpoint('demo.paused.cp', { evaluate: () => null }); // passes
    stubInterrupts([{ nodeId: 'cp1', kind: 'walkthrough-step', data: { checkpoint: 'demo.paused.cp', hitl: false } }]);

    const { result } = renderHook(() => useWalkthroughPlayer(), { wrapper });
    act(() => { result.current.pause(); });
    await act(async () => { await result.current.launch('walkthrough-pausedcp'); });
    expect(resolveByRun).not.toHaveBeenCalled(); // stashed, not evaluated
    act(() => { result.current.resume(); });
    // With the data preserved, the CHECKPOINT branch runs (passed:true) — the
    // old view-only stash lost data.checkpoint and needs-update'd instead.
    await waitFor(() => expect(resolveByRun).toHaveBeenCalledWith('run-1', 'cp1', { passed: true }));
    expect(result.current.status).not.toBe('needs-update');
  });

  it('hitlAuto is false when hitlComplete cannot attach — the manual fallback path (grade-pass)', async () => {
    const input = document.createElement('input');
    registerWalkthroughAction('demo.noattach', { route: '/', resolve: () => input, verb: 'focus', hitlComplete: () => null });
    stubInterrupts([{ nodeId: 's7', kind: 'walkthrough-step', data: { actionId: 'demo.noattach', hitl: true } }]);
    const { result } = renderHook(() => useWalkthroughPlayer(), { wrapper });
    await act(async () => { await result.current.launch('walkthrough-noattach'); });
    await waitFor(() => expect(result.current.status).toBe('waiting-user'));
    expect(result.current.hitlAuto).toBe(false); // chrome shows "I did it"
  });

  it('reload re-attach: a sessionStorage active pointer re-subscribes and continues the open step (WALK-9)', async () => {
    const btn = document.createElement('button');
    const clicked = vi.fn();
    btn.addEventListener('click', clicked);
    registerWalkthroughAction('demo.reattach.click', { route: '/', resolve: () => btn, verb: 'click' });
    sessionStorage.setItem('openwop.walkthrough.active', JSON.stringify({ runId: 'run-77', walkthroughId: 'walkthrough-re' }));
    stubInterrupts([{ nodeId: 'r1', kind: 'walkthrough-step', data: { actionId: 'demo.reattach.click', hitl: false } }]);

    renderHook(() => useWalkthroughPlayer(), { wrapper });
    // No launch() call — the mount effect alone must re-attach + perform.
    await waitFor(() => expect(resolveByRun).toHaveBeenCalledWith('run-77', 'r1', { acked: true, actionId: 'demo.reattach.click' }));
    expect(clicked).toHaveBeenCalled();
    expect(createRun).not.toHaveBeenCalled(); // re-attach, never a fresh run
  });

  it("launch's resume-in-flight branch re-attaches to the caller's started run instead of creating one (WALK-9)", async () => {
    const btn = document.createElement('button');
    registerWalkthroughAction('demo.resume.click', { route: '/', resolve: () => btn, verb: 'click' });
    // The in-flight run is `waiting_*`, which is what makes the branch re-attach
    // rather than start fresh. Asserted through the client, not the transport:
    // the snapshot read is tenant-bound now, so a URL-matching stub would be
    // pinning the binding rather than the behaviour under test.
    getRun.mockImplementation((id: string) => Promise.resolve({ runId: id, status: 'waiting_interrupt' }));
    // Route-aware stub: progress row (started) -> open interrupts.
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      const u = String(url);
      // ANOTHER walkthrough's started row comes FIRST: matching on status alone
      // would re-attach to run-99.
      if (u.includes('/walkthroughs/progress')) return Promise.resolve({ ok: true, json: async () => ({ progress: [
        { walkthroughId: 'other-walkthrough', status: 'started', runId: 'run-99' },
        { walkthroughId: 'walkthrough-inflight', status: 'started', runId: 'run-55' },
      ] }) });
      // The snapshot no longer rides `fetch` — see the `getRun` mock above.
      if (u.includes('/interrupts')) return Promise.resolve({ ok: true, json: async () => ({ interrupts: [{ nodeId: 's5', kind: 'walkthrough-step', data: { actionId: 'demo.resume.click', hitl: false } }] }) });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }));

    const { result } = renderHook(() => useWalkthroughPlayer(), { wrapper });
    await act(async () => { await result.current.launch('walkthrough-inflight'); });
    await waitFor(() => expect(resolveByRun).toHaveBeenCalledWith('run-55', 's5', { acked: true, actionId: 'demo.resume.click' }));
    expect(createRun).not.toHaveBeenCalled(); // re-attached to the in-flight run
    expect(getRun).toHaveBeenCalledWith('run-55');
    expect(getRun).not.toHaveBeenCalledWith('run-99');
  });

  it("launch's resume-in-flight branch starts FRESH when the started run is already terminal (WALK-9)", async () => {
    const btn = document.createElement('button');
    registerWalkthroughAction('demo.fresh.click', { route: '/', resolve: () => btn, verb: 'click' });
    getRun.mockResolvedValue({ runId: 'run-55', status: 'completed' });
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes('/walkthroughs/progress')) return Promise.resolve({ ok: true, json: async () => ({ progress: [{ walkthroughId: 'walkthrough-done', status: 'started', runId: 'run-55' }] }) });
      if (u.includes('/interrupts')) return Promise.resolve({ ok: true, json: async () => ({ interrupts: [{ nodeId: 's1', kind: 'walkthrough-step', data: { actionId: 'demo.fresh.click', hitl: false } }] }) });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }));

    const { result } = renderHook(() => useWalkthroughPlayer(), { wrapper });
    await act(async () => { await result.current.launch('walkthrough-done'); });
    expect(getRun).toHaveBeenCalledWith('run-55');
    expect(createRun).toHaveBeenCalledWith(expect.objectContaining({ workflowId: 'walkthrough-done' }));
    await waitFor(() => expect(resolveByRun).toHaveBeenCalledWith('run-1', 's1', { acked: true, actionId: 'demo.fresh.click' }));
    expect(resolveByRun).not.toHaveBeenCalledWith('run-55', expect.anything(), expect.anything());
  });

  it('a failed checkpoint CANCELS the run', async () => {
    registerWalkthroughCheckpoint('demo.brief-exists', { evaluate: () => 'no brief found' });
    stubInterrupts([{ nodeId: 'cp', kind: 'tour-step', data: { checkpoint: 'demo.brief-exists', hitl: false } }]);
    const { result } = renderHook(() => useWalkthroughPlayer(), { wrapper });
    await act(async () => { await result.current.launch('tour-cp'); });
    await waitFor(() => expect(cancelRun).toHaveBeenCalledWith('run-1', 'walkthrough checkpoint failed'));
    expect(result.current.error).toBe('no brief found');
    expect(resolveByRun).not.toHaveBeenCalled();
  });

  // ── ADR 0489 D1/D2 — the already-satisfied arm ──────────────────────────
  it('an ALREADY-SATISFIED checkpoint resolves as skipped and never cancels', async () => {
    registerWalkthroughCheckpoint('demo.already', {
      evaluate: () => ({ satisfied: true as const, because: 'You already connected a provider.' }),
    });
    stubInterrupts([{ nodeId: 'cp', kind: 'walkthrough-step', data: { checkpoint: 'demo.already', hitl: false } }]);
    const { result } = renderHook(() => useWalkthroughPlayer(), { wrapper });
    await act(async () => { await result.current.launch('tour-skip'); });
    await waitFor(() => expect(resolveByRun).toHaveBeenCalledWith('run-1', 'cp', {
      passed: true, skipped: true, because: 'You already connected a provider.',
    }));
    // The run survives — a skip is DONE, not divergence.
    expect(cancelRun).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
    // D2 — the skip stays VISIBLE so the learner can see what was bypassed.
    expect(result.current.skipped).toEqual([{ nodeId: 'cp', because: 'You already connected a provider.' }]);
  });

  it('FAILS CLOSED on a malformed verdict — a garbage return never skips a step', async () => {
    // The dangerous regression: any truthy object read as "already satisfied"
    // would silently bypass real work. It must cancel instead.
    // A BLANK reason is type-valid but semantically malformed, so this proves the
    // fail-closed path without a cast. (The exhaustive malformed-shape matrix —
    // wrong types, bare objects, arrays — lives in actionRegistry.test.ts, where
    // narrowCheckpointVerdict takes `unknown` and needs no cast either.)
    registerWalkthroughCheckpoint('demo.garbage', {
      evaluate: () => ({ satisfied: true as const, because: '   ' }),
    });
    stubInterrupts([{ nodeId: 'cp', kind: 'walkthrough-step', data: { checkpoint: 'demo.garbage', hitl: false } }]);
    const { result } = renderHook(() => useWalkthroughPlayer(), { wrapper });
    await act(async () => { await result.current.launch('tour-garbage'); });
    await waitFor(() => expect(cancelRun).toHaveBeenCalledWith('run-1', 'walkthrough checkpoint failed'));
    expect(resolveByRun).not.toHaveBeenCalled();
    expect(result.current.skipped).toEqual([]);
  });

  it('LEGACY contract regression — a null-returning checkpoint still passes untouched', async () => {
    registerWalkthroughCheckpoint('demo.legacy-pass', { evaluate: () => null });
    stubInterrupts([{ nodeId: 'cp', kind: 'walkthrough-step', data: { checkpoint: 'demo.legacy-pass', hitl: false } }]);
    const { result } = renderHook(() => useWalkthroughPlayer(), { wrapper });
    await act(async () => { await result.current.launch('tour-legacy'); });
    await waitFor(() => expect(resolveByRun).toHaveBeenCalledWith('run-1', 'cp', { passed: true }));
    expect(cancelRun).not.toHaveBeenCalled();
    expect(result.current.skipped).toEqual([]); // a PASS is not a skip
  });
});
