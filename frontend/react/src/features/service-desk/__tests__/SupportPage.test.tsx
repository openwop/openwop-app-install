/**
 * UX_UPGRADE-service-desk SD-G1 + SD-G2 + SD-G3.
 *
 * SD-G1 is the app-builder sync-binding shape again: `getIntakeConfig` reports
 * NOT CONFIGURED as `{ configured: false, here: false, config: null }` (ADR 0878
 * D2; it used to be a bare `null`) and THROWS when the read fails, and the page
 * landed both in the same state. The null branch offers "Enable" — a PUT that re-points the
 * tenant's inbound intake at this org. So a transient failure invited an agent
 * to re-route support intake for an org that was already configured.
 *
 * SD-G2: a failed detail read silently kept the LIST row, whose `messages` are
 * the queue projection — the thread then read as complete when it was not.
 *
 * SD-G3: the client parsed `error.message` from a body whose `error` is a string
 * code, so every server sentence was replaced by a status line.
 *
 * PROTECTED (failure honesty: a failed intake read must never offer the
 * re-routing PUT). Sabotage-witnessed (round 1/2): the intake `.catch` flag, the
 * `!intakeFailed` gate on Enable, the re-check wiring, the SD-G2 stale flag and
 * its quiet path, the client's `message` parse, the Pocket's agent id + scope.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

// ADR 0768 D5 — stub the Pocket so the page test reads WHICH agent and WHAT scope it mounts.
vi.mock('../../../chat/ChatPocket.js', () => ({
  ChatPocket: ({ agentId, contextLabel }: { agentId: string; contextLabel?: unknown }) => (
    <div data-testid="pocket" data-agent={agentId}>{contextLabel as string}</div>
  ),
}));
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react';
import type { Ticket, TicketDetail, IntakeStatus, IntakeConfig, QueueView } from '../serviceDeskClient.js';
import type { Organization } from '../../../client/accessClient.js';

const { listSupportTickets, getSupportTicket, getIntakeConfig, setIntakeOrg, listOrgs } = vi.hoisted(() => ({
  listSupportTickets: vi.fn<(orgId: string, status?: string, view?: QueueView) => Promise<Ticket[]>>(),
  getSupportTicket: vi.fn<(orgId: string, ticketId: string) => Promise<TicketDetail>>(),
  getIntakeConfig: vi.fn<(orgId: string) => Promise<IntakeStatus>>(),
  setIntakeOrg: vi.fn<(orgId: string) => Promise<IntakeConfig>>(),
  listOrgs: vi.fn<() => Promise<Organization[]>>(),
}));
vi.mock('../serviceDeskClient.js', async (orig) => ({
  ...(await orig<typeof import('../serviceDeskClient.js')>()),
  // ADR 0878 D7 — the assignee picker read (enrichment; never the network in tests).
  listAssignees: async () => ({ assignees: [], me: [] }),
  listSupportTickets, getSupportTicket, getIntakeConfig, setIntakeOrg,
}));
vi.mock('../../../client/accessClient.js', async (orig) => ({
  ...(await orig<typeof import('../../../client/accessClient.js')>()),
  listOrgs,
}));

import { SupportPage } from '../SupportPage.js';

const TICKET: Ticket = {
  ticketId: 't1', subject: 'Login broken', status: 'open', priority: 'high',
  channel: 'email', messages: [{ messageId: 'm1', direction: 'inbound', body: 'help', author: 'c@x.io', at: '2026-07-25T10:00:00Z' }],
  updatedAt: '2026-07-25T10:00:00Z', createdAt: '2026-07-25T09:00:00Z',
};
const ORG: Organization = {
  orgId: 'o1', tenantId: 'tn1', name: 'Acme', slug: 'acme', createdBy: 'u1',
  createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-01T00:00:00Z',
};

const mount = async (): Promise<void> => {
  render(<SupportPage />);
  await act(async () => {});
};

afterEach(() => {
  cleanup();
  // A red assertion must not leak SD-G3's fetch stub into later cases.
  vi.unstubAllGlobals();
});
beforeEach(() => {
  vi.clearAllMocks();
  getIntakeConfig.mockReset();
  listOrgs.mockResolvedValue([ORG]);
  listSupportTickets.mockResolvedValue([TICKET]);
  getIntakeConfig.mockResolvedValue({ configured: true, here: true, config: { defaultOrgId: 'o1' } });
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

    // …and the re-check really re-reads: once the read recovers, the warning goes.
    getIntakeConfig.mockResolvedValue({ configured: true, here: true, config: { defaultOrgId: 'o1' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Check again' })); });
    await waitFor(() => expect(getIntakeConfig).toHaveBeenCalledTimes(2));
    expect(getIntakeConfig).toHaveBeenLastCalledWith('o1');
    await waitFor(() => expect(document.body.textContent).not.toContain('Could not check'));
    expect(screen.queryByRole('button', { name: 'File intake into this org' })).toBeNull();
  });

  it('a genuine null STILL offers Enable', async () => {
    // The fix must not cost the real unconfigured case its only action.
    getIntakeConfig.mockResolvedValue({ configured: false, here: false, config: null });
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
    // Settle on the detail read itself before asserting the absence.
    await waitFor(() => expect(getSupportTicket).toHaveBeenCalledWith('o1', 't1'));
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
  });
});

describe('ADR 0768 D5 — the feature assistant Pocket', () => {
  it('mounts this feature\'s agent with an honest scope (orgs the caller can read)', async () => {
    render(<SupportPage />);
    const pocket = await screen.findByTestId('pocket');
    expect(pocket.getAttribute('data-agent')).toBe('vendor.openwop-app.service-desk.agents.support');
    expect(pocket.textContent).toBe('tickets in organizations you can read');
  });
});
