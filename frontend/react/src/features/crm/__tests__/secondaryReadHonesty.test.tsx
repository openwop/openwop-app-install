/**
 * UX_UPGRADE-crm-console ROUND 2 — XCC-1: secondary reads surface their
 * failure. Round 1 fixed the PRIMARY lists; the round-2 defect mass sat in
 * the reads AROUND them, each failing into a shape indistinguishable from
 * honest emptiness:
 *
 *  - CC-SP-2 GmailSync: failed connections read → "No Google connection, go
 *    connect one" (a false instruction).
 *  - CC-SP-6 DealDetail: failed pipelines read → an EMPTY stage select;
 *    failed company read → renders as "no company".
 *  - CC-SP-8 Contacts: failed segments read → saved segments read as deleted.
 *  - CC-SP-9 Deals: failed companies read → a silently empty dropdown.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';

const listConnections = vi.fn();
vi.mock('../../connections/connectionsClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listConnections: (...a: unknown[]) => listConnections(...a),
}));

const listContacts = vi.fn();
const listSegments = vi.fn();
vi.mock('../crmClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listContacts: (...a: unknown[]) => listContacts(...a),
  listSegments: (...a: unknown[]) => listSegments(...a),
  // CRM-UX-7 — ContactsTab reads the contact field DEFS on mount. Stubbed for
  // the same reason `listGmailSyncs` is noted below: this factory SPREADS the
  // original, so an unstubbed export is a REAL fetch, and its rejection would
  // mount a second failure chip + retry button and make this file flaky.
  listContactFields: vi.fn(async () => []),
}));

// `listGmailSyncs` lives in gmailSyncClient, NOT crmClient — GmailSyncTab imports
// it from `./gmailSyncClient.js`. It was previously listed in the crmClient mock
// above, where nothing imports it, so the mock was inert and the component made a
// REAL `fetch` on every run. That is what made this file flaky at ~30% solo: the
// real read rejects with "fetch failed", setting the component's `error` state and
// rendering a SECOND retry button, so `getByRole('button', {name:/retry/i})` threw
// "Found multiple elements" whenever the network rejection landed before the
// assertion. The mock was not slow — it was never installed.
const listGmailSyncs = vi.fn();
vi.mock('../gmailSyncClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listGmailSyncs: (...a: unknown[]) => listGmailSyncs(...a),
}));

const getDeal = vi.fn();
const getCompany = vi.fn();
const listPipelines = vi.fn();
const listCompanies = vi.fn();
const listDeals = vi.fn();
const listActivities = vi.fn(async (..._a: unknown[]) => []);
vi.mock('../crmOrgClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDeal: (...a: unknown[]) => getDeal(...a),
  getCompany: (...a: unknown[]) => getCompany(...a),
  listPipelines: (...a: unknown[]) => listPipelines(...a),
  listCompanies: (...a: unknown[]) => listCompanies(...a),
  listDeals: (...a: unknown[]) => listDeals(...a),
  listActivities: (...a: unknown[]) => listActivities(...a),
}));

// The detail page gates on the feature toggle + mounts UserPicker; the shared
// mock-shape helper keeps the access fixture honest (the mock-shape ratchet).
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess(),
}));
vi.mock('../../../orgs/orgMembers.js', () => ({
  loadOrgMembers: vi.fn(async () => []),
  invalidateOrgMembers: vi.fn(),
}));

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('CC-SP-2 — GmailSync failed connections read is not "go connect Google"', () => {
  it('renders the read-error card with retry, NOT the no-connection instruction', async () => {
    const { GmailSyncTab } = await import('../GmailSyncTab.js');
    listGmailSyncs.mockResolvedValue([]);
    listConnections.mockRejectedValue(new Error('boom'));
    render(<MemoryRouter><GmailSyncTab orgId="org:1" /></MemoryRouter>);
    await screen.findByText(/couldn.t check your google connections/i);
    // Review F6 — the earlier assertion queried the i18n KEY, which never
    // renders, so it passed either way. Match the real translation.
    expect(screen.queryByText(/connect google first/i)).toBeNull();
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
  });

  it('a SUCCESSFUL empty read still gets the honest no-connection card (the positive case)', async () => {
    const { GmailSyncTab } = await import('../GmailSyncTab.js');
    listGmailSyncs.mockResolvedValue([]);
    listConnections.mockResolvedValue([]);
    render(<MemoryRouter><GmailSyncTab orgId="org:1" /></MemoryRouter>);
    // The no-connection card's manage-connections link renders only on the honest path.
    await screen.findByRole('link', { name: /connection/i });
    expect(screen.queryByText(/couldn.t check your google connections/i)).toBeNull();
  });
});

describe('CC-SP-6 — DealDetail secondary reads', () => {
  const renderDetail = async () => {
    const { DealDetailPage } = await import('../DealDetailPage.js');
    return render(
      <MemoryRouter initialEntries={['/crm/deals/d1?org=org:1']}>
        <Routes><Route path="/crm/deals/:dealId" element={<DealDetailPage />} /></Routes>
      </MemoryRouter>,
    );
  };

  it('a failed pipelines read shows the stages error + retry, not an empty select', async () => {
    getDeal.mockResolvedValue({ dealId: 'd1', title: 'Big deal', stageId: 's1', pipelineId: 'p1' });
    listPipelines.mockRejectedValue(new Error('boom'));
    await renderDetail();
    await screen.findByText(/stages didn.t load/i);
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
  });

  it('a failed company read is named, never rendered as "no company"', async () => {
    getDeal.mockResolvedValue({ dealId: 'd1', title: 'Big deal', stageId: 's1', pipelineId: 'p1', companyId: 'co1' });
    getCompany.mockRejectedValue(new Error('boom'));
    listPipelines.mockResolvedValue([{ pipelineId: 'p1', name: 'P', stages: [{ stageId: 's1', name: 'Stage 1' }] }]);
    await renderDetail();
    await screen.findByText(/couldn.t load the linked company/i);
  });

  it('a deal with genuinely NO company shows nothing (the positive case)', async () => {
    getDeal.mockResolvedValue({ dealId: 'd1', title: 'Big deal', stageId: 's1', pipelineId: 'p1' });
    listPipelines.mockResolvedValue([{ pipelineId: 'p1', name: 'P', stages: [{ stageId: 's1', name: 'Stage 1' }] }]);
    await renderDetail();
    await screen.findByDisplayValue('Big deal');
    expect(screen.queryByText(/couldn.t load the linked company/i)).toBeNull();
    expect(getCompany).not.toHaveBeenCalled();
  });
});

describe('CC-SP-8 — Contacts segments failed read is visible', () => {
  it('shows the segments-failed chip + retry; a retry that succeeds clears it', async () => {
    const { ContactsTab } = await import('../ContactsTab.js');
    listContacts.mockResolvedValue([]);
    listSegments.mockRejectedValueOnce(new Error('boom')).mockResolvedValue([]);
    render(<MemoryRouter><ContactsTab /></MemoryRouter>);
    await screen.findByText(/segments didn.t load/i);
    screen.getByRole('button', { name: /retry/i }).click();
    await vi.waitFor(() => expect(screen.queryByText(/segments didn.t load/i)).toBeNull());
  });
});

describe('CC-SP-9 — Deals companies dropdown failure is named', () => {
  it('a failed companies read shows the incomplete-list warning by the select', async () => {
    const { DealsTab } = await import('../DealsTab.js');
    listPipelines.mockResolvedValue([{ pipelineId: 'p1', name: 'P', stages: [{ stageId: 's1', name: 'Stage 1' }] }]);
    listDeals.mockResolvedValue([]);
    listCompanies.mockRejectedValue(new Error('boom'));
    render(<MemoryRouter><DealsTab orgId="org:1" /></MemoryRouter>);
    await screen.findByText(/couldn.t load companies/i);
  });
});
