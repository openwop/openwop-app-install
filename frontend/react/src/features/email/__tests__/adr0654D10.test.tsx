/**
 * ADR 0655 D10 — the Email hub's frontend half (feature loop 2026-09 it.10).
 *
 * Pins, each with BOTH polarities where a polarity exists:
 *  - EM-UX-5 / EM-UX-23  the Suppressions panel: list, Release (manual rows
 *    only) calling the route, the locked hint on non-manual rows, and a failed
 *    read that never claims "no suppressed addresses".
 *  - EM-UX-27            a failed provider-status read is a FAILED STATE with
 *    retry, not absence.
 *  - EM-UX-6             failed templates / campaigns reads render the failure,
 *    never "Create one above" / "No campaigns yet." — and a real empty still does.
 *  - EM-UX-13            send AND re-send confirms carry `danger`.
 *  - EM-UX-7 / -8 / -9   the page-level failure and the sends failure carry a
 *    Retry, and the in-panel failures announce POLITELY.
 *
 * Every claim above is sabotage-witnessed (/grade-tests wave 9, `w9g4-d10-*`):
 * mounting the panel eagerly, `danger`/`force` on every release, keeping a
 * released row, releasing on a declined confirm, toasting a generic message,
 * writing `[]` on a failed read (suppressions / provider / templates /
 * campaigns / sends), an assertive suppressions announce, a dead filter or sends
 * Retry, and dropping `danger` from send / re-send each turn its case red.
 *
 * Mocks are typed against the real client (`vi.fn<typeof EC.x>`), so a fixture
 * that drifts from `Campaign` / `ProviderStatus` / `Suppression` fails `tsc`.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type * as EC from '../emailClient.js';
import type { Campaign, EmailTemplate, ProviderStatus } from '../emailClient.js';
import type * as SC from '../suppressionsClient.js';
import type { Suppression } from '../suppressionsClient.js';

const api = vi.hoisted(() => ({
  listCampaigns: vi.fn<typeof EC.listCampaigns>(),
  listTemplates: vi.fn<typeof EC.listTemplates>(),
  sendCampaign: vi.fn<typeof EC.sendCampaign>(),
  listSends: vi.fn<typeof EC.listSends>(),
  getProviderStatus: vi.fn<typeof EC.getProviderStatus>(),
}));
const supp = vi.hoisted(() => ({
  listSuppressions: vi.fn<typeof SC.listSuppressions>(),
  removeSuppression: vi.fn<typeof SC.removeSuppression>(),
}));
const confirmFn = vi.hoisted(() => vi.fn());
const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }));

import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../emailClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listCampaigns: (...a: Parameters<typeof EC.listCampaigns>) => api.listCampaigns(...a),
  listTemplates: (...a: Parameters<typeof EC.listTemplates>) => api.listTemplates(...a),
  sendCampaign: (...a: Parameters<typeof EC.sendCampaign>) => api.sendCampaign(...a),
  listSends: (...a: Parameters<typeof EC.listSends>) => api.listSends(...a),
  getProviderStatus: (...a: Parameters<typeof EC.getProviderStatus>) => api.getProviderStatus(...a),
  listSegments: async () => [],
  getEmailSettings: async () => ({ senderAddress: 'news@acme.test', configured: true }),
  listOrgs: async () => [{ orgId: 'org:1', name: 'Acme' }],
}));
vi.mock('../suppressionsClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listSuppressions: (...a: Parameters<typeof SC.listSuppressions>) => supp.listSuppressions(...a),
  removeSuppression: (...a: Parameters<typeof SC.removeSuppression>) => supp.removeSuppression(...a),
}));
vi.mock('../../../ui/confirm.js', () => ({ confirm: (...a: unknown[]) => confirmFn(...a) }));
vi.mock('../../../ui/toast.js', () => ({ toast: toasts }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: true, loading: false }),
}));

const { EmailPage } = await import('../EmailPage.js');
const { currentAnnouncements } = await import('../../../ui/announce.js');

const tpl: EmailTemplate = { templateId: 'tpl1', orgId: 'org:1', name: 'Welcome', subject: 's', body: 'b', createdAt: '', updatedAt: '' };
const campaign = (status: Campaign['status']): Campaign => ({
  campaignId: 'c1', orgId: 'org:1', templateId: 'tpl1', audience: { stage: 'lead' }, status, createdAt: '', updatedAt: '',
});
const connected: ProviderStatus = { providers: [{ provider: 'sendgrid', connected: true }], defaultProvider: 'sendgrid', senderAddress: 'news@acme.test' };
const row = (email: string, reason: Suppression['reason']): Suppression => ({
  key: `t1::${email}`, tenantId: 't1', email, reason, actor: 'u1',
  // RELATIVE, deliberately. The assertion below reads the rendered relative time
  // (`/suppressed .*ago/`), so an ABSOLUTE `at` is a date bomb: `formatRelativeTime`
  // uses `numeric:'auto'`, which renders -1 year as "last year" — no "ago" — so the
  // pinned `2026-09-01` would have gone red for real on 2027-09-01. The clock-shift
  // lane (`OPENWOP_CI_CLOCKSHIFT=1`, +365d) detonated it a year early, which is what
  // that lane is for. A relative `at` states the instant the test actually means and
  // shifts with the clock, so both lanes read the same "2 days ago".
  at: new Date(Date.now() - 2 * 86_400_000).toISOString(),
});

const renderPage = () => render(<MemoryRouter><EmailPage /></MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  api.listTemplates.mockResolvedValue([tpl]);
  api.listCampaigns.mockResolvedValue([]);
  api.listSends.mockResolvedValue([]);
  api.getProviderStatus.mockResolvedValue(connected);
  api.sendCampaign.mockResolvedValue({ ...campaign('sent'), stats: { sent: 1, failed: 0, skipped: 0 } });
  supp.listSuppressions.mockResolvedValue([]);
  supp.removeSuppression.mockResolvedValue(true);
  confirmFn.mockResolvedValue(true);
});
afterEach(cleanup);

const openSuppressions = async () => {
  const toggle = await screen.findByRole('button', { name: /show suppressions/i });
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(toggle);
  await waitFor(() => expect(supp.listSuppressions).toHaveBeenCalledTimes(1));
  expect(screen.getByRole('button', { name: /hide suppressions/i }).getAttribute('aria-expanded')).toBe('true');
};

describe('ADR 0655 D10 — Suppressions panel (EM-UX-5 / EM-UX-23)', () => {
  it('is a lazy disclosure: no read until opened; lists address, reason and date', async () => {
    supp.listSuppressions.mockResolvedValue([row('a@x.test', 'manual'), row('b@x.test', 'bounced')]);
    renderPage();
    await screen.findAllByText('Welcome');
    expect(supp.listSuppressions).not.toHaveBeenCalled();
    await openSuppressions();
    expect(await screen.findByText('a@x.test')).toBeTruthy();
    expect(screen.getByText('b@x.test')).toBeTruthy();
    expect(screen.getByText('manual block')).toBeTruthy();
    expect(screen.getByText('bounced')).toBeTruthy();
    expect(screen.getAllByText(/suppressed .*ago|suppressed (just now|in)/i).length).toBeGreaterThan(0);
  });

  it('Release: every row is releasable — a manual row confirms plainly; a bounce/unsubscribe row confirms as an ATTESTATION (danger) and calls DELETE with force', async () => {
    supp.listSuppressions.mockResolvedValue([row('a@x.test', 'manual'), row('b@x.test', 'unsubscribed')]);
    renderPage();
    await openSuppressions();
    await screen.findByText('a@x.test');
    // ADR 0655 D10 — TWO Release buttons: the D3 preference page now refuses a
    // suppressed recipient's own re-grant and tells them to ask the sender, so the
    // sender needs a door for every kind (the operator's attested `?force=true`).
    const releases = screen.getAllByRole('button', { name: /^release /i });
    expect(releases).toHaveLength(2);
    expect(screen.queryByText(/only the recipient can lift this/i)).toBeNull();

    fireEvent.click(releases[0]!);
    await waitFor(() => expect(confirmFn).toHaveBeenCalled());
    const arg = confirmFn.mock.calls[0]![0] as { title: string; body: string; danger?: boolean };
    expect(arg.title).toContain('a@x.test');
    expect(arg.body).toMatch(/receive marketing email again/i);
    expect(arg.body).toMatch(/re-suppress/i);
    expect(arg.danger).toBeFalsy();
    await waitFor(() => expect(supp.removeSuppression).toHaveBeenCalledWith('a@x.test', { force: false }));
    // The released row leaves the list; success is announced via toast.
    await waitFor(() => expect(screen.queryByText('a@x.test')).toBeNull());
    expect(toasts.success).toHaveBeenCalled();

    // The unsubscribed row: the confirm names that the recipient ASKED to stop and is
    // the operator's attestation; the call carries force.
    fireEvent.click(screen.getByRole('button', { name: /^release b@x\.test/i }));
    await waitFor(() => expect(confirmFn).toHaveBeenCalledTimes(2));
    const forced = confirmFn.mock.calls[1]![0] as { body: string; danger?: boolean };
    expect(forced.body).toMatch(/asked to stop/i);
    expect(forced.danger).toBe(true);
    await waitFor(() => expect(supp.removeSuppression).toHaveBeenCalledWith('b@x.test', { force: true }));
  });

  it('Release declined: nothing is called', async () => {
    supp.listSuppressions.mockResolvedValue([row('a@x.test', 'manual')]);
    confirmFn.mockResolvedValue(false);
    renderPage();
    await openSuppressions();
    fireEvent.click(await screen.findByRole('button', { name: /^release /i }));
    await waitFor(() => expect(confirmFn).toHaveBeenCalled());
    expect(supp.removeSuppression).not.toHaveBeenCalled();
    expect(screen.getByText('a@x.test')).toBeTruthy();
  });

  it('Release failure: the server message reaches the operator; the row stays', async () => {
    supp.listSuppressions.mockResolvedValue([row('a@x.test', 'manual')]);
    supp.removeSuppression.mockRejectedValue(new Error('lift_refused'));
    renderPage();
    await openSuppressions();
    fireEvent.click(await screen.findByRole('button', { name: /^release /i }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('lift_refused'));
    expect(screen.getByText('a@x.test')).toBeTruthy();
  });

  it('FAILED read: a failed state with Retry, announced politely — never "No suppressed addresses"', async () => {
    supp.listSuppressions.mockRejectedValueOnce(new Error('supp_500')).mockResolvedValueOnce([]);
    renderPage();
    await openSuppressions();
    expect(await screen.findByText(/couldn’t load the suppression list/i)).toBeTruthy();
    expect(screen.queryByText(/no suppressed addresses/i)).toBeNull();
    expect(currentAnnouncements().polite).toMatch(/couldn’t load the suppression list/i);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(supp.listSuppressions).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/no suppressed addresses/i)).toBeTruthy();
  });

  it('filter by address narrows the list and the no-match state offers Clear', async () => {
    supp.listSuppressions.mockResolvedValue([row('alice@x.test', 'manual'), row('bob@y.test', 'complaint')]);
    renderPage();
    await openSuppressions();
    await screen.findByText('alice@x.test');
    const filter = screen.getByLabelText(/filter suppressions by address/i);
    fireEvent.change(filter, { target: { value: 'bob' } });
    expect(screen.queryByText('alice@x.test')).toBeNull();
    expect(screen.getByText('bob@y.test')).toBeTruthy();
    fireEvent.change(filter, { target: { value: 'nobody' } });
    expect(screen.getByText(/no suppressed address matches/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /clear search/i }));
    expect(screen.getByText('alice@x.test')).toBeTruthy();
  });
});

describe('EM-UX-27 — provider status: failed ≠ absent', () => {
  it('a FAILED read renders the failed state with Retry under the provider heading', async () => {
    api.getProviderStatus.mockRejectedValueOnce(new Error('ps_500'));
    renderPage();
    expect(await screen.findByText(/provider status didn’t load/i)).toBeTruthy();
    const heading = screen.getByRole('heading', { name: 'Sending provider' });
    expect(currentAnnouncements().polite).toMatch(/provider status didn’t load/i);
    const before = api.getProviderStatus.mock.calls.length;
    // The Retry INSIDE the provider card (the page has several same-named Retries).
    fireEvent.click(within(heading.parentElement!).getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(api.getProviderStatus.mock.calls.length).toBeGreaterThan(before));
    // …and the retry RECOVERS: the second read lands and the failed state is gone.
    expect(await screen.findByText(/sendgrid/i)).toBeTruthy();
    expect(screen.queryByText(/provider status didn’t load/i)).toBeNull();
  });
  it('a successful read renders the providers, and no failed state', async () => {
    renderPage();
    expect(await screen.findByText(/sendgrid/i)).toBeTruthy();
    expect(screen.queryByText(/provider status didn’t load/i)).toBeNull();
  });
});

describe('EM-UX-6 / EM-UX-7 — failed page-level reads state the failure, never the empty instruction', () => {
  it('templates FAILED: "Couldn’t load templates" + Retry; NOT "No templates yet"', async () => {
    api.listTemplates.mockRejectedValue(new Error('tpl_500'));
    renderPage();
    expect(await screen.findByText('Couldn’t load templates')).toBeTruthy();
    expect(screen.queryByText(/No templates yet/i)).toBeNull();
    // The templates instruction specifically (the campaigns EMPTY card below
    // legitimately says "Create one above" — that read succeeded).
    expect(screen.queryByText(/Create one above — a template is/i)).toBeNull();
    // EM-UX-7: the page-level Notice carries a Retry, and announces the headline.
    expect(screen.getByText('tpl_500')).toBeTruthy();
    expect(currentAnnouncements().assertive).toMatch(/could not load/i);
    const retries = screen.getAllByRole('button', { name: /retry/i });
    expect(retries.length).toBeGreaterThanOrEqual(2);
    api.listTemplates.mockResolvedValue([]);
    fireEvent.click(retries[0]!);
    expect(await screen.findByText(/No templates yet/i)).toBeTruthy();
    expect(screen.queryByText('Couldn’t load templates')).toBeNull();
  });

  it('campaigns FAILED: "Couldn’t load campaigns"; NOT "No campaigns yet."', async () => {
    api.listCampaigns.mockRejectedValue(new Error('cmp_500'));
    renderPage();
    expect(await screen.findByText('Couldn’t load campaigns')).toBeTruthy();
    expect(screen.queryByText(/No campaigns yet/i)).toBeNull();
  });

  it('campaigns EMPTY (a real answer): the designed StateCard, not the failure (EM-UX-28)', async () => {
    renderPage();
    expect(await screen.findByText('No campaigns yet.', { selector: '.state-card__title' })).toBeTruthy();
    expect(screen.queryByText('Couldn’t load campaigns')).toBeNull();
  });
});

describe('EM-UX-13 — the irreversible send is a danger confirm', () => {
  it('first send passes danger: true', async () => {
    api.listCampaigns.mockResolvedValue([campaign('draft')]);
    confirmFn.mockResolvedValue(false);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /^send$/i }));
    await waitFor(() => expect(confirmFn).toHaveBeenCalled());
    expect((confirmFn.mock.calls[0]![0] as { danger?: boolean }).danger).toBe(true);
  });
  it('re-send passes danger: true with a short title and the consequence in the body (EM-UX-21)', async () => {
    api.listCampaigns.mockResolvedValue([campaign('sent')]);
    confirmFn.mockResolvedValue(false);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /^re-send$/i }));
    await waitFor(() => expect(confirmFn).toHaveBeenCalled());
    const arg = confirmFn.mock.calls[0]![0] as { title: string; body: string; danger?: boolean };
    expect(arg.danger).toBe(true);
    expect(arg.title).toBe('Re-send this campaign?');
    expect(arg.body).toMatch(/already sent/i);
    expect(arg.body).toContain('Welcome');
  });
});

describe('EM-UX-29 — the delete confirm says what is (not) deleted', () => {
  it('names that the send log and engagement history are kept, not cascaded', async () => {
    api.listCampaigns.mockResolvedValue([campaign('sent')]);
    confirmFn.mockResolvedValue(false);
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /delete campaign/i }));
    await waitFor(() => expect(confirmFn).toHaveBeenCalled());
    const arg = confirmFn.mock.calls[0]![0] as { title: string; body: string; danger?: boolean };
    expect(arg.danger).toBe(true);
    expect(arg.body).toMatch(/send log and engagement history are not deleted/i);
  });
});

describe('EM-UX-8 / EM-UX-9 — the sends failure has a Retry and announces politely', () => {
  it('failed log read → failed state + Retry re-runs the read; never "No sends yet."', async () => {
    api.listCampaigns.mockResolvedValue([campaign('sent')]);
    api.listSends.mockRejectedValueOnce(new Error('sends_500')).mockResolvedValueOnce([]);
    renderPage();
    await screen.findAllByText('Welcome');
    fireEvent.click(screen.getByRole('button', { name: 'Log' }));
    expect(await screen.findByText(/could not load the send history/i)).toBeTruthy();
    expect(screen.queryByText(/No sends yet/i)).toBeNull();
    expect(currentAnnouncements().polite).toMatch(/could not load the send history/i);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(api.listSends).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/No sends yet/i)).toBeTruthy();
  });
});
