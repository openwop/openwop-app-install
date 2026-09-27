/**
 * useCollab seam tests (ADR 0335 Phase 2a). Verifies the control flow without a
 * live backend: disabled ⇒ no-op; enabled ⇒ dynamically provisions a Y.Doc +
 * WebsocketProvider (mocked) + awareness and tears them down on unmount. The live
 * FE↔backend sync is a browser/e2e concern (the backend room is unit-tested in
 * backend/test/collab-*.test.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

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

describe('useCollab', () => {
  beforeEach(() => { destroy.mockClear(); off.mockClear(); on.mockClear(); });

  it('is a no-op when disabled', () => {
    const { result } = renderHook(() => useCollab({ canvasId: 'c1', enabled: false }));
    expect(result.current).toEqual({ enabled: false });
  });

  it('is a no-op when there is no canvasId (unsaved canvas)', () => {
    const { result } = renderHook(() => useCollab({ canvasId: undefined, enabled: true }));
    expect(result.current).toEqual({ enabled: false });
  });

  it('provisions a session when enabled, then tears it down on unmount', async () => {
    const { result, unmount } = renderHook(() => useCollab({ canvasId: 'c1', enabled: true }));
    await waitFor(() => expect(result.current.enabled).toBe(true));
    expect(result.current).toMatchObject({ enabled: true, synced: false });
    if (result.current.enabled) { expect(result.current.ydoc).toBeTruthy(); expect(result.current.awareness).toBeTruthy(); }
    expect(on).toHaveBeenCalledWith('sync', expect.any(Function));
    act(() => unmount());
    expect(destroy).toHaveBeenCalled();
  });

  it('flags `failed` when no first sync arrives in the window; Retry (attempt bump) re-provisions (UX-B2)', async () => {
    vi.useFakeTimers();
    // The ticket mint awaits fetch before provisioning — under fake timers a
    // real fetch never settles, so resolve it synchronously (mint declined ⇒
    // the cookie-fallback path, which is what this test exercises anyway).
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
    try {
      const { result, rerender } = renderHook(
        ({ attempt }: { attempt: number }) => useCollab({ canvasId: 'c1', enabled: true, attempt }),
        { initialProps: { attempt: 0 } },
      );
      // Let the dynamic imports resolve (fake timers pause macrotasks only).
      await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
      expect(result.current.enabled).toBe(true);
      await act(async () => { vi.advanceTimersByTime(21_000); });
      expect(result.current.enabled && result.current.failed).toBe(true);
      // Retry: a bumped attempt tears down and re-provisions a fresh session.
      rerender({ attempt: 1 });
      await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); });
      expect(result.current.enabled && !result.current.failed).toBe(true);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('claimSeed is a single-flight POST to the canvas-collab election (ADR 0359 D2)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ seed: true }) });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const { result } = renderHook(() => useCollab({ canvasId: 'c1', enabled: true }));
      await waitFor(() => expect(result.current.enabled).toBe(true));
      if (!result.current.enabled) throw new Error('unreachable');
      const mintCalls = fetchMock.mock.calls.length; // the ticket mint fires during provisioning
      expect(mintCalls).toBe(1);
      expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/host/openwop-app/canvas-collab/c1/ticket');
      const [a, b] = await Promise.all([result.current.claimSeed(), result.current.claimSeed()]);
      expect(a).toBe(true);
      expect(b).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(mintCalls + 1); // single-flight election
      expect(String(fetchMock.mock.calls[mintCalls]?.[0])).toContain('/host/openwop-app/canvas-collab/c1/claim-seed');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
