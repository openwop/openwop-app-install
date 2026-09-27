/**
 * ADR 0640 — the banner appears on the signal, counts down, and leaves on its own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: { seconds?: number }) => (o && o.seconds !== undefined ? `${k}:${o.seconds}` : k) }),
}));
import { RateLimitBanner } from '../RateLimitBanner.js';
import { _resetRateLimitSignal, noteRateLimited } from '../../client/rateLimitSignal.js';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-07T12:00:00Z')); _resetRateLimitSignal(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('RateLimitBanner', () => {
  it('is absent until a 429 is noted, then shows the countdown and disappears when it lapses', () => {
    render(<RateLimitBanner />);
    expect(screen.queryByTestId('rate-limit-banner')).toBeNull();

    act(() => { noteRateLimited(new Response(null, { status: 429, headers: { 'retry-after': '3' } })); });
    expect(screen.getByTestId('rate-limit-banner').textContent).toBe('rateLimitedBanner:3');

    act(() => { vi.advanceTimersByTime(1_000); });
    expect(screen.getByTestId('rate-limit-banner').textContent).toBe('rateLimitedBanner:2');

    act(() => { vi.advanceTimersByTime(2_500); });
    expect(screen.queryByTestId('rate-limit-banner')).toBeNull();
  });
});
