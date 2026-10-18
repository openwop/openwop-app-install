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
 *
 * Sabotage-witnessed (w7 grade-tests): making `retryCompanies` not bump its
 * tick reds CS-SP-1 (the editor-open refetch also fails here, so ONLY the
 * Retry can recover); dropping the grid's `days <= 30` chip reds CS-SP-5;
 * rendering ARR without its currency reds CS-SP-2; sending `arrCurrency`
 * without an amount reds the create leg.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type * as C from '../csmClient.js';
import type { Account } from '../csmClient.js';

const access = vi.hoisted(() => ({ value: { enabled: true, loading: false, variant: undefined as string | undefined } }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => access.value,
}));

const api = vi.hoisted(() => ({
  listAccounts: vi.fn<typeof C.listAccounts>(),
  listOrgs: vi.fn<typeof C.listOrgs>(),
  listCrmCompanies: vi.fn<typeof C.listCrmCompanies>(),
  createAccount: vi.fn<typeof C.createAccount>(),
  deleteAccount: vi.fn<typeof C.deleteAccount>(),
  updateAccount: vi.fn<typeof C.updateAccount>(),
  // ADR 0882 D3 — the owner picker's people list.
  listAssignees: vi.fn<typeof C.listAssignees>(async () => ({ assignees: [{ subject: 'user:me', displayName: 'Mia Me' }, { subject: 'user:dana', displayName: 'Dana Diaz' }], me: ['user:me'] })),
}));
const { listAccounts, listCrmCompanies, createAccount } = api;
const toastError = vi.hoisted(() => vi.fn());
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: toastError, info: vi.fn() } }));

// Partial mock: every fetching export replaced; the REAL `CsmRequestError`
// survives for the page's `instanceof` map (CSMWF-11).
vi.mock('../csmClient.js', async (orig) => ({
  ...(await orig<typeof import('../csmClient.js')>()),
  ...api,
}));
// ADR 0882 (CSM2UX-4) — write controls follow `workspace:write`; `writeAccess.value`
// lets a case render as a Viewer.
const writeAccess = vi.hoisted(() => ({ value: true }));
vi.mock('../../../lib/writeAccess.js', async (orig) => ({
  ...(await orig<typeof import('../../../lib/writeAccess.js')>()),
  useScopeWriteAccess: () => writeAccess.value,
}));

import { CsmPage } from '../CsmPage.js';

const acct = (id: string, name: string, over: Partial<Account> = {}): Account => ({
  accountId: id, tenantId: 't1', name, healthScore: 80,
  createdAt: '2026-08-01T00:00:00Z', updatedAt: '2026-08-01T00:00:00Z', ...over,
});

const day = (offset: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const renderPage = () => render(<MemoryRouter><CsmPage /></MemoryRouter>);

beforeEach(() => {
  access.value = { enabled: true, loading: false, variant: undefined };
  vi.resetAllMocks();
  // useViewMode persists to localStorage — the grid-view test would leak its
  // 'grid' choice into every later render in this file.
  window.localStorage.clear();
  api.listOrgs.mockResolvedValue([{ orgId: 'org-1', name: 'Org One' }]);
  listCrmCompanies.mockResolvedValue([{ companyId: 'cmp:1', name: 'Acme Corp' }]);
  listAccounts.mockResolvedValue([]);
  createAccount.mockImplementation(async (input) => acct('new', input.name));
});
afterEach(() => cleanup());

describe('CS-SP-1 — company-read failure is visible and retryable', () => {
  it('a failed read shows "name unavailable" in the cell, and a retry that succeeds recovers the picker', async () => {
    listAccounts.mockResolvedValue([acct('a1', 'Globex', { crmRef: { orgId: 'org-1', companyId: 'cmp:1' } })]);
    // BOTH the initial batch read AND the editor-open refetch fail, so the
    // Retry is the only path back — otherwise opening the editor alone would
    // recover and the retry claim could not fail.
    listCrmCompanies
      .mockRejectedValueOnce(new Error('boom'))
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue([{ companyId: 'cmp:1', name: 'Acme Corp' }]);
    renderPage();
    // The cell names the failure — it does NOT silently show the raw id.
    await screen.findByText(/name unavailable/i);
    expect(screen.queryByText('cmp:1')).toBeNull();
    // Open the link editor for that org → failed state shows error + retry.
    fireEvent.click(screen.getByRole('button', { name: /edit crm company link for .*Globex/i }));
    await waitFor(() => expect(listCrmCompanies).toHaveBeenCalledTimes(2));
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    expect(screen.queryAllByText('Acme Corp')).toHaveLength(0);
    expect(screen.getAllByText('Company names didn’t load').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: 'Retry loading company names' }));
    // The retry refetches (the old [] cache made this impossible) and the
    // company name appears.
    await waitFor(() => expect(screen.getAllByText('Acme Corp').length).toBeGreaterThan(0));
  });
});

describe('CS-SP-3 — owner is rendered', () => {
  it('a legacy typed owner still shows, marked as a typed name', async () => {
    listAccounts.mockResolvedValue([acct('a1', 'Globex', { owner: 'dana@example.com' })]);
    renderPage();
    await screen.findByText('dana@example.com');
    expect(screen.getAllByText('Typed name').length).toBeGreaterThan(0);
  });
});

describe('ADR 0882 D3 — the owner is a member', () => {
  it('shows the member\'s name, "You" for me, and "Mine" filters to my accounts', async () => {
    listAccounts.mockResolvedValue([
      acct('a1', 'MineCo', { ownerUserId: 'user:me' }),
      acct('a2', 'DanaCo', { ownerUserId: 'user:dana' }),
      acct('a3', 'NobodyCo', {}),
      acct('a4', 'GoneCo', { ownerUserId: 'user:left' }),
    ]);
    renderPage();
    await screen.findByText('MineCo');
    // The name renders in the Owner cell (and as an option in the picker).
    await waitFor(() => expect(screen.getAllByText('Dana Diaz').length).toBeGreaterThan(1));
    expect(screen.getByText('You')).toBeTruthy();
    expect(screen.getByText('Former member')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/filter by owner/i), { target: { value: 'mine' } });
    expect(screen.queryByText('DanaCo')).toBeNull();
    expect(screen.getByText('MineCo')).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/filter by owner/i), { target: { value: 'unassigned' } });
    expect(screen.getByText('NobodyCo')).toBeTruthy();
    expect(screen.queryByText('MineCo')).toBeNull();
  });

  it('the create form sends a member id, never typed text', async () => {
    listAccounts.mockResolvedValue([]);
    createAccount.mockResolvedValue(acct('n1', 'New'));
    renderPage();
    const owner = await screen.findByLabelText(/^owner$/i);
    await waitFor(() => expect((owner as HTMLSelectElement).disabled).toBe(false));
    fireEvent.change(screen.getByLabelText(/^account$/i), { target: { value: 'New' } });
    fireEvent.change(owner, { target: { value: 'user:dana' } });
    fireEvent.click(screen.getByRole('button', { name: /add account/i }));
    await waitFor(() => expect(createAccount).toHaveBeenCalled());
    expect(createAccount.mock.calls[0]![0]).toMatchObject({ name: 'New', ownerUserId: 'user:dana' });
    expect(createAccount.mock.calls[0]![0]).not.toHaveProperty('owner');
  });
});

describe('ADR 0882 D7 — the plays card', () => {
  it('deep-links each play into the builder preflight, never runs it here', async () => {
    listAccounts.mockResolvedValue([]);
    renderPage();
    const links = await screen.findAllByRole('link', { name: /^set up .* in the builder$/i });
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      '/builder?template=csm-ops.red-account-rescue',
      '/builder?template=csm-ops.renewal-runway',
    ]);
  });

  it('CSM2UX-3: says how each play STARTS — the rescue play needs its event bound', async () => {
    listAccounts.mockResolvedValue([]);
    renderPage();
    const bind = await screen.findByRole('link', { name: /bind the event/i });
    expect(bind.getAttribute('href')).toBe('/event-bindings');
    expect(screen.getByText(/from a schedule you add in the builder/i)).toBeTruthy();
  });
});

describe('ADR 0882 — grade-ux fixes', () => {
  afterEach(() => { writeAccess.value = true; });

  it('CSM2UX-1: nothing grabs focus on load; opening the editor focuses its first field', async () => {
    listAccounts.mockResolvedValue([acct('a1', 'FocusCo')]);
    renderPage();
    await screen.findByText('FocusCo');
    expect(document.activeElement === document.body || document.activeElement === null).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /edit focusco/i }));
    const panel = (await screen.findByText(/edit "focusco"/i)).closest('form')!;
    expect(document.activeElement).toBe(within(panel).getByLabelText(/^account$/i));
  });

  it('CSM2UX-2: while the people list is loading, an owner is not called a former member', async () => {
    api.listAssignees.mockImplementationOnce(() => new Promise(() => {}));
    listAccounts.mockResolvedValue([acct('a1', 'PendingCo', { ownerUserId: 'user:dana' })]);
    renderPage();
    await screen.findByText('PendingCo');
    expect(screen.queryByText('Former member')).toBeNull();
    expect(screen.getAllByText('Loading…').length).toBeGreaterThan(0);
  });

  it('CSM2UX-4: a Viewer is not offered the add form, row actions or play set-up', async () => {
    writeAccess.value = false;
    listAccounts.mockResolvedValue([acct('a1', 'ReadOnlyCo')]);
    renderPage();
    await screen.findByText('ReadOnlyCo');
    expect(screen.queryByRole('button', { name: /add account/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /edit readonlyco/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /^set up .* in the builder$/i })).toBeNull();
    expect(screen.getByText(/needs edit access/i)).toBeTruthy();
  });

  it('CSM2UX-10: a DSAR-erased owner reads as "Erased", not the raw marker', async () => {
    listAccounts.mockResolvedValue([acct('a1', 'ErasedCo', { owner: '[erased]' })]);
    renderPage();
    await screen.findByText('ErasedCo');
    expect(screen.getByText('Erased')).toBeTruthy();
    expect(screen.queryByText('[erased]')).toBeNull();
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
    // The GRID is what renders now — no table rows to borrow a chip from.
    await waitFor(() => expect(document.querySelector('tbody')).toBeNull());
    const card = (name: string): HTMLElement => screen.getByText(name).closest('.surface-card') as HTMLElement;
    expect(within(card('SoonCo')).getByText(/^in 5\s*d$/)).toBeTruthy();
    expect(within(card('FarCo')).queryByText(/^in \d+\s*d$/)).toBeNull();
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
    // Grouped: both figures present WITH their unit, the blind 150,000 absent.
    expect(band.textContent).toMatch(/\$100,000/);
    expect(band.textContent).toMatch(/€50,000/);
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

    // …and a currency with NO amount is not sent: a unit on nothing.
    createAccount.mockClear();
    await waitFor(() => expect((screen.getByLabelText(/^account$/i) as HTMLInputElement).value).toBe(''));
    fireEvent.change(screen.getByLabelText(/^account$/i), { target: { value: 'OtherCo' } });
    fireEvent.change(screen.getByLabelText(/^currency$/i), { target: { value: 'usd' } });
    fireEvent.click(screen.getByRole('button', { name: /add account/i }));
    await waitFor(() => expect(createAccount).toHaveBeenCalled());
    expect(createAccount.mock.calls[0]![0]).toMatchObject({ name: 'OtherCo' });
    expect(createAccount.mock.calls[0]![0]).not.toHaveProperty('arrCurrency');
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
    const payload = createAccount.mock.calls[0]![0];
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
    // Native validation blocks the submit synchronously; drain, don't sleep.
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
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
      acct('a2', 'BadCodeCo', { arr: 300, arrCurrency: 'XX!' }),
    ]);
    renderPage();
    await screen.findByText('UnitlessCo');
    const band = screen.getByRole('group', { name: /portfolio/i });
    expect(band.textContent).toMatch(/700/);
    expect(band.textContent).toMatch(/300/);
    expect(band.textContent).not.toMatch(/1[,.]?000/); // never a blind cross-group total
  });
});

