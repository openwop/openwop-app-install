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
 * contract with `GlobalLiveRegion`), only its urgency. Each case waits for ITS
 * site's message (not any announce call), so a case cannot pass on another
 * site's announcement.
 *
 * Sabotage-witnessed (wave-4 /grade-tests, w4g5-lf-*): `{ assertive: true }`
 * re-added at each of the five sites — DealsTab:155, TasksTab:152, ContactsTab's
 * consolidated announcer, DealDetailPage's stages (:81) and deal-tasks (:281)
 * reads — turns that site's case red; so do the consolidated announcer speaking
 * only the last part, and it talking over the primary failure card. (The two
 * DealDetailPage sites had no case until wave 4 — the header claimed them while
 * nothing guarded them.)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { Deal } from '../crmOrgClient.js';

type OrgApi = typeof import('../crmOrgClient.js');
type CrmApi = typeof import('../crmClient.js');

const announceSpy = vi.hoisted(() => vi.fn<typeof import('../../../ui/announce.js')['announce']>());
vi.mock('../../../ui/announce.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return { ...actual, announce: announceSpy };
});

const api = vi.hoisted(() => ({
  listCompanies: vi.fn<OrgApi['listCompanies']>(),
  listDeals: vi.fn<OrgApi['listDeals']>(),
  listPipelines: vi.fn<OrgApi['listPipelines']>(),
  listTasks: vi.fn<OrgApi['listTasks']>(),
  getDeal: vi.fn<OrgApi['getDeal']>(),
  listActivities: vi.fn<OrgApi['listActivities']>(),
}));
vi.mock('../crmOrgClient.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return { ...actual, ...api };
});

// LOW-2 — `listContactFields` MUST be stubbed. This factory SPREADS the real
// module, and `ContactsTab` now calls that export on mount, so leaving it out
// fires a REAL `fetch` from jsdom — a latent flake, not a hard failure, which
// is exactly why it survived. Same rationale as `contactEmail.test.tsx`'s stub.
const crm = vi.hoisted(() => ({
  listContacts: vi.fn<CrmApi['listContacts']>(),
  listSegments: vi.fn<CrmApi['listSegments']>(),
  listSegmentMembers: vi.fn<CrmApi['listSegmentMembers']>(),
  listContactFields: vi.fn<CrmApi['listContactFields']>(),
}));
vi.mock('../crmClient.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return { ...actual, ...crm };
});

// DealDetailPage gates on the feature toggle and mounts UserPicker.
vi.mock('../../../featureToggles/FeatureAccessContext.js', async () => {
  const { makeFeatureAccess } = await import('../../../featureToggles/__testing__/makeFeatureAccess.js');
  return { useFeatureAccess: () => makeFeatureAccess({ enabled: true, loading: false }) };
});
vi.mock('../../../orgs/orgMembers.js', () => ({
  loadOrgMembers: vi.fn(async () => []),
  invalidateOrgMembers: vi.fn(),
}));

import { DealsTab } from '../DealsTab.js';
import { DealDetailPage } from '../DealDetailPage.js';
import { TasksTab } from '../TasksTab.js';
import { ContactsTab } from '../ContactsTab.js';

const DEAL: Deal = { dealId: 'd1', title: 'Globex expansion', pipelineId: 'p1', stageId: 's1', status: 'open' };

beforeEach(() => {
  vi.resetAllMocks();
  api.getDeal.mockResolvedValue(DEAL);
  api.listActivities.mockResolvedValue([]);
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

/** Every `announce` call's message — whatever its urgency, so a case waits on
 *  ITS site having spoken, and the urgency check below then judges that call. */
function announcedMessages(): string[] {
  return announceSpy.mock.calls.map((call) => String(call[0]));
}

/** Every `announce` call's options argument — `undefined` is the polite default. */
function announcedUrgencies(): unknown[] {
  return announceSpy.mock.calls.map((call) => call[1]);
}

describe('CRM-UX-8 — load-time failures announce politely', () => {
  it('DealsTab: a failed companies read is polite', async () => {
    api.listCompanies.mockRejectedValue(new Error('companies_500'));
    render(<MemoryRouter><DealsTab orgId="o1" /></MemoryRouter>);
    await waitFor(() => expect(announcedMessages()).toContain('Couldn’t load companies — the list may be incomplete, not empty.'));
    expect(announcedUrgencies()).not.toContainEqual({ assertive: true });
  });

  it('TasksTab: a failed deals read is polite', async () => {
    api.listDeals.mockRejectedValue(new Error('deals_500'));
    render(<MemoryRouter><TasksTab orgId="o1" /></MemoryRouter>);
    await waitFor(() => expect(announcedMessages()).toContain('Couldn’t load deals — the picker may be incomplete, not empty.'));
    expect(announcedUrgencies()).not.toContainEqual({ assertive: true });
  });

  it('ContactsTab: a failed segments read is polite', async () => {
    crm.listSegments.mockRejectedValue(new Error('segments_500'));
    render(<MemoryRouter><ContactsTab /></MemoryRouter>);
    await waitFor(() => expect(announceSpy).toHaveBeenCalled());
    expect(announcedUrgencies()).not.toContainEqual({ assertive: true });
  });

  const renderDealDetail = (): void => {
    render(
      <MemoryRouter initialEntries={['/crm/deals/d1?org=o1']}>
        <Routes><Route path="/crm/deals/:dealId" element={<DealDetailPage />} /></Routes>
      </MemoryRouter>,
    );
  };

  it('DealDetailPage: a failed stages (pipelines) read is polite', async () => {
    api.listPipelines.mockRejectedValue(new Error('pipelines_500'));
    renderDealDetail();
    await waitFor(() => expect(announcedMessages()).toContain('Stages didn’t load'));
    expect(announcedUrgencies()).not.toContainEqual({ assertive: true });
  });

  it('DealDetailPage: a failed deal-tasks read is polite', async () => {
    api.listPipelines.mockResolvedValue([{ pipelineId: 'p1', name: 'Sales', stages: [{ stageId: 's1', name: 'New', probability: 10 }] }]);
    api.listTasks.mockRejectedValue(new Error('tasks_500'));
    renderDealDetail();
    await waitFor(() => expect(announcedMessages()).toContain('Tasks didn’t load'));
    expect(announcedUrgencies()).not.toContainEqual({ assertive: true });
  });

  it('the spy is wired: the visible chip proves the failure branch really ran', async () => {
    // Guards against the vacuity mode where a mock never rejects and every
    // assertion above passes over ZERO announce calls.
    crm.listSegments.mockRejectedValue(new Error('segments_500'));
    render(<MemoryRouter><ContactsTab /></MemoryRouter>);
    // The failure CHIP, not the ever-present "Segments" heading — a substring
    // match on the heading would pass without the failure branch ever running.
    expect(await screen.findByText('Segments didn’t load', {}, { timeout: 5000 })).toBeTruthy();
    // The announcement is made in an effect after the chip renders, so wait for it
    // rather than reading the spy synchronously (#4176).
    await waitFor(() => expect(announceSpy).toHaveBeenCalledWith('Segments didn’t load'), { timeout: 5000 });
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
