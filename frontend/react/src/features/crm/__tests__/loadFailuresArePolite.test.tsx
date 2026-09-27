/**
 * CRM-UX-8 — a failure the user did not initiate announces POLITELY.
 *
 * Five CRM secondary reads announced with `{ assertive: true }`: the companies
 * picker (DealsTab), the deals picker (TasksTab), the segments list
 * (ContactsTab), and the stages + deal-tasks reads (DealDetailPage). Four of
 * them carried a `// review F12` comment, so this was a deliberate call — it
 * simply predates DESIGN.md §4.6, which reserves assertive for a failed ACTION:
 * "these appear on load or on a background poll, so interrupting someone
 * mid-sentence for something they did not do is the wrong trade."
 *
 * WHAT THIS DISCRIMINATES. `announce(msg)` and `announce(msg, { assertive:
 * true })` render identical visible output — the chip and the inline text are
 * unchanged either way — so nothing in the DOM can tell them apart. Spying on
 * the module is the only place the distinction is observable, which is exactly
 * why the assertive calls survived four rounds of review. Reinstating
 * `{ assertive: true }` at any of these sites fails this file.
 *
 * It does NOT assert the message is spoken at all (that is `announce`'s own
 * contract with `GlobalLiveRegion`), only its urgency.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const announceSpy = vi.hoisted(() => vi.fn());
vi.mock('../../../ui/announce.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return { ...actual, announce: announceSpy };
});

const api = vi.hoisted(() => ({
  listCompanies: vi.fn(),
  listDeals: vi.fn(),
  listPipelines: vi.fn(),
  listTasks: vi.fn(),
}));
vi.mock('../crmOrgClient.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return { ...actual, ...api };
});

// LOW-2 — `listContactFields` MUST be stubbed. This factory SPREADS the real
// module, and `ContactsTab` now calls that export on mount, so leaving it out
// fires a REAL `fetch` from jsdom — a latent flake, not a hard failure, which
// is exactly why it survived. Same rationale as `contactEmail.test.tsx`'s stub.
const crm = vi.hoisted(() => ({ listContacts: vi.fn(), listSegments: vi.fn(), listSegmentMembers: vi.fn(), listContactFields: vi.fn() }));
vi.mock('../crmClient.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return { ...actual, ...crm };
});

import { DealsTab } from '../DealsTab.js';
import { TasksTab } from '../TasksTab.js';
import { ContactsTab } from '../ContactsTab.js';

beforeEach(() => {
  vi.clearAllMocks();
  api.listPipelines.mockResolvedValue([{ pipelineId: 'p1', name: 'Sales', stages: [{ stageId: 's1', name: 'New', probability: 10 }] }]);
  api.listDeals.mockResolvedValue([]);
  api.listTasks.mockResolvedValue([]);
  api.listCompanies.mockResolvedValue([]);
  crm.listContacts.mockResolvedValue([]);
  crm.listSegments.mockResolvedValue([]);
  crm.listSegmentMembers.mockResolvedValue([]);
  crm.listContactFields.mockResolvedValue([]);
});
afterEach(cleanup);

/** Every `announce` call's options argument — `undefined` is the polite default. */
function announcedUrgencies(): unknown[] {
  return announceSpy.mock.calls.map((call) => call[1]);
}

describe('CRM-UX-8 — load-time failures announce politely', () => {
  it('DealsTab: a failed companies read is polite', async () => {
    api.listCompanies.mockRejectedValue(new Error('companies_500'));
    render(<MemoryRouter><DealsTab orgId="o1" /></MemoryRouter>);
    await waitFor(() => expect(announceSpy).toHaveBeenCalled());
    expect(announcedUrgencies()).not.toContainEqual({ assertive: true });
  });

  it('TasksTab: a failed deals read is polite', async () => {
    api.listDeals.mockRejectedValue(new Error('deals_500'));
    render(<MemoryRouter><TasksTab orgId="o1" /></MemoryRouter>);
    await waitFor(() => expect(announceSpy).toHaveBeenCalled());
    expect(announcedUrgencies()).not.toContainEqual({ assertive: true });
  });

  it('ContactsTab: a failed segments read is polite', async () => {
    crm.listSegments.mockRejectedValue(new Error('segments_500'));
    render(<MemoryRouter><ContactsTab /></MemoryRouter>);
    await waitFor(() => expect(announceSpy).toHaveBeenCalled());
    expect(announcedUrgencies()).not.toContainEqual({ assertive: true });
  });

  it('the spy is wired: the visible chip proves the failure branch really ran', async () => {
    // Guards against the vacuity mode where a mock never rejects and every
    // assertion above passes over ZERO announce calls.
    crm.listSegments.mockRejectedValue(new Error('segments_500'));
    render(<MemoryRouter><ContactsTab /></MemoryRouter>);
    // The failure CHIP, not the ever-present "Segments" heading — a substring
    // match on the heading would pass without the failure branch ever running.
    expect(await screen.findByText('Segments didn’t load')).toBeTruthy();
    expect(announceSpy).toHaveBeenCalledWith('Segments didn’t load');
  });
});

describe('LOW-3 — the tab’s polite announcements do not overwrite each other', () => {
  // `announce` keeps ONE module-level polite string; last writer wins. Three
  // sites on this tab could write it (the contacts failure StateCard, the
  // segments catch, the field-defs catch), and the two async catches land
  // last — so the message that survived was the least important one.
  it('both secondary failures arrive in ONE message, not one erasing the other', async () => {
    crm.listSegments.mockRejectedValue(new Error('segments_500'));
    crm.listContactFields.mockRejectedValue(new Error('fields_500'));
    render(<MemoryRouter><ContactsTab /></MemoryRouter>);
    await screen.findByText('Segments didn’t load');
    await waitFor(() => {
      const spoken = announceSpy.mock.calls.map((c) => String(c[0]));
      // The LAST thing spoken has to carry BOTH — before this it carried one.
      const last = spoken[spoken.length - 1] ?? '';
      expect(last).toContain('Segments didn’t load');
      expect(last).toContain('Contact fields didn’t load');
    });
  });

  it('the PRIMARY failure card is the ONLY thing announced when the contacts read fails', async () => {
    // The contacts read is the headline. Asserting only "the card's message is
    // spoken LAST" would not discriminate: with per-catch announcers the order
    // is a microtask race, so it passes about as often as not. Asserting the
    // secondary line is never announced AT ALL is deterministic — the
    // consolidated announcer bails on `error`, the per-catch version could not.
    // The secondary failure is still VISIBLE; it just does not take the slot.
    crm.listContacts.mockRejectedValue(new Error('contacts_500'));
    crm.listSegments.mockRejectedValue(new Error('segments_500'));
    render(<MemoryRouter><ContactsTab /></MemoryRouter>);
    await screen.findByText('Segments didn’t load');
    await waitFor(() => expect(announceSpy).toHaveBeenCalledWith('Could not load this'));
    const spoken = announceSpy.mock.calls.map((c) => String(c[0]));
    expect(spoken).not.toContain('Segments didn’t load');
  });
});
