/**
 * ADR 0788 D6 — the "AI clients (MCP)" Access Hub tab.
 *
 * Pins the honesty rules the old /capabilities card broke: a network failure is
 * never shown as "turned off" (it used to be), a turned-off mount says so in
 * plain words (no env-var name), the per-tool switch is offered only to a caller
 * the server lets manage exposure (both directions), and a new key is shown
 * with a ready config exactly once.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ApiError } from '../../client/requestJson.js';

const canWrite = vi.hoisted(() => ({ value: true }));
vi.mock('../../lib/writeAccess.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  useScopeWriteAccess: () => canWrite.value,
}));
vi.mock('../../chrome/hubContext.js', () => ({ useHub: () => ({ embedded: true }) }));
vi.mock('../../auth/SignInButton.js', () => ({ SignInButton: () => <button type="button">Sign in</button> }));
vi.mock('../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() } }));
vi.mock('../mcpAccessClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getMcpExposure: vi.fn(),
  setMcpToolDisabled: vi.fn(async (key: string, disabled: boolean) => ({ disabled: disabled ? [key] : [], updatedAt: 'now' })),
  listMcpKeys: vi.fn(async () => []),
  createMcpKey: vi.fn(async (label: string) => ({ token: 'owk_secret_once', key: { keyId: 'dk:1', name: `MCP: ${label}`, scopes: ['workspace:read'], createdAt: '2026-09-30T00:00:00Z' } })),
  revokeMcpKey: vi.fn(),
}));

import { McpAccessPage } from '../McpAccessPage.js';
import { getMcpExposure, setMcpToolDisabled, createMcpKey } from '../mcpAccessClient.js';

const mGet = vi.mocked(getMcpExposure);
const view = (over: Partial<Awaited<ReturnType<typeof getMcpExposure>>> = {}) => ({
  enabled: true,
  endpoint: { url: 'https://svc.example/host/openwop-app/mcp', derived: false, viaProxy: false },
  protocolVersions: ['2026-07-28', '2025-06-18'],
  canManage: true,
  tools: [
    { key: 'host:notebooks.mcp.search:notebook-search', name: 'notebook-search', description: 'Search', source: 'host' as const, safetyTier: 'read', approval: 'never', requiredScopes: ['workspace:read'], disabled: false },
  ],
  ...over,
});
const renderPage = () => render(<MemoryRouter><McpAccessPage /></MemoryRouter>);

beforeEach(() => { vi.clearAllMocks(); canWrite.value = true; });
afterEach(cleanup);

describe('McpAccessPage', () => {
  it('a network failure reads as a failure with a retry — never as "turned off"', async () => {
    mGet.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    renderPage();
    expect(await screen.findByText('AI client access didn’t load')).toBeTruthy();
    expect(screen.queryByText(/doesn’t accept AI client connections/)).toBeNull();
    mGet.mockResolvedValueOnce(view());
    fireEvent.click(screen.getByRole('button', { name: /Try again/ }));
    expect(await screen.findByText('https://svc.example/host/openwop-app/mcp')).toBeTruthy();
  });

  it('a turned-off mount says so in plain words, with no deployment variable name', async () => {
    mGet.mockResolvedValueOnce(view({ enabled: false }));
    renderPage();
    expect(await screen.findByText(/doesn’t accept AI client connections yet/)).toBeTruthy();
    expect(document.body.textContent).not.toContain('OPENWOP_MCP_SERVER_ENABLED');
    // No keys to hand out for a server that does not accept connections.
    expect(screen.queryByRole('button', { name: 'Create key' })).toBeNull();
  });

  it('a signed-out caller is asked to sign in', async () => {
    mGet.mockRejectedValueOnce(new ApiError({ status: 401, statusText: 'Unauthorized', url: 'x', body: {}, message: 'x' }));
    renderPage();
    expect(await screen.findByText('Sign in to connect an AI client')).toBeTruthy();
  });

  it('an admin gets the per-tool switch, and turning it off sends the tool key', async () => {
    mGet.mockResolvedValueOnce(view());
    renderPage();
    const sw = await screen.findByRole('switch', { name: 'Let AI clients use notebook-search' });
    fireEvent.click(sw);
    await waitFor(() => expect(vi.mocked(setMcpToolDisabled)).toHaveBeenCalledWith('host:notebooks.mcp.search:notebook-search', true));
    await waitFor(() => expect((screen.getByRole('switch') as HTMLInputElement).checked).toBe(false));
  });

  it('a member who cannot manage exposure is NOT offered the switch', async () => {
    mGet.mockResolvedValueOnce(view({ canManage: false, tools: [{ ...view().tools[0]!, disabled: true }] }));
    renderPage();
    expect(await screen.findByText('Turned off')).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('a new key is shown once, inside a ready config, and Done removes it', async () => {
    mGet.mockResolvedValueOnce(view());
    renderPage();
    fireEvent.change(await screen.findByLabelText('Name this key'), { target: { value: 'Laptop' } });
    fireEvent.click(screen.getByLabelText(/Read & act/));
    fireEvent.click(screen.getByRole('button', { name: 'Create key' }));
    await waitFor(() => expect(vi.mocked(createMcpKey)).toHaveBeenCalledWith('Laptop', 'act'));
    const snippet = await screen.findByRole('group', { name: 'Client configuration with your key' });
    expect(snippet.textContent).toContain('owk_secret_once');
    expect(snippet.textContent).toContain('https://svc.example/host/openwop-app/mcp');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(document.body.textContent).not.toContain('owk_secret_once');
  });

  it('the keyboard lands on "Copy configuration" when the one-time key appears, and returns to the name field on Done (MCPUX-2)', async () => {
    mGet.mockResolvedValueOnce(view());
    renderPage();
    const input = await screen.findByLabelText('Name this key');
    fireEvent.change(input, { target: { value: 'Laptop' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create key' }));
    const copy = await screen.findByRole('button', { name: /Copy configuration/ });
    await waitFor(() => expect(document.activeElement).toBe(copy));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(document.activeElement).toBe(screen.getByLabelText('Name this key'));
  });

  it('an empty name is refused with a message, not a silently dead button', async () => {
    mGet.mockResolvedValueOnce(view());
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Create key' }));
    expect(await screen.findByText(/Give the key a name/)).toBeTruthy();
    expect(vi.mocked(createMcpKey)).not.toHaveBeenCalled();
  });

  it('a member without edit access is not offered a "Read & act" key it could not use (MCPUX-7)', async () => {
    canWrite.value = false;
    mGet.mockResolvedValueOnce(view({ canManage: false }));
    renderPage();
    const act = (await screen.findByLabelText(/Read & act/)) as HTMLInputElement;
    expect(act.disabled).toBe(true);
    expect(screen.getByText(/Needs edit access/)).toBeTruthy();
  });
});
