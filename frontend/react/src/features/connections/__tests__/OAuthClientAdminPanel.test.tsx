/**
 * FP-2 — component coverage for the superadmin OAuth-client admin panel. The
 * load-bearing behavior is the FE-is-never-authority gate: the backend 403s a
 * non-superadmin (`ForbiddenError`), and the panel must HIDE itself rather than
 * render an action that would fail. Also covers the no-oauth-providers hide and
 * the set/remove mutation flows. Clients mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

// Defined via vi.hoisted so it exists when the hoisted vi.mock factory runs.
const { MockForbiddenError } = vi.hoisted(() => {
  class MockForbiddenError extends Error {}
  return { MockForbiddenError };
});

vi.mock('../connectionsClient.js', () => ({
  ForbiddenError: MockForbiddenError,
  listProviders: vi.fn(),
  listOAuthClients: vi.fn(),
  setOAuthClient: vi.fn(),
  deleteOAuthClient: vi.fn(),
}));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import {
  listProviders, listOAuthClients, setOAuthClient, deleteOAuthClient,
  type Provider, type OAuthClientConfig,
} from '../connectionsClient.js';
import { OAuthClientAdminPanel } from '../OAuthClientAdminPanel.js';

const mProviders = vi.mocked(listProviders);
const mList = vi.mocked(listOAuthClients);
const mSet = vi.mocked(setOAuthClient);
const mDelete = vi.mocked(deleteOAuthClient);

const google = (over: Partial<Provider> = {}): Provider =>
  ({ id: 'google', label: 'Google', kind: 'oauth2', reach: 'user', refreshable: true, oauthConfigured: true, ...over });
const cfg = (over: Partial<OAuthClientConfig> = {}): OAuthClientConfig =>
  ({ provider: 'google', clientId: 'abc.apps', configured: false, updatedAt: '2026-06-22T00:00:00Z', ...over });

const editableText = (): HTMLInputElement =>
  Array.from(document.querySelectorAll<HTMLInputElement>('input[type="text"]')).find((i) => !i.readOnly)!;

beforeEach(() => { mProviders.mockReset(); mList.mockReset(); mSet.mockReset(); mDelete.mockReset(); });
afterEach(cleanup);

describe('OAuthClientAdminPanel (FP-2)', () => {
  it('HIDES itself for a non-superadmin (backend 403 → ForbiddenError)', async () => {
    mProviders.mockResolvedValue([google()]);
    mList.mockRejectedValue(new MockForbiddenError('forbidden'));
    const { container } = render(<OAuthClientAdminPanel />);
    await waitFor(() => expect(mList).toHaveBeenCalled());
    expect(screen.queryByText('Google')).toBeNull(); // not rendered
    expect(container.textContent).toBe(''); // hidden entirely
  });

  it('renders for a superadmin with oauth providers (shows the not-configured state)', async () => {
    mProviders.mockResolvedValue([google()]);
    mList.mockResolvedValue([cfg({ configured: false })]);
    render(<OAuthClientAdminPanel />);
    await waitFor(() => expect(screen.getByText('Google')).toBeTruthy());
  });

  it('hides when there are no oauth providers (even for a superadmin)', async () => {
    mProviders.mockResolvedValue([{ id: 'sn', label: 'SN', kind: 'api_key', reach: 'user', refreshable: false }]);
    mList.mockResolvedValue([]);
    const { container } = render(<OAuthClientAdminPanel />);
    await waitFor(() => expect(mList).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  it('saves a client id + secret for an unconfigured provider', async () => {
    mProviders.mockResolvedValue([google()]);
    mList.mockResolvedValue([]); // no existing config → the button is "Save" (not "Replace")
    mSet.mockResolvedValue(undefined);
    render(<OAuthClientAdminPanel />);
    await waitFor(() => expect(screen.getByText('Google')).toBeTruthy());
    fireEvent.change(editableText(), { target: { value: 'my-client-id' } });
    fireEvent.change(document.querySelector('input[type="password"]') as HTMLInputElement, { target: { value: 'my-secret' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(mSet).toHaveBeenCalledWith('google', 'my-client-id', 'my-secret'));
  });

  it('removes a configured client', async () => {
    mProviders.mockResolvedValue([google()]);
    mList.mockResolvedValue([cfg({ configured: true })]);
    mDelete.mockResolvedValue(undefined);
    render(<OAuthClientAdminPanel />);
    await waitFor(() => expect(screen.getByText('Google')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /remove/i }));
    await waitFor(() => expect(mDelete).toHaveBeenCalledWith('google'));
  });
});
