/**
 * UX_UPGRADE-email ROUND 2 — XEM-1/2/3/4 (frontend).
 *
 *  - EM-SP-4: a FAILED segments read never renders the "create one on the CRM
 *    page" instruction (a false instruction over a read error).
 *  - EM-SP-5: a failed settings read BLOCKS the sender save — Save with the
 *    stranded-empty input would persist '' = a deliberate unset.
 *  - EM-G2: a segment audience's confirm carries the live estimate, LABELLED
 *    as one; a failed estimate degrades to the countless copy.
 *  - EM-G3: the test-send modal posts the address; success closes it.
 *  - EM-SP-9/10: agent-drafted chip; localized skip reasons.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Campaign } from '../emailClient.js';

const listCampaigns = vi.fn();
const listTemplates = vi.fn();
const listSegments = vi.fn();
const getEmailSettings = vi.fn();
const putEmailSettings = vi.fn();
const getSegmentEstimate = vi.fn();
const sendCampaign = vi.fn();
const sendTestEmail = vi.fn();
import type { SendLog } from '../emailClient.js';
const listSends = vi.fn(async (..._a: unknown[]): Promise<SendLog[]> => []);
const getEngagement = vi.fn();
const confirmFn = vi.fn();

import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../emailClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listCampaigns: (...a: unknown[]) => listCampaigns(...a),
  listTemplates: (...a: unknown[]) => listTemplates(...a),
  listSegments: (...a: unknown[]) => listSegments(...a),
  getEmailSettings: (...a: unknown[]) => getEmailSettings(...a),
  putEmailSettings: (...a: unknown[]) => putEmailSettings(...a),
  getSegmentEstimate: (...a: unknown[]) => getSegmentEstimate(...a),
  sendCampaign: (...a: unknown[]) => sendCampaign(...a),
  sendTestEmail: (...a: unknown[]) => sendTestEmail(...a),
  listSends: (...a: unknown[]) => listSends(...a),
  getEngagement: (...a: unknown[]) => getEngagement(...a),
  listOrgs: async () => [{ orgId: 'org:1', name: 'Acme' }],
  // FLAKE FIX — this was UNMOCKED, so the real `getProviderStatus` ran a live
  // fetch in jsdom, rejected, and rendered a SECOND "Retry" (the provider-status
  // failure card) beside the one each test here selects with a singular
  // `getByRole(name:/retry/i)`. EmailPage has TEN same-named Retry buttons, so
  // that selector is only unambiguous while exactly one panel is in its failed
  // state. Whether the stray rejection landed before or after the assertion
  // depended on event-loop timing, which is why this only ever went red inside a
  // full parallel `npm run ci` run and never in isolation, in either file order,
  // or serially across this directory. MEASURED: with a 300ms settle before the
  // click, the failure is 100% reproducible and the count is 2.
  getProviderStatus: async () => ({ providers: [{ provider: 'sendgrid', connected: true }], defaultProvider: 'sendgrid', senderAddress: 'ops@acme.dev' }),
}));
vi.mock('../../../ui/confirm.js', () => ({ confirm: (...a: unknown[]) => confirmFn(...a) }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: true, loading: false }),
}));

const { EmailPage } = await import('../EmailPage.js');

const campaign = (over: Partial<Campaign> = {}): Campaign => ({
  campaignId: 'c1', orgId: 'org:1', templateId: 'tpl1',
  audience: { stage: 'lead' }, status: 'draft', createdAt: '2026-08-09T00:00:00Z', updatedAt: '', ...over,
} as Campaign);

const renderPage = () => render(<MemoryRouter><EmailPage /></MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  listTemplates.mockResolvedValue([{ templateId: 'tpl1', orgId: 'org:1', name: 'Welcome', subject: 's', body: 'b', createdAt: '', updatedAt: '' }]);
  listCampaigns.mockResolvedValue([]);
  listSegments.mockResolvedValue([]);
  getEmailSettings.mockResolvedValue({ senderAddress: 'ops@acme.dev', configured: true });
  sendCampaign.mockResolvedValue({ status: 'sent', stats: { sent: 1, failed: 0, skipped: 0 } });
});
afterEach(cleanup);

describe('EM-SP-4 — failed segments read is not "create one on the CRM page"', () => {
  it('renders the named failure + retry instead of the instruction', async () => {
    listSegments.mockRejectedValueOnce(new Error('boom')).mockResolvedValue([{ segmentId: 'seg1', name: 'VIPs' }]);
    renderPage();
    // The picker (where the failure renders) shows in segment audience mode.
    const mode = await screen.findByLabelText(/audience/i, { selector: 'select' });
    fireEvent.change(mode, { target: { value: 'segment' } });
    await screen.findByText(/segments didn.t load/i);
    expect(screen.queryByText(/create one on the crm page/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(screen.queryByText(/segments didn.t load/i)).toBeNull());
  });
});

describe('EM-SP-5 — a failed settings read blocks the save that would unset config', () => {
  it('disables the sender input + save until a read lands', async () => {
    getEmailSettings.mockRejectedValue(new Error('boom'));
    renderPage();
    await screen.findByText(/haven.t loaded yet/i);
    const save = screen.getByRole('button', { name: /save sender|save/i });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(save);
    expect(putEmailSettings).not.toHaveBeenCalled();
  });

  it('a successful read enables the save (positive case)', async () => {
    renderPage();
    await waitFor(() => expect(screen.queryByText(/haven.t loaded yet/i)).toBeNull());
    expect((screen.getByDisplayValue('ops@acme.dev') as HTMLInputElement).disabled).toBe(false);
  });
});

describe('EM-G2 — the confirm carries a labelled estimate for segment audiences', () => {
  it('fetches the estimate at confirm-open and includes the count', async () => {
    listCampaigns.mockResolvedValue([campaign({ audience: { segmentId: 'seg1' } })]);
    listSegments.mockResolvedValue([{ segmentId: 'seg1', name: 'VIPs' }]);
    getSegmentEstimate.mockResolvedValue({ size: 42 });
    confirmFn.mockResolvedValue(false); // decline — we only inspect the copy
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /^send$/i }));
    await waitFor(() => expect(confirmFn).toHaveBeenCalled());
    expect(getSegmentEstimate).toHaveBeenCalledWith('seg1');
    const arg = confirmFn.mock.calls[0]![0] as { body: string };
    expect(arg.body).toMatch(/estimated recipients: 42/i);
  });

  it('a FAILED estimate degrades to the countless copy — never a fabricated number', async () => {
    listCampaigns.mockResolvedValue([campaign({ audience: { segmentId: 'seg1' } })]);
    listSegments.mockResolvedValue([{ segmentId: 'seg1', name: 'VIPs' }]);
    getSegmentEstimate.mockRejectedValue(new Error('boom'));
    confirmFn.mockResolvedValue(false);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /^send$/i }));
    await waitFor(() => expect(confirmFn).toHaveBeenCalled());
    const arg = confirmFn.mock.calls[0]![0] as { body: string };
    expect(arg.body).not.toMatch(/estimated/i);
    expect(arg.body).toMatch(/VIPs/);
  });

  it('a STAGE audience asks without a count (no cheap read exists — deferred with reason)', async () => {
    listCampaigns.mockResolvedValue([campaign()]);
    confirmFn.mockResolvedValue(false);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /^send$/i }));
    await waitFor(() => expect(confirmFn).toHaveBeenCalled());
    expect(getSegmentEstimate).not.toHaveBeenCalled();
  });
});

describe('EM-G3 — the test-send modal', () => {
  it('posts the typed address and closes on success', async () => {
    listCampaigns.mockResolvedValue([campaign()]);
    sendTestEmail.mockResolvedValue(undefined);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /send test of/i }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(screen.getByLabelText(/send to/i), { target: { value: 'me@tester.dev' } });
    fireEvent.click(screen.getByRole('button', { name: /send test email/i }));
    await waitFor(() => expect(sendTestEmail).toHaveBeenCalledWith('org:1', 'c1', 'me@tester.dev'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(dialog).toBeDefined();
  });
});

describe('EM-G3 — test-send failure polarity', () => {
  it('a failed test send toasts the error and the modal STAYS OPEN', async () => {
    listCampaigns.mockResolvedValue([campaign()]);
    sendTestEmail.mockRejectedValue(new Error('Configure the sender address before test-sending.'));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /send test of/i }));
    await screen.findByRole('dialog');
    fireEvent.change(screen.getByLabelText(/send to/i), { target: { value: 'me@tester.dev' } });
    fireEvent.click(screen.getByRole('button', { name: /send test email/i }));
    await waitFor(() => expect(sendTestEmail).toHaveBeenCalled());
    // The modal must not close on failure — the user retries or cancels.
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});

describe('EM-SP-9/10 — visibility', () => {
  it('an agent-minted campaign carries the agent-draft chip; a human one does not', async () => {
    listCampaigns.mockResolvedValue([
      campaign({ campaignId: 'cmp:agent:run1:abc' }),
      campaign({ campaignId: 'cmp:human1' }),
    ]);
    renderPage();
    await waitFor(() => expect(screen.getAllByText(/agent draft/i)).toHaveLength(1));
  });

  it('a known skip reason localizes; an unknown provider error stays verbatim', async () => {
    listCampaigns.mockResolvedValue([campaign({ status: 'sent' })]);
    listSends.mockResolvedValue([
      { sendId: 's1', campaignId: 'c1', contactId: 'ct1', status: 'skipped', error: 'no_email', ts: '2026-08-09T00:00:00Z' },
      { sendId: 's2', campaignId: 'c1', contactId: 'ct2', status: 'failed', error: 'SMTP 550 mailbox full', ts: '2026-08-09T00:00:00Z' },
    ]);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /^log$/i }));
    await screen.findByText(/no email address/);
    expect(screen.queryByText(/: no_email/)).toBeNull();
    expect(screen.getByText(/SMTP 550 mailbox full/)).toBeTruthy();
  });
});

describe('R3 EM-SP-7 — the engagement lane gets its FIRST consumer', () => {
  const stats = { clicks: 5, uniqueClicks: 3, unsubscribes: 1, opens: 9, uniqueOpens: 4 };

  it('opens the panel, shows unique/total stats + the pixel under-count caveat + events', async () => {
    listCampaigns.mockResolvedValue([campaign({ status: 'sent' })]);
    getEngagement.mockResolvedValue({ stats, events: [
      { id: 'e1', contactId: 'ct-1', kind: 'opened', at: '2026-08-14T00:00:00Z' },
      { id: 'e2', contactId: 'ct-2', kind: 'clicked', url: 'https://x.test/a', at: '2026-08-14T00:01:00Z' },
    ] });
    renderPage();
    await screen.findAllByText('Welcome');
    fireEvent.click(screen.getByRole('button', { name: 'Engagement' }));
    await screen.findByText('Opens: 4 unique · 9 total');
    expect(screen.getByText('Clicks: 3 unique · 5 total')).toBeTruthy();
    expect(screen.getByText(/under-count/i)).toBeTruthy();
    expect(screen.getByText(/clicked · https:\/\/x\.test\/a/)).toBeTruthy();
    expect(getEngagement).toHaveBeenCalledWith('org:1', 'c1');
  });

  it('a FAILED engagement read says so — never "no engagement yet"', async () => {
    listCampaigns.mockResolvedValue([campaign({ status: 'sent' })]);
    getEngagement.mockRejectedValue(new Error('boom'));
    renderPage();
    await screen.findAllByText('Welcome');
    fireEvent.click(screen.getByRole('button', { name: 'Engagement' }));
    await screen.findByText(/could not be loaded/i);
    expect(screen.queryByText(/No engagement recorded/i)).toBeNull();
  });

  it('zero events on a successful read IS the designed empty state (paired polarity)', async () => {
    listCampaigns.mockResolvedValue([campaign({ status: 'sent' })]);
    getEngagement.mockResolvedValue({ stats: { clicks: 0, uniqueClicks: 0, unsubscribes: 0, opens: 0, uniqueOpens: 0 }, events: [] });
    renderPage();
    await screen.findAllByText('Welcome');
    fireEvent.click(screen.getByRole('button', { name: 'Engagement' }));
    await screen.findByText(/No engagement recorded/i);
    expect(screen.queryByText(/could not be loaded/i)).toBeNull();
  });
});
