/**
 * FP-2 — component coverage for the superadmin OAuth-client admin panel. The
 * load-bearing behavior is the FE-is-never-authority gate: the backend 403s a
 * non-superadmin (`ForbiddenError`), and the panel must HIDE itself rather than
 * render an action that would fail. Also covers the no-oauth-providers hide and
 * the set/remove mutation flows. Clients mocked.
 *
 * Every "renders nothing" case first SETTLES the load (the panel also renders
 * nothing while `loading`, so an emptiness check made before the reads land
 * passes for the wrong reason — wave 52). Since OAUTHADMIN-ERR-1 (#4882) a
 * non-403 failure is shown, so the 403 hide is load-bearing on the
 * `ForbiddenError` → `setHidden(true)` branch alone: drop it and the 403 renders
 * the error Notice ("forbidden") and the case goes red. The non-403 contrast
 * case is what keeps that distinction honest.
 *
 * Sabotage that turns it red: dropping the ForbiddenError branch, the
 * `oauthProviders.length === 0` hide, the not-configured chip, the trim on save,
 * the draft clear after save, or the confirm gate on Remove.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';

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
const secretInput = (): HTMLInputElement => document.querySelector<HTMLInputElement>('input[type="password"]')!;
/** Let both reads settle and the `.then/.catch/.finally` chain commit. */
const settle = (): Promise<void> => act(async () => { for (let i = 0; i < 5; i += 1) await new Promise<void>((r) => { setImmediate(r); }); });

beforeEach(() => { mProviders.mockReset(); mList.mockReset(); mSet.mockReset(); mDelete.mockReset(); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('OAuthClientAdminPanel (FP-2)', () => {
  it('HIDES itself for a non-superadmin (backend 403 → ForbiddenError)', async () => {
    mProviders.mockResolvedValue([google()]);
    mList.mockRejectedValue(new MockForbiddenError('forbidden'));
    const { container } = render(<OAuthClientAdminPanel />);
    await settle();
    expect(mList).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Google')).toBeNull(); // not rendered
    expect(screen.queryByText('forbidden')).toBeNull(); // not shown as an error either
    expect(container.textContent).toBe(''); // hidden entirely
  });

  // OAUTHADMIN-ERR-1 — the contrast that gives the 403 case meaning. A failed
  // read left `providers` empty and the panel returned null for that too, so
  // its error Notice was dead code and a superadmin whose read failed saw what
  // a non-superadmin sees. Only a 403 hides; any other failure is SHOWN, with a
  // Retry that re-reads. Sabotage: restore `if (oauthProviders.length === 0)
  // return null;` (drop `&& !error`) → red.
  it('a non-403 load failure is SHOWN, not hidden like a 403, and Retry re-reads (OAUTHADMIN-ERR-1)', async () => {
    mProviders.mockResolvedValue([google()]);
    mList.mockRejectedValueOnce(new Error('upstream 503'));
    render(<OAuthClientAdminPanel />);
    expect(await screen.findByText('upstream 503')).toBeTruthy();

    mList.mockResolvedValueOnce([cfg({ configured: false })]);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Google')).toBeTruthy();
    expect(screen.queryByText('upstream 503')).toBeNull();
    expect(mList).toHaveBeenCalledTimes(2);
  });

  it('renders for a superadmin with oauth providers (shows the not-configured state)', async () => {
    mProviders.mockResolvedValue([google()]);
    mList.mockResolvedValue([cfg({ configured: false })]);
    render(<OAuthClientAdminPanel />);
    await waitFor(() => expect(screen.getByText('Google')).toBeTruthy());
    expect(screen.getByText('Not configured')).toBeTruthy();
    expect(screen.queryByText('Configured')).toBeNull();
  });

  it('hides when there are no oauth providers (even for a superadmin)', async () => {
    mProviders.mockResolvedValue([{ id: 'sn', label: 'SN', kind: 'api_key', reach: 'user', refreshable: false }]);
    mList.mockResolvedValue([]);
    const { container } = render(<OAuthClientAdminPanel />);
    await settle();
    expect(mList).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe('');
  });

  it('saves a client id + secret for an unconfigured provider', async () => {
    mProviders.mockResolvedValue([google()]);
    mList.mockResolvedValue([]); // no existing config → the button is "Save" (not "Replace")
    mSet.mockResolvedValue(undefined);
    render(<OAuthClientAdminPanel />);
    await waitFor(() => expect(screen.getByText('Google')).toBeTruthy());
    fireEvent.change(editableText(), { target: { value: '  my-client-id  ' } });
    fireEvent.change(secretInput(), { target: { value: '  my-secret  ' } });
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(mSet).toHaveBeenCalledWith('google', 'my-client-id', 'my-secret'));
    // The secret is write-only: it leaves the DOM once saved.
    await waitFor(() => expect(secretInput().value).toBe(''));
    expect(editableText().value).toBe('');
  });

  it('removes a configured client', async () => {
    // The destructive action is confirm()-gated (XC-1); without a mounted
    // <ConfirmRoot> it falls back to window.confirm — accept it.
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    mProviders.mockResolvedValue([google()]);
    mList.mockResolvedValue([cfg({ configured: true })]);
    mDelete.mockResolvedValue(undefined);
    render(<OAuthClientAdminPanel />);
    await waitFor(() => expect(screen.getByText('Google')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /remove/i }));
    await waitFor(() => expect(mDelete).toHaveBeenCalledWith('google'));
  });

  it('a declined confirm removes nothing (XC-1)', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    mProviders.mockResolvedValue([google()]);
    mList.mockResolvedValue([cfg({ configured: true })]);
    mDelete.mockResolvedValue(undefined);
    render(<OAuthClientAdminPanel />);
    await waitFor(() => expect(screen.getByText('Google')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /remove/i }));
    await settle();
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(mDelete).not.toHaveBeenCalled();
  });
});
