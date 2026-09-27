/**
 * UX_UPGRADE-service-desk SD-G1 + SD-G2 + SD-G3.
 *
 * SD-G1 is the app-builder sync-binding shape again: `getIntakeConfig` returns
 * `null` for NOT CONFIGURED and THROWS when the read fails, and both landed in
 * the same `null`. The null branch offers "Enable" — a PUT that re-points the
 * tenant's inbound intake at this org. So a transient failure invited an agent
 * to re-route support intake for an org that was already configured.
 *
 * SD-G2: a failed detail read silently kept the LIST row, whose `messages` are
 * the queue projection — the thread then read as complete when it was not.
 *
 * SD-G3: the client parsed `error.message` from a body whose `error` is a string
 * code, so every server sentence was replaced by a status line.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';

const { listSupportTickets, getSupportTicket, getIntakeConfig, setIntakeOrg, listOrgs } = vi.hoisted(() => ({
  listSupportTickets: vi.fn(), getSupportTicket: vi.fn(), getIntakeConfig: vi.fn(), setIntakeOrg: vi.fn(), listOrgs: vi.fn(),
}));
vi.mock('../serviceDeskClient.js', async (orig) => ({
  ...(await orig<typeof import('../serviceDeskClient.js')>()),
  listSupportTickets, getSupportTicket, getIntakeConfig, setIntakeOrg,
}));
vi.mock('../../../client/accessClient.js', async (orig) => ({
  ...(await orig<typeof import('../../../client/accessClient.js')>()),
  listOrgs,
}));

import { SupportPage } from '../SupportPage.js';

const TICKET = {
  ticketId: 't1', subject: 'Login broken', status: 'open' as const, priority: 'high' as const,
  channel: 'email', messages: [{ messageId: 'm1', direction: 'inbound' as const, body: 'help', author: 'c@x.io', at: '2026-07-25T10:00:00Z' }],
  updatedAt: '2026-07-25T10:00:00Z', createdAt: '2026-07-25T09:00:00Z',
};

const mount = async (): Promise<void> => {
  render(<SupportPage />);
  await act(async () => {});
};

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  listOrgs.mockResolvedValue([{ orgId: 'o1', name: 'Acme' }]);
  listSupportTickets.mockResolvedValue([TICKET]);
  getIntakeConfig.mockResolvedValue({ defaultOrgId: 'o1' });
  getSupportTicket.mockResolvedValue(TICKET);
});

describe('SD-G1 — a failed intake check never offers to re-point intake', () => {
  it('offers only a re-check, never Enable', async () => {
    getIntakeConfig.mockRejectedValue(new Error('503'));
    await mount();
    // Enable is a PUT that re-routes inbound support for the workspace. It must
    // be ABSENT, not disabled — a disabled control still asserts "not configured".
    expect(screen.queryByRole('button', { name: 'File intake into this org' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Check again' })).toBeTruthy();
    expect(document.body.textContent).toContain('Could not check');
  });

  it('a genuine null STILL offers Enable', async () => {
    // The fix must not cost the real unconfigured case its only action.
    getIntakeConfig.mockResolvedValue(null);
    await mount();
    expect(screen.getByRole('button', { name: 'File intake into this org' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull();
  });

  it('a configured workspace shows neither', async () => {
    await mount();
    expect(screen.queryByRole('button', { name: 'File intake into this org' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Check again' })).toBeNull();
  });
});

describe('SD-G2 — a partial thread says it is partial', () => {
  it('warns when the full conversation could not be loaded', async () => {
    getSupportTicket.mockRejectedValue(new Error('500'));
    await mount();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Login broken' })); });
    expect(document.body.textContent).toContain('Could not load the full conversation');
    // The panel still opens — an open panel beats a blank one.
    expect(screen.getByRole('button', { name: 'Reload the thread' })).toBeTruthy();
    expect(document.body.textContent).toContain('help');
  });

  it('says nothing when the detail read succeeds', async () => {
    await mount();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Login broken' })); });
    expect(document.body.textContent).not.toContain('Could not load the full conversation');
  });
});

describe('SD-G3 — the client keeps the server sentence', () => {
  it('parses the real envelope shape', async () => {
    const { postTicketMessage } = await vi.importActual<typeof import('../serviceDeskClient.js')>('../serviceDeskClient.js');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'conflict', message: 'This ticket is closed — reopen it before replying.' }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    )));
    await expect(postTicketMessage('o1', 't1', 'hi', 'outbound'))
      .rejects.toThrow('This ticket is closed — reopen it before replying.');
    vi.unstubAllGlobals();
  });
});
