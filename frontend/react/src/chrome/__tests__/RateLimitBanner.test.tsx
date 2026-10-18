/**
 * ADR 0640 — the banner appears on the signal, counts down from the server's
 * `Retry-After`, and leaves on its own.
 *
 * Sabotage that turns it red: ignore `Retry-After` (fixed 5 s window); drop the
 * subscription; stop the 1 s tick; keep rendering after the deadline; round the
 * remaining time down instead of up.
 *
 * RLB-A11Y-1 (/grade-tests w35, BLOCKED-ON-PRODUCT): the banner is a CONDITIONALLY
 * MOUNTED `role="status"` node inserted with its text already inside. A live region
 * only speaks on mutation, and `status` (unlike `alert`) gets no announce-on-insert,
 * so the onset is silent to assistive tech (repo lessons:
 * live-region-mounted-with-content, live-region-alert-vs-status-spec). Pinned below
 * as `it.fails` asserting the CORRECT behaviour: the message reaches the pre-mounted
 * `GlobalLiveRegion`, or the banner is an `alert`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: { seconds?: number }) => (o && o.seconds !== undefined ? `${k}:${o.seconds}` : k) }),
}));
import { RateLimitBanner } from '../RateLimitBanner.js';
import { _resetRateLimitSignal, noteRateLimited } from '../../client/rateLimitSignal.js';
import { GlobalLiveRegion, announce } from '../../ui/announce.js';

const res429 = (retryAfter: string): Response => new Response(null, { status: 429, headers: { 'retry-after': retryAfter } });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-07T12:00:00Z'));
  _resetRateLimitSignal();
  announce('');
  announce('', { assertive: true });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('RateLimitBanner', () => {
  it('is absent until a 429 is noted, then shows the countdown and disappears when it lapses', () => {
    render(<RateLimitBanner />);
    expect(screen.queryByTestId('rate-limit-banner')).toBeNull();

    act(() => { noteRateLimited(res429('3')); });
    expect(screen.getByTestId('rate-limit-banner').textContent).toBe('rateLimitedBanner:3');

    act(() => { vi.advanceTimersByTime(1_000); });
    expect(screen.getByTestId('rate-limit-banner').textContent).toBe('rateLimitedBanner:2');

    act(() => { vi.advanceTimersByTime(2_500); });
    expect(screen.queryByTestId('rate-limit-banner')).toBeNull();
  });

  it('rounds a part-second remainder UP — 2.5 s left reads as 3, never 2', () => {
    render(<RateLimitBanner />);
    // The signal was raised 500 ms ago with Retry-After: 3 → 2.5 s remain now.
    act(() => { noteRateLimited(res429('3'), Date.now() - 500); });
    expect(screen.getByTestId('rate-limit-banner').textContent).toBe('rateLimitedBanner:3');
  });

  // RLB-A11Y-1 — BLOCKED-ON-PRODUCT. Correct: the onset is SPOKEN. Today it is silent.
  it.fails('RLB-A11Y-1: the onset is announced (reaches the pre-mounted live region, or the banner is an alert)', async () => {
    vi.useRealTimers();
    const { container } = render(<><GlobalLiveRegion /><RateLimitBanner /></>);
    act(() => { noteRateLimited(res429('3')); });
    await waitFor(() => {
      const spoken = Array.from(container.querySelectorAll('[data-owp-live]'))
        .some((el) => (el.textContent ?? '').includes('rateLimitedBanner:3'));
      const isAlert = screen.queryByTestId('rate-limit-banner')?.getAttribute('role') === 'alert';
      expect(spoken || isAlert).toBe(true);
    }, { timeout: 500 });
  });
});
