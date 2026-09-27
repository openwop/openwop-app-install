/**
 * UX_UPGRADE-csm CSM-G1/CSM-G2 — the renewal column.
 *
 * A CSM console exists to answer "who is at risk". Health already reads at a
 * glance through a severity chip; the renewal date beside it rendered as a RAW
 * stored ISO string with no urgency signal, so a renewal five days out looked
 * identical to one a year away — and a non-en operator read an ISO date while
 * every other date in the app is locale-formatted.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Account } from '../csmClient.js';

const listAccounts = vi.fn();
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../csmClient.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  listAccounts: (...a: unknown[]) => listAccounts(...a),
  listOrgs: async () => [],
  // `listCompanies` was overridden here too, but csmClient does not export it
  // (it lives in crm/crmOrgClient) and nothing under features/csm imports it —
  // so the override was inert. Harmless here, unlike the same mistake in
  // crm/secondaryReadHonesty, where the inert key let a real `fetch` through and
  // made the file flaky. Removed so `check-inert-mocks` can hold at zero.
}));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: true, loading: false }),
}));

const { CsmPage } = await import('../CsmPage.js');

const acct = (name: string, renewalDate?: string): Account =>
  ({ accountId: name, tenantId: 't', name, healthScore: 80, createdAt: '', updatedAt: '', ...(renewalDate ? { renewalDate } : {}) } as Account);

/** A date-only key `n` days from today, in the same shape the field stores. */
const day = (offset: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const renderPage = () => render(<MemoryRouter><CsmPage /></MemoryRouter>);
const rowFor = (name: string): HTMLElement => screen.getByText(name).closest('tr') as HTMLElement;

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('CSM — renewal date is formatted, not raw (CSM-G1)', () => {
  it('renders a machine-readable <time> rather than the stored string', async () => {
    listAccounts.mockResolvedValue([acct('Acme', day(200))]);
    const { container } = renderPage();
    await screen.findByText('Acme');
    const time = container.querySelector('time');
    expect(time).toBeTruthy();
    // The `datetime` keeps the raw key (machines), while the visible text is
    // locale-formatted (people). The two must not be the same thing by accident.
    expect(time!.getAttribute('datetime')).toBe(day(200));
  });

  it('still shows a placeholder when there is no renewal date', async () => {
    listAccounts.mockResolvedValue([acct('Acme')]);
    const { container } = renderPage();
    await screen.findByText('Acme');
    // No <time> at all, rather than a formatted empty value.
    expect(container.querySelector('time')).toBeNull();
    expect(within(rowFor('Acme')).getAllByText('—').length).toBeGreaterThan(0);
  });

  it('does not shift the day in a negative-offset timezone', async () => {
    // A calendar date is not an instant. `new Date('2026-07-29')` parses as UTC
    // midnight and renders as the 28th anywhere west of Greenwich — both this
    // and the day count were off by one in the first cut of this change.
    listAccounts.mockResolvedValue([acct('Acme', day(200))]);
    const { container } = renderPage();
    await screen.findByText('Acme');
    const time = container.querySelector('time')!;
    const [, , dd] = day(200).split('-');
    expect(time.textContent).toContain(String(Number(dd)));
    expect(time.getAttribute('datetime')).toBe(day(200));
  });
});

describe('CSM — renewal urgency (CSM-G2)', () => {
  it('flags a renewal inside 30 days', async () => {
    listAccounts.mockResolvedValue([acct('Acme', day(5))]);
    renderPage();
    await screen.findByText('Acme');
    expect(within(rowFor('Acme')).getByText(/in 5\s*d/i)).toBeTruthy();
  });

  it('does NOT flag a renewal comfortably in the future', async () => {
    listAccounts.mockResolvedValue([acct('Acme', day(120))]);
    const { container } = renderPage();
    await screen.findByText('Acme');
    expect(container.querySelector('.chip--warning')).toBeNull();
    expect(container.querySelector('.chip--danger')).toBeNull();
  });

  it('marks a renewal that has already passed as past due, not "in -3d"', async () => {
    listAccounts.mockResolvedValue([acct('Acme', day(-3))]);
    const { container } = renderPage();
    await screen.findByText('Acme');
    expect(within(rowFor('Acme')).getByText(/past due/i)).toBeTruthy();
    expect(container.querySelector('.chip--warning')).toBeNull();
  });

  it('treats the 30-day edge as urgent and 31 as not', async () => {
    listAccounts.mockResolvedValue([acct('Edge', day(30)), acct('Beyond', day(31))]);
    renderPage();
    await screen.findByText('Edge');
    expect(within(rowFor('Edge')).getByText(/in 30\s*d/i)).toBeTruthy();
    expect(within(rowFor('Beyond')).queryByText(/in 31\s*d/i)).toBeNull();
  });
});
