/**
 * The campaign send log is a deep-linkable QUICK-LOOK (`CC-4`, DESIGN.md §4.5 rule 9).
 *
 * A campaign has no editor, so its "detail" IS the send log, and rule 9 is explicit
 * that reviewing an entity should not leave the list — the log correctly stays in
 * place. What the rule ALSO requires, and what was missing, is that the open state
 * be "deep-linkable via URL params". Held in `useState` it could not be shared,
 * bookmarked, or restored on reload, and Back did not close it.
 *
 * The load path is the part worth pinning: the fetch follows the URL rather than the
 * click, so an INBOUND `?log=` link opens a populated panel instead of an empty one.
 * That is the difference between a deep link that works and one that only looks like
 * it does.
 *
 * Sabotage-witnessed (/grade-tests wave 9): `logFor` ignoring the URL turns case 1
 * red (`w9g4-cl-url-open`); a default `?log=` turns case 2 red (`w9g4-cl-url-none`).
 * A third case ("a ?log= naming an unknown campaign does not crash the page") was
 * CUT: the stale id matches no rendered row, so no code path could crash and its
 * probe stayed green (`w9g4-cl-stale-VACUOUS`). A FAILED log read on a real row is
 * pinned by `adr0654D10.test.tsx` "failed log read → failed state + Retry…"
 * (witnessed red by `w9g4-d10-sends-failed`).
 *
 * Every read the page makes is mocked (incl. `getProviderStatus`), so this file
 * no longer needs a `test-live-fetch-allowlist.txt` line.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type * as EC from '../emailClient.js';
import type { Campaign, EmailSettings, ProviderStatus, SendLog } from '../emailClient.js';

const listCampaigns = vi.fn<typeof EC.listCampaigns>();
const listTemplates = vi.fn<typeof EC.listTemplates>();
const listSends = vi.fn<typeof EC.listSends>();

import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../emailClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  // ADR 0955 D7 — the page's sending-health card (a healthy sender).
  getSendingHealth: async () => ({ state: null, window: { sent: 0, hardBounces: 0, complaints: 0 }, thresholds: { minSends: 500, complaintRate: 0.001, hardBounceRate: 0.02 }, canResume: false }),
  listCampaigns: (...a: Parameters<typeof EC.listCampaigns>) => listCampaigns(...a),
  listTemplates: (...a: Parameters<typeof EC.listTemplates>) => listTemplates(...a),
  listSends: (...a: Parameters<typeof EC.listSends>) => listSends(...a),
  listSegments: async () => [],
  listTopics: async () => ({ topics: [], max: 20 }),
  getEmailSettings: async (): Promise<EmailSettings> => ({ senderAddress: 'news@acme.test', configured: true }),
  getProviderStatus: async (): Promise<ProviderStatus> => ({ providers: [], defaultProvider: null, senderAddress: 'news@acme.test' }),
  listOrgs: async () => [{ orgId: 'org:1', name: 'Acme' }],
}));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: true, loading: false }),
}));

const { EmailPage } = await import('../EmailPage.js');

const campaign: Campaign = {
  campaignId: 'c1', orgId: 'org:1', templateId: 'tpl1',
  audience: { stage: 'lead' }, status: 'sent', createdAt: '', updatedAt: '',
};

const send: SendLog = {
  sendId: 's1', campaignId: 'c1', contactId: 'contact-42', status: 'sent', ts: '',
};

const renderAt = (entry: string) =>
  render(<MemoryRouter initialEntries={[entry]}><EmailPage /></MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  listCampaigns.mockResolvedValue([campaign]);
  listTemplates.mockResolvedValue([{ templateId: 'tpl1', orgId: 'org:1', name: 'Welcome', subject: 'Hi', body: 'x', createdAt: '', updatedAt: '' }]);
  listSends.mockResolvedValue([send]);
});
afterEach(cleanup);

describe('the campaign send log follows the URL', () => {
  it('an inbound ?log= link OPENS the log and loads it', async () => {
    renderAt('/email?org=org:1&log=c1');
    // The fetch is keyed to the URL, not to a click — this is the assertion that
    // separates a working deep link from one that opens an empty panel.
    await waitFor(() => expect(listSends).toHaveBeenCalledWith('org:1', 'c1'));
    expect(await screen.findByText(/contact-42/)).toBeTruthy();
  });

  it('does NOT load a log when the URL names none', async () => {
    renderAt('/email?org=org:1');
    // Give the page the same settle time the positive case gets, so this is a
    // real "did not happen" rather than a race that has not resolved yet.
    // `listCampaigns` and the sends effect fire in the SAME org commit, so once the
    // campaigns read has been issued the sends effect has already run (or not).
    await waitFor(() => expect(listCampaigns).toHaveBeenCalled());
    expect(listSends).not.toHaveBeenCalled();
  });
});
