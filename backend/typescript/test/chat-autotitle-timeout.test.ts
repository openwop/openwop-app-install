/**
 * ATC-2 — the fire-and-forget auto-title dispatch passed no `AbortSignal`, so it
 * had no FEATURE-owned wall-clock bound. (It wasn't literally unbounded: an
 * unguarded caller inherits `dispatchChat`'s coarse 120s default floor. But 120s
 * is far too long for a detached best-effort title, and a title timeout was
 * indistinguishable from any other provider error.) `generateTitle` now passes
 * its own 15s signal — which the dispatch layer leaves untouched, replacing the
 * floor — mirroring the chat-responder bound (`nodes.ts` MANAGED_CHAT_TIMEOUT_MS,
 * pinned by `chat-responder-timeout.test.ts`).
 *
 * Strategy: stub `dispatchManagedChat` (so the real dispatch-layer floor never runs) to
 * return a promise that settles ONLY when the AbortSignal fires, then drive the clock with
 * fake timers: not settled one tick before the (shrunk) window, settled to `null` AT it, and
 * the signal handed down is the one that aborted. Deterministic — no wall-clock bounds.
 * Sabotage-verified: deleting `signal: abort.signal` (the stub never settles), stretching the
 * timer, or rethrowing from the catch each turn the case red.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// `vi.mock` is hoisted above the import of the generator. Replace
// `dispatchManagedChat` with a stub that honors the AbortSignal — when the
// signal fires we reject with an AbortError, matching what the underlying fetch
// implementation would do. Also record the signal we were handed.
let lastSignal: AbortSignal | undefined | 'unset' = 'unset';
vi.mock('../src/providers/managedProvider.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/providers/managedProvider.js')>();
  return {
    ...original,
    dispatchManagedChat: vi.fn(async (req: { signal?: AbortSignal }) => {
      lastSignal = req.signal;
      return new Promise((_resolve, reject) => {
        const fail = () => {
          const err = new Error('The operation was aborted.');
          err.name = 'AbortError';
          reject(err);
        };
        if (req.signal) {
          if (req.signal.aborted) return fail();
          req.signal.addEventListener('abort', fail, { once: true });
        }
        // Without a signal the promise hangs forever — the pre-fix behavior.
      });
    }),
  };
});

// Import AFTER vi.mock so the stub is in place.
let generateTitle: typeof import('../src/features/chat-autotitle/titleGenerator.js')['generateTitle'];
let _setTitleTimeoutMs: typeof import('../src/features/chat-autotitle/titleGenerator.js')['_setTitleTimeoutMs'];

beforeAll(async () => {
  const mod = await import('../src/features/chat-autotitle/titleGenerator.js');
  generateTitle = mod.generateTitle;
  _setTitleTimeoutMs = mod._setTitleTimeoutMs;
});

afterEach(() => {
  vi.useRealTimers();
  lastSignal = 'unset';
  // Restore a large default so other tests in the same worker don't inherit it.
  _setTitleTimeoutMs(15_000);
});

describe('chat-autotitle: managed dispatch timeout (ATC-2)', () => {
  it('degrades to null when the upstream never responds within the title timeout', { timeout: 5000 }, async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    _setTitleTimeoutMs(250);
    let settled = false;
    const p = generateTitle('user:t', 'hello there', 'general kenobi').then((t) => { settled = true; return t; });
    // One tick short of the window: still waiting (the bound is not early).
    await vi.advanceTimersByTimeAsync(249);
    expect(settled).toBe(false);
    // At the window: the feature-owned bound fires and the title degrades to the placeholder.
    await vi.advanceTimersByTimeAsync(1);
    expect(settled, 'the bound must fire AT the window (not later, not never)').toBe(true);
    // Best-effort: a bounded hang yields the placeholder (null), never a throw.
    expect(await p).toBeNull();
    // The wiring: the signal handed to the managed dispatch is the one that aborted.
    expect(lastSignal, 'generateTitle must pass req.signal to dispatchManagedChat').toBeInstanceOf(AbortSignal);
    const sig = lastSignal;
    expect(sig instanceof AbortSignal && sig.aborted).toBe(true);
  });
});
