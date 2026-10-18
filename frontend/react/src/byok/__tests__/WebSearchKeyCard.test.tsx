/**
 * WSRCH-6 (grade-code 2026-06-22) — the BYOK web-search key card (ADR 0101 Phase 3).
 * Pure component test: `byokClient` is mocked. Covers the write-only save (stores
 * under the bare `web-search` ref + clears the field), the configured/remove path,
 * and that the empty form can't submit.
 *
 * The 403 message on a failed remove is guarded TWICE (an honest double guard,
 * not a gap): `writeErrorMessage` maps `forbidden` first, and with no server
 * sentence a 403 falls through to `loadErrorMessage`, which classifies it the same
 * way. byokWriteAccess.test.ts "a 403 is the localized permission message" (a 403
 * WITH a body sentence) is the case that witnesses the first guard alone.
 *
 * Sabotage that turns these red (KeysPage.tsx WebSearchKeyCard): not clearing the
 * field, a different ref, `type="text"`, Save enabled when empty, skipping the
 * confirm, swallowing a remove failure, dropping `canManage` from the Remove or
 * the form gate.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { ApiError } from '../../client/requestJson.js';
import type { confirm } from '../../ui/confirm.js';

vi.mock('../lib/byokClient.js', () => ({
  storeKey: vi.fn(),
  deleteKey: vi.fn(),
  listStoredRefs: vi.fn(),
}));
// ADR 0779 D7 — Remove now asks first (it disables web search for every agent).
const confirmMock = vi.fn<typeof confirm>();
vi.mock('../../ui/confirm.js', () => ({ confirm: (...a: Parameters<typeof confirm>) => confirmMock(...a) }));
import { storeKey, deleteKey } from '../lib/byokClient.js';
import { WebSearchKeyCard } from '../KeysPage.js';

const mockStore = vi.mocked(storeKey);
const mockDelete = vi.mocked(deleteKey);

beforeEach(() => {
  mockStore.mockReset().mockResolvedValue({ credentialRef: 'web-search', masked: '••••' });
  mockDelete.mockReset().mockResolvedValue(undefined);
  confirmMock.mockReset().mockResolvedValue(true);
});
afterEach(cleanup);

describe('WebSearchKeyCard (WSRCH-6)', () => {
  it('stores the key under the bare `web-search` ref and clears the field (write-only)', async () => {
    const onChanged = vi.fn().mockResolvedValue(undefined);
    render(<WebSearchKeyCard configured={false} onChanged={onChanged} />);

    const input = screen.getByLabelText('Search-provider API key') as HTMLInputElement;
    expect(input.type).toBe('password'); // never echoed as plain text
    fireEvent.change(input, { target: { value: 'brave-secret-123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mockStore).toHaveBeenCalledWith('web-search', 'brave-secret-123'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(input.value).toBe(''); // write-only: cleared after save
  });

  it('the Save button is disabled until a value is entered', () => {
    render(<WebSearchKeyCard configured={false} onChanged={vi.fn()} />);
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('when configured, shows a Remove action that deletes the `web-search` ref', async () => {
    const onChanged = vi.fn().mockResolvedValue(undefined);
    render(<WebSearchKeyCard configured={true} onChanged={onChanged} />);

    // No edit form by default when configured.
    expect(screen.queryByLabelText('Search-provider API key')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /remove/i }));

    await waitFor(() => expect(mockDelete).toHaveBeenCalledWith('web-search'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(confirmMock).toHaveBeenCalled();
  });

  it('ADR 0779 D7 — a declined confirm removes nothing, and a failed remove says so (no unhandled rejection)', async () => {
    confirmMock.mockResolvedValueOnce(false);
    const onChanged = vi.fn();
    render(<WebSearchKeyCard configured={true} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: /remove/i }));
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(mockDelete).not.toHaveBeenCalled();

    mockDelete.mockRejectedValueOnce(new ApiError({ status: 403, statusText: 'Forbidden', url: '/host/openwop-app/byok/secrets/web-search' }));
    fireEvent.click(screen.getByRole('button', { name: /remove/i }));
    expect(await screen.findByText(/You don't have permission to do that here/)).toBeTruthy();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('ADR 0779 D7 — a caller who cannot manage keys is offered no Remove on a configured key', () => {
    render(<WebSearchKeyCard configured={true} onChanged={vi.fn()} canManage={false} />);
    expect(screen.queryByRole('button', { name: /remove/i })).toBeNull();
  });

  it('ADR 0779 D7 — a caller who cannot manage keys is offered no key form when none is configured', () => {
    // configured={false} is the state where the form WOULD show (case 1 is the
    // positive control); with configured={true} it is hidden for everyone, so the
    // permission gate was never exercised there.
    render(<WebSearchKeyCard configured={false} onChanged={vi.fn()} canManage={false} />);
    expect(screen.queryByLabelText('Search-provider API key')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });
});
