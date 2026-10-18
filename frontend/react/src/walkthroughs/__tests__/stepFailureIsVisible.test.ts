/**
 * WALK-8 fixed the unhandled rejection and left the learner waiting.
 *
 * `guardedPerform` turned a non-benign step failure into `console.warn` and
 * nothing else: `status` stayed `running`, the interrupt stayed open, the overlay
 * kept highlighting the element. A step that will never advance, presented as a
 * step in progress — in the one surface whose entire job is telling someone what
 * to do next.
 *
 * w51 r2 (/grade-tests) — REWRITTEN from source greps to behaviour, cases 4 → 4.
 * The greps could not fail on a guard turned dead (`if (Date.now() < 0)
 * setStatus('needs-update')`) or on `setError(null)` — probes sf-dead-status and
 * sf-null-error were vacuous. The header used to argue that driving a live run
 * "proves mostly that the stubs were wired"; useWalkthroughPlayer.test.tsx already
 * owns exactly that harness, so these cases drive the real hook: a registered
 * click step whose resolve fails with a real 500 `WopError` reaches
 * `guardedPerform`'s catch.
 *
 * Limitation kept from the original: this proves the STATE that renders the
 * message is set (`status: 'needs-update'`, `error`); the overlay's `needs-update`
 * rendering is covered by its own tests.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { createElement, type ReactNode } from 'react';

const createRun = vi.fn();
const cancelRun = vi.fn();
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

const resolveByRun = vi.fn();
vi.mock('../../client/interruptsClient.js', () => ({ resolveByRun: (...a: unknown[]) => resolveByRun(...a) }));

const getWorkflowDefinition = vi.fn();
vi.mock('../../client/workflowsClient.js', () => ({ getWorkflowDefinition: (...a: unknown[]) => getWorkflowDefinition(...a) }));

import { WopError } from '@openwop/openwop';
import { useWalkthroughPlayer } from '../useWalkthroughPlayer.js';
import { registerWalkthroughAction, __resetWalkthroughRegistryForTests } from '../actionRegistry.js';

const wrapper = ({ children }: { children: ReactNode }) => createElement(MemoryRouter, null, children);

/** Route-aware fetch: no in-flight progress row, one open click step. */
function stubTransport(): void {
  vi.stubGlobal('fetch', vi.fn((url: string) => {
    const body = String(url).includes('/walkthroughs/progress')
      ? { progress: [] }
      : { interrupts: [{ nodeId: 's1', kind: 'walkthrough-step', data: { actionId: 'demo.fail.click', hitl: false } }] };
    return Promise.resolve({ ok: true, json: async () => body });
  }));
}

const serverError = (): WopError => new WopError(500, '', { error: 'internal_error', message: 'upstream exploded' }, undefined);

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  __resetWalkthroughRegistryForTests();
  sessionStorage.clear();
  onEvent = null;
  createRun.mockReset().mockResolvedValue({ runId: 'run-1' });
  cancelRun.mockReset().mockResolvedValue(undefined);
  getRun.mockReset();
  resolveByRun.mockReset();
  getWorkflowDefinition.mockReset().mockResolvedValue(null);
  registerWalkthroughAction('demo.fail.click', { route: '/', resolve: () => document.createElement('button'), verb: 'click' });
  stubTransport();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { warn.mockRestore(); vi.unstubAllGlobals(); });

describe('a failed walkthrough step tells the learner', () => {
  it('sets needs-update, not only a console warning', async () => {
    const err = serverError();
    resolveByRun.mockRejectedValueOnce(err);
    const { result } = renderHook(() => useWalkthroughPlayer(), { wrapper });
    await act(async () => { await result.current.launch('walkthrough-fail'); });
    await waitFor(() => expect(result.current.status).toBe('needs-update'));
    expect(err.message).not.toBe('');
    expect(result.current.error).toBe(err.message); // the real failure, not a blank
  });

  it('keeps the warning — it was there to stop an unhandled rejection', async () => {
    // The fix ADDS to WALK-8 rather than replacing it. Dropping the warn would
    // lose the diagnostic that made this findable in the first place.
    const err = serverError();
    resolveByRun.mockRejectedValueOnce(err);
    const { result } = renderHook(() => useWalkthroughPlayer(), { wrapper });
    await act(async () => { await result.current.launch('walkthrough-fail'); });
    await waitFor(() => expect(result.current.status).toBe('needs-update'));
    expect(warn).toHaveBeenCalledWith('[walkthroughs] step perform failed', err);
  });

  it('stays silent when the run it belonged to is no longer in play', async () => {
    // A step that fails because the learner stopped or navigated away must not
    // interrupt them: the resolve is still in flight when Stop lands, and its
    // failure arrives afterwards.
    let fail: (e: unknown) => void = () => {};
    resolveByRun.mockImplementationOnce(() => new Promise((_res, rej) => { fail = rej; }));
    const { result } = renderHook(() => useWalkthroughPlayer(), { wrapper });
    await act(async () => { await result.current.launch('walkthrough-fail'); });
    await waitFor(() => expect(resolveByRun).toHaveBeenCalledTimes(1));
    await act(async () => { await result.current.stop(); });
    await act(async () => { fail(serverError()); });
    // Positive control: the catch DID run (so the silence is the guard, not a miss).
    await waitFor(() => expect(warn).toHaveBeenCalledWith('[walkthroughs] step perform failed', expect.any(WopError)));
    expect(result.current.status).toBe('idle');
    expect(result.current.error).toBeNull();
  });

  it('is not vacuous — a benign interrupt_gone (410) is never surfaced as a failure', async () => {
    // The contrast case: only a REAL error reaches the learner. A 410 means the
    // interrupt already closed (the run advanced) — the step is done, not stuck.
    // `interrupt_gone` is not a registered spec code, so on the major-2 wire it
    // travels as `openwop-app.interrupt_gone` (ADR 0647) and the client strips it.
    resolveByRun.mockRejectedValueOnce(new WopError(410, '', { error: 'openwop-app.interrupt_gone', message: 'interrupt already resolved' }, undefined));
    const { result } = renderHook(() => useWalkthroughPlayer(), { wrapper });
    await act(async () => { await result.current.launch('walkthrough-fail'); });
    await waitFor(() => expect(resolveByRun).toHaveBeenCalledTimes(1));
    await act(async () => {});
    expect(result.current.status).not.toBe('needs-update');
    expect(result.current.error).toBeNull();
    expect(warn).not.toHaveBeenCalledWith('[walkthroughs] step perform failed', expect.anything());
    await act(async () => { onEvent?.({ type: 'run.completed' }); });
    expect(result.current.status).toBe('completed');
  });
});
