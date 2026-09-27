/**
 * BRAND-R2-1 (brand round 2) — a failed orgs read must not say
 * "No organization yet".
 *
 * `listOrgs().catch(() => {})` left `orgs` at `[]`, and the empty-brands
 * branch renders the no-org StateCard — which tells the user to go CREATE an
 * organization — whenever `orgs.length === 0`. A transient orgs-500 therefore
 * instructed users who already own an org to make another one (the UX-BRD-1
 * shape: a failed read inviting a duplicate).
 *
 * Both polarities: a genuinely org-less tenant still gets the real invitation.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

const api = vi.hoisted(() => ({ listBrands: vi.fn(), listOrgs: vi.fn() }));
vi.mock('../brandClient.js', async (orig) => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    listBrands: api.listBrands,
    listOrgs: api.listOrgs,
    createBrand: vi.fn(async () => ({})),
    updateBrand: vi.fn(async () => ({})),
    deleteBrand: vi.fn(async () => {}),
    listBrandFonts: vi.fn(async () => []),
  };
});

import { BrandPage } from '../BrandPage.js';

beforeEach(() => {
  vi.clearAllMocks();
  api.listBrands.mockResolvedValue([]);
});
afterEach(cleanup);

describe('BRAND-R2-1 — the no-org invitation never rides a failed read', () => {
  it('FAILED orgs read: shows the load-failure card, NOT "create an organization"', async () => {
    api.listOrgs.mockRejectedValue(new Error('orgs_500'));
    render(<BrandPage />);
    expect(await screen.findByText(/Could not load this/i)).toBeTruthy();
    expect(screen.queryByText('No organization yet')).toBeNull();
  });

  it('TRUTHFUL org-less tenant: still gets the real no-org invitation', async () => {
    api.listOrgs.mockResolvedValue([]);
    render(<BrandPage />);
    expect(await screen.findByText('No organization yet')).toBeTruthy();
    expect(screen.queryByText(/Could not load this/i)).toBeNull();
  });
});
