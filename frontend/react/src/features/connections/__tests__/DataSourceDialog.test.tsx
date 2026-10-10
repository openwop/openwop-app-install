/**
 * ADR 0783 D1 — the SPA half of a data source. A writer can set and clear a
 * connection's base URL from its row; the host's refusal (its URL rule) is shown
 * beside the field; a Viewer is never offered the action.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';

vi.mock('../connectionsClient.js', () => ({
  listProviders: vi.fn(),
  listConnections: vi.fn(),
  createConnection: vi.fn(),
  revokeConnection: vi.fn(),
  beginOAuth: vi.fn(),
  testConnection: vi.fn(),
  setDataSource: vi.fn(),
}));
vi.mock('../../../client/accessClient.js', () => ({ getEffectiveAccess: vi.fn() }));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const accessState = vi.hoisted(() => ({ value: { access: { basis: 'member', scopes: ['workspace:write'] as string[] }, resolved: true } }));
vi.mock('../../../client/useEffectiveAccess.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../client/useEffectiveAccess.js')>();
  return { ...real, useEffectiveAccessState: () => accessState.value };
});

import { listProviders, listConnections, setDataSource, type Connection } from '../connectionsClient.js';
import { getEffectiveAccess } from '../../../client/accessClient.js';
import { ConnectionsManager } from '../ConnectionsManager.js';
import { toast } from '../../../ui/toast.js';
import { ApiError } from '../../../client/requestJson.js';

const row = (over: Partial<Connection> = {}): Connection =>
  ({ connectionId: 'c1', provider: 'servicenow', kind: 'api_key', displayName: 'My ServiceNow', status: 'active', scopes: [], connectedAt: '2026-10-08T00:00:00Z', userId: 'user:me', ...over });

beforeEach(() => {
  vi.mocked(listProviders).mockResolvedValue([{ id: 'servicenow', label: 'ServiceNow', kind: 'api_key', reach: 'user', refreshable: false }]);
  vi.mocked(listConnections).mockReset();
  vi.mocked(setDataSource).mockReset();
  vi.mocked(getEffectiveAccess).mockResolvedValue({ roles: [], scopes: [], basis: 'member' });
  vi.mocked(toast.success).mockReset();
  accessState.value = { access: { basis: 'member', scopes: ['workspace:write'] }, resolved: true };
});
afterEach(cleanup);

const openDialog = async (): Promise<HTMLElement> => {
  fireEvent.click(await screen.findByRole('button', { name: 'Data source for My ServiceNow' }));
  return screen.findByRole('dialog');
};

describe('the data-source field (ADR 0783 D1)', () => {
  it('a pending save refuses repeated submission and racing clear/cancel, retaining focus', async () => {
    vi.mocked(listConnections).mockResolvedValue([row({ dataSource: { baseUrl: 'https://acme.service-now.com/api', updatedAt: 'x' } })]);
    let finish = (): void => {};
    vi.mocked(setDataSource).mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    render(<ConnectionsManager />);
    const dialog = await openDialog();
    const input = within(dialog).getByLabelText('Base URL') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'https://acme.service-now.com/api/now' } });
    const save = within(dialog).getByRole('button', { name: 'Save' });
    save.focus();
    fireEvent.click(save);
    fireEvent.click(save);
    const form = input.closest('form');
    expect(form).not.toBeNull();
    fireEvent.submit(form as HTMLFormElement);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop using as a data source' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(setDataSource).toHaveBeenCalledTimes(1);
    expect(setDataSource).toHaveBeenCalledWith('c1', 'https://acme.service-now.com/api/now');
    expect(input.readOnly).toBe(true);
    expect(save.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(save);
    expect(screen.getByRole('dialog')).toBe(dialog);
    await act(async () => { finish(); });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(toast.success).toHaveBeenCalledTimes(1);
  });
  it('a writer sets a base URL; the row then shows it', async () => {
    vi.mocked(listConnections)
      .mockResolvedValueOnce([row()])
      .mockResolvedValue([row({ dataSource: { baseUrl: 'https://acme.service-now.com/api/now', updatedAt: 'x' } })]);
    vi.mocked(setDataSource).mockResolvedValue();
    render(<ConnectionsManager />);
    const dialog = await openDialog();
    fireEvent.change(within(dialog).getByLabelText('Base URL'), { target: { value: ' https://acme.service-now.com/api/now ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(setDataSource).toHaveBeenCalledWith('c1', 'https://acme.service-now.com/api/now'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(toast.success).toHaveBeenCalledWith('My ServiceNow is now a data source.');
    expect(await screen.findByText('Data source: https://acme.service-now.com/api/now')).toBeTruthy();
  });

  it("the host's URL rule is shown beside the field, and the dialog stays open", async () => {
    vi.mocked(listConnections).mockResolvedValue([row()]);
    vi.mocked(setDataSource).mockRejectedValue(new ApiError({ status: 400, statusText: 'Bad Request', url: '/x', body: {}, message: "baseUrl's host is outside the provider's allowed API hosts" }));
    render(<ConnectionsManager />);
    const dialog = await openDialog();
    const input = within(dialog).getByLabelText('Base URL');
    fireEvent.change(input, { target: { value: 'https://evil.example/api' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect((await within(dialog).findByRole('alert')).textContent).toBe("baseUrl's host is outside the provider's allowed API hosts");
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('a configured source can be cleared', async () => {
    vi.mocked(listConnections).mockResolvedValue([row({ dataSource: { baseUrl: 'https://acme.service-now.com/api', updatedAt: 'x' } })]);
    vi.mocked(setDataSource).mockResolvedValue();
    render(<ConnectionsManager />);
    const dialog = await openDialog();
    expect((within(dialog).getByLabelText('Base URL') as HTMLInputElement).value).toBe('https://acme.service-now.com/api');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Stop using as a data source' }));
    await waitFor(() => expect(setDataSource).toHaveBeenCalledWith('c1', null));
    expect(toast.success).toHaveBeenCalledWith('My ServiceNow is no longer a data source.');
  });

  it('a Viewer is not offered the action, and neither is a revoked row', async () => {
    accessState.value = { access: { basis: 'member', scopes: [] }, resolved: true };
    vi.mocked(listConnections).mockResolvedValue([row()]);
    const { unmount } = render(<ConnectionsManager />);
    await screen.findByText('My ServiceNow');
    expect(screen.queryByRole('button', { name: 'Data source for My ServiceNow' })).toBeNull();
    unmount();
    accessState.value = { access: { basis: 'member', scopes: ['workspace:write'] }, resolved: true };
    vi.mocked(listConnections).mockResolvedValue([row({ status: 'revoked' })]);
    render(<ConnectionsManager />);
    await screen.findByText('My ServiceNow');
    expect(screen.queryByRole('button', { name: 'Data source for My ServiceNow' })).toBeNull();
  });
});
