/**
 * ADR 0905 D7 — topics on the Email page: a campaign can target a topic, a topic can be
 * added and the list re-reads, and a campaign row names its topic.
 *
 * Sabotage (w76 probes): dropping `topicId` from the create call reds the first case;
 * not re-reading after an add reds it too; dropping the topic chip on the row, or losing
 * its name, reds the second.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { t } from 'i18next';
import type * as EC from '../emailClient.js';
import type { Campaign, EmailSettings, ProviderStatus } from '../emailClient.js';

const AT = '2026-10-17T00:00:00.000Z';
const listCampaigns = vi.fn<typeof EC.listCampaigns>();
const createCampaign = vi.fn<typeof EC.createCampaign>();
const createTopic = vi.fn<typeof EC.createTopic>();
const listTopics = vi.fn<typeof EC.listTopics>();
const TOPICS: Awaited<ReturnType<typeof EC.listTopics>> = { topics: [{ topicId: 'tp1', orgId: 'org:1', name: 'Webinars', createdAt: AT, updatedAt: AT }], max: 20 };

import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../emailClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // ADR 0955 D7 — the page's sending-health card (a healthy sender).
  getSendingHealth: async (): Promise<EC.SendingHealth> => ({ state: null, window: { sent: 0, hardBounces: 0, complaints: 0 }, thresholds: { minSends: 500, complaintRate: 0.001, hardBounceRate: 0.02 }, canResume: false }),
  listCampaigns: (...a: Parameters<typeof EC.listCampaigns>) => listCampaigns(...a),
  createCampaign: (...a: Parameters<typeof EC.createCampaign>) => createCampaign(...a),
  createTopic: (...a: Parameters<typeof EC.createTopic>) => createTopic(...a),
  listTopics: (...a: Parameters<typeof EC.listTopics>) => listTopics(...a),
  listTemplates: async (): Promise<EC.EmailTemplate[]> => [{ templateId: 'tpl1', orgId: 'org:1', name: 'Welcome', subject: 's', body: 'b', createdAt: AT, updatedAt: AT }],
  listSends: async () => [],
  listSegments: async () => [],
  getEmailSettings: async (): Promise<EmailSettings> => ({ senderAddress: 'news@acme.test', configured: true }),
  getProviderStatus: async (): Promise<ProviderStatus> => ({ providers: [], defaultProvider: null, senderAddress: 'news@acme.test' }),
  listOrgs: async (): Promise<EC.Org[]> => [{ orgId: 'org:1', name: 'Acme' }],
}));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: true, loading: false }),
}));

const { EmailPage } = await import('../EmailPage.js');
const campaign = (extra: Partial<Campaign> = {}): Campaign => ({ campaignId: 'c1', orgId: 'org:1', templateId: 'tpl1', audience: {}, status: 'draft', createdAt: AT, updatedAt: AT, ...extra });
const renderPage = () => render(<MemoryRouter><EmailPage /></MemoryRouter>);

beforeEach(() => { vi.clearAllMocks(); listTopics.mockResolvedValue(TOPICS); });
afterEach(cleanup);

describe('ADR 0905 D7 — topics on the Email page', () => {
  it('a campaign can target a topic; a topic can be added', async () => {
    listCampaigns.mockResolvedValue([]);
    createCampaign.mockResolvedValue(campaign({ topicId: 'tp1' }));
    createTopic.mockResolvedValue(TOPICS.topics[0]!);
    renderPage();
    const select = await screen.findByLabelText(t('email:campaignTopicLabel'));
    await waitFor(() => expect(screen.getAllByText('Welcome').length).toBeGreaterThan(0));
    fireEvent.change(select, { target: { value: 'tp1' } });
    fireEvent.click(screen.getByRole('button', { name: t('email:newCampaign') }));
    await waitFor(() => expect(createCampaign).toHaveBeenCalledWith('org:1', expect.objectContaining({ topicId: 'tp1' })));

    const reads = listTopics.mock.calls.length;
    fireEvent.change(screen.getByLabelText(t('email:topicNameLabel')), { target: { value: 'Product updates' } });
    fireEvent.click(screen.getByRole('button', { name: t('email:topicAdd') }));
    await waitFor(() => expect(createTopic).toHaveBeenCalledWith('org:1', { name: 'Product updates' }));
    await waitFor(() => expect(listTopics).toHaveBeenCalledTimes(reads + 1));
    expect(listTopics).toHaveBeenLastCalledWith('org:1');
  });

  it('a campaign row names its topic', async () => {
    listCampaigns.mockResolvedValue([campaign({ topicId: 'tp1' })]);
    renderPage();
    const send = await screen.findByRole('button', { name: /^send$/i });
    const row = send.closest<HTMLElement>('.surface-inset');
    if (!row) throw new Error('no campaign row');
    expect(await within(row).findByText('Webinars')).toBeTruthy();
  });
});
