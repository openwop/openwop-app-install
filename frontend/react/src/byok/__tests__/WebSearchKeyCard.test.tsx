/**
 * WSRCH-6 (grade-code 2026-06-22) — the BYOK web-search key card (ADR 0101 Phase 3).
 * Pure component test: `byokClient` is mocked. Covers the write-only save (stores
 * under the bare `web-search` ref + clears the field), the configured/remove path,
 * and that the empty form can't submit.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

vi.mock('../lib/byokClient.js', () => ({
  storeKey: vi.fn().mockResolvedValue(undefined),
  deleteKey: vi.fn().mockResolvedValue(undefined),
  listStoredRefs: vi.fn().mockResolvedValue([]),
}));
// ADR 0779 D7 — Remove now asks first (it disables web search for every agent).
const confirmMock = vi.fn().mockResolvedValue(true);
vi.mock('../../ui/confirm.js', () => ({ confirm: (...a: unknown[]) => confirmMock(...a) }));
import { storeKey, deleteKey } from '../lib/byokClient.js';
import { WebSearchKeyCard } from '../KeysPage.js';

const mockStore = vi.mocked(storeKey);
const mockDelete = vi.mocked(deleteKey);

beforeEach(() => { mockStore.mockClear(); mockDelete.mockClear(); });
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

    mockDelete.mockRejectedValueOnce(Object.assign(new Error('DELETE … → 403'), { status: 403 }));
    fireEvent.click(screen.getByRole('button', { name: /remove/i }));
    expect(await screen.findByText(/You don't have permission to do that here/)).toBeTruthy();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('ADR 0779 D7 — a caller who cannot manage keys is offered neither the form nor Remove', () => {
    render(<WebSearchKeyCard configured={true} onChanged={vi.fn()} canManage={false} />);
    expect(screen.queryByRole('button', { name: /remove/i })).toBeNull();
    expect(screen.queryByLabelText('Search-provider API key')).toBeNull();
  });
});
