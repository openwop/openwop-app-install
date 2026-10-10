/**
 * UX_UPGRADE-csm CSM-G1/CSM-G2 — the renewal column.
 *
 * A CSM console exists to answer "who is at risk". Health already reads at a
 * glance through a severity chip; the renewal date beside it rendered as a RAW
 * stored ISO string with no urgency signal, so a renewal five days out looked
 * identical to one a year away — and a non-en operator read an ISO date while
 * every other date in the app is locale-formatted.
 *
 * Sabotage-witnessed (w7 grade-tests): rendering the stored string reds the
 * formatting leg; parsing the date-only key as UTC midnight (`new Date(key)`)
 * reds the timezone leg — the zone is PINNED to a negative offset below, so
 * that leg can fail on a UTC machine too; `days <= 30` → `<= 29` reds the edge.
 */
import { describe, it, expect, vi, afterEach, beforeEach, afterAll } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type * as C from '../csmClient.js';
import type { Account } from '../csmClient.js';
import { formatDate } from '../../../i18n/format.js';
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';

const api = vi.hoisted(() => ({
  listAccounts: vi.fn<typeof C.listAccounts>(),
  listOrgs: vi.fn<typeof C.listOrgs>(),
  listCrmCompanies: vi.fn<typeof C.listCrmCompanies>(),
}));
vi.mock('../csmClient.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../csmClient.js')>()),
  ...api,
  // `listCompanies` was overridden here once, but csmClient does not export it
  // (it lives in crm/crmOrgClient) — an inert key `check-inert-mocks` holds at zero.
}));
vi.mock('../../../featureToggles/FeatureAccessContext.js', async (orig) => ({
  ...(await orig<typeof import('../../../featureToggles/FeatureAccessContext.js')>()),
  useFeatureAccess: () => makeFeatureAccess({ enabled: true, loading: false }),
}));

// A calendar date is not an instant. Pin a NEGATIVE-offset zone before any
// date formatter is built, so a UTC-midnight parse shows the PREVIOUS day here
// whatever zone the host runs in (in UTC it would be a silent no-op).
const hostTz = process.env.TZ;
process.env.TZ = 'America/Los_Angeles';
afterAll(() => {
  if (hostTz === undefined) delete process.env.TZ; else process.env.TZ = hostTz;
});

const { CsmPage } = await import('../CsmPage.js');

const acct = (name: string, renewalDate?: string): Account => ({
  accountId: name, tenantId: 't', name, healthScore: 80,
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  ...(renewalDate ? { renewalDate } : {}),
});

/** A date-only key `n` days from today, in the same shape the field stores. */
const day = (offset: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
/** The LOCAL calendar day a date-only key names — what the cell must show. */
const localDay = (key: string): Date => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y!, m! - 1, d!);
};

const renderPage = () => render(<MemoryRouter><CsmPage /></MemoryRouter>);
const rowFor = (name: string): HTMLElement => screen.getByText(name).closest('tr') as HTMLElement;

beforeEach(() => {
  vi.resetAllMocks();
  api.listOrgs.mockResolvedValue([]);
  api.listCrmCompanies.mockResolvedValue([]);
});
afterEach(cleanup);

describe('CSM — renewal date is formatted, not raw (CSM-G1)', () => {
  it('renders a machine-readable <time> rather than the stored string', async () => {
    api.listAccounts.mockResolvedValue([acct('Acme', day(200))]);
    const { container } = renderPage();
    await screen.findByText('Acme');
    const time = container.querySelector('time');
    expect(time).toBeTruthy();
    // The `datetime` keeps the raw key (machines), while the visible text is
    // locale-formatted (people). The two must not be the same thing.
    expect(time!.getAttribute('datetime')).toBe(day(200));
    expect(time!.textContent).not.toBe(day(200));
    expect(time!.textContent).toBe(formatDate(localDay(day(200))));
  });

  it('still shows a placeholder when there is no renewal date', async () => {
    api.listAccounts.mockResolvedValue([acct('Acme')]);
    const { container } = renderPage();
    await screen.findByText('Acme');
    // No <time> at all, rather than a formatted empty value.
    expect(container.querySelector('time')).toBeNull();
    expect(within(rowFor('Acme')).getAllByText('—').length).toBeGreaterThan(0);
  });

  it('does not shift the day in a negative-offset timezone', async () => {
    // `new Date('2026-07-29')` parses as UTC midnight and renders as the 28th
    // anywhere west of Greenwich — both this and the day count were off by one
    // in the first cut of this change. Asserted as the WHOLE formatted date: a
    // day-number substring collided with the year digits ("27" in 2027).
    api.listAccounts.mockResolvedValue([acct('Acme', day(200))]);
    const { container } = renderPage();
    await screen.findByText('Acme');
    const time = container.querySelector('time')!;
    expect(time.textContent).toBe(formatDate(localDay(day(200))));
    expect(time.getAttribute('datetime')).toBe(day(200));
  });
});

describe('CSM — renewal urgency (CSM-G2)', () => {
  it('flags a renewal inside 30 days', async () => {
    api.listAccounts.mockResolvedValue([acct('Acme', day(5))]);
    renderPage();
    await screen.findByText('Acme');
    expect(within(rowFor('Acme')).getByText(/in 5\s*d/i)).toBeTruthy();
  });

  it('does NOT flag a renewal comfortably in the future', async () => {
    api.listAccounts.mockResolvedValue([acct('Acme', day(120))]);
    const { container } = renderPage();
    await screen.findByText('Acme');
    expect(container.querySelector('.chip--warning')).toBeNull();
    expect(container.querySelector('.chip--danger')).toBeNull();
  });

  it('marks a renewal that has already passed as past due, not "in -3d"', async () => {
    api.listAccounts.mockResolvedValue([acct('Acme', day(-3))]);
    const { container } = renderPage();
    await screen.findByText('Acme');
    expect(within(rowFor('Acme')).getByText(/past due/i)).toBeTruthy();
    expect(container.querySelector('.chip--warning')).toBeNull();
  });

  it('treats the 30-day edge as urgent and 31 as not', async () => {
    api.listAccounts.mockResolvedValue([acct('Edge', day(30)), acct('Beyond', day(31))]);
    renderPage();
    await screen.findByText('Edge');
    expect(within(rowFor('Edge')).getByText(/in 30\s*d/i)).toBeTruthy();
    expect(within(rowFor('Beyond')).queryByText(/in 31\s*d/i)).toBeNull();
  });
});
