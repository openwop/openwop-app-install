/**
 * useCollab seam tests (ADR 0335 Phase 2a). Verifies the control flow without a
 * live backend: disabled ⇒ no-op; enabled ⇒ dynamically provisions a Y.Doc +
 * WebsocketProvider (mocked) + awareness and tears them down on unmount. The live
 * FE↔backend sync is a browser/e2e concern (the backend room is unit-tested in
 * backend/test/collab-*.test.ts).
 *
 * Breaks it: provisioning a socket when the toggle is off or the canvas is
 * unsaved; leaking the provider on unmount; an infinite spinner with no
 * `failed` ceiling or a Retry that does not re-provision (UX-B2); a reader who
 * cannot write joining a room (ADR 0886 D2); a duplicate seeder election POST.
 *
 * `fetch` is stubbed in EVERY case (/grade-tests w46): the ticket mint runs
 * before the provider exists, so an unstubbed case made a live call. The
 * provision is async (dynamic imports + mint), so a "stays disabled" claim is
 * only asserted after `settle()` — the same drain a positive control proves is
 * long enough for an ENABLED hook to provision.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { config } from '../../client/config.js';

const destroy = vi.fn();
const off = vi.fn();
const on = vi.fn();
class FakeProvider {
  awareness: unknown;
  constructor(_url: string, _room: string, _doc: unknown, opts: { awareness: unknown }) { this.awareness = opts.awareness; }
  on = on; off = off; destroy = destroy;
}
vi.mock('y-websocket', () => ({ WebsocketProvider: FakeProvider }));

import { useCollab } from '../useCollab.js';

const TICKET_URL = `${config.baseUrl}/host/openwop-app/canvas-collab/c1/ticket`;
const CLAIM_URL = `${config.baseUrl}/host/openwop-app/canvas-collab/c1/claim-seed`;

/** A declined mint (the cookie-fallback path) unless a case overrides it. */
const fetchMock = vi.fn(async (_url: string, _init?: RequestInit): Promise<Response> => new Response(null, { status: 500 }));

/** Let the dynamic imports + the (stubbed) mint resolve. */
async function settle(): Promise<void> {
  await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); });
}

beforeAll(async () => {
  // Warm the module cache so `settle()` measures the hook, not first-load cost.
  await import('yjs'); await import('y-websocket'); await import('y-protocols/awareness');
});

describe('useCollab', () => {
  beforeEach(() => {
    destroy.mockClear(); off.mockClear(); on.mockClear();
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => new Response(null, { status: 500 }));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('is a no-op when disabled', async () => {
    const { result } = renderHook(() => useCollab({ canvasId: 'c1', enabled: false }));
    await settle();
    expect(result.current).toEqual({ enabled: false });
    expect(fetchMock).not.toHaveBeenCalled(); // no ticket mint
    expect(on).not.toHaveBeenCalled();        // no provider constructed
    // Positive control: the SAME drain is long enough for an enabled hook.
    const control = renderHook(() => useCollab({ canvasId: 'c1', enabled: true }));
    await settle();
    expect(control.result.current.enabled).toBe(true);
  });

  it('is a no-op when there is no canvasId (unsaved canvas)', async () => {
    const { result } = renderHook(() => useCollab({ canvasId: undefined, enabled: true }));
    await settle();
    expect(result.current).toEqual({ enabled: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(on).not.toHaveBeenCalled();
  });

  it('provisions a session when enabled, then tears it down on unmount', async () => {
    const { result, unmount } = renderHook(() => useCollab({ canvasId: 'c1', enabled: true }));
    await waitFor(() => expect(result.current.enabled).toBe(true));
    const session = result.current;
    if (!session.enabled) throw new Error('not enabled');
    expect(session).toMatchObject({ enabled: true, synced: false, failed: false });
    expect(session.ydoc).toBeTruthy();
    expect(session.awareness).toBeTruthy();
    expect(on).toHaveBeenCalledWith('sync', expect.any(Function));
    act(() => unmount());
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(off).toHaveBeenCalledWith('sync', expect.any(Function));
    expect(off).toHaveBeenCalledWith('status', expect.any(Function));
  });

  it('flags `failed` when no first sync arrives in the window; Retry (attempt bump) re-provisions (UX-B2)', async () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(
      ({ attempt }: { attempt: number }) => useCollab({ canvasId: 'c1', enabled: true, attempt }),
      { initialProps: { attempt: 0 } },
    );
    // Let the dynamic imports resolve (fake timers pause macrotasks only).
    await settle();
    expect(result.current.enabled).toBe(true);
    const first = result.current.enabled ? result.current.ydoc : null;
    await act(async () => { vi.advanceTimersByTime(21_000); });
    expect(result.current.enabled && result.current.failed).toBe(true);
    // Retry: a bumped attempt tears down and re-provisions a FRESH session.
    rerender({ attempt: 1 });
    await settle();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(result.current.enabled && !result.current.failed).toBe(true);
    expect(result.current.enabled ? result.current.ydoc : null).not.toBe(first);
  });

  it('a reader who cannot write (403 collab_write_required) stays DISABLED — no socket, no "failed" (ADR 0886 D2)', async () => {
    fetchMock.mockImplementation(async () => new Response(
      JSON.stringify({ error: 'forbidden_scope', details: { reason: 'collab_write_required' } }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    ));
    const { result } = renderHook(() => useCollab({ canvasId: 'c1', enabled: true }));
    // The real settle signal: the mint answered, and its body was read.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await settle();
    expect(result.current).toEqual({ enabled: false });
    expect(on).not.toHaveBeenCalled(); // no provider was ever constructed
  });

  it('any OTHER mint refusal still falls back to the cookie socket (unchanged)', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }));
    const { result } = renderHook(() => useCollab({ canvasId: 'c1', enabled: true }));
    await waitFor(() => expect(result.current.enabled).toBe(true));
  });

  it('claimSeed is a single-flight POST to the canvas-collab election (ADR 0359 D2)', async () => {
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ seed: true }), { status: 200 }));
    const { result } = renderHook(() => useCollab({ canvasId: 'c1', enabled: true }));
    await waitFor(() => expect(result.current.enabled).toBe(true));
    if (!result.current.enabled) throw new Error('unreachable');
    const mintCalls = fetchMock.mock.calls.length; // the ticket mint fires during provisioning
    expect(mintCalls).toBe(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(TICKET_URL);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe('POST');
    const [a, b] = await Promise.all([result.current.claimSeed(), result.current.claimSeed()]);
    expect(a).toBe(true);
    expect(b).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(mintCalls + 1); // single-flight election
    expect(fetchMock.mock.calls[mintCalls]?.[0]).toBe(CLAIM_URL);
    expect(fetchMock.mock.calls[mintCalls]?.[1]?.method).toBe('POST');
  });
});
