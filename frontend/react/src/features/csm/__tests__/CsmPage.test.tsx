/**
 * CsmPage (ADR 0212): the access-gate tri-state (mirrors CrmPage.test.tsx),
 * plus the crmRef display branch — a linked account shows the CRM company
 * name as a Link into /crm/companies/:id, an unlinked account shows "Not
 * linked" — and the healthFactors breakdown + "computed <relative time>"
 * stamp when present.
 *
 * Sabotage-witnessed (w7 grade-tests): `if (csm.enabled) load()` → `load()`
 * reds the not-enabled leg; dropping the `Set` dedupe of crmRef orgs reds the
 * batching leg; ignoring `?health=` reds the deep-link leg (ADR 0582 §14).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type * as C from '../csmClient.js';
import type { Account } from '../csmClient.js';
import { makeFeatureAccess, type FeatureAccessResult } from '../../../featureToggles/__testing__/makeFeatureAccess.js';

// Read lazily at call time, so the module-scope binding is initialised first.
let accessValue: FeatureAccessResult = makeFeatureAccess();
vi.mock('../../../featureToggles/FeatureAccessContext.js', async (orig) => ({
  ...(await orig<typeof import('../../../featureToggles/FeatureAccessContext.js')>()),
  useFeatureAccess: () => accessValue,
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
// Partial mock: every fetching export is replaced, and the REAL
// `CsmRequestError` survives for the page's `instanceof` map (CSMWF-11).
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

const acct = (over: Partial<Account> & Pick<Account, 'accountId' | 'name'>): Account => ({
  tenantId: 't1', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...over,
});

const renderPage = () => render(<MemoryRouter><CsmPage /></MemoryRouter>);

beforeEach(() => {
  vi.resetAllMocks();
  accessValue = makeFeatureAccess({ enabled: false });
  api.listAccounts.mockResolvedValue([]);
  api.listOrgs.mockResolvedValue([{ orgId: 'org-1', name: 'Org One' }]);
  api.listCrmCompanies.mockResolvedValue([
    { companyId: 'cmp:1', name: 'Acme Corp' },
    { companyId: 'cmp:2', name: 'Globex' },
  ]);
});
afterEach(() => cleanup());

describe('CsmPage — access gate', () => {
  it('renders a skeleton while loading', () => {
    accessValue = makeFeatureAccess({ enabled: false, loading: true });
    const { container } = renderPage();
    expect(container.querySelector('.skeleton, [class*="skeleton"]')).not.toBeNull();
    // Loading is not the disabled state.
    expect(screen.queryByText('CSM is not enabled')).toBeNull();
  });

  it('shows the not-enabled StateCard when disabled — the FE is never the authority gate', async () => {
    renderPage();
    expect(await screen.findByText('CSM is not enabled')).toBeTruthy();
    expect(api.listAccounts).not.toHaveBeenCalled();
  });
});

describe('CsmPage — ADR 0212 crmRef + healthFactors display', () => {
  beforeEach(() => {
    accessValue = makeFeatureAccess();
  });

  it('shows the linked company name as a Link for an account with crmRef', async () => {
    api.listAccounts.mockResolvedValueOnce([
      acct({ accountId: 'csm:1', name: 'Linked Co Account', healthScore: 80, crmRef: { orgId: 'org-1', companyId: 'cmp:1' } }),
      acct({ accountId: 'csm:4', name: 'Second Linked Account', healthScore: 75, crmRef: { orgId: 'org-1', companyId: 'cmp:2' } }),
    ]);
    renderPage();
    const link = await screen.findByRole('link', { name: 'Acme Corp' });
    expect(link.getAttribute('href')).toBe('/crm/companies/cmp%3A1?org=org-1');
    expect(await screen.findByRole('link', { name: 'Globex' })).toBeTruthy();
    expect(api.listCrmCompanies).toHaveBeenCalledWith('org-1');
    // Batched — ONE call per distinct org, not per row (two rows share org-1).
    expect(api.listCrmCompanies).toHaveBeenCalledTimes(1);
  });

  it('shows "Not linked" for an account with no crmRef', async () => {
    api.listAccounts.mockResolvedValueOnce([acct({ accountId: 'csm:2', name: 'Unlinked Account', healthScore: 50 })]);
    renderPage();
    expect(await screen.findByText('Not linked')).toBeTruthy();
    expect(api.listCrmCompanies).not.toHaveBeenCalled();
  });

  it('shows the healthFactors breakdown + a computed-at stamp when present', async () => {
    api.listAccounts.mockResolvedValueOnce([
      acct({
        accountId: 'csm:3',
        name: 'Computed Account',
        healthScore: 62,
        healthFactors: [{ factor: 'openDeals', weight: 8, value: 2 }],
        healthComputedAt: new Date(Date.now() - 60_000).toISOString(),
      }),
    ]);
    renderPage();
    expect(await screen.findByText('1 factor')).toBeTruthy();
    expect(screen.getByText('openDeals')).toBeTruthy();
    expect(screen.getByText(/computed/)).toBeTruthy();
  });
});

/**
 * ADR 0582 §14 — the dashboard's `CsmHealthTile` deep-links
 * `/csm?health=unscored` ("N accounts nobody has measured"). Until this landed
 * `CsmPage` never read `useSearchParams`, so the click arrived on a completely
 * UNFILTERED list: the tile promised a filtered view and delivered the default
 * one. In a change about not promising what you do not deliver, that had to be
 * wired rather than documented.
 */
describe('CsmPage — the ?health= deep link is honoured', () => {
  const renderAt = (path: string) =>
    render(<MemoryRouter initialEntries={[path]}><CsmPage /></MemoryRouter>);

  beforeEach(() => {
    accessValue = makeFeatureAccess();
    api.listAccounts.mockResolvedValue([
      acct({ accountId: 'a1', name: 'Unmeasured Co' }),              // no healthScore ⇒ unscored
      acct({ accountId: 'a2', name: 'Healthy Co', healthScore: 95 }),
    ]);
  });

  it('?health=unscored preselects the facet, so only the unmeasured account shows', async () => {
    renderAt('/csm?health=unscored');
    expect(await screen.findByText('Unmeasured Co')).toBeTruthy();
    // The measured account is filtered OUT — this is what proves the param was
    // read, not merely that the page rendered.
    await waitFor(() => expect(screen.queryByText('Healthy Co')).toBeNull());
  });

  it('with NO param both accounts show — so the leg above is not vacuous', async () => {
    renderAt('/csm');
    expect(await screen.findByText('Unmeasured Co')).toBeTruthy();
    expect(await screen.findByText('Healthy Co')).toBeTruthy();
  });

  it('an UNRECOGNISED health value is ignored rather than filtering everything away', async () => {
    renderAt('/csm?health=not-a-tier');
    expect(await screen.findByText('Unmeasured Co')).toBeTruthy();
    expect(await screen.findByText('Healthy Co')).toBeTruthy();
  });
});
