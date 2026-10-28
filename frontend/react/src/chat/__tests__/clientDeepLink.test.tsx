/**
 * ADR 0944 D2 — `/chat?client=<orgId>` opens a NEW conversation bound to that
 * client, then hands over to `?conversation=` (keeping `?agent=`). A refused
 * binding strips the link and reports the failure; it never opens an unbound
 * chat in its place. The chip names the bound client.
 *
 * Break it by dropping `clientOrgId` from the create call (first case), by
 * setting `conversation` in the catch (second case), or by rendering the chip
 * without the client's name (third case).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import type { ChatSessionHeader } from '../../client/chatSessionsClient.js';

const createChatSession = vi.fn<(opts: { sessionId?: string; clientOrgId?: string }) => Promise<ChatSessionHeader>>();
vi.mock('../../client/chatSessionsClient.js', () => ({
  createChatSession: (opts: { sessionId?: string; clientOrgId?: string }) => createChatSession(opts),
}));

const { useClientDeepLink } = await import('../useClientDeepLink.js');
const { ClientMemoryChip } = await import('../ClientMemoryChip.js');

function Probe({ enabled = true }: { enabled?: boolean }): JSX.Element {
  const { state } = useClientDeepLink(enabled);
  const loc = useLocation();
  return <div><span data-testid="state">{state}</span><span data-testid="search">{loc.search}</span></div>;
}

afterEach(() => { cleanup(); createChatSession.mockReset(); });

describe('ADR 0944 — the ?client= chat link', () => {
  it('waits for session/config readiness before creating the bound conversation', async () => {
    createChatSession.mockResolvedValue({ sessionId: 'ready-conv', tenantId: 't', title: 'New chat', createdAt: 'x', updatedAt: 'x', messageCount: 0 });
    const { rerender } = render(<MemoryRouter initialEntries={['/chat?client=org-a']}><Probe enabled={false} /></MemoryRouter>);
    expect(createChatSession).not.toHaveBeenCalled();
    rerender(<MemoryRouter initialEntries={['/chat?client=org-a']}><Probe enabled /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('search').textContent).toContain('conversation=ready-conv'));
    expect(createChatSession).toHaveBeenCalledTimes(1);
  });
  it('creates a client-bound conversation and hands over to ?conversation=, keeping ?agent=', async () => {
    createChatSession.mockResolvedValue({ sessionId: 'new-conv', tenantId: 't', title: 'New chat', createdAt: 'x', updatedAt: 'x', messageCount: 0 });
    render(<MemoryRouter initialEntries={['/chat?client=org-a&agent=strategist']}><Probe /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('search').textContent).toContain('conversation=new-conv'));
    expect(createChatSession).toHaveBeenCalledWith(expect.objectContaining({ clientOrgId: 'org-a' }));
    const search = screen.getByTestId('search').textContent ?? '';
    expect(search).toContain('agent=strategist');
    expect(search).not.toContain('client=');
    expect(screen.getByTestId('state').textContent).toBe('idle');
  });

  it('a refused binding strips the link and reports it, never opening an unbound chat', async () => {
    createChatSession.mockRejectedValue(new Error('forbidden_scope'));
    render(<MemoryRouter initialEntries={['/chat?client=org-b']}><Probe /></MemoryRouter>);
    await waitFor(() => expect(screen.getByTestId('state').textContent).toBe('failed'));
    const search = screen.getByTestId('search').textContent ?? '';
    expect(search).not.toContain('client=');
    expect(search).not.toContain('conversation=');
  });

  it('StrictMode effect replay opens exactly one client chat and completes navigation', async () => {
    createChatSession.mockResolvedValue({ sessionId: 'strict-conv', tenantId: 't', title: 'New chat', createdAt: 'x', updatedAt: 'x', messageCount: 0 });
    render(<StrictMode><MemoryRouter initialEntries={['/chat?client=org-a&agent=strategist']}><Probe /></MemoryRouter></StrictMode>);
    await waitFor(() => expect(screen.getByTestId('search').textContent).toContain('conversation=strict-conv'));
    expect(createChatSession).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('state').textContent).toBe('idle');
  });

  it('the chip names the bound client', () => {
    render(<ClientMemoryChip client={{ orgId: 'org-a', name: 'Client A' }} />);
    expect(screen.getByText(/Client A/)).toBeTruthy();
  });
});
