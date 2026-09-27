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
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Campaign, SendLog } from '../emailClient.js';

const listCampaigns = vi.fn();
const listTemplates = vi.fn();
const listSends = vi.fn();

import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../emailClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listCampaigns: (...a: unknown[]) => listCampaigns(...a),
  listTemplates: (...a: unknown[]) => listTemplates(...a),
  listSends: (...a: unknown[]) => listSends(...a),
  listSegments: async () => [],
  getEmailSettings: async () => ({}),
  listOrgs: async () => [{ orgId: 'org:1', name: 'Acme' }],
}));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: true, loading: false }),
}));

const { EmailPage } = await import('../EmailPage.js');

const campaign: Campaign = {
  campaignId: 'c1', orgId: 'org:1', templateId: 'tpl1',
  audience: { stage: 'lead' }, status: 'sent', createdAt: '', updatedAt: '',
} as Campaign;

const send: SendLog = {
  sendId: 's1', campaignId: 'c1', contactId: 'contact-42', status: 'sent', ts: '',
} as SendLog;

const renderAt = (entry: string) =>
  render(<MemoryRouter initialEntries={[entry]}><EmailPage /></MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  listCampaigns.mockResolvedValue([campaign]);
  listTemplates.mockResolvedValue([{ templateId: 'tpl1', name: 'Welcome', subject: 'Hi', body: 'x' }]);
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
    await waitFor(() => expect(listCampaigns).toHaveBeenCalled());
    expect(listSends).not.toHaveBeenCalled();
  });

  it('a ?log= naming an unknown campaign does not crash the page', async () => {
    // The param is user-supplied and can outlive the campaign it names.
    listSends.mockRejectedValue(new Error('404'));
    renderAt('/email?org=org:1&log=deleted-campaign');
    await waitFor(() => expect(listSends).toHaveBeenCalledWith('org:1', 'deleted-campaign'));
    // The campaigns list still renders — a stale param must not take the page.
    // `findAll`: the template name appears both as a card and as an option in
    // the new-campaign picker, by design.
    expect((await screen.findAllByText('Welcome')).length).toBeGreaterThan(0);
  });
});
