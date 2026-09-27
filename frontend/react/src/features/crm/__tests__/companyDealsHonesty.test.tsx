/**
 * CRM-R2-1 (crm round 2) — a failed deals read must not claim a company has
 * no deals.
 *
 * `listDeals(...).catch(() => setDeals([]))` rendered the noDealsForCompany
 * empty card on any failure — a false sales claim on the record page. Both
 * polarities pinned.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const api = vi.hoisted(() => ({ getCompany: vi.fn(), listDeals: vi.fn() }));
import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../crmOrgClient.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return { ...actual, getCompany: api.getCompany, listDeals: api.listDeals };
});

const access = vi.hoisted(() => ({ useFeatureAccess: vi.fn() }));
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: access.useFeatureAccess,
}));

import { CompanyDetailPage } from '../CompanyDetailPage.js';

// A COMPLETE fixture: the render maps company.tags unconditionally.
const COMPANY = { companyId: 'c1', orgId: 'o1', name: 'Acme Co', tags: [] };

beforeEach(() => {
  vi.clearAllMocks();
  access.useFeatureAccess.mockReturnValue(makeFeatureAccess({ enabled: true, loading: false }));
  api.getCompany.mockResolvedValue(COMPANY);
});
afterEach(cleanup);

function view(): void {
  render(
    <MemoryRouter initialEntries={['/crm/companies/c1?org=o1']}>
      <Routes><Route path="/crm/companies/:companyId" element={<CompanyDetailPage />} /></Routes>
    </MemoryRouter>,
  );
}

describe('CRM-R2-1 — company deals honesty', () => {
  it("FAILED deals read: unavailable card with retry, never 'no deals'", async () => {
    api.listDeals.mockRejectedValue(new Error('deals_500'));
    view();
    expect(await screen.findByText(/deals couldn.t be loaded/i)).toBeTruthy();
    expect(screen.queryByText(/no deals/i)).toBeNull();
  });

  it("TRUTHFUL empty: a real [] still shows the no-deals card", async () => {
    api.listDeals.mockResolvedValue([]);
    view();
    expect(await screen.findByText('No deals yet')).toBeTruthy();
    expect(screen.queryByText(/couldn.t be loaded/i)).toBeNull();
  });
});
