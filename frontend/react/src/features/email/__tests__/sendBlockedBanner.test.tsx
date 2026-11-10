/**
 * ADR 0994 — the Email hub's "Campaigns can't send yet" banner names what
 * actually blocks sending, from provider-status, not a hard-coded vendor.
 *
 * Pins:
 *  - nothing connected and no sender → one banner naming the sender AND every
 *    provider the read returned, by display name, linking to Connections;
 *  - Postmark connected, no sender → the sender-only message, no provider list;
 *  - a connected provider and a sender → no banner at all.
 *
 * Copy is asserted through `t()`, never an imported message table. The
 * provider list is pinned as a literal, and the fixture lists the providers in
 * an order (SendGrid, SMTP, Postmark) that differs from the page's own
 * `KNOWN_EMAIL_PROVIDERS` order, so a banner built from that constant instead
 * of provider-status renders a different list.
 *
 * Red when (sabotage-witnessed, /grade-tests wave 80): the banner lists the
 * hard-coded provider constant; the sender-only branch also requires a
 * missing provider; the provider branch fires when one is connected; the
 * connected check is inverted; the Connections link moves; providers render
 * by id instead of display name.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import i18n from '../../../i18n/index.js';
import type * as EC from '../emailClient.js';
import type { ProviderStatus } from '../emailClient.js';

const api = vi.hoisted(() => ({
  getProviderStatus: vi.fn<typeof EC.getProviderStatus>(),
  getEmailSettings: vi.fn<typeof EC.getEmailSettings>(),
}));

import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../emailClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSendingHealth: async (): ReturnType<typeof EC.getSendingHealth> => ({ state: null, window: { sent: 0, hardBounces: 0, complaints: 0 }, thresholds: { minSends: 500, complaintRate: 0.001, hardBounceRate: 0.02 }, canResume: false }),
  listCampaigns: async (): ReturnType<typeof EC.listCampaigns> => [],
  listTemplates: async (): ReturnType<typeof EC.listTemplates> => [],
  listSends: async (): ReturnType<typeof EC.listSends> => [],
  listSegments: async (): ReturnType<typeof EC.listSegments> => [],
  listTopics: async (): ReturnType<typeof EC.listTopics> => ({ topics: [], max: 20 }),
  listOrgs: async (): ReturnType<typeof EC.listOrgs> => [{ orgId: 'org:1', name: 'Acme' }],
  getProviderStatus: (...a: Parameters<typeof EC.getProviderStatus>) => api.getProviderStatus(...a),
  getEmailSettings: (...a: Parameters<typeof EC.getEmailSettings>) => api.getEmailSettings(...a),
}));
vi.mock('../suppressionsClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listSuppressions: async () => [],
}));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: true, loading: false }),
}));

const { EmailPage } = await import('../EmailPage.js');

const t = (key: string, opts?: Record<string, unknown>): string => i18n.t(`email:${key}`, opts ?? {});
const stripTags = (s: string): string => s.replace(/<\/?0>/g, '');
const status = (connected: string | null, senderAddress: string | null): ProviderStatus => ({
  providers: ['sendgrid', 'smtp', 'postmark'].map((provider) => ({ provider, connected: provider === connected })),
  defaultProvider: 'postmark',
  senderAddress,
});
const pageText = (): string => document.body.textContent ?? '';
/** The fixture's providers, by display name, in the fixture's order (en). */
const PROVIDERS = 'SendGrid, SMTP (e.g. Amazon SES), or Postmark';
/** Every banner variant that names providers, as rendered. */
const providerBanners = (): string[] => ['sendBlockedSenderAndProvider', 'sendBlockedSenderAndProviderAskAdmin', 'sendBlockedProvider']
  .map((k) => stripTags(t(k, { providers: PROVIDERS })));

beforeEach(() => {
  api.getProviderStatus.mockReset();
  api.getEmailSettings.mockReset();
});
afterEach(cleanup);

const renderPage = async (): Promise<void> => {
  render(<MemoryRouter><EmailPage /></MemoryRouter>);
  // The provider chips render once provider-status lands, by display name.
  await screen.findByText(new RegExp(`^${t('providerName_sendgrid')} — `));
};

describe('ADR 0994 — the send-blocked banner names the providers from provider-status', () => {
  it('nothing connected, no sender: names the sender and every provider, linking Connections', async () => {
    api.getProviderStatus.mockResolvedValue(status(null, null));
    api.getEmailSettings.mockResolvedValue({ senderAddress: '', configured: false });
    await renderPage();
    const expected = stripTags(t('sendBlockedSenderAndProvider', { providers: PROVIDERS }));
    await waitFor(() => expect(pageText()).toContain(expected));
    expect(pageText()).toContain(PROVIDERS);
    expect(pageText()).not.toContain(t('senderUnconfiguredNotice'));
    expect(document.querySelector('a[href="/access?tab=connections"]')).not.toBeNull();
  });

  it('Postmark connected, no sender: only the sender message, no provider list', async () => {
    api.getProviderStatus.mockResolvedValue(status('postmark', null));
    api.getEmailSettings.mockResolvedValue({ senderAddress: '', configured: false });
    await renderPage();
    await waitFor(() => expect(pageText()).toContain(t('senderUnconfiguredNotice')));
    for (const b of providerBanners()) expect(pageText()).not.toContain(b);
    expect(document.querySelector('a[href="/access?tab=connections"]')).toBeNull();
  });

  it('a connected provider and a sender: no banner', async () => {
    api.getProviderStatus.mockResolvedValue(status('sendgrid', 'news@acme.test'));
    api.getEmailSettings.mockResolvedValue({ senderAddress: 'news@acme.test', configured: true });
    await renderPage();
    await screen.findByText(t('providerSenderIs', { sender: 'news@acme.test' }));
    expect(pageText()).not.toContain(t('senderUnconfiguredNotice'));
    for (const b of providerBanners()) expect(pageText()).not.toContain(b);
    expect(document.querySelector('a[href="/access?tab=connections"]')).toBeNull();
  });
});
