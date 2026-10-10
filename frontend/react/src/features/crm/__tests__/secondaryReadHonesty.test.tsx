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
 *
 * Gap ids in `docs/steward/UX_UPGRADE-crm-console.md`. Sabotage-witnessed
 * (wave-4 /grade-tests, w4g5-sr-*): forcing each failure flag's branch off
 * (GmailSync `connectionsFailed`, DealDetail `pipelinesFailed` /
 * `companyFailed`, DealsTab `companiesFailed`) reds its case, and a segments
 * Retry that only clears the flag without re-reading reds CC-SP-8 — which,
 * before wave 4, passed that sabotage: the chip is cleared synchronously on
 * click, so "chip gone" alone could not see whether the re-read happened.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
import type { Pipeline } from '../crmOrgClient.js';

type OrgApi = typeof import('../crmOrgClient.js');
type CrmApi = typeof import('../crmClient.js');
type ConnApi = typeof import('../../connections/connectionsClient.js');
type GmailApi = typeof import('../gmailSyncClient.js');
const PIPELINES: Pipeline[] = [{ pipelineId: 'p1', name: 'P', stages: [{ stageId: 's1', name: 'Stage 1', probability: 10 }] }];

const listConnections = vi.fn<ConnApi['listConnections']>();
vi.mock('../../connections/connectionsClient.js', async (importOriginal) => ({
  ...(await importOriginal<ConnApi>()),
  listConnections: (...a: Parameters<ConnApi['listConnections']>) => listConnections(...a),
}));

const listContacts = vi.fn<CrmApi['listContacts']>();
const listSegments = vi.fn<CrmApi['listSegments']>();
vi.mock('../crmClient.js', async (importOriginal) => ({
  ...(await importOriginal<CrmApi>()),
  listContacts: (...a: Parameters<CrmApi['listContacts']>) => listContacts(...a),
  listSegments: (...a: Parameters<CrmApi['listSegments']>) => listSegments(...a),
  // CRM-UX-7 — ContactsTab reads the contact field DEFS on mount. Stubbed for
  // the same reason `listGmailSyncs` is noted below: this factory SPREADS the
  // original, so an unstubbed export is a REAL fetch, and its rejection would
  // mount a second failure chip + retry button and make this file flaky.
  listContactFields: vi.fn<CrmApi['listContactFields']>(async () => []),
}));

// `listGmailSyncs` lives in gmailSyncClient, NOT crmClient — GmailSyncTab imports
// it from `./gmailSyncClient.js`. It was previously listed in the crmClient mock
// above, where nothing imports it, so the mock was inert and the component made a
// REAL `fetch` on every run. That is what made this file flaky at ~30% solo: the
// real read rejects with "fetch failed", setting the component's `error` state and
// rendering a SECOND retry button, so `getByRole('button', {name:/retry/i})` threw
// "Found multiple elements" whenever the network rejection landed before the
// assertion. The mock was not slow — it was never installed.
const listGmailSyncs = vi.fn<GmailApi['listGmailSyncs']>();
vi.mock('../gmailSyncClient.js', async (importOriginal) => ({
  ...(await importOriginal<GmailApi>()),
  listGmailSyncs: (...a: Parameters<GmailApi['listGmailSyncs']>) => listGmailSyncs(...a),
}));

const getDeal = vi.fn<OrgApi['getDeal']>();
const getCompany = vi.fn<OrgApi['getCompany']>();
const listPipelines = vi.fn<OrgApi['listPipelines']>();
const listCompanies = vi.fn<OrgApi['listCompanies']>();
const listDeals = vi.fn<OrgApi['listDeals']>();
const listActivities = vi.fn<OrgApi['listActivities']>(async () => []);
// DealDetailPage also reads the deal's tasks; unstubbed it was a live fetch.
const listTasks = vi.fn<OrgApi['listTasks']>(async () => []);
vi.mock('../crmOrgClient.js', async (importOriginal) => ({
  ...(await importOriginal<OrgApi>()),
  getDeal: (...a: Parameters<OrgApi['getDeal']>) => getDeal(...a),
  getCompany: (...a: Parameters<OrgApi['getCompany']>) => getCompany(...a),
  listPipelines: (...a: Parameters<OrgApi['listPipelines']>) => listPipelines(...a),
  listCompanies: (...a: Parameters<OrgApi['listCompanies']>) => listCompanies(...a),
  listDeals: (...a: Parameters<OrgApi['listDeals']>) => listDeals(...a),
  listActivities: (...a: Parameters<OrgApi['listActivities']>) => listActivities(...a),
  listTasks: (...a: Parameters<OrgApi['listTasks']>) => listTasks(...a),
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

beforeEach(() => vi.resetAllMocks());
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
    getDeal.mockResolvedValue({ dealId: 'd1', title: 'Big deal', stageId: 's1', pipelineId: 'p1', status: 'open' });
    listPipelines.mockRejectedValue(new Error('boom'));
    await renderDetail();
    await screen.findByText(/stages didn.t load/i);
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
    // …and NOT an empty stage select beside it (the defect's shape).
    expect(screen.queryByRole('combobox', { name: /stage/i })).toBeNull();
  });

  it('a failed company read is named, never rendered as "no company"', async () => {
    getDeal.mockResolvedValue({ dealId: 'd1', title: 'Big deal', stageId: 's1', pipelineId: 'p1', status: 'open', companyId: 'co1' });
    getCompany.mockRejectedValue(new Error('boom'));
    listPipelines.mockResolvedValue(PIPELINES);
    await renderDetail();
    await screen.findByText(/couldn.t load the linked company/i);
  });

  it('a deal with genuinely NO company shows nothing (the positive case)', async () => {
    getDeal.mockResolvedValue({ dealId: 'd1', title: 'Big deal', stageId: 's1', pipelineId: 'p1', status: 'open' });
    listPipelines.mockResolvedValue(PIPELINES);
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
    listSegments.mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue([{ segmentId: 'sg1', name: 'VIPs', filters: [], createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }]);
    render(<MemoryRouter><ContactsTab /></MemoryRouter>);
    await screen.findByText(/segments didn.t load/i);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    // The chip is cleared SYNCHRONOUSLY on click, so its absence alone cannot
    // tell a real re-read from a Retry that only resets the flag: wait for the
    // re-read's segment to arrive in the picker.
    expect(await screen.findByRole('option', { name: 'VIPs' })).toBeTruthy();
    expect(listSegments).toHaveBeenCalledTimes(2);
    expect(screen.queryByText(/segments didn.t load/i)).toBeNull();
  });
});

describe('CC-SP-9 — Deals companies dropdown failure is named', () => {
  it('a failed companies read shows the incomplete-list warning by the select', async () => {
    const { DealsTab } = await import('../DealsTab.js');
    listPipelines.mockResolvedValue(PIPELINES);
    listDeals.mockResolvedValue([]);
    listCompanies.mockRejectedValue(new Error('boom'));
    render(<MemoryRouter><DealsTab orgId="org:1" /></MemoryRouter>);
    await screen.findByText(/couldn.t load companies/i);
  });
});
