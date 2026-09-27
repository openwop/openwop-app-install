/**
 * UX_UPGRADE-email EM-G1 — confirming a campaign send.
 *
 * Only a RE-send asked for confirmation. The first send — the one that actually
 * mails real people, and cannot be recalled — went straight through on a single
 * click. This pins the gate, and pins that the dialog carries information
 * (what is going to whom) rather than being pure friction.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Campaign } from '../emailClient.js';

const listCampaigns = vi.fn();
const listTemplates = vi.fn();
const sendCampaign = vi.fn();
const confirmFn = vi.fn();

import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../emailClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listCampaigns: (...a: unknown[]) => listCampaigns(...a),
  listTemplates: (...a: unknown[]) => listTemplates(...a),
  sendCampaign: (...a: unknown[]) => sendCampaign(...a),
  listSends: async () => [],
  listSegments: async () => [],
  getEmailSettings: async () => ({}),
  listOrgs: async () => [{ orgId: 'org:1', name: 'Acme' }],
}));
vi.mock('../../../ui/confirm.js', () => ({ confirm: (...a: unknown[]) => confirmFn(...a) }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: true, loading: false }),
}));

const { EmailPage } = await import('../EmailPage.js');

const campaign = (status: Campaign['status']): Campaign => ({
  campaignId: 'c1', orgId: 'org:1', templateId: 'tpl1',
  audience: { stage: 'lead' }, status, createdAt: '', updatedAt: '',
} as Campaign);

// The page reads the URL (org deep-link), so it needs a router.
const renderPage = () => render(<MemoryRouter><EmailPage /></MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  listTemplates.mockResolvedValue([{ templateId: 'tpl1', orgId: 'org:1', name: 'Welcome', subject: 's', body: 'b', createdAt: '', updatedAt: '' }]);
  sendCampaign.mockResolvedValue({ status: 'sent', stats: { sent: 3, failed: 0, skipped: 0 } });
});
afterEach(cleanup);

const clickSend = async () => {
  // R2 EM-SP-11 — the accessible name now EQUALS the visible verb (WCAG 2.5.3);
  // the old 'Send campaign' aria-label diverged from the visible 'Send'.
  const btn = await screen.findByRole('button', { name: /^send$|^re-send$|^continue sending$/i });
  fireEvent.click(btn);
};

describe('email — the first send is gated too (EM-G1)', () => {
  it('ASKS before a first send, and does not send when declined', async () => {
    listCampaigns.mockResolvedValue([campaign('draft')]);
    confirmFn.mockResolvedValue(false);
    renderPage();
    await clickSend();

    await waitFor(() => expect(confirmFn).toHaveBeenCalled());
    // The gate held: nothing was mailed.
    expect(sendCampaign).not.toHaveBeenCalled();
  });

  it('names WHAT is going to WHOM, so the dialog is information not friction', async () => {
    listCampaigns.mockResolvedValue([campaign('draft')]);
    confirmFn.mockResolvedValue(false);
    renderPage();
    await clickSend();

    await waitFor(() => expect(confirmFn).toHaveBeenCalled());
    const arg = confirmFn.mock.calls[0]![0] as { title: string; body: string };
    expect(arg.body).toContain('Welcome');            // the template
    expect(arg.body).toMatch(/lead/i);                // the audience
    expect(arg.body).toMatch(/can’t be recalled/i);   // why it matters
  });

  it('proceeds when confirmed', async () => {
    listCampaigns.mockResolvedValue([campaign('draft')]);
    confirmFn.mockResolvedValue(true);
    renderPage();
    await clickSend();
    await waitFor(() => expect(sendCampaign).toHaveBeenCalledWith('org:1', 'c1', false));
  });
});

describe('email — resend keeps its stronger warning (EM-G1)', () => {
  it('still asks, with the re-send wording and the resend flag', async () => {
    listCampaigns.mockResolvedValue([campaign('sent')]);
    confirmFn.mockResolvedValue(true);
    renderPage();
    const btn = await screen.findByRole('button', { name: /^re-send$/i });
    fireEvent.click(btn);

    await waitFor(() => expect(confirmFn).toHaveBeenCalled());
    // EM-UX-21 — the TITLE (the dialog's accessible name) is a short question;
    // the "already sent" consequence moved to the body.
    const arg = confirmFn.mock.calls[0]![0] as { title: string; body: string };
    expect(arg.title).toMatch(/re-send this campaign\?/i);
    expect(arg.body).toMatch(/already sent/i);
    await waitFor(() => expect(sendCampaign).toHaveBeenCalledWith('org:1', 'c1', true));
  });
});

describe('email — resuming an in-flight send is not re-asked (EM-G1)', () => {
  it('continues a partially-sent campaign without a second dialog', async () => {
    // The send was already authorized; asking again would train people to click
    // past the dialog that matters.
    listCampaigns.mockResolvedValue([campaign('sending')]);
    renderPage();
    const btn = await screen.findByRole('button', { name: /send campaign|continue/i });
    fireEvent.click(btn);

    await waitFor(() => expect(sendCampaign).toHaveBeenCalled());
    expect(confirmFn).not.toHaveBeenCalled();
  });
});
