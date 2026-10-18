/**
 * RFCW-UX-9: a spoken toast must never be invisible. When the lazy
 * `ToasterView` chunk cannot load (offline, or pruned by a deploy), `Toaster`
 * retries once (after 2 s) and then renders the minimal in-entry fallback stack.
 *
 * Fake timers drive the retry delay, which both removes a real 2 s wait and makes
 * the retry OBSERVABLE: the fallback must not exist before the retry window has
 * elapsed. Before this, a loader that fell back with no retry stayed green (w49
 * probe `tf-retry`).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, within, fireEvent, waitFor, act } from '@testing-library/react';

vi.mock('../ToasterView.js', () => { throw new Error('chunk load failed'); });

afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('Toaster — the view chunk fails to load', () => {
  it('falls back to a visible, dismissible stack after one retry', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { Toaster, toast } = await import('../toast.js');
    render(<Toaster />);
    toast.error('Still visible');
    // Inside the retry window: the first import has failed, the retry has not run.
    await act(() => vi.advanceTimersByTimeAsync(1500));
    expect(screen.queryByRole('region', { name: 'Notifications' })).toBeNull();
    // Past it: the retry fails too, and the fallback renders.
    await act(() => vi.advanceTimersByTimeAsync(600));
    const region = await screen.findByRole('region', { name: 'Notifications' }, { timeout: 5000 });
    expect(within(region).getByText('Still visible')).toBeTruthy();
    fireEvent.click(within(region).getByRole('button', { name: 'Dismiss' }));
    // The dismissal renders asynchronously; a synchronous read races it under load (#4176).
    await waitFor(() => expect(within(region).queryByText('Still visible')).toBeNull(), { timeout: 5000 });
  }, 10_000);
});
