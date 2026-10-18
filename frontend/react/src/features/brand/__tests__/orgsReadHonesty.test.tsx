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
 * The failed read must also offer no create control (wave 51: a read-failure case
 * checks that the empty state is ABSENT and the create path is gone, not only that
 * an error string appears).
 *
 * Sabotage-witnessed (w52): `.catch(() => setOrgsFailed(true))` → `false` (case 1
 * red); `setOrgsFailed(false)` → `true` on success (case 2 red).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type * as C from '../brandClient.js';

const api = vi.hoisted(() => ({ listBrands: vi.fn<typeof C.listBrands>(), listOrgs: vi.fn<typeof C.listOrgs>() }));
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
  api.listBrands.mockReset().mockResolvedValue([]);
  api.listOrgs.mockReset();
});
afterEach(cleanup);

describe('BRAND-R2-1 — the no-org invitation never rides a failed read', () => {
  it('FAILED orgs read: shows the load-failure card, NOT "create an organization"', async () => {
    api.listOrgs.mockRejectedValue(new Error('orgs_500'));
    render(<BrandPage />);
    expect(await screen.findByText(/Could not load this/i)).toBeTruthy();
    // The card is the ORGS failure, not a brands failure wearing the same title:
    // the brands read was made and answered [].
    expect(api.listBrands).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('No organization yet')).toBeNull();
    // No create path rides the failed read.
    expect(screen.queryByRole('button', { name: /create|new brand/i })).toBeNull();
  });

  it('TRUTHFUL org-less tenant: still gets the real no-org invitation', async () => {
    api.listOrgs.mockResolvedValue([]);
    render(<BrandPage />);
    expect(await screen.findByText('No organization yet')).toBeTruthy();
    expect(screen.queryByText(/Could not load this/i)).toBeNull();
  });
});
