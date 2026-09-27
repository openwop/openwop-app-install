/**
 * ADR 0517 + ADR 0499 — "Remove key" must UNBIND before it deletes.
 *
 * Making the active chat binding a registered credentialRef consumer means
 * `DELETE /byok/secrets/:ref` now 409s while the chat still points at that key —
 * which is the whole point of the guard, and which would have broken this button
 * outright. The tempting shortcut, `?force=true`, bypasses EVERY consumer
 * including a realtime-voice binding on the same key: that is precisely the
 * orphaning ADR 0499 was written to stop. So the order is load-bearing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const deleteKey = vi.fn();
const clearActiveConfig = vi.fn();
const order: string[] = [];

vi.mock('../lib/byokClient.js', () => ({
  deleteKey: (...a: unknown[]) => { order.push('deleteKey'); return deleteKey(...a); },
  clearActiveConfig: (...a: unknown[]) => { order.push('clearActiveConfig'); return clearActiveConfig(...a); },
}));
vi.mock('../../ui/confirm.js', () => ({ confirm: () => Promise.resolve(true) }));

const { ConfiguredProviderCard } = await import('../ConfiguredProviderCard.js');

const config = { provider: 'google', model: 'gemini-3.1-flash-lite', credentialRef: 'byok:google' } as never;

beforeEach(() => {
  order.length = 0;
  vi.clearAllMocks();
  deleteKey.mockResolvedValue(undefined);
  clearActiveConfig.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe('ConfiguredProviderCard — remove key', () => {
  it('clears the binding BEFORE deleting the secret, so the 0499 guard cannot 409 it', async () => {
    const onRemoved = vi.fn();
    render(<ConfiguredProviderCard config={config} stored onChange={vi.fn()} onRemoved={onRemoved} />);

    fireEvent.click(screen.getByRole('button', { name: /remove|delete/i }));

    await waitFor(() => expect(onRemoved).toHaveBeenCalled());
    expect(order).toEqual(['clearActiveConfig', 'deleteKey']);
  });

  it('never force-deletes — that would orphan another feature\'s binding on the same key', async () => {
    render(<ConfiguredProviderCard config={config} stored onChange={vi.fn()} onRemoved={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /remove|delete/i }));

    await waitFor(() => expect(deleteKey).toHaveBeenCalled());
    expect(deleteKey).toHaveBeenCalledWith('byok:google');
    expect(JSON.stringify(deleteKey.mock.calls)).not.toMatch(/force/);
  });
});
