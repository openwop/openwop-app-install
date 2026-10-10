/**
 * ADR 0211 §2 (email side) — the campaign audience picker gains a "By segment"
 * mode alongside "All contacts" / "By stage". Covers the access-gate tri-state
 * (mirrors CrmPage.test.tsx's precedent) plus the new picker: it renders the
 * three modes, fetches saved segments (mocked — no real CRM round trip), and
 * passes `segmentId` (not `stage`) to `createCampaign` when "By segment" is
 * selected. Also covers the campaign-row segment-name display.
 *
 * Sabotage-witnessed (/grade-tests wave 9, `w9g4-ep-*`): dropping the loading
 * guard, the not-enabled gate, the lazy segments condition, the `segmentId`
 * payload, or the segment-name lookup each turns its case red.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type * as EC from '../emailClient.js';

const access = vi.hoisted(() => ({ value: { enabled: false, loading: false, variant: undefined as string | undefined } }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => access.value,
}));

// Typed against the real client, so a fixture drifting from `Campaign` & co. fails tsc.
const listOrgs = vi.hoisted(() => vi.fn<typeof EC.listOrgs>(async () => [{ orgId: 'o1', name: 'Org One' }]));
const listTemplates = vi.hoisted(() => vi.fn<typeof EC.listTemplates>(async () => [{ templateId: 'tpl1', orgId: 'o1', name: 'Welcome', subject: 'Hi', body: 'Hello', createdAt: '', updatedAt: '' }]));
const listCampaigns = vi.hoisted(() => vi.fn<typeof EC.listCampaigns>(async () => []));
const listSends = vi.hoisted(() => vi.fn<typeof EC.listSends>(async () => []));
const listSegments = vi.hoisted(() => vi.fn<typeof EC.listSegments>(async () => [{ segmentId: 'seg1', name: 'Qualified leads' }]));
const createCampaign = vi.hoisted(() => vi.fn<typeof EC.createCampaign>(async () => ({ campaignId: 'cmp1', orgId: 'o1', templateId: 'tpl1', audience: {}, status: 'draft', createdAt: '', updatedAt: '' })));
const getEmailSettings = vi.hoisted(() => vi.fn<typeof EC.getEmailSettings>(async () => ({ senderAddress: 'news@acme.test', configured: true })));
const getProviderStatus = vi.hoisted(() => vi.fn<typeof EC.getProviderStatus>(async () => ({ providers: [], defaultProvider: null, senderAddress: 'news@acme.test' })));

vi.mock('../emailClient.js', () => ({
  CONTACT_STAGES: ['lead', 'qualified', 'customer', 'churned'],
  listOrgs,
  listTemplates,
  createTemplate: vi.fn(),
  updateTemplate: vi.fn(),
  deleteTemplate: vi.fn(),
  listCampaigns,
  createCampaign,
  deleteCampaign: vi.fn(),
  sendCampaign: vi.fn(),
  listSends,
  listSegments,
  getEmailSettings,
  putEmailSettings: vi.fn(),
  getProviderStatus,
}));

import { EmailPage } from '../EmailPage.js';

// EmailPage reads `?org=` / `?log=` (useSearchParams) — needs a Router. (The open
// template is a ROUTE since ADR 0520, not a `?template=` param.)
const renderPage = () => render(<MemoryRouter><EmailPage /></MemoryRouter>);

beforeEach(() => {
  access.value = { enabled: false, loading: false, variant: undefined };
  listOrgs.mockClear(); listTemplates.mockClear(); listSends.mockClear();
  listCampaigns.mockReset();
  listCampaigns.mockResolvedValue([]);
  listSegments.mockReset();
  listSegments.mockResolvedValue([{ segmentId: 'seg1', name: 'Qualified leads' }]);
  createCampaign.mockClear();
  getEmailSettings.mockClear();
  getProviderStatus.mockClear();
});
afterEach(cleanup);

describe('EmailPage access gate', () => {
  it('renders a skeleton while access is loading', () => {
    access.value = { enabled: false, loading: true, variant: undefined };
    const { container } = renderPage();
    expect(screen.queryByText(/not enabled/i)).toBeNull();
    // The claim is the skeleton — and ONLY the skeleton (no page, no gate card).
    // `ui/Skeleton` is a decorative aria-hidden span, so its class is the one
    // observable it has.
    expect(container.firstElementChild?.classList.contains('skeleton')).toBe(true);
    expect(screen.queryByRole('heading')).toBeNull();
    expect(listOrgs).not.toHaveBeenCalled();
  });

  it('shows the "not enabled" StateCard when the feature is off', () => {
    access.value = { enabled: false, loading: false, variant: undefined };
    renderPage();
    expect(screen.getByText(/Email is not enabled/i)).toBeTruthy();
  });
});

describe('EmailPage audience picker (ADR 0211 §2)', () => {
  it('defaults to "All contacts"; segments are NOT fetched until "By segment" is selected (CRMGAP-FE-6)', async () => {
    access.value = { enabled: true, loading: false, variant: undefined };
    renderPage();

    const mode = await screen.findByLabelText('Audience');
    expect((mode as HTMLSelectElement).value).toBe('all');
    // Lazy: no segments round trip on mount / while in the default mode.
    expect(listSegments).not.toHaveBeenCalled();

    fireEvent.change(mode, { target: { value: 'segment' } });
    // First selection triggers the fetch; the select shows a loading option
    // in the interim, then the fetched segments once it resolves.
    await waitFor(() => expect(listSegments).toHaveBeenCalledTimes(1));
    const segmentSelect = await screen.findByLabelText('Segment');
    await waitFor(() => expect(screen.getByRole('option', { name: 'Qualified leads' })).toBeTruthy());
    fireEvent.change(segmentSelect, { target: { value: 'seg1' } });
    expect((segmentSelect as HTMLSelectElement).value).toBe('seg1');
  });

  it('creating a campaign in "By segment" mode passes segmentId (not stage) to createCampaign', async () => {
    access.value = { enabled: true, loading: false, variant: undefined };
    renderPage();
    await waitFor(() => expect(listTemplates).toHaveBeenCalled());

    fireEvent.change(await screen.findByLabelText('Audience'), { target: { value: 'segment' } });
    const segmentSelect = await screen.findByLabelText('Segment');
    await waitFor(() => expect(screen.getByRole('option', { name: 'Qualified leads' })).toBeTruthy());
    fireEvent.change(segmentSelect, { target: { value: 'seg1' } });

    fireEvent.click(screen.getByRole('button', { name: /New campaign/i }));
    await waitFor(() => expect(createCampaign).toHaveBeenCalledWith('o1', { templateId: 'tpl1', segmentId: 'seg1' }));
  });

  it('a campaign whose audience is a segment shows the segment name on its row', async () => {
    access.value = { enabled: true, loading: false, variant: undefined };
    listCampaigns.mockResolvedValue([
      { campaignId: 'cmp1', orgId: 'o1', templateId: 'tpl1', audience: { segmentId: 'seg1' }, status: 'draft', createdAt: '', updatedAt: '' },
    ]);
    renderPage();
    await waitFor(() => expect(screen.getByText(/segment: Qualified leads/i)).toBeTruthy());
  });
});
