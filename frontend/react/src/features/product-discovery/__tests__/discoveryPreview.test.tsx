/**
 * UX_UPGRADE-product-discovery — PD-G1 / PD-G2 / PD-G3.
 *
 *  - PD-G1: the preview rendered `{p.price} {p.currency}` — a bare number and a
 *    code ("1299.5 USD") where every other money surface in this app renders
 *    locale-formatted currency.
 *  - PD-G2: the list stopped at 12 and each facet at 3, in silence, which reads
 *    as "this is the whole result set".
 *  - PD-G3: the rules table rendered NOTHING when empty — no loading state, no
 *    empty state — while collections got both. A merch rule hides products from
 *    shoppers, so "are there any?" has to be answerable.
 *
 * PROTECTED (failure honesty — a FAILED rules read never reads as "no rules";
 * money display). What breaks it: bare `price currency`, a silent 12-row or
 * 3-value cap, a disclosure that fires when everything fits, the cap shown as
 * the total, a failed read rendering "shoppers see everything".
 * Sabotage-witnessed (round 1/2): formatCurrency, PRODUCT_CAP slice + its
 * disclosure condition, FACET_CAP slice + its disclosure condition, the real
 * `total`, the hiddenByRules line (and its position outside the non-empty
 * branch), the rules empty/failed branches, the search-failure clear + retry.
 * Every "says nothing" case settles on rendered rows FIRST — an absence checked
 * while the search is in flight cannot fail (round 1: `pd-quiet-total`,
 * `pd-facet-disclose` were vacuous that way / via a regex that never matched
 * the real copy).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent, act, within } from '@testing-library/react';
import type { SearchProduct, Facet, SearchResponse, MerchRule, Collection, Org } from '../discoveryClient.js';

const listCollections = vi.fn<(orgId: string) => Promise<Collection[]>>();
const listRules = vi.fn<(orgId: string) => Promise<MerchRule[]>>();
const search = vi.fn<(orgId: string, q: string) => Promise<SearchResponse>>();

import { makeFeatureAccess } from '../../../featureToggles/__testing__/makeFeatureAccess.js';
vi.mock('../discoveryClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listOrgs: vi.fn(async (): Promise<Org[]> => [{ orgId: 'org-1', name: 'Acme' }]),
  listCollections: (orgId: string) => listCollections(orgId),
  listRules: (orgId: string) => listRules(orgId),
  search: (orgId: string, q: string) => search(orgId, q),
  createCollection: vi.fn(),
  deleteCollection: vi.fn(async () => {}),
  createRule: vi.fn(),
  deleteRule: vi.fn(async () => {}),
}));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
// The real hook returns an OBJECT. Mocking it as `true` is what HID the live bug
// (the page did `const enabled = useFeatureAccess(…)` then `if (!enabled)`, which
// is never true for an object, so the toggle-off branch was dead in production
// and this mock made the page agree). Mirror the real shape.
vi.mock('../../../featureToggles/FeatureAccessContext.js', () => ({
  useFeatureAccess: () => makeFeatureAccess({ enabled: true, loading: false }),
}));

import { DiscoveryPage } from '../DiscoveryPage.js';

const products = (n: number): SearchProduct[] =>
  Array.from({ length: n }, (_, i) => ({ productId: `p${i}`, name: `Product ${i}`, price: 1299.5, currency: 'USD' }));

const facet = (n: number, totalValues = n): Facet => ({
  key: 'category', label: 'Category',
  values: Array.from({ length: n }, (_, i) => ({ value: `cat${i}`, count: 1000 + i })),
  totalValues,
});

const view = async (): Promise<void> => {
  render(<DiscoveryPage />);
  await act(async () => {});
};

async function runSearch(): Promise<void> {
  await view();
  await waitFor(() => expect(listRules).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button', { name: /run search|search/i }));
  await waitFor(() => expect(search).toHaveBeenCalled());
}

beforeEach(() => {
  listCollections.mockReset(); listRules.mockReset(); search.mockReset();
  listCollections.mockResolvedValue([]);
  listRules.mockResolvedValue([]);
  // Review B1 — this fixture is the CONTRACT: it must mirror what `routes.ts` sends.
  // The route was omitting `total`/`truncated`/`hiddenByRules` entirely and the page's
  // `?? products.length` fallbacks turned that into the original defect. The client
  // types are required now, so a wire drop is a compile error; this keeps the fixture
  // honest about the shape.
  search.mockResolvedValue({ products: products(3), facets: [], total: 3, truncated: false, hiddenByRules: 0 });
});
afterEach(cleanup);

describe('PD-G1: preview prices are formatted money', () => {
  it('renders locale currency, not a bare number and a code', async () => {
    await runSearch();
    // One row per product, each with locale-formatted money.
    expect((await screen.findAllByText(/\$1,299\.50/)).length).toBe(3);
    expect(screen.queryByText(/1299\.5 USD/)).toBeNull();
  });
});

describe('PD-G2: truncation is disclosed', () => {
  it('says how many of how many when the list is capped', async () => {
    search.mockResolvedValue({ products: products(40), facets: [], total: 40, truncated: false, hiddenByRules: 0 });
    await runSearch();
    expect(await screen.findByText('Showing the first 12 of 40 matches.')).toBeTruthy();
    // …and the list really stopped at 12 (PRODUCT_CAP): rows 0–11, not row 12.
    const list = screen.getByText('Product 0 — $1,299.50').closest('ul') as HTMLElement;
    expect(within(list).getAllByRole('listitem')).toHaveLength(12);
    expect(screen.getByText('Product 11 — $1,299.50')).toBeTruthy();
    expect(screen.queryByText(/^Product 12 —/)).toBeNull();
  });

  it('says NOTHING when the whole result set fits', async () => {
    search.mockResolvedValue({ products: products(5), facets: [], total: 5, truncated: false, hiddenByRules: 0 });
    await runSearch();
    // Settle on the LAST row first — absence before the result renders proves nothing.
    expect(await screen.findByText('Product 4 — $1,299.50')).toBeTruthy();
    expect(screen.queryByText(/Showing the first/i)).toBeNull();
  });

  it('discloses the per-facet cap when a facet has more values', async () => {
    search.mockResolvedValue({ products: products(1), facets: [facet(9)], total: 1, truncated: false, hiddenByRules: 0 });
    await runSearch();
    expect(await screen.findByText('Top 3 of 9 values per facet.')).toBeTruthy(); // review M2 — say of HOW MANY
    // …and the facet really stopped at 3 (FACET_CAP): cat0–cat2 shown, cat3 not.
    expect(screen.getByText('Category: cat0 (1,000)')).toBeTruthy();
    expect(screen.getByText('Category: cat2 (1,002)')).toBeTruthy();
    expect(screen.queryByText(/Category: cat3/)).toBeNull();
  });

  it('says nothing about facets when every facet fits', async () => {
    search.mockResolvedValue({ products: products(1), facets: [facet(2)], total: 1, truncated: false, hiddenByRules: 0 });
    await runSearch();
    // Settle on the rendered facet chips first, then the (real-copy) line is absent.
    expect(await screen.findByText('Category: cat1 (1,001)')).toBeTruthy();
    expect(screen.queryByText(/values per facet/i)).toBeNull();
  });
});

describe('PD-G3: the rules table has a loading and an empty state', () => {
  it('while the rules read is in flight the table shows a loading placeholder, never the empty state', async () => {
    // Both store-scoped reads held open: collections + rules each render their
    // skeleton (two "Loading…" statuses) and neither "no rules" line appears.
    listCollections.mockReturnValue(new Promise<Collection[]>(() => {}));
    listRules.mockReturnValue(new Promise<MerchRule[]>(() => {}));
    await view();
    await waitFor(() => expect(listRules).toHaveBeenCalledWith('org-1'));
    expect(screen.getAllByRole('status', { name: 'Loading…' })).toHaveLength(2);
    expect(screen.queryByText(/no merch rules/i)).toBeNull();
    expect(screen.queryByText(/shoppers see everything/i)).toBeNull();
  });

  it('an empty rule set SAYS it is empty, and what that means', async () => {
    await view();
    // Previously this region rendered nothing at all.
    expect(await screen.findByText(/no merch rules/i)).toBeTruthy();
    expect(screen.getByText(/shoppers see everything/i)).toBeTruthy();
  });

  it('renders the rules when there are some', async () => {
    // A COMPLETE fixture rather than an `as MerchRule` cast (no `orgId`, no `active`).
    // The cast let the object drift from the type, which the unit-test type ratchet
    // counts — it had main sitting at 178 against a 176 baseline (#3129 restored it).
    listRules.mockResolvedValue([{ ruleId: 'r1', orgId: 'org-1', name: 'Hide clearance', scope: 'all', actions: [], active: true }]);
    await view();
    expect(await screen.findByText('Hide clearance')).toBeTruthy();
    expect(screen.queryByText(/no merch rules/i)).toBeNull();
  });

  it('a FAILED load does not masquerade as "no rules configured"', async () => {
    listRules.mockRejectedValue(new Error('rules store down'));
    listCollections.mockRejectedValue(new Error('rules store down'));
    await view();
    expect(await screen.findByText(/rules store down/)).toBeTruthy();
    // R2 PD2-2 — the banner alone was ALL this test asserted, and the rules table
    // went on rendering "None are active, so shoppers see everything" directly
    // beneath it. A designed falsehood is not cured by a banner above it; assert
    // the claim is GONE, and that the failure is stated where the rows would be.
    expect(screen.queryByText(/no merch rules/i)).toBeNull();
    expect(screen.queryByText(/shoppers see everything/i)).toBeNull();
    expect(screen.getAllByText(/couldn't load this store's rules/i).length).toBeGreaterThan(0);
  });

  it('states the real match count, not the page cap', async () => {
    // The server caps the page at 48 and reports the true match count separately.
    search.mockResolvedValue({ products: products(48), facets: [], total: 5000, truncated: true, hiddenByRules: 0 });
    await runSearch();
    // "Showing the first {{shown}} of {{total}}" — the total must be 5,000, not 48.
    const line = await screen.findByText(/first 12 of/i);
    expect(line.textContent).toContain('5,000');
    expect(line.textContent).not.toContain('48');
  });

  it('says so even when hide rules removed EVERY match (review M1)', async () => {
    // The line used to live inside the non-empty branch, so the one case where "where
    // did they go?" most needs answering rendered a bare "No products matched."
    search.mockResolvedValue({ products: [], facets: [], total: 0, truncated: false, hiddenByRules: 4 });
    await runSearch();
    expect(await screen.findByText(/hidden from this preview/i)).toBeTruthy();
  });

  it('says when hide rules removed products from the preview', async () => {
    search.mockResolvedValue({ products: products(3), facets: [], total: 3, truncated: false, hiddenByRules: 7 });
    await runSearch();
    expect(await screen.findByText(/hidden from this preview/i)).toBeTruthy();
  });

  it('stays quiet when nothing was hidden (the disclosure must not become noise)', async () => {
    search.mockResolvedValue({ products: products(3), facets: [], total: 3, truncated: false, hiddenByRules: 0 });
    await runSearch();
    await screen.findByText(/Product 0/);
    expect(screen.queryByText(/hidden from this preview/i)).toBeNull();
  });
});

describe('R3 PD2-8 — a failed search never presents the previous query\'s results', () => {
  it('failure clears the panel + shows the persistent failed state; a successful retry restores results and clears it', async () => {
    search.mockResolvedValue({ products: products(2), facets: [], total: 2, truncated: false, hiddenByRules: 0 });
    await runSearch();
    await screen.findByText(/Product 0/);

    // The next query FAILS — the old list must not stand as its answer.
    search.mockRejectedValueOnce(new Error('boom'));
    fireEvent.click(screen.getByRole('button', { name: /run search|search/i }));
    await waitFor(() => expect(screen.queryByText(/Product 0/)).toBeNull());
    expect(screen.getByText(/not results for your query/i)).toBeTruthy();

    // Retry succeeds → results return, the failure clears.
    search.mockResolvedValueOnce({ products: products(1), facets: [], total: 1, truncated: false, hiddenByRules: 0 });
    // Scope to the failure notice — the page has other retry affordances.
    const callsBefore = search.mock.calls.length;
    const failureNotice = screen.getByText(/not results for your query/i).closest('div');
    fireEvent.click(within(failureNotice as HTMLElement).getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(search.mock.calls.length).toBe(callsBefore + 1));
    await waitFor(() => expect(screen.getByText(/Product 0/)).toBeTruthy());
    expect(screen.queryByText(/not results for your query/i)).toBeNull();
  });
});
