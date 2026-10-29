/**
 * FP-2 — component coverage for the Connections headline page. The clients are
 * mocked, so this is a pure component test of the states the page must get right:
 * progressive load, the FP-4 independent-settle (a providers failure must NOT blank
 * the separately-fetched connections), the org-share gate (only offered to a caller
 * who holds `host:connections:manage`), and the revoke + create mutation flows.
 *
 * Wave 52: the "hides the org-share scope" case settles the ACCESS read before
 * asserting absence (`canManageOrg` starts false, so an absence check made while
 * `getEffectiveAccess` is in flight passed for the wrong reason); the create case
 * checks the secret leaves the DOM; a declined confirm revokes nothing; a refused
 * write shows the exact shared forbidden copy.
 * Sabotage that turns it red: granting org-share without the scope, keeping the
 * secret after save, dropping the revoke confirm, or printing the server's 403
 * sentence.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';

vi.mock('../connectionsClient.js', () => ({
  listProviders: vi.fn(),
  listConnections: vi.fn(),
  createConnection: vi.fn(),
  revokeConnection: vi.fn(),
  beginOAuth: vi.fn(),
  testConnection: vi.fn(),
}));
vi.mock('../../../client/accessClient.js', () => ({ getEffectiveAccess: vi.fn() }));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// ADR 0780 — the write-access hook reads this; a test sets the caller's role.
const accessState = vi.hoisted((): { value: { access: EffectiveAccess; resolved: boolean } } => ({ value: { access: { roles: [], basis: 'member', scopes: ['workspace:write'] }, resolved: true } }));
vi.mock('../../../client/useEffectiveAccess.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../client/useEffectiveAccess.js')>();
  return { ...real, useEffectiveAccessState: () => accessState.value };
});

import {
  listProviders, listConnections, createConnection, revokeConnection,
  type Provider, type Connection,
} from '../connectionsClient.js';
import { getEffectiveAccess, type EffectiveAccess } from '../../../client/accessClient.js';
import { ConnectionsManager } from '../ConnectionsManager.js';
import { toast } from '../../../ui/toast.js';
import { ApiError } from '../../../client/requestJson.js';
import { HubProvider } from '../../../chrome/hubContext.js';

const mProviders = vi.mocked(listProviders);
const mConnections = vi.mocked(listConnections);
const mCreate = vi.mocked(createConnection);
const mRevoke = vi.mocked(revokeConnection);
const mAccess = vi.mocked(getEffectiveAccess);

const prov = (over: Partial<Provider> = {}): Provider =>
  ({ id: 'servicenow', label: 'ServiceNow', kind: 'api_key', reach: 'user', refreshable: false, oauthConfigured: false, writeScopes: [], ...over });
const conn = (over: Partial<Connection> = {}): Connection =>
  ({ connectionId: 'c1', provider: 'servicenow', kind: 'api_key', displayName: 'My ServiceNow', status: 'active', scopes: [], connectedAt: '2026-06-22T00:00:00Z', userId: 'user:me', ...over });

const ADMIN_ACCESS: EffectiveAccess = { roles: ['admin'], scopes: ['host:connections:manage'], basis: 'member' };
const MEMBER_ACCESS: EffectiveAccess = { roles: [], scopes: [], basis: 'member' };
const FORBIDDEN_COPY = "You don't have permission to do that here. Ask an admin of this workspace for access.";
const settle = (): Promise<void> => act(async () => { for (let i = 0; i < 5; i += 1) await new Promise<void>((r) => { setImmediate(r); }); });

/** A WORKSPACE row: neither `userId` nor `orgId` (omitted, not `undefined`). */
const workspaceConn = (over: Partial<Connection> = {}): Connection => {
  const { userId: _owner, ...row } = conn(over);
  return row;
};

beforeEach(() => {
  mProviders.mockReset(); mConnections.mockReset(); mCreate.mockReset(); mRevoke.mockReset(); mAccess.mockReset();
  mAccess.mockResolvedValue({ ...MEMBER_ACCESS });
  accessState.value = { access: { roles: [], basis: 'member', scopes: ['workspace:write'] }, resolved: true };
  vi.mocked(toast.error).mockReset();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('ConnectionsManager (FP-2)', () => {
  it('loads providers + connections and renders a connection row', async () => {
    mProviders.mockResolvedValue([prov()]);
    mConnections.mockResolvedValue([conn()]);
    render(<ConnectionsManager />);
    await waitFor(() => expect(screen.getByText('My ServiceNow')).toBeTruthy());
    expect(screen.getByText('Connect')).toBeTruthy(); // the providers half landed too
  });

  it('surfaces independent retryable error states when both reads fail', async () => {
    mProviders.mockRejectedValue(new Error('load boom'));
    mConnections.mockRejectedValue(new Error('also boom'));
    render(<ConnectionsManager />);
    await waitFor(() => expect(screen.getByText('Providers could not be loaded')).toBeTruthy());
    expect(screen.getByText('Connections could not be loaded')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(2);
    // A failed read is not "nothing here": no empty state, no connect form.
    expect(screen.queryByText('No connections yet')).toBeNull();
    expect(screen.queryByText('Connect')).toBeNull();
  });

  it('FP-4: a providers failure does NOT blank the connections list (independent settle)', async () => {
    mProviders.mockRejectedValue(new Error('providers down'));
    mConnections.mockResolvedValue([conn({ displayName: 'Still Here' })]);
    render(<ConnectionsManager />);
    await waitFor(() => expect(screen.getByText('Still Here')).toBeTruthy()); // connections rendered
    expect(screen.getByText('Providers could not be loaded')).toBeTruthy(); // error still surfaced
    expect(screen.queryByText('Connections could not be loaded')).toBeNull();
  });

  it('offers the org-share scope ONLY to a caller with host:connections:manage', async () => {
    mProviders.mockResolvedValue([prov()]);
    mConnections.mockResolvedValue([]);
    mAccess.mockResolvedValue({ ...MEMBER_ACCESS, scopes: ['host:connections:manage'] });
    render(<ConnectionsManager />);
    await waitFor(() => expect(screen.getByText('Shared with')).toBeTruthy());
  });

  it('hides the org-share scope without the manage scope', async () => {
    mProviders.mockResolvedValue([prov()]);
    mConnections.mockResolvedValue([]);
    render(<ConnectionsManager />);
    // Settle the access read itself — `canManageOrg` starts false, so absence
    // asserted before it lands proves nothing.
    await waitFor(() => expect(mAccess).toHaveBeenCalled());
    await act(async () => { await mAccess.mock.results[0]!.value; });
    await settle();
    expect(screen.getByText('Connect')).toBeTruthy(); // positive control: the form is up
    expect(screen.queryByText('Shared with')).toBeNull();
  });

  it('revokes a connection', async () => {
    // The destructive action is confirm()-gated (XC-1); without a mounted
    // <ConfirmRoot> it falls back to window.confirm — accepted in beforeEach.
    mProviders.mockResolvedValue([prov()]);
    mConnections.mockResolvedValue([conn()]);
    mRevoke.mockResolvedValue(undefined);
    render(<ConnectionsManager />);
    await waitFor(() => expect(screen.getByText('My ServiceNow')).toBeTruthy());
    fireEvent.click(screen.getByLabelText(/revoke/i));
    await waitFor(() => expect(mRevoke).toHaveBeenCalledWith('c1'));
  });

  it('a declined revoke confirm revokes nothing (XC-1)', async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    mProviders.mockResolvedValue([prov()]);
    mConnections.mockResolvedValue([conn()]);
    mRevoke.mockResolvedValue(undefined);
    render(<ConnectionsManager />);
    await waitFor(() => expect(screen.getByText('My ServiceNow')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Revoke My ServiceNow'));
    await settle();
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(mRevoke).not.toHaveBeenCalled();
    expect(screen.getByText('My ServiceNow')).toBeTruthy();
  });

  it('creates a connection from the secret form (secret trimmed, scoped to the user by default)', async () => {
    mProviders.mockResolvedValue([prov()]);
    mConnections.mockResolvedValue([]);
    mCreate.mockResolvedValue(conn());
    render(<ConnectionsManager />);
    await waitFor(() => expect(screen.getByText('Connect')).toBeTruthy());
    const secret = document.querySelector('input[type="password"]') as HTMLInputElement;
    fireEvent.change(secret, { target: { value: '  super-secret  ' } });
    fireEvent.click(screen.getByText('Connect'));
    await waitFor(() => expect(mCreate).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'servicenow', secret: 'super-secret', scope: 'user' }),
    ));
    // The secret is write-only: it leaves the DOM once the connection is made.
    await waitFor(() => expect(secret.value).toBe(''));
  });

  it('ADR 0994: an admin can create a workspace-default row, the only kind an unattended send resolves', async () => {
    mProviders.mockResolvedValue([prov({ id: 'postmark', label: 'Postmark' })]);
    mConnections.mockResolvedValue([]);
    mCreate.mockResolvedValue(workspaceConn({ provider: 'postmark' }));
    mAccess.mockResolvedValue({ ...ADMIN_ACCESS });
    render(<ConnectionsManager />);
    await waitFor(() => expect(screen.getByText('Shared with')).toBeTruthy());
    fireEvent.change(screen.getByRole('combobox', { name: 'Provider (API key / token)' }), { target: { value: 'postmark' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Shared with' }), { target: { value: 'workspace' } });
    expect(screen.getByText(/approval notices and scheduled campaigns/)).toBeTruthy();
    fireEvent.change(document.querySelector('input[type="password"]') as HTMLInputElement, { target: { value: 'server-token' } });
    fireEvent.click(screen.getByText('Connect'));
    await waitFor(() => expect(mCreate).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'postmark', secret: 'server-token', scope: 'workspace' }),
    ));
    expect(toast.success).toHaveBeenCalledWith('Postmark connected for the whole workspace.');
  });

  it('ADR 0994: under the hub Workspace pill an admin chooses org-shared or workspace-default; Personal offers neither', async () => {
    mProviders.mockResolvedValue([prov()]);
    mConnections.mockResolvedValue([]);
    mAccess.mockResolvedValue({ ...ADMIN_ACCESS });
    const { unmount } = render(<HubProvider scope="workspace"><ConnectionsManager /></HubProvider>);
    await waitFor(() => expect(screen.getByText('Shared with')).toBeTruthy());
    const options = [...(screen.getByRole('combobox', { name: 'Shared with' }) as HTMLSelectElement).options].map((o) => o.value);
    expect(options).toEqual(['org', 'workspace']);
    unmount();
    render(<HubProvider scope="personal"><ConnectionsManager /></HubProvider>);
    await waitFor(() => expect(mAccess).toHaveBeenCalledTimes(2));
    await act(async () => { await mAccess.mock.results[1]!.value; });
    await settle();
    expect(screen.getByText('Connect')).toBeTruthy();
    expect(screen.queryByText('Shared with')).toBeNull();
  });

  it('ADR 0780: a Viewer is not offered the connect controls — one read-only notice instead', async () => {
    accessState.value = { access: { roles: [], basis: 'member', scopes: ['workspace:read'] }, resolved: true };
    mProviders.mockResolvedValue([prov(), prov({ id: 'slack', label: 'Slack', kind: 'oauth2', oauthConfigured: true })]);
    mConnections.mockResolvedValue([conn()]);
    render(<ConnectionsManager />);
    await waitFor(() => expect(screen.getByText('My ServiceNow')).toBeTruthy());
    expect(screen.getByText(/don't have permission to connect new accounts/)).toBeTruthy();
    expect(screen.queryByText('Connect')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Connect Slack' })).toBeNull();
    // Their OWN row can still be revoked (the server allows it to every role).
    expect(screen.getByLabelText('Revoke My ServiceNow')).toBeTruthy();
  });

  it('ADR 0780: a workspace row is labelled Workspace, and a non-admin gets no manage buttons for it', async () => {
    mProviders.mockResolvedValue([prov()]);
    mConnections.mockResolvedValue([workspaceConn({ connectionId: 'ws1', displayName: 'Shared ServiceNow' })]);
    render(<ConnectionsManager />);
    await waitFor(() => expect(screen.getByText('Shared ServiceNow')).toBeTruthy());
    expect(screen.getByText('Workspace')).toBeTruthy();
    expect(screen.queryByText('Personal')).toBeNull();
    expect(screen.getByText('Managed by an admin')).toBeTruthy();
    expect(screen.queryByLabelText('Revoke Shared ServiceNow')).toBeNull();
  });

  it('ADR 0780: an admin keeps the manage buttons on a workspace row', async () => {
    mAccess.mockResolvedValue({ ...ADMIN_ACCESS });
    mProviders.mockResolvedValue([prov()]);
    mConnections.mockResolvedValue([workspaceConn({ connectionId: 'ws1', displayName: 'Shared ServiceNow' })]);
    render(<ConnectionsManager />);
    await waitFor(() => expect(screen.getByLabelText('Revoke Shared ServiceNow')).toBeTruthy());
  });

  it('ADR 0780: a refused write says so (common:error_forbidden), not "Revoke failed."', async () => {
    mProviders.mockResolvedValue([prov()]);
    mConnections.mockResolvedValue([conn()]);
    mRevoke.mockRejectedValue(new ApiError({ status: 403, statusText: 'Forbidden', url: '/x', body: { error: 'forbidden', message: 'Only the connecting user may manage this connection.' } }));
    render(<ConnectionsManager />);
    await waitFor(() => expect(screen.getByText('My ServiceNow')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Revoke My ServiceNow'));
    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalled());
    expect(vi.mocked(toast.error).mock.calls[0]?.[0]).toBe(FORBIDDEN_COPY);
  });

  it('ADR 0780: status is a localized label and a needs-reconsent oauth row offers Reconnect in place', async () => {
    mProviders.mockResolvedValue([prov({ id: 'slack', label: 'Slack', kind: 'oauth2', oauthConfigured: true })]);
    mConnections.mockResolvedValue([conn({ provider: 'slack', kind: 'oauth2', displayName: 'My Slack', status: 'needs-reconsent' })]);
    render(<ConnectionsManager />);
    await waitFor(() => expect(screen.getByText('My Slack')).toBeTruthy());
    expect(screen.getByText('Needs reconnecting')).toBeTruthy();
    expect(screen.getByLabelText('Reconnect My Slack')).toBeTruthy();
  });

  it('CONNUX-6: revoking the LAST row lands focus on the list heading, not <body>', async () => {
    mProviders.mockResolvedValue([prov()]);
    mConnections.mockResolvedValueOnce([conn()]).mockResolvedValue([]);
    mRevoke.mockResolvedValue(undefined);
    render(<ConnectionsManager />);
    await waitFor(() => expect(screen.getByText('My ServiceNow')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Revoke My ServiceNow'));
    await waitFor(() => expect(screen.getByText('No connections yet')).toBeTruthy());
    await waitFor(() => expect(document.activeElement?.tagName).toBe('H2'));
  });

  it('CONNUX-6: an in-flight row action is aria-disabled, never natively disabled (focus stays put)', async () => {
    let finish!: (v: { ok: boolean; status: string }) => void;
    const { testConnection } = await import('../connectionsClient.js');
    vi.mocked(testConnection).mockImplementation(() => new Promise((r) => { finish = r; }));
    mProviders.mockResolvedValue([prov()]);
    mConnections.mockResolvedValue([conn()]);
    render(<ConnectionsManager />);
    await waitFor(() => expect(screen.getByText('My ServiceNow')).toBeTruthy());
    const btn = screen.getByLabelText('Test My ServiceNow') as HTMLButtonElement;
    btn.focus();
    fireEvent.click(btn);
    await waitFor(() => expect(btn.getAttribute('aria-disabled')).toBe('true'));
    expect(btn.disabled).toBe(false);
    expect(document.activeElement).toBe(btn);
    finish({ ok: true, status: 'active' });
  });

  it('a provider-allowlist 403 says it is a policy, not the caller\'s role', async () => {
    mProviders.mockResolvedValue([prov()]);
    mConnections.mockResolvedValue([]);
    mCreate.mockRejectedValue(new ApiError({ status: 403, statusText: 'Forbidden', url: '/x', body: { error: 'forbidden', message: 'x', details: { provider: 'servicenow' } } }));
    render(<ConnectionsManager />);
    await waitFor(() => expect(screen.getByText('Connect')).toBeTruthy());
    fireEvent.change(document.querySelector('input[type="password"]') as HTMLInputElement, { target: { value: 'k' } });
    fireEvent.click(screen.getByText('Connect'));
    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalled());
    expect(String(vi.mocked(toast.error).mock.calls[0]?.[0])).toMatch(/allowlist/);
  });
});
