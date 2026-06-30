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

import {
  listProviders, listConnections, createConnection, revokeConnection,
  type Provider, type Connection,
} from '../connectionsClient.js';
import { getEffectiveAccess } from '../../../client/accessClient.js';
import { ConnectionsManager } from '../ConnectionsManager.js';

const mProviders = vi.mocked(listProviders);
const mConnections = vi.mocked(listConnections);
const mCreate = vi.mocked(createConnection);
const mRevoke = vi.mocked(revokeConnection);
const mAccess = vi.mocked(getEffectiveAccess);

const prov = (over: Partial<Provider> = {}): Provider =>
  ({ id: 'servicenow', label: 'ServiceNow', kind: 'api_key', reach: 'user', refreshable: false, oauthConfigured: false, writeScopes: [], ...over });
const conn = (over: Partial<Connection> = {}): Connection =>
  ({ connectionId: 'c1', provider: 'servicenow', kind: 'api_key', displayName: 'My ServiceNow', status: 'active', scopes: [], connectedAt: '2026-06-22T00:00:00Z', ...over });

beforeEach(() => {
  mProviders.mockReset(); mConnections.mockReset(); mCreate.mockReset(); mRevoke.mockReset(); mAccess.mockReset();
  mAccess.mockResolvedValue({ scopes: [] });
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

  it('surfaces an error Notice when a load fails', async () => {
    mProviders.mockRejectedValue(new Error('load boom'));
    mConnections.mockRejectedValue(new Error('also boom'));
    render(<ConnectionsManager />);
    await waitFor(() => expect(screen.getByText('load boom')).toBeTruthy());
  });

  it('FP-4: a providers failure does NOT blank the connections list (independent settle)', async () => {
    mProviders.mockRejectedValue(new Error('providers down'));
    mConnections.mockResolvedValue([conn({ displayName: 'Still Here' })]);
    render(<ConnectionsManager />);
    await waitFor(() => expect(screen.getByText('Still Here')).toBeTruthy()); // connections rendered
    expect(screen.getByText('providers down')).toBeTruthy(); // error still surfaced
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
    mProviders.mockResolvedValue([prov()]);
    mConnections.mockResolvedValue([conn()]);
    mRevoke.mockResolvedValue(undefined);
    render(<ConnectionsManager />);
    await waitFor(() => expect(screen.getByText('My ServiceNow')).toBeTruthy());
    fireEvent.click(screen.getByLabelText(/revoke/i));
    await waitFor(() => expect(mRevoke).toHaveBeenCalledWith('c1'));
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
});
