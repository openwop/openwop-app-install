/**
 * FP-2 — component coverage for the Connections headline page. The clients are
 * mocked, so this is a pure component test of the states the page must get right:
 * progressive load, the FP-4 independent-settle (a providers failure must NOT blank
 * the separately-fetched connections), the org-share gate (only offered to a caller
 * who holds `host:connections:manage`), and the revoke + create mutation flows.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

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
const accessState = vi.hoisted(() => ({ value: { access: { basis: 'member', scopes: ['workspace:write'] as string[] }, resolved: true } }));
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

/** A WORKSPACE row: neither `userId` nor `orgId` (omitted, not `undefined`). */
const workspaceConn = (over: Partial<Connection> = {}): Connection => {
  const { userId: _owner, ...row } = conn(over);
  return row;
};

beforeEach(() => {
  mProviders.mockReset(); mConnections.mockReset(); mCreate.mockReset(); mRevoke.mockReset(); mAccess.mockReset();
  mAccess.mockResolvedValue({ scopes: [] });
  accessState.value = { access: { basis: 'member', scopes: ['workspace:write'] }, resolved: true };
  vi.mocked(toast.error).mockReset();
});
afterEach(cleanup);

describe('ConnectionsManager (FP-2)', () => {
  it('loads providers + connections and renders a connection row', async () => {
    mProviders.mockResolvedValue([prov()]);
    mConnections.mockResolvedValue([conn()]);
    render(<ConnectionsManager />);
    await waitFor(() => expect(screen.getByText('My ServiceNow')).toBeTruthy());
    expect(mProviders).toHaveBeenCalled();
    expect(mConnections).toHaveBeenCalled();
  });

  it('surfaces independent retryable error states when both reads fail', async () => {
    mProviders.mockRejectedValue(new Error('load boom'));
    mConnections.mockRejectedValue(new Error('also boom'));
    render(<ConnectionsManager />);
    await waitFor(() => expect(screen.getByText('Providers could not be loaded')).toBeTruthy());
    expect(screen.getByText('Connections could not be loaded')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Retry' })).toHaveLength(2);
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
    mAccess.mockResolvedValue({ scopes: ['host:connections:manage'] });
    render(<ConnectionsManager />);
    await waitFor(() => expect(screen.getByText('Shared with')).toBeTruthy());
  });

  it('hides the org-share scope without the manage scope', async () => {
    mProviders.mockResolvedValue([prov()]);
    mConnections.mockResolvedValue([]);
    render(<ConnectionsManager />);
    await waitFor(() => expect(mProviders).toHaveBeenCalled());
    expect(screen.queryByText('Shared with')).toBeNull();
  });

  it('revokes a connection', async () => {
    // The destructive action is confirm()-gated (XC-1); without a mounted
    // <ConfirmRoot> it falls back to window.confirm — accept it.
    const origConfirm = window.confirm;
    window.confirm = () => true;
    mProviders.mockResolvedValue([prov()]);
    mConnections.mockResolvedValue([conn()]);
    mRevoke.mockResolvedValue(undefined);
    render(<ConnectionsManager />);
    await waitFor(() => expect(screen.getByText('My ServiceNow')).toBeTruthy());
    fireEvent.click(screen.getByLabelText(/revoke/i));
    await waitFor(() => expect(mRevoke).toHaveBeenCalledWith('c1'));
    window.confirm = origConfirm;
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
  });

  it('ADR 0780: a Viewer is not offered the connect controls — one read-only notice instead', async () => {
    accessState.value = { access: { basis: 'member', scopes: ['workspace:read'] }, resolved: true };
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
    const origConfirm = window.confirm;
    window.confirm = () => true;
    mProviders.mockResolvedValue([prov()]);
    mConnections.mockResolvedValue([conn()]);
    mRevoke.mockRejectedValue(new ApiError({ status: 403, statusText: 'Forbidden', url: '/x', body: { error: 'forbidden', message: 'Only the connecting user may manage this connection.' } }));
    render(<ConnectionsManager />);
    await waitFor(() => expect(screen.getByText('My ServiceNow')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Revoke My ServiceNow'));
    await waitFor(() => expect(vi.mocked(toast.error)).toHaveBeenCalled());
    const said = String(vi.mocked(toast.error).mock.calls[0]?.[0]);
    expect(said).not.toBe('Revoke failed.');
    expect(said).not.toContain('Only the connecting user');
    window.confirm = origConfirm;
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
    const origConfirm = window.confirm;
    window.confirm = () => true;
    mProviders.mockResolvedValue([prov()]);
    mConnections.mockResolvedValueOnce([conn()]).mockResolvedValue([]);
    mRevoke.mockResolvedValue(undefined);
    render(<ConnectionsManager />);
    await waitFor(() => expect(screen.getByText('My ServiceNow')).toBeTruthy());
    fireEvent.click(screen.getByLabelText('Revoke My ServiceNow'));
    await waitFor(() => expect(screen.getByText('No connections yet')).toBeTruthy());
    await waitFor(() => expect(document.activeElement?.tagName).toBe('H2'));
    window.confirm = origConfirm;
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
