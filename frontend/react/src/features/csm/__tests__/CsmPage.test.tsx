/**
 * CsmPage (ADR 0212): the access-gate tri-state (mirrors CrmPage.test.tsx),
 * plus the crmRef display branch — a linked account shows the CRM company
 * name as a Link into /crm/companies/:id, an unlinked account shows "Not
 * linked" — and the healthFactors breakdown + "computed <relative time>"
 * stamp when present.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const access = vi.hoisted(() => ({ value: { enabled: false, loading: false, variant: undefined as string | undefined } }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => access.value,
}));

const listAccounts = vi.hoisted(() => vi.fn(async () => [] as unknown[]));
const listOrgs = vi.hoisted(() => vi.fn(async () => [{ orgId: 'org-1', name: 'Org One' }]));
const listCrmCompanies = vi.hoisted(() => vi.fn(async () => [{ companyId: 'cmp:1', name: 'Acme Corp' }]));
vi.mock('../csmClient.js', () => ({
  listAccounts,
  listOrgs,
  listCrmCompanies,
  createAccount: vi.fn(),
  deleteAccount: vi.fn(),
  updateAccount: vi.fn(),
}));

import { CsmPage } from '../CsmPage.js';

const renderPage = () => render(<MemoryRouter><CsmPage /></MemoryRouter>);

beforeEach(() => {
  access.value = { enabled: false, loading: false, variant: undefined };
  listAccounts.mockClear();
  listOrgs.mockClear();
  listCrmCompanies.mockClear();
});
afterEach(() => cleanup());

describe('CsmPage — access gate', () => {
  it('renders a skeleton while loading', () => {
    access.value = { enabled: false, loading: true, variant: undefined };
    const { container } = renderPage();
    expect(container.querySelector('.skeleton, [class*="skeleton"]')).toBeTruthy();
  });

  it('shows the not-enabled StateCard when disabled — the FE is never the authority gate', async () => {
    access.value = { enabled: false, loading: false, variant: undefined };
    renderPage();
    expect(await screen.findByText('CSM is not enabled')).toBeTruthy();
    expect(listAccounts).not.toHaveBeenCalled();
  });

  it('loads accounts once enabled', async () => {
    access.value = { enabled: true, loading: false, variant: undefined };
    renderPage();
    await waitFor(() => expect(listAccounts).toHaveBeenCalled());
  });
});

describe('CsmPage — ADR 0212 crmRef + healthFactors display', () => {
  beforeEach(() => {
    access.value = { enabled: true, loading: false, variant: undefined };
  });

  it('shows the linked company name as a Link for an account with crmRef', async () => {
    listAccounts.mockResolvedValueOnce([
      {
        accountId: 'csm:1',
        tenantId: 't1',
        name: 'Linked Co Account',
        healthScore: 80,
        crmRef: { orgId: 'org-1', companyId: 'cmp:1' },
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    renderPage();
    const link = await screen.findByRole('link', { name: 'Acme Corp' });
    expect(link.getAttribute('href')).toBe('/crm/companies/cmp%3A1?org=org-1');
    await waitFor(() => expect(listCrmCompanies).toHaveBeenCalledWith('org-1'));
    // Batched — ONE call per distinct org, not per row.
    expect(listCrmCompanies).toHaveBeenCalledTimes(1);
  });

  it('shows "Not linked" for an account with no crmRef', async () => {
    listAccounts.mockResolvedValueOnce([
      {
        accountId: 'csm:2',
        tenantId: 't1',
        name: 'Unlinked Account',
        healthScore: 50,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);
    renderPage();
    expect(await screen.findByText('Not linked')).toBeTruthy();
    expect(listCrmCompanies).not.toHaveBeenCalled();
  });

  it('shows the healthFactors breakdown + a computed-at stamp when present', async () => {
    listAccounts.mockResolvedValueOnce([
      {
        accountId: 'csm:3',
        tenantId: 't1',
        name: 'Computed Account',
        healthScore: 62,
        healthFactors: [{ factor: 'openDeals', weight: 8, value: 2 }],
        healthComputedAt: new Date(Date.now() - 60_000).toISOString(),
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
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
    access.value = { enabled: true, loading: false, variant: undefined };
    listAccounts.mockImplementation(async () => [
      { accountId: 'a1', name: 'Unmeasured Co', orgId: 'org-1' },              // no healthScore ⇒ unscored
      { accountId: 'a2', name: 'Healthy Co', orgId: 'org-1', healthScore: 95 },
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
