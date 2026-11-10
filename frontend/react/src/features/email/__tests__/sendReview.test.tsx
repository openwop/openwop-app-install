/**
 * ADR 0905 D3/D4 — the campaign row's send-review controls.
 *
 * Sabotage (w76 probes): leaving Send enabled under the gate reds the first case; dropping
 * the Submit-for-review button or the gate notice reds it too; blocking an approved campaign
 * reds the second; withdrawing the wrong campaign reds it too; hiding the reviewer note reds
 * the third.
 *
 * The second case waits for a draft row's gate notice before it reads Send: `approvalGate`
 * starts false, so an enabled Send proves nothing until the settings have landed.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { t } from 'i18next';
import type * as EC from '../emailClient.js';
import type { Campaign, EmailSettings, ProviderStatus } from '../emailClient.js';

const AT = '2026-10-17T00:00:00.000Z';
const listCampaigns = vi.fn<typeof EC.listCampaigns>();
const submitCampaignReview = vi.fn<typeof EC.submitCampaignReview>();
const withdrawCampaignReview = vi.fn<typeof EC.withdrawCampaignReview>();
const sendCampaign = vi.fn<typeof EC.sendCampaign>();
let settings: EmailSettings = { senderAddress: 'news@acme.test', configured: true };

import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../emailClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // ADR 0955 D7 — the page's sending-health card (a healthy sender).
  getSendingHealth: async (): Promise<EC.SendingHealth> => ({ state: null, window: { sent: 0, hardBounces: 0, complaints: 0 }, thresholds: { minSends: 500, complaintRate: 0.001, hardBounceRate: 0.02 }, canResume: false }),
  listCampaigns: (...a: Parameters<typeof EC.listCampaigns>) => listCampaigns(...a),
  listTemplates: async (): Promise<EC.EmailTemplate[]> => [{ templateId: 'tpl1', orgId: 'org:1', name: 'Welcome', subject: 's', body: 'b', createdAt: AT, updatedAt: AT }],
  submitCampaignReview: (...a: Parameters<typeof EC.submitCampaignReview>) => submitCampaignReview(...a),
  withdrawCampaignReview: (...a: Parameters<typeof EC.withdrawCampaignReview>) => withdrawCampaignReview(...a),
  sendCampaign: (...a: Parameters<typeof EC.sendCampaign>) => sendCampaign(...a),
  listSends: async () => [],
  listSegments: async () => [],
  listTopics: async () => ({ topics: [], max: 20 }),
  getEmailSettings: async (): Promise<EmailSettings> => settings,
  getProviderStatus: async (): Promise<ProviderStatus> => ({ providers: [], defaultProvider: null, senderAddress: 'news@acme.test' }),
  listOrgs: async (): Promise<EC.Org[]> => [{ orgId: 'org:1', name: 'Acme' }],
}));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: true, loading: false }),
}));

const { EmailPage } = await import('../EmailPage.js');

const campaign = (status: Campaign['status'], extra: Partial<Campaign> = {}): Campaign => ({
  campaignId: 'c1', orgId: 'org:1', templateId: 'tpl1', audience: { stage: 'lead' }, status, createdAt: AT, updatedAt: AT, ...extra,
});
const renderPage = () => render(<MemoryRouter><EmailPage /></MemoryRouter>);
const rowOf = (el: HTMLElement): HTMLElement => {
  const row = el.closest<HTMLElement>('.surface-inset');
  if (!row) throw new Error('no campaign row');
  return row;
};

beforeEach(() => { vi.clearAllMocks(); settings = { senderAddress: 'news@acme.test', configured: true }; });
afterEach(cleanup);

describe('ADR 0905 — campaign send review controls', () => {
  it('under the gate a draft cannot be sent; Submit for review calls the route', async () => {
    settings = { ...settings, approvalGate: true };
    listCampaigns.mockResolvedValue([campaign('draft')]);
    submitCampaignReview.mockResolvedValue(campaign('in_review'));
    renderPage();
    const sendBtn = await screen.findByRole('button', { name: /^send$/i });
    await waitFor(() => expect(sendBtn).toHaveProperty('disabled', true));
    expect(screen.getByText(t('email:sendNeedsApproval'))).toBeTruthy();
    fireEvent.click(sendBtn);
    expect(sendCampaign).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: t('email:submitForReview') }));
    await waitFor(() => expect(submitCampaignReview).toHaveBeenCalledWith('org:1', 'c1'));
  });

  it('an approved campaign can be sent under the gate and shows the pinned version; Withdraw is offered', async () => {
    settings = { ...settings, approvalGate: true };
    withdrawCampaignReview.mockResolvedValue(campaign('draft'));
    listCampaigns.mockResolvedValue([
      campaign('approved', { review: { cycle: 1, approvalId: 'a1', fromStatus: 'draft', submittedAt: AT, outcome: 'approved', pin: { templateId: 'tpl1', templateVersion: 4, contentHash: 'h', senderAddress: 'x', audienceHash: 'y' } } }),
      campaign('draft', { campaignId: 'c2' }),
    ]);
    renderPage();
    // The settle signal: the gate has loaded. One match, so the approved row has no notice.
    await screen.findByText(t('email:sendNeedsApproval'));
    const row = within(rowOf(screen.getByText(t('email:reviewApprovedLine', { version: '4' }))));
    expect(row.getByRole('button', { name: /^send$/i })).toHaveProperty('disabled', false);
    fireEvent.click(row.getByRole('button', { name: t('email:withdrawReview') }));
    await waitFor(() => expect(withdrawCampaignReview).toHaveBeenCalledWith('org:1', 'c1'));
  });

  it('a rejected review shows "Changes requested" with the reviewer note', async () => {
    listCampaigns.mockResolvedValue([campaign('draft', { review: { cycle: 1, approvalId: 'a1', fromStatus: 'draft', submittedAt: AT, outcome: 'changes_requested', note: 'Fix the subject line', pin: { templateId: 'tpl1', templateVersion: 1, contentHash: 'h', senderAddress: 'x', audienceHash: 'y' } } })]);
    renderPage();
    expect(await screen.findByText(t('email:reviewChangesRequested'))).toBeTruthy();
    expect(screen.getByText(/Fix the subject line/)).toBeTruthy();
  });
});
