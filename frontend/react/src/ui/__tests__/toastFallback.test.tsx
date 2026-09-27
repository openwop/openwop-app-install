/**
 * RFCW-UX-9: a spoken toast must never be invisible. When the lazy
 * `ToasterView` chunk cannot load (offline, or pruned by a deploy), `Toaster`
 * retries once and then renders the minimal in-entry fallback stack.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, within, fireEvent } from '@testing-library/react';

vi.mock('../ToasterView.js', () => { throw new Error('chunk load failed'); });

afterEach(cleanup);

describe('Toaster — the view chunk fails to load', () => {
  it('falls back to a visible, dismissible stack after one retry', async () => {
    const { Toaster, toast } = await import('../toast.js');
    render(<Toaster />);
    toast.error('Still visible');
    const region = await screen.findByRole('region', { name: 'Notifications' }, { timeout: 5000 });
    expect(within(region).getByText('Still visible')).toBeTruthy();
    fireEvent.click(within(region).getByRole('button', { name: 'Dismiss' }));
    expect(within(region).queryByText('Still visible')).toBeNull();
  }, 10_000);
});
