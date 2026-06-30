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
  });
});
