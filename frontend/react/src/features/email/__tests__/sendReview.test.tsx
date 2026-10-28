/**
 * ADR 0905 D3/D4 — the campaign row's send-review controls.
 *
 * Sabotage-witnessed: leaving Send enabled under the gate reds the first case; dropping
 * the Submit-for-review button reds it too; hiding the reviewer note reds the third.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type * as EC from '../emailClient.js';
import type { Campaign, EmailSettings, ProviderStatus } from '../emailClient.js';

const listCampaigns = vi.fn<typeof EC.listCampaigns>();
const submitCampaignReview = vi.fn<typeof EC.submitCampaignReview>();
const withdrawCampaignReview = vi.fn<typeof EC.withdrawCampaignReview>();
let settings: EmailSettings = { senderAddress: 'news@acme.test', configured: true };

import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../emailClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // ADR 0955 D7 — the page's sending-health card (a healthy sender).
  getSendingHealth: async () => ({ state: null, window: { sent: 0, hardBounces: 0, complaints: 0 }, thresholds: { minSends: 500, complaintRate: 0.001, hardBounceRate: 0.02 }, canResume: false }),
  listCampaigns: (...a: Parameters<typeof EC.listCampaigns>) => listCampaigns(...a),
  listTemplates: async () => [{ templateId: 'tpl1', orgId: 'org:1', name: 'Welcome', subject: 's', body: 'b', createdAt: '', updatedAt: '' }],
  submitCampaignReview: (...a: Parameters<typeof EC.submitCampaignReview>) => submitCampaignReview(...a),
  withdrawCampaignReview: (...a: Parameters<typeof EC.withdrawCampaignReview>) => withdrawCampaignReview(...a),
  sendCampaign: async () => { throw new Error('not in this test'); },
  listSends: async () => [],
  listSegments: async () => [],
  listTopics: async () => ({ topics: [], max: 20 }),
  getEmailSettings: async (): Promise<EmailSettings> => settings,
  getProviderStatus: async (): Promise<ProviderStatus> => ({ providers: [], defaultProvider: null, senderAddress: 'news@acme.test' }),
  listOrgs: async () => [{ orgId: 'org:1', name: 'Acme' }],
}));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: true, loading: false }),
}));

const { EmailPage } = await import('../EmailPage.js');

const campaign = (status: Campaign['status'], extra: Partial<Campaign> = {}): Campaign => ({
  campaignId: 'c1', orgId: 'org:1', templateId: 'tpl1', audience: { stage: 'lead' }, status, createdAt: '', updatedAt: '', ...extra,
});
const renderPage = () => render(<MemoryRouter><EmailPage /></MemoryRouter>);

beforeEach(() => { vi.clearAllMocks(); settings = { senderAddress: 'news@acme.test', configured: true }; });
afterEach(cleanup);

describe('ADR 0905 — campaign send review controls', () => {
  it('under the gate a draft cannot be sent; Submit for review calls the route', async () => {
    settings = { ...settings, approvalGate: true };
    listCampaigns.mockResolvedValue([campaign('draft')]);
    submitCampaignReview.mockResolvedValue(campaign('in_review'));
    renderPage();
    const sendBtn = await screen.findByRole('button', { name: /^send$/i });
    await waitFor(() => expect((sendBtn as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByText(/requires an approval before sending/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Submit for review' }));
    await waitFor(() => expect(submitCampaignReview).toHaveBeenCalledWith('org:1', 'c1'));
  });

  it('an approved campaign can be sent under the gate and shows the pinned version; Withdraw is offered', async () => {
    settings = { ...settings, approvalGate: true };
    listCampaigns.mockResolvedValue([campaign('approved', { review: { cycle: 1, approvalId: 'a1', fromStatus: 'draft', submittedAt: '', outcome: 'approved', pin: { templateId: 'tpl1', templateVersion: 4, contentHash: 'h', senderAddress: 'x', audienceHash: 'y' } } })]);
    renderPage();
    const sendBtn = await screen.findByRole('button', { name: /^send$/i });
    expect((sendBtn as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByText(/Approved · template v4/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Withdraw review' })).toBeTruthy();
  });

  it('a rejected review shows "Changes requested" with the reviewer note', async () => {
    listCampaigns.mockResolvedValue([campaign('draft', { review: { cycle: 1, approvalId: 'a1', fromStatus: 'draft', submittedAt: '', outcome: 'changes_requested', note: 'Fix the subject line', pin: { templateId: 'tpl1', templateVersion: 1, contentHash: 'h', senderAddress: 'x', audienceHash: 'y' } } })]);
    renderPage();
    expect(await screen.findByText('Changes requested')).toBeTruthy();
    expect(screen.getByText(/Fix the subject line/)).toBeTruthy();
  });
});
