/**
 * Two defects on one page, from two different reads — the reason `-1`'s third
 * deciding fact belongs in the checklist.
 *
 *  1. A failed WORKSPACE read left `orgId` '', so `if (!orgId) return` meant the
 *     tickets read never started, `rows` stayed null, and the page rendered its
 *     skeleton forever. `error` could not save it: `error` is set by the tickets
 *     read, which is the read that never ran.
 *
 *  2. A failed TICKETS read set `setRows([])` **and** an error. So the page showed
 *     the error Notice AND, directly beneath it, "No tickets yet — configure
 *     intake below or create tickets from WhatsApp, forms, or the API."
 *     AN ERROR BESIDE A FALSE CLAIM IS STILL A FALSE CLAIM, and the instruction
 *     is the half that reads as the answer. Scanning the `.catch` alone does not
 *     surface this — the claim is not in the catch, it is in a render branch the
 *     catch happens to select.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';

const { listOrgs } = vi.hoisted(() => ({ listOrgs: vi.fn() }));
const { listSupportTickets, getIntakeConfig, setIntakeOrg, postTicketMessage, setTicketStatus, getSupportTicket } = vi.hoisted(() => ({
  listSupportTickets: vi.fn(), getIntakeConfig: vi.fn(),
  // The three org-scoped WRITES this page can issue (ORG-HON-2).
  setIntakeOrg: vi.fn(), postTicketMessage: vi.fn(), setTicketStatus: vi.fn(),
  getSupportTicket: vi.fn(),
}));
vi.mock('../../../client/accessClient.js', async (orig) => ({
  ...(await orig<typeof import('../../../client/accessClient.js')>()),
  listOrgs,
  // ADR 0661 — this factory OVERRIDES the shared `shared-read-seams.ts` mock of
  // accessClient, so the seam's `getEffectiveAccess` no longer applies and the real
  // one ran. A partial override re-opens the hole the seam closed; re-state it here.
  getEffectiveAccess: async () => ({ roles: [], scopes: [], basis: 'none' as const }),
}));
vi.mock('../serviceDeskClient.js', async (orig) => ({
  ...(await orig<typeof import('../serviceDeskClient.js')>()),
  listSupportTickets, getIntakeConfig, setIntakeOrg, postTicketMessage, setTicketStatus, getSupportTicket,
}));

import { SupportPage } from '../SupportPage.js';

const ORG = { orgId: 'o1', name: 'Acme' };
const TICKET = {
  ticketId: 't1', subject: 'Printer on fire', status: 'open' as const,
  priority: 'high' as const, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
};

const mount = async (): Promise<void> => {
  render(<SupportPage />);
  await act(async () => {});
};

afterEach(cleanup);
beforeEach(() => {
  vi.clearAllMocks();
  listOrgs.mockResolvedValue([ORG]);
  listSupportTickets.mockResolvedValue([TICKET]);
  getIntakeConfig.mockResolvedValue({ enabled: false });
  getSupportTicket.mockResolvedValue({ ...TICKET, messages: [] });
});

describe('a failed workspace read does not hang the ticket queue', () => {
  it('says the read failed instead of rendering the skeleton forever', async () => {
    listOrgs.mockRejectedValue(new Error('503'));
    await mount();
    expect(document.body.textContent).toContain('Could not load your organizations');
    expect(document.body.textContent).toContain(
      'The ticket list was never requested. This is a failed read, not an empty organization list.',
    );
    expect(document.querySelector('.skeleton')).toBeNull();
  });

  it('never even requested the tickets — which is why no error appeared', async () => {
    // Pins the mechanism, not just the symptom: the dependent read is gated on
    // `orgId`, so it is not that it failed silently, it is that it never ran.
    listOrgs.mockRejectedValue(new Error('503'));
    await mount();
    expect(listSupportTickets).not.toHaveBeenCalled();
  });

  it('read SUCCEEDS with []: the zero-ORGANIZATION state, never an endless skeleton (HG-1)', async () => {
    // The third state, and the one the two tests above do not reach. A SUCCESSFUL
    // read of no workspaces leaves `orgId` '', so `if (!orgId) return` means the
    // tickets read never starts and `rows` stays null — the same permanent
    // skeleton, arrived at from the honest side. The server answered "none"; the
    // screen said "loading". DESIGN.md §4.6: loading may only say it is loading.
    listOrgs.mockResolvedValue([]);
    await mount();
    expect(document.body.textContent).toContain('No organizations');
    expect(document.body.textContent).toContain('Support tickets belong to an organization.');
    // Nothing failed, so nothing claims it did.
    expect(document.body.textContent).not.toContain('Could not load your organizations');
    expect(document.body.textContent).not.toContain('Could not load tickets');
    // The a11y half: `SkeletonRows` is a `role="status"` region labelled "Loading…"
    // whose children are aria-hidden — a screen-reader user was told permanently
    // that work was in progress.
    expect(screen.queryByRole('status', { name: 'Loading…' })).toBeNull();
    expect(document.querySelector('.skeleton')).toBeNull();
    expect(listSupportTickets).not.toHaveBeenCalled();
  });

  it('the retry re-runs the workspace read', async () => {
    listOrgs.mockRejectedValueOnce(new Error('503')).mockResolvedValue([ORG]);
    await mount();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Try again' })); });
    expect(listOrgs).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain('Could not load your organizations');
  });
});

describe('a failed ticket read does not render an instruction beside the error', () => {
  it('stops claiming the queue is empty', async () => {
    listSupportTickets.mockRejectedValue(new Error('503'));
    await mount();
    expect(document.body.textContent).toContain('Could not load tickets');
    // The claim, and the instruction attached to it, must both be gone.
    expect(document.body.textContent).not.toContain('No tickets yet');
    expect(document.body.textContent).not.toContain('Configure intake below');
  });

  it('a workspace that genuinely has no tickets still gets the instruction', async () => {
    // The failure mode of this fix: a real empty queue with nothing telling the
    // operator how to start receiving tickets.
    listSupportTickets.mockResolvedValue([]);
    await mount();
    expect(document.body.textContent).toContain('No tickets yet');
    expect(document.body.textContent).not.toContain('Could not load tickets');
  });

  it('a successful read still lists the tickets', async () => {
    await mount();
    expect(document.body.textContent).toContain('Printer on fire');
  });
});

/**
 * ORG-HON-2 / ORG-HON-4 — the WRITE half. Everything above pins the dependent
 * READ (`listSupportTickets` was never called). Nothing pinned the half that
 * would mint a data defect: a write issued with an EMPTY organization id.
 *
 * This page has three org-scoped writes. `postTicketMessage` and
 * `setTicketStatus` need a selected ticket, and a ticket can only be selected
 * from a queue that was never read — they are unreachable for the same reason
 * the read never fired. `setIntakeOrg` is the interesting one: it is a PUT that
 * re-points the tenant's inbound support intake, and its Notice sits ABOVE the
 * org-state chain, so it never inherited that chain's protection. It was safe
 * only because `rows !== null` is false whenever `orgId` is '' — a fact about a
 * DIFFERENT state variable, which is luck, not a guard. The second test drives
 * the pair the luck argument depends on (`rows` populated, selection cleared)
 * and is the one that goes red without the component's `orgId &&`.
 */
describe('service desk — no organization, no write (ORG-HON-2)', () => {
  it('zero organizations: none of the three org-scoped writes is reachable', async () => {
    listOrgs.mockResolvedValue([]);
    getIntakeConfig.mockResolvedValue(null);
    await mount();

    expect(document.body.textContent).toContain('No organizations');
    // The intake PUT's affordance is absent, and so is the state it lives in:
    // with no org the intake config was never read either.
    expect(screen.queryByRole('button', { name: 'File intake into this org' })).toBeNull();
    expect(getIntakeConfig).not.toHaveBeenCalled();
    expect(setIntakeOrg).not.toHaveBeenCalled();
    // No queue ⇒ no ticket ⇒ no detail panel ⇒ neither ticket write can be aimed.
    expect(screen.queryByLabelText('Reply as')).toBeNull();
    expect(postTicketMessage).not.toHaveBeenCalled();
    expect(setTicketStatus).not.toHaveBeenCalled();
  });

  it('selection cleared while the queue is loaded: the intake PUT goes with it (ORG-HON-4)', async () => {
    // The state the old code's safety rested on never happening. Two orgs, so the
    // picker renders; the queue loads (`rows` is now `[]`, NOT null) and intake
    // reads as unconfigured, so the "File intake into this org" button appears.
    listOrgs.mockResolvedValue([ORG, { orgId: 'o2', name: 'Globex' }]);
    listSupportTickets.mockResolvedValue([]);
    getIntakeConfig.mockResolvedValue(null);
    await mount();
    const enable = screen.getByRole('button', { name: 'File intake into this org' });
    expect(enable).toBeTruthy();

    // Clear the selection. `load()` returns early on `if (!orgId) return`, so the
    // rows it already fetched STAY — the exact pair the old guard assumed away.
    await act(async () => {
      fireEvent.change(screen.getByLabelText('Organization'), { target: { value: '' } });
    });
    expect(document.body.textContent).toContain('No tickets yet'); // rows is still []

    // The button is gone with its target, and no PUT was issued at nothing.
    expect(screen.queryByRole('button', { name: 'File intake into this org' })).toBeNull();
    expect(setIntakeOrg).not.toHaveBeenCalled();
  });

  it('positive control: with an organization selected, the intake PUT does fire — at that org', async () => {
    // Without this, the two assertions above could pass because the button never
    // renders for anyone, which is a different bug wearing the same green.
    getIntakeConfig.mockResolvedValue(null);
    setIntakeOrg.mockResolvedValue({ enabled: true });
    await mount();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'File intake into this org' }));
    });
    expect(setIntakeOrg).toHaveBeenCalledWith('o1');
  });
});
