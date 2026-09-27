/**
 * ADR 0420 (admin link surface) — the operator can see what is for sale, link a
 * published version to a product, and is never allowed to relink silently: the
 * server's 409 becomes an explicit "replace" choice, and unlink asks first.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const state = {
  links: [{ tenantId: 't', productId: 'prod:1', challengeId: 'chal:a', challengeVersion: 1, createdBy: 'u', createdAt: '2026-09-01T00:00:00Z' }],
  linkImpl: vi.fn(async (_input: unknown) => ({ tenantId: 't', productId: 'prod:2', challengeId: 'chal:b', challengeVersion: 2, createdBy: 'u', createdAt: '' })),
};
const reads = vi.hoisted(() => ({
  listLinks: vi.fn(),
  listChallenges: vi.fn(),
  listProducts: vi.fn(),
}));

vi.mock('../../../client/kicktodoLinksClient.js', async (importOriginal) => {
  const orig = await importOriginal<Record<string, unknown>>();
  return {
    ...orig,
    listChallengeLinks: reads.listLinks,
    linkChallengeProduct: (input: unknown) => state.linkImpl(input),
    unlinkChallengeProduct: vi.fn(async () => undefined),
  };
});
vi.mock('../../../client/kicktodoClient.js', () => ({
  listChallenges: reads.listChallenges,
}));
vi.mock('../../commerce/commerceClient.js', () => ({
  listOrgs: vi.fn(async () => [{ orgId: 'org-1', name: 'KickTodo Store' }]),
  listProducts: reads.listProducts,
}));
vi.mock('../../../ui/confirm.js', () => ({ confirm: vi.fn(async () => true) }));

import { AdminPaidChallengesPage } from '../AdminPaidChallengesPage.js';
import { LinkConflictError, unlinkChallengeProduct } from '../../../client/kicktodoLinksClient.js';
import { messages as en } from '../i18n/en.js';

beforeEach(() => {
  reads.listLinks.mockReset().mockImplementation(async () => state.links);
  reads.listChallenges.mockReset().mockResolvedValue([
    { id: 'chal:a', version: 1, status: 'published', title: 'Sleep Reset', summary: '', outcome: '', durationDays: 7, activities: [] },
    { id: 'chal:b', version: 2, status: 'published', title: 'Deep Work', summary: '', outcome: '', durationDays: 7, activities: [] },
    { id: 'chal:c', version: 1, status: 'draft', title: 'Not yet', summary: '', outcome: '', durationDays: 7, activities: [] },
  ]);
  reads.listProducts.mockReset().mockResolvedValue([{ productId: 'prod:2', name: 'Deep Work — paid', type: 'digital', price: 9, currency: 'USD', variants: [], active: true, updatedAt: '' }]);
  state.linkImpl.mockReset().mockResolvedValue({ tenantId: 't', productId: 'prod:2', challengeId: 'chal:b', challengeVersion: 2, createdBy: 'u', createdAt: '' });
});
afterEach(cleanup);
const view = () => render(<MemoryRouter><AdminPaidChallengesPage /></MemoryRouter>);

describe('AdminPaidChallengesPage', () => {
  it('lists what is for sale with the challenge title resolved, and only PUBLISHED versions are offered to link', async () => {
    view();
    await waitFor(() => expect(screen.getByText(/Sleep Reset · v1/, { selector: 'td' })).toBeTruthy());
    expect(screen.getByText('prod:1')).toBeTruthy();
    const select = screen.getByLabelText(new RegExp(en.paidChallengeLabel)) as HTMLSelectElement;
    const options = [...select.options].map((o) => o.textContent);
    expect(options).toContain('Deep Work · v2');
    expect(options.some((o) => o?.includes('Not yet'))).toBe(false);
  });

  it('links a chosen product to a chosen version; a 409 becomes an explicit replace, never a silent overwrite', async () => {
    state.linkImpl.mockImplementationOnce(async () => { throw new LinkConflictError('Product already sells chal:a v1; unlink it or pass replace: true.'); });
    view();
    await waitFor(() => screen.getByText(/Sleep Reset · v1/, { selector: 'td' }));
    fireEvent.change(screen.getByLabelText(new RegExp(en.paidChallengeLabel)), { target: { value: 'chal:b::2' } });
    await waitFor(() => expect((screen.getByRole('button', { name: en.paidLinkCta }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: en.paidLinkCta }));
    await waitFor(() => expect(screen.getByText(/already sells chal:a v1/)).toBeTruthy());
    expect(state.linkImpl).toHaveBeenLastCalledWith({ productId: 'prod:2', challengeId: 'chal:b', challengeVersion: 2 });
    // The explicit replace is a second, deliberate call carrying replace:true.
    fireEvent.click(screen.getByRole('button', { name: en.paidReplaceCta }));
    await waitFor(() => expect(screen.getByText(en.paidLinked)).toBeTruthy());
    expect(state.linkImpl).toHaveBeenLastCalledWith({ productId: 'prod:2', challengeId: 'chal:b', challengeVersion: 2, replace: true });
  });

  it('unlink asks first and then removes the product’s link', async () => {
    view();
    await waitFor(() => screen.getByText(/Sleep Reset · v1/, { selector: 'td' }));
    fireEvent.click(screen.getByRole('button', { name: en.paidUnlinkCta }));
    await waitFor(() => expect(vi.mocked(unlinkChallengeProduct)).toHaveBeenCalledWith('prod:1'));
  });

  it('keeps failed link, challenge, and product reads distinct and retryable', async () => {
    reads.listLinks.mockRejectedValueOnce(new Error('links down'));
    reads.listChallenges.mockRejectedValueOnce(new Error('challenges down'));
    reads.listProducts.mockRejectedValueOnce(new Error('products down'));
    view();
    const linksError = await screen.findByText(en.paidLoadError);
    const challengesError = await screen.findByText(en.paidChallengesFailedTitle);
    const productsError = await screen.findByText(en.paidProductsFailedTitle);
    expect(screen.queryByText(en.paidEmptyTitle)).toBeNull();
    fireEvent.click(linksError.closest('.state-card')!.querySelector('button')!);
    fireEvent.click(challengesError.closest('.state-card')!.querySelector('button')!);
    fireEvent.click(productsError.closest('.state-card')!.querySelector('button')!);
    await waitFor(() => expect(screen.queryByText(en.paidLoadError)).toBeNull());
    expect(screen.queryByText(en.paidChallengesFailedTitle)).toBeNull();
    expect(screen.queryByText(en.paidProductsFailedTitle)).toBeNull();
  });

  it('does not invent challenge titles or allow linking while dependent catalogs are unavailable', async () => {
    reads.listChallenges.mockRejectedValueOnce(new Error('challenges down'));
    reads.listProducts.mockRejectedValueOnce(new Error('products down'));
    view();
    expect(await screen.findByText(en.paidChallengeTitleUnavailable, { selector: 'td' })).toBeTruthy();
    expect((screen.getByRole('button', { name: en.paidLinkCta }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText(new RegExp(en.paidProductLabel)) as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByLabelText(new RegExp(en.paidChallengeLabel)) as HTMLSelectElement).disabled).toBe(true);
  });
});
