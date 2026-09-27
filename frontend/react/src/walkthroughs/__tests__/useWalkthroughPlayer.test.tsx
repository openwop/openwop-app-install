/**
 * ADR 0368 P2 — the player loop with mocked transports: launch stamps
 * run.metadata.guidedTour; a tour-step suspension fetches the payload and
 * performs the registry action then resolves; HITL steps wait for the user;
 * an unknown actionId lands needs-update (no silent hang); a failed
 * checkpoint cancels the run.
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

function stubInterrupts(rows: Array<Record<string, unknown>>): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ interrupts: rows }) }));
}

beforeEach(() => {
  __resetWalkthroughRegistryForTests();
  createRun.mockReset().mockResolvedValue({ runId: 'run-1' });
  resolveByRun.mockClear();
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
    getWorkflowDefinition.mockResolvedValue({ nodes: [
      { nodeId: 's1', typeId: 'ui.walkthrough.step', config: { actionId: 'demo.pos.click', narration: 'One' } },
      { nodeId: 's2', typeId: 'ui.walkthrough.step', config: { actionId: 'demo.pos.fill', narration: 'Two', hitl: true } },
      { nodeId: 's3', typeId: 'ui.walkthrough.checkpoint', config: { expect: 'demo.pos.done' } },
    ] });
    stubInterrupts([{ nodeId: 's1', kind: 'walkthrough-step', data: { actionId: 'demo.pos.click', hitl: false } }]);

    const { result } = renderHook(() => useWalkthroughPlayer(), { wrapper });
    await act(async () => { await result.current.launch('walkthrough-pos'); });
    await waitFor(() => expect(result.current.steps).toHaveLength(3));
    expect(result.current.steps[1]).toMatchObject({ nodeId: 's2', hitl: true, narration: 'Two' });
    expect(result.current.steps[2]).toMatchObject({ nodeId: 's3', checkpoint: true });
    await waitFor(() => expect(result.current.position).toEqual({ index: 0, total: 3 }));
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

    // Idle/no-step guard: a second confirm after completion is a no-op.
    resolveByRun.mockClear();
  getWorkflowDefinition.mockReset().mockResolvedValue(null);
    await act(async () => { onEvent!({ type: 'run.completed' }); });
    await act(async () => { await result.current.confirmHitl(); });
    expect(resolveByRun).not.toHaveBeenCalled();
  });

  it('stop() during an in-flight element retry NEVER performs the step afterward (grade-pass)', async () => {
    const btn = document.createElement('button');
    const clicked = vi.fn();
    btn.addEventListener('click', clicked);
    let available = false; // element not resolvable yet — the retry loop spins
    registerWalkthroughAction('demo.late.click', { route: '/', resolve: () => (available ? btn : null), verb: 'click' });
    stubInterrupts([{ nodeId: 's1', kind: 'walkthrough-step', data: { actionId: 'demo.late.click', hitl: false } }]);

    const { result } = renderHook(() => useWalkthroughPlayer(), { wrapper });
    await act(async () => { await result.current.launch('walkthrough-late'); });
    await act(async () => { await new Promise((r) => setTimeout(r, 300)); }); // mid-retry
    await act(async () => { await result.current.stop(); });
    available = true; // the element appears AFTER stop
    await act(async () => { await new Promise((r) => setTimeout(r, 600)); });
    expect(clicked).not.toHaveBeenCalled();        // the zombie perform is dead
    expect(resolveByRun).not.toHaveBeenCalled();   // and nothing resolved a dead run
    expect(result.current.status).toBe('idle');
  });

  it('pause() then resume() preserves the checkpoint data (grade-pass — the stash carries data)', async () => {
    registerWalkthroughCheckpoint('demo.paused.cp', { evaluate: () => null }); // passes
    stubInterrupts([{ nodeId: 'cp1', kind: 'walkthrough-step', data: { checkpoint: 'demo.paused.cp', hitl: false } }]);

    const { result } = renderHook(() => useWalkthroughPlayer(), { wrapper });
    act(() => { result.current.pause(); });
    await act(async () => { await result.current.launch('walkthrough-pausedcp'); });
    expect(resolveByRun).not.toHaveBeenCalled(); // stashed, not evaluated
    await act(async () => { result.current.resume(); await new Promise((r) => setTimeout(r, 20)); });
    // With the data preserved, the CHECKPOINT branch runs (passed:true) — the
    // old view-only stash lost data.checkpoint and needs-update'd instead.
    expect(resolveByRun).toHaveBeenCalledWith('run-1', 'cp1', { passed: true });
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
    getRun.mockResolvedValue({ runId: 'run-55', status: 'waiting_interrupt' });
    // Route-aware stub: progress row (started) -> open interrupts.
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes('/walkthroughs/progress')) return Promise.resolve({ ok: true, json: async () => ({ progress: [{ walkthroughId: 'walkthrough-inflight', status: 'started', runId: 'run-55' }] }) });
      // The snapshot no longer rides `fetch` — see the `getRun` mock above.
      if (u.includes('/interrupts')) return Promise.resolve({ ok: true, json: async () => ({ interrupts: [{ nodeId: 's5', kind: 'walkthrough-step', data: { actionId: 'demo.resume.click', hitl: false } }] }) });
      return Promise.resolve({ ok: true, json: async () => ({}) });
    }));

    const { result } = renderHook(() => useWalkthroughPlayer(), { wrapper });
    await act(async () => { await result.current.launch('walkthrough-inflight'); });
    await waitFor(() => expect(resolveByRun).toHaveBeenCalledWith('run-55', 's5', { acked: true, actionId: 'demo.resume.click' }));
    expect(createRun).not.toHaveBeenCalled(); // re-attached to the in-flight run
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
