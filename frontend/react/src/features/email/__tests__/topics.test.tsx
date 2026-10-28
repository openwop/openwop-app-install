/**
 * ADR 0905 D7 — topics on the Email page: the org's topics are managed in their own
 * card, a campaign can target one, and a campaign row names its topic.
 *
 * Sabotage-witnessed: dropping `topicId` from the create call reds the first case;
 * dropping the topic chip on the row reds the second.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type * as EC from '../emailClient.js';
import type { Campaign, EmailSettings, ProviderStatus } from '../emailClient.js';

const listCampaigns = vi.fn<typeof EC.listCampaigns>();
const createCampaign = vi.fn<typeof EC.createCampaign>();
const createTopic = vi.fn<typeof EC.createTopic>();
const TOPICS = { topics: [{ topicId: 'tp1', orgId: 'org:1', name: 'Webinars', createdAt: '', updatedAt: '' }], max: 20 };

import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../emailClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // ADR 0955 D7 — the page's sending-health card (a healthy sender).
  getSendingHealth: async () => ({ state: null, window: { sent: 0, hardBounces: 0, complaints: 0 }, thresholds: { minSends: 500, complaintRate: 0.001, hardBounceRate: 0.02 }, canResume: false }),
  listCampaigns: (...a: Parameters<typeof EC.listCampaigns>) => listCampaigns(...a),
  createCampaign: (...a: Parameters<typeof EC.createCampaign>) => createCampaign(...a),
  createTopic: (...a: Parameters<typeof EC.createTopic>) => createTopic(...a),
  listTopics: async () => TOPICS,
  listTemplates: async () => [{ templateId: 'tpl1', orgId: 'org:1', name: 'Welcome', subject: 's', body: 'b', createdAt: '', updatedAt: '' }],
  listSends: async () => [],
  listSegments: async () => [],
  getEmailSettings: async (): Promise<EmailSettings> => ({ senderAddress: 'news@acme.test', configured: true }),
  getProviderStatus: async (): Promise<ProviderStatus> => ({ providers: [], defaultProvider: null, senderAddress: 'news@acme.test' }),
  listOrgs: async () => [{ orgId: 'org:1', name: 'Acme' }],
}));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: true, loading: false }),
}));

const { EmailPage } = await import('../EmailPage.js');
const campaign = (extra: Partial<Campaign> = {}): Campaign => ({ campaignId: 'c1', orgId: 'org:1', templateId: 'tpl1', audience: {}, status: 'draft', createdAt: '', updatedAt: '', ...extra });
const renderPage = () => render(<MemoryRouter><EmailPage /></MemoryRouter>);

beforeEach(() => { vi.clearAllMocks(); });
afterEach(cleanup);

describe('ADR 0905 D7 — topics on the Email page', () => {
  it('a campaign can target a topic; a topic can be added', async () => {
    listCampaigns.mockResolvedValue([]);
    createCampaign.mockResolvedValue(campaign({ topicId: 'tp1' }));
    createTopic.mockResolvedValue(TOPICS.topics[0]!);
    renderPage();
    const select = await screen.findByLabelText('Topic');
    await waitFor(() => expect(screen.getAllByText('Welcome').length).toBeGreaterThan(0));
    fireEvent.change(select, { target: { value: 'tp1' } });
    fireEvent.click(screen.getByRole('button', { name: /new campaign/i }));
    await waitFor(() => expect(createCampaign).toHaveBeenCalled());
    expect(createCampaign.mock.calls[0]![1]).toMatchObject({ topicId: 'tp1' });

    fireEvent.change(screen.getByLabelText('New topic'), { target: { value: 'Product updates' } });
    fireEvent.click(screen.getByRole('button', { name: /add topic/i }));
    await waitFor(() => expect(createTopic).toHaveBeenCalledWith('org:1', { name: 'Product updates' }));
  });

  it('a campaign row names its topic', async () => {
    listCampaigns.mockResolvedValue([campaign({ topicId: 'tp1' })]);
    renderPage();
    await waitFor(() => expect(screen.getAllByText('Webinars').length).toBe(3));
  });
});
