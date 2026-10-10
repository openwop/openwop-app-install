/**
 * ADR 0779 D7 — the Keys page offers only the writes the server accepts, and a
 * refused delete says what the server said.
 *
 *  - a member without `host:byok:manage` sees no add / delete controls and one
 *    read-only notice (they used to be offered every control and read
 *    `POST … → 403: Missing required scope`);
 *  - a 409 opens a SEPARATE danger confirmation (never a button that replaces
 *    the one just pressed) that NAMES the consumers (or says they could not be
 *    checked); only confirming it sends `force`;
 *  - a failed load reads as the localized message, not transport text.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ApiError } from '../../client/requestJson.js';

const access = { current: { access: { basis: 'tenant-owner', scopes: [] as string[] }, resolved: true } };
vi.mock('../../client/useEffectiveAccess.js', async (orig) => ({
  ...(await orig<object>()),
  useEffectiveAccessState: () => access.current,
}));
const listStoredRefs = vi.fn();
const deleteKey = vi.fn();
vi.mock('../lib/byokClient.js', async (orig) => ({
  ...(await orig<object>()),
  listStoredRefs: () => listStoredRefs(),
  deleteKey: (...a: unknown[]) => deleteKey(...a),
  getActiveConfig: () => Promise.resolve({ config: null, valid: false, anonymous: false }),
  getAiDefault: () => Promise.resolve(null),
}));
vi.mock('../../chrome/hubContext.js', () => ({ useHub: () => ({ embedded: true }) }));
vi.mock('../SubscriptionCredentialCard.js', () => ({ SubscriptionCredentialCard: () => null }));
interface ConfirmOpts { title: string; body?: unknown; confirmLabel?: string; danger?: boolean }
const confirmMock = vi.fn<(o: ConfirmOpts) => Promise<boolean>>();
vi.mock('../../ui/confirm.js', () => ({ confirm: (o: ConfirmOpts) => confirmMock(o) }));

const { KeysPage } = await import('../KeysPage.js');

beforeEach(() => {
  vi.clearAllMocks();
  access.current = { access: { basis: 'tenant-owner', scopes: [] }, resolved: true };
  listStoredRefs.mockResolvedValue(['anthropic:prod']);
});
afterEach(cleanup);

describe('KeysPage — ADR 0779 D7', () => {
  it('a member without host:byok:manage is offered no add or delete control', async () => {
    access.current = { access: { basis: 'member', scopes: ['workspace:read', 'workspace:write'] }, resolved: true };
    render(<KeysPage />);
    await screen.findAllByText('anthropic:prod');
    expect(screen.getByText(/Only workspace admins can add or remove AI keys/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Delete anthropic:prod' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Add .* key/ })).toBeNull();
  });

  it('an admin (polarity) is offered delete', async () => {
    render(<KeysPage />);
    expect(await screen.findByRole('button', { name: 'Delete anthropic:prod' })).toBeTruthy();
  });

  it('a 409 opens a separate danger confirmation naming the consumers; confirming sends force', async () => {
    deleteKey.mockRejectedValueOnce(new ApiError({ status: 409, statusText: 'Conflict', url: '/x', body: { error: 'conflict', details: { references: ['realtime voice (gemini-live)'] } } }));
    deleteKey.mockResolvedValueOnce(undefined);
    confirmMock.mockResolvedValueOnce(true);
    render(<KeysPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete anthropic:prod' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete key' }));
    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    const opts = confirmMock.mock.calls[0]![0];
    expect(opts).toMatchObject({ danger: true, confirmLabel: 'Delete anyway' });
    expect(opts.title).toMatch(/still in use, so it was not deleted/);
    render(<>{opts.body as JSX.Element}</>);
    expect(screen.getByText('realtime voice (gemini-live)')).toBeTruthy();
    await waitFor(() => expect(deleteKey).toHaveBeenLastCalledWith('anthropic:prod', { force: true }));
    // The in-page button never became the override.
    expect(screen.queryByRole('button', { name: 'Delete anyway' })).toBeNull();
  });

  it('declining the confirmation deletes nothing more', async () => {
    deleteKey.mockRejectedValueOnce(new ApiError({ status: 409, statusText: 'Conflict', url: '/x', body: { error: 'conflict', details: { references: ['x'] } } }));
    confirmMock.mockResolvedValueOnce(false);
    render(<KeysPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete anthropic:prod' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete key' }));
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(deleteKey).toHaveBeenCalledTimes(1);
  });

  it('a 409 the server could not verify says so instead of listing nothing', async () => {
    deleteKey.mockRejectedValueOnce(new ApiError({ status: 409, statusText: 'Conflict', url: '/x', body: { error: 'conflict', details: { referencesKnown: false } } }));
    confirmMock.mockResolvedValueOnce(false);
    render(<KeysPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete anthropic:prod' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete key' }));
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    expect(confirmMock.mock.calls[0]![0].title).toMatch(/couldn’t check what uses this key/);
  });

  it('a 403 on load reads as the permission message, not transport text', async () => {
    listStoredRefs.mockRejectedValue(new ApiError({ status: 403, statusText: 'Forbidden', url: '/host/openwop-app/byok/secrets' }));
    render(<KeysPage />);
    expect(await screen.findByText(/You don't have permission to do that here/)).toBeTruthy();
    expect(screen.queryByText(/byok\/secrets/)).toBeNull();
    // A failed read is not an empty store: no "No API keys yet", no add CTA.
    expect(screen.queryByText('No API keys yet')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add your first key' })).toBeNull();
  });
});
