/**
 * UX_UPGRADE-csm ROUND 2 — XCS-0..3.
 *
 *  - CS-SP-1: a FAILED company-name read is never cached as empty forever —
 *    the picker shows a named error + retry, and a retry that succeeds
 *    populates it (the old `[]`-cache made that structurally impossible).
 *  - CS-SP-3: `owner` finally renders (it was captured, searchable, and
 *    PATCHable with no surface).
 *  - CS-SP-5: the GRID view carries the renewal urgency chip too.
 *  - CSM-G3: the "renewing soon / past due" facet; undated rows SINK in the
 *    renewal sort.
 *  - CS-SP-2 / CSM-R2-3: ARR renders with its unit; the portfolio band groups
 *    by currency — never a blind cross-unit total.
 *  - CS-SP-7: an emptied health-score field errors instead of recording 0.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Account } from '../csmClient.js';

const access = vi.hoisted(() => ({ value: { enabled: true, loading: false, variant: undefined as string | undefined } }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => access.value,
}));

const listAccounts = vi.hoisted(() => vi.fn(async (): Promise<Account[]> => []));
const listOrgs = vi.hoisted(() => vi.fn(async () => [{ orgId: 'org-1', name: 'Org One' }]));
const listCrmCompanies = vi.hoisted(() => vi.fn(async () => [{ companyId: 'cmp:1', name: 'Acme Corp' }]));
const createAccount = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => ({})));
const toastError = vi.hoisted(() => vi.fn());
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: toastError, info: vi.fn() } }));

vi.mock('../csmClient.js', () => ({
  listAccounts,
  listOrgs,
  listCrmCompanies,
  createAccount,
  deleteAccount: vi.fn(),
  updateAccount: vi.fn(),
}));

import { CsmPage } from '../CsmPage.js';

const acct = (id: string, name: string, over: Partial<Account> = {}): Account => ({
  accountId: id, tenantId: 't1', name, healthScore: 80,
  createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z', ...over,
} as Account);

const day = (offset: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const renderPage = () => render(<MemoryRouter><CsmPage /></MemoryRouter>);

beforeEach(() => {
  access.value = { enabled: true, loading: false, variant: undefined };
  vi.clearAllMocks();
  // useViewMode persists to localStorage — the grid-view test would leak its
  // 'grid' choice into every later render in this file.
  window.localStorage.clear();
  listOrgs.mockResolvedValue([{ orgId: 'org-1', name: 'Org One' }]);
  listCrmCompanies.mockResolvedValue([{ companyId: 'cmp:1', name: 'Acme Corp' }]);
});
afterEach(() => cleanup());

describe('CS-SP-1 — company-read failure is visible and retryable', () => {
  it('a failed read shows "name unavailable" in the cell, and a retry that succeeds recovers the picker', async () => {
    listAccounts.mockResolvedValue([acct('a1', 'Globex', { crmRef: { orgId: 'org-1', companyId: 'cmp:1' } })]);
    listCrmCompanies.mockRejectedValueOnce(new Error('boom')).mockResolvedValue([{ companyId: 'cmp:1', name: 'Acme Corp' }]);
    renderPage();
    // The cell names the failure — it does NOT silently show the raw id.
    await screen.findByText(/name unavailable/i);
    expect(screen.queryByText('cmp:1')).toBeNull();
    // Open the link editor for that org → failed state shows error + retry.
    fireEvent.click(screen.getByRole('button', { name: /edit crm company link for .*Globex/i }));
    const retry = await screen.findByRole('button', { name: /retry/i });
    fireEvent.click(retry);
    // The retry refetches (the old [] cache made this impossible) and the
    // company name appears.
    await waitFor(() => expect(screen.getAllByText('Acme Corp').length).toBeGreaterThan(0));
  });
});

describe('CS-SP-3 — owner is rendered', () => {
  it('the Owner column shows the value the form/search/PATCH always carried', async () => {
    listAccounts.mockResolvedValue([acct('a1', 'Globex', { owner: 'dana@example.com' })]);
    renderPage();
    await screen.findByText('dana@example.com');
  });
});

describe('CS-SP-5 + CSM-G3 — grid chip parity, facet, undated sink', () => {
  it('the GRID view shows the urgency chip (round 1 fixed only the table)', async () => {
    listAccounts.mockResolvedValue([
      acct('a1', 'SoonCo', { renewalDate: day(5) }),
      acct('a2', 'FarCo', { renewalDate: day(300) }),
      acct('a3', 'C3', {}), acct('a4', 'C4', {}),
    ]);
    renderPage();
    await screen.findByText('SoonCo');
    fireEvent.click(screen.getByRole('button', { name: /grid/i }));
    await waitFor(() => expect(screen.getAllByText(/renews in|days/i).length).toBeGreaterThan(0));
  });

  it('the renewal facet narrows to renewing-soon and past-due', async () => {
    listAccounts.mockResolvedValue([
      acct('a1', 'SoonCo', { renewalDate: day(30) }),
      acct('a2', 'PastCo', { renewalDate: day(-10) }),
      acct('a3', 'FarCo', { renewalDate: day(300) }),
      acct('a4', 'NoDateCo', {}),
    ]);
    renderPage();
    await screen.findByText('FarCo');
    fireEvent.change(screen.getByLabelText(/filter by renewal/i), { target: { value: 'soon' } });
    await waitFor(() => expect(screen.queryByText('FarCo')).toBeNull());
    expect(screen.getByText('SoonCo')).toBeTruthy();
    expect(screen.queryByText('PastCo')).toBeNull();
    fireEvent.change(screen.getByLabelText(/filter by renewal/i), { target: { value: 'past' } });
    await waitFor(() => expect(screen.getByText('PastCo')).toBeTruthy());
    expect(screen.queryByText('SoonCo')).toBeNull();
  });
});

describe('CS-SP-2 / CSM-R2-3 — currency truth', () => {
  it('ARR renders with its unit; the portfolio band groups by currency, never a blind total', async () => {
    listAccounts.mockResolvedValue([
      acct('a1', 'UsdCo', { arr: 100000, arrCurrency: 'USD' }),
      acct('a2', 'EurCo', { arr: 50000, arrCurrency: 'EUR' }),
    ]);
    renderPage();
    await screen.findByText('UsdCo');
    const band = screen.getByRole('group', { name: /portfolio/i });
    // Grouped: both figures present, the blind 150,000 absent.
    expect(band.textContent).toMatch(/100,000|100 000/);
    expect(band.textContent).toMatch(/50,000|50 000/);
    expect(band.textContent).not.toMatch(/150,?\s?000/);
  });

  it('create sends the uppercased currency only WITH an amount', async () => {
    listAccounts.mockResolvedValue([]);
    renderPage();
    await screen.findByText(/no accounts/i);
    fireEvent.change(screen.getByLabelText(/^account$/i), { target: { value: 'NewCo' } });
    fireEvent.change(screen.getByLabelText(/^arr$/i), { target: { value: '5000' } });
    fireEvent.change(screen.getByLabelText(/^currency$/i), { target: { value: 'eur' } });
    fireEvent.click(screen.getByRole('button', { name: /add account/i }));
    await waitFor(() => expect(createAccount).toHaveBeenCalled());
    expect(createAccount.mock.calls[0]![0]).toMatchObject({ arr: 5000, arrCurrency: 'EUR' });
  });
});

describe('CS-SP-7 / ADR 0582 §4 — an emptied score field is UNSCORED, never a zero', () => {
  // CS-SP-7's original claim was "an emptied field must not be recorded as 0"
  // (the PR-3049 number-field family). It asserted that by requiring a value,
  // which was only defensible while the field was pre-filled with `'50'` and an
  // unscored account had no representation. ADR 0582 makes "not scored" a real
  // state, so the honest form of the SAME claim is: empty creates the account
  // with NO score — and still never 0.
  it('submitting with an empty score creates the account UNSCORED', async () => {
    listAccounts.mockResolvedValue([]);
    renderPage();
    await screen.findByText(/no accounts/i);
    fireEvent.change(screen.getByLabelText(/^account$/i), { target: { value: 'NewCo' } });
    fireEvent.change(screen.getByLabelText(/^health \(0/i), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /add account/i }));
    await waitFor(() => expect(createAccount).toHaveBeenCalled());
    const payload = createAccount.mock.calls[0]![0] as Record<string, unknown>;
    expect('healthScore' in payload, 'an unscored account must carry NO score').toBe(false);
    expect(toastError).not.toHaveBeenCalled();
  });

  // MEASURED while writing this: an out-of-range value cannot reach the JS
  // guard through the form at all — `min=0 max=100` makes the field fail native
  // constraint validation, so the submit event never fires (jsdom implements
  // this, which is why the first attempt at this test saw ZERO calls to both
  // `createAccount` and `toast.error` and looked like a broken guard). The
  // range is therefore asserted where it is actually enforced. The JS guard
  // stays as the non-native-path defence and is exercised at the service layer.
  it('an OUT-OF-RANGE score cannot be submitted — the field is natively invalid', async () => {
    listAccounts.mockResolvedValue([]);
    renderPage();
    await screen.findByText(/no accounts/i);
    const score = screen.getByLabelText(/^health \(0/i) as HTMLInputElement;
    fireEvent.change(score, { target: { value: '140' } });
    expect(score.checkValidity()).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /add account/i }));
    await new Promise((r) => setTimeout(r, 50));
    expect(createAccount).not.toHaveBeenCalled();
    // ...while an EMPTY field is valid, which is what makes "unscored" reachable.
    fireEvent.change(score, { target: { value: '' } });
    expect(score.checkValidity()).toBe(true);
  });
});

describe('CSM-G3 — renewal sort sinks undated rows (ascending)', () => {
  it('soonest first; undated rows come LAST', async () => {
    listAccounts.mockResolvedValue([
      acct('a1', 'NoDateCo', {}),
      acct('a2', 'LaterCo', { renewalDate: day(60) }),
      acct('a3', 'SoonCo', { renewalDate: day(3) }),
      acct('a4', 'Pad', {}),
    ]);
    renderPage();
    await screen.findByText('SoonCo');
    // Click the Renewal header to sort ascending (selected by class + text —
    // the accessible-name dump in jsdom truncates some sort buttons).
    const renewalBtn = [...document.querySelectorAll('button.data-sort-btn')]
      .find((b) => (b.textContent ?? '').includes('Renewal'));
    expect(renewalBtn).toBeDefined();
    fireEvent.click(renewalBtn!);
    const names = [...document.querySelectorAll('tbody tr')].map((r) => r.textContent ?? '');
    const idx = (n: string): number => names.findIndex((tx) => tx.includes(n));
    expect(idx('SoonCo')).toBeLessThan(idx('LaterCo'));
    expect(idx('LaterCo')).toBeLessThan(idx('NoDateCo'));
  });
});

describe('F8 coverage — formatArr edge branches (band-level)', () => {
  it('a unitless account groups beside a currency group; an invalid agent code degrades, never crashes', async () => {
    listAccounts.mockResolvedValue([
      acct('a1', 'UnitlessCo', { arr: 700 }),
      acct('a2', 'BadCodeCo', { arr: 300, arrCurrency: 'XX!' as string }),
    ]);
    renderPage();
    await screen.findByText('UnitlessCo');
    const band = screen.getByRole('group', { name: /portfolio/i });
    expect(band.textContent).toMatch(/700/);
    expect(band.textContent).toMatch(/300/);
    expect(band.textContent).not.toMatch(/1[,.]?000/); // never a blind cross-group total
  });
});

