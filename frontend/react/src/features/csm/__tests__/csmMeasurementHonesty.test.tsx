/**
 * ADR 0582 §6 — the CSM console tells the truth about measurement, failure and
 * editability. Every leg here FAILS against the pre-fix page.
 *
 *  - CSM-UX-1: `healthScore` was non-optional, the service defaulted a missing
 *    one to 50, and the form pre-filled `'50'` — so "never measured", "scored
 *    50 on purpose" and "the form's default" were one value. A 100 produced by
 *    an empty or mis-scoped CRM fan-in then rendered as the GREENEST chip on the
 *    page, and `portfolioArrAtRisk` (`< 70`) DROPPED that account's ARR out of
 *    the at-risk figure — the exec summary got quieter exactly when measurement
 *    broke. Unmeasured is now a state, it is counted OUT of "at risk", and it is
 *    counted IN, visibly, beside it.
 *  - CSM-UX-2: a failed read left `accounts` null, which is also the loading
 *    state, so `DataTable` rendered skeleton rows forever with no retry anywhere
 *    on the page for its primary read.
 *  - CSM-UX-3: `csmClient` always threw a bare `Error`, so the page's
 *    `err instanceof Error ? err.message : t(…)` idiom could never select `t`:
 *    four localized failure strings × four locales were dead by construction and
 *    every failure rendered raw English server text.
 *  - CSM-UX-5: six of the seven PATCHable fields had no editor, so the remedy
 *    for a typo or an ARR change was delete-and-recreate — which mints a new
 *    accountId and destroys the CRM link and the health history.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Account } from '../csmClient.js';

const access = vi.hoisted(() => ({ value: { enabled: true, loading: false, variant: undefined as string | undefined } }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({ useFeatureAccess: () => access.value }));

const listAccounts = vi.hoisted(() => vi.fn(async (): Promise<Account[]> => []));
const updateAccount = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => ({})));
const toastError = vi.hoisted(() => vi.fn());
const toastSuccess = vi.hoisted(() => vi.fn());
vi.mock('../../../ui/toast.js', () => ({ toast: { success: toastSuccess, error: toastError, info: vi.fn() } }));
vi.mock('../csmClient.js', async () => {
  const actual = await vi.importActual<typeof import('../csmClient.js')>('../csmClient.js');
  return {
    ...actual,
    listAccounts,
    updateAccount,
    listOrgs: vi.fn(async () => [{ orgId: 'org-1', name: 'Org One' }]),
    listCrmCompanies: vi.fn(async () => [{ companyId: 'cmp:1', name: 'Acme Corp' }]),
    createAccount: vi.fn(async () => ({})),
    deleteAccount: vi.fn(async () => undefined),
  };
});

// The REAL typed error, taken from the (partially) mocked module so it is the
// SAME class identity the page's `instanceof` map keys on. Constructing a
// look-alike locally would silently fall through to the offline branch and every
// localized-copy assertion below would be testing the wrong sentence.
import { CsmRequestError } from '../csmClient.js';
import { CsmPage } from '../CsmPage.js';

const acct = (over: Partial<Account> & { accountId: string; name: string }): Account => ({
  tenantId: 't1', createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z', ...over,
} as Account);

const renderPage = () => render(<MemoryRouter><CsmPage /></MemoryRouter>);

beforeEach(() => {
  access.value = { enabled: true, loading: false, variant: undefined };
  vi.clearAllMocks();
  window.localStorage.clear();
});
afterEach(cleanup);

describe('CSM-UX-1 — "not measured" is a state, not a number', () => {
  it('an account with no healthScore renders as NOT SCORED, never as a number', async () => {
    listAccounts.mockResolvedValue([acct({ accountId: 'a1', name: 'Unmeasured Co' })]);
    renderPage();
    const row = (await screen.findByText('Unmeasured Co')).closest('tr')!;
    expect(within(row).getByText(/not scored/i)).toBeTruthy();
    // The pre-fix page rendered `clampScore(undefined)` = 50 as a chip here.
    expect(within(row).queryByText('50')).toBeNull();
    expect(within(row).queryByText('100')).toBeNull();
  });

  it('a RECORDED measurement failure outranks any score sitting beside it', async () => {
    listAccounts.mockResolvedValue([acct({
      accountId: 'a1', name: 'Broken Co', healthScore: 92,
      healthMeasureFailedAt: '2026-08-17T00:00:00Z',
      healthMeasureFailedReason: 'the CRM fan-in was incomplete',
    })]);
    renderPage();
    const row = (await screen.findByText('Broken Co')).closest('tr')!;
    expect(within(row).getByText(/measurement failed/i)).toBeTruthy();
    // The stale number may be SHOWN, but only labelled as last-known — never as
    // the current health, and never as a bare green chip.
    expect(within(row).getByText(/last known 92/i)).toBeTruthy();
  });

  it('unmeasured ARR is counted OUT of "ARR at risk" and counted IN, visibly, beside it', async () => {
    listAccounts.mockResolvedValue([
      acct({ accountId: 'a1', name: 'Sick Co', healthScore: 30, arr: 1000, arrCurrency: 'USD' }),
      // Pre-fix, a broken fan-in scored this 100 — which is `>= 70`, so its ARR
      // silently VANISHED from the at-risk figure. That is the defect: a
      // measurement outage made the exec summary quieter.
      acct({ accountId: 'a2', name: 'Unknown Co', arr: 500_000, arrCurrency: 'USD' }),
    ]);
    renderPage();
    await screen.findByText('Unknown Co');
    const band = screen.getByRole('group', { name: /portfolio summary/i });
    // At-risk counts ONLY the confidently-measured sick account.
    expect(within(band).getByText(/^\$?1,000(\.00)?$/)).toBeTruthy();
    // ...and the unmeasured half is stated out loud, with its ARR.
    expect(within(band).getByText(/health not measured/i)).toBeTruthy();
    expect(within(band).getByText(/1 account/i)).toBeTruthy();
    expect(within(band).getByText(/excluded from arr at risk/i)).toBeTruthy();
  });

  it('the health facet can select the unscored accounts', async () => {
    listAccounts.mockResolvedValue([
      acct({ accountId: 'a1', name: 'Alpha Co', healthScore: 80 }),
      acct({ accountId: 'a2', name: 'Beta Co', healthScore: 20 }),
      acct({ accountId: 'a3', name: 'Gamma Co', healthScore: 50 }),
      acct({ accountId: 'a4', name: 'Delta Co' }),
    ]);
    renderPage();
    await screen.findByText('Delta Co');
    fireEvent.change(screen.getByLabelText(/filter by health/i), { target: { value: 'unscored' } });
    expect(screen.getByText('Delta Co')).toBeTruthy();
    expect(screen.queryByText('Alpha Co')).toBeNull();
  });
});

describe('CSM-UX-4 — the factor breakdown states its own arithmetic', () => {
  it('a penalty-sum breakdown says so, and labels the third column a COUNT', async () => {
    listAccounts.mockResolvedValue([acct({
      accountId: 'a1', name: 'Computed Co', healthScore: 89,
      healthFactors: [{ factor: 'openDeals', weight: 8, value: 1 }],
      healthComputedAt: '2026-08-17T00:00:00Z',
      healthMethod: 'penalty-sum',
    })]);
    renderPage();
    const row = (await screen.findByText('Computed Co')).closest('tr')!;
    expect(within(row).getByText(/100 − sum of \(weight × count\)/i)).toBeTruthy();
    expect(within(row).getByText(/^count$/i)).toBeTruthy();
  });

  it('a weighted-mean breakdown states the OPPOSITE direction under the same headers', async () => {
    listAccounts.mockResolvedValue([acct({
      accountId: 'a1', name: 'Seeded Co', healthScore: 63,
      healthFactors: [{ factor: 'Order recency', weight: 40, value: 80 }],
      healthComputedAt: '2026-08-17T00:00:00Z',
      healthMethod: 'weighted-mean',
    })]);
    renderPage();
    const row = (await screen.findByText('Seeded Co')).closest('tr')!;
    expect(within(row).getByText(/÷ total weight/i)).toBeTruthy();
    expect(within(row).getByText(/higher values raise the score/i)).toBeTruthy();
  });
});

describe('CSM-UX-2 — a failed read is a designed state with a retry', () => {
  it('renders a failure card with a Retry that refetches, instead of skeleton rows forever', async () => {
    listAccounts.mockRejectedValueOnce(new CsmRequestError('listAccounts', 500));
    renderPage();
    // The consequence clause: an empty table and a failed read look identical
    // without it, and the difference matters commercially.
    await screen.findByText(/this is not an empty book of business/i);
    expect(listAccounts).toHaveBeenCalledTimes(1);

    listAccounts.mockResolvedValueOnce([acct({ accountId: 'a1', name: 'Recovered Co', healthScore: 70 })]);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(screen.getByText('Recovered Co')).toBeTruthy());
    expect(listAccounts).toHaveBeenCalledTimes(2);
  });
});

describe('CSM-UX-3 — failure copy is LOCALIZED, and the server text is a detail', () => {
  it('a 403 renders the localized permission sentence, not the raw server string', async () => {
    listAccounts.mockRejectedValueOnce(new CsmRequestError('listAccounts', 403, 'Missing required scope: workspace:read'));
    renderPage();
    // The localized sentence is the TITLE...
    await screen.findByText(/you do not have permission to do that here/i);
    // ...and the server's own words survive as a detail, never as the whole body.
    expect(screen.getByText(/missing required scope/i)).toBeTruthy();
  });

  it('a 404 and a 500 select DIFFERENT localized sentences (the map is real, not one string)', async () => {
    listAccounts.mockRejectedValueOnce(new CsmRequestError('listAccounts', 404));
    const first = renderPage();
    await screen.findByText(/that account is no longer here/i);
    first.unmount();

    listAccounts.mockRejectedValueOnce(new CsmRequestError('listAccounts', 500));
    renderPage();
    await screen.findByText(/unavailable right now/i);
  });
});

describe('CSM-UX-5 — the account editor', () => {
  it('PATCHes the six fields that previously had no editor at all', async () => {
    listAccounts.mockResolvedValue([acct({
      accountId: 'a1', name: 'Typo Co', healthScore: 55, arr: 1000, arrCurrency: 'USD', owner: 'cs-1', renewalDate: '2027-01-15',
    })]);
    renderPage();
    await screen.findByText('Typo Co');
    fireEvent.click(screen.getByRole('button', { name: /edit typo co/i }));
    const panel = (await screen.findByText(/edit "typo co"/i)).closest('form')!;
    fireEvent.change(within(panel).getByLabelText(/^account$/i), { target: { value: 'Fixed Co' } });
    fireEvent.change(within(panel).getByLabelText(/^arr$/i), { target: { value: '2500' } });
    fireEvent.change(within(panel).getByLabelText(/^owner$/i), { target: { value: 'cs-2' } });
    fireEvent.click(within(panel).getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(updateAccount).toHaveBeenCalled());
    expect(updateAccount.mock.calls[0]![0]).toBe('a1');
    expect(updateAccount.mock.calls[0]![1]).toMatchObject({
      name: 'Fixed Co', arr: 2500, owner: 'cs-2', healthScore: 55, renewalDate: '2027-01-15', arrCurrency: 'USD',
    });
  });

  it('clearing the score field UN-ASSERTS it (sends null) rather than inventing another number', async () => {
    listAccounts.mockResolvedValue([acct({ accountId: 'a1', name: 'Distrusted Co', healthScore: 100 })]);
    renderPage();
    await screen.findByText('Distrusted Co');
    fireEvent.click(screen.getByRole('button', { name: /edit distrusted co/i }));
    const panel = (await screen.findByText(/edit "distrusted co"/i)).closest('form')!;
    fireEvent.change(within(panel).getByLabelText(/^health \(0/i), { target: { value: '' } });
    fireEvent.click(within(panel).getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(updateAccount).toHaveBeenCalled());
    expect((updateAccount.mock.calls[0]![1] as { healthScore: unknown }).healthScore).toBeNull();
  });

  it('a failed save surfaces LOCALIZED copy, and the editor stays open', async () => {
    listAccounts.mockResolvedValue([acct({ accountId: 'a1', name: 'Guarded Co', healthScore: 55 })]);
    updateAccount.mockRejectedValueOnce(new CsmRequestError('updateAccount', 403, 'Missing required scope: workspace:write'));
    renderPage();
    await screen.findByText('Guarded Co');
    fireEvent.click(screen.getByRole('button', { name: /edit guarded co/i }));
    const panel = (await screen.findByText(/edit "guarded co"/i)).closest('form')!;
    fireEvent.click(within(panel).getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(toastError).toHaveBeenCalledWith('You do not have permission to do that here.'));
    expect(screen.getByText(/edit "guarded co"/i)).toBeTruthy();
  });
});
