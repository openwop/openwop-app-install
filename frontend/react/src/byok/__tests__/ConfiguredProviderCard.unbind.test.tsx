/**
 * ADR 0517 + ADR 0499 — "Remove key" must UNBIND before it deletes.
 *
 * Making the active chat binding a registered credentialRef consumer means
 * `DELETE /byok/secrets/:ref` now 409s while the chat still points at that key —
 * which is the whole point of the guard, and which would have broken this button
 * outright. The tempting shortcut, `?force=true`, bypasses EVERY consumer
 * including a realtime-voice binding on the same key: that is precisely the
 * orphaning ADR 0499 was written to stop. So the order is load-bearing.
 *
 * Sabotage that turns these red (ConfiguredProviderCard.tsx `onDelete`): deleting
 * before unbinding; passing `{ force: true }` to `deleteKey`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type * as ByokClient from '../lib/byokClient.js';
import type { BYOKActiveConfig } from '../lib/useBYOKConfig.js';

const deleteKey = vi.fn<typeof ByokClient.deleteKey>();
const clearActiveConfig = vi.fn<typeof ByokClient.clearActiveConfig>();
const order: string[] = [];

vi.mock('../lib/byokClient.js', () => ({
  deleteKey: (...a: Parameters<typeof ByokClient.deleteKey>) => { order.push('deleteKey'); return deleteKey(...a); },
  clearActiveConfig: (...a: Parameters<typeof ByokClient.clearActiveConfig>) => { order.push('clearActiveConfig'); return clearActiveConfig(...a); },
}));
vi.mock('../../ui/confirm.js', () => ({ confirm: () => Promise.resolve(true) }));

const { ConfiguredProviderCard } = await import('../ConfiguredProviderCard.js');

const config: BYOKActiveConfig = { provider: 'google', model: 'gemini-3.1-flash-lite', credentialRef: 'byok:google' };

beforeEach(() => {
  order.length = 0;
  deleteKey.mockReset().mockResolvedValue(undefined);
  clearActiveConfig.mockReset().mockResolvedValue(undefined);
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
    // Exactly the ref and NO options argument: `{ force: true }` (or any opts) is absent.
    expect(deleteKey.mock.calls).toEqual([['byok:google']]);
  });
});
