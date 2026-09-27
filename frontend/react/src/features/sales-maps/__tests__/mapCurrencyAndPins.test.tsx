/**
 * UX_UPGRADE-sales-maps — SM-G1 / SM-G2.
 *
 *  - SM-G1: the page took the FIRST territory that happened to carry a currency
 *    and labelled EVERY country's money with it. `currency` is per-territory and
 *    optional, so a model spanning EUR and GBP had the whole map stamped with
 *    whichever came first in the array — not a neutral default, an arbitrary
 *    pick from the data.
 *  - SM-G2: outlets without coordinates were dropped silently. On a MAP, an
 *    absent pin reads as "no presence there".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { TerritoryAttainment } from '../../territories/territoriesClient.js';
import type { Outlet } from '../../dealers/dealersClient.js';

const getAttainment = vi.fn();
const listAllOutlets = vi.fn();

vi.mock('../../crm/crmOrgClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listOrgs: vi.fn(async () => [{ orgId: 'org-1', name: 'Acme' }]),
}));
vi.mock('../../territories/territoriesClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listModels: vi.fn(async () => ({ activeModelId: 'm-1', models: [] })),
  getAttainment: () => getAttainment(),
}));
vi.mock('../../dealers/dealersClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listAllOutlets: () => listAllOutlets(),
}));

import { SalesMapsPage } from '../SalesMapsPage.js';

/** A territory whose quota AND deals are in the same currency — the ordinary case.
 *  `currency` is the QUOTA's; `valueCurrency` is what the plotted `rolled.won` is in,
 *  and it is the one this map must read (TER2 review B1). */
const terr = (name: string, won: number, currency?: string): TerritoryAttainment => ({
  territoryId: `t-${name}`, name, parentTerritoryId: null, quota: 1000,
  ...(currency ? { currency, valueCurrency: currency } : {}),
  rolled: { won, quota: 1000, attainment: 0.5 },
} as TerritoryAttainment);

const outlet = (id: string, geo: boolean): Outlet => ({
  outletId: id, orgId: 'org-1', name: `Outlet ${id}`,
  ...(geo ? { lat: 51.5, lng: -0.12 } : {}),
} as Outlet);

/** The values are only rendered inside the collapsed data table — the reason no
 *  round-1 case could assert a currency symbol at all. */
const openTable = async (): Promise<void> => {
  const btn = screen.getAllByRole('button').find((b) => /show data table|data table/i.test(b.textContent ?? ''));
  if (btn) await act(async () => { btn.click(); });
};

const view = async (): Promise<void> => {
  render(<MemoryRouter><SalesMapsPage /></MemoryRouter>);
  await act(async () => {});
  await waitFor(() => expect(getAttainment).toHaveBeenCalled());
};

beforeEach(() => {
  getAttainment.mockReset(); listAllOutlets.mockReset();
  getAttainment.mockResolvedValue({ territories: [terr('France', 100, 'EUR')] });
  listAllOutlets.mockResolvedValue([]);
});
afterEach(cleanup);

describe('SM-G1: the map never stamps an arbitrary currency on every country', () => {
  it('a single currency across territories IS used', async () => {
    await view();
    expect(screen.queryByText(/more than one currency/i)).toBeNull();
    // R2 SM2-F22 — the round-1 set asserted only that the mixed NOTE was ABSENT, so
    // deleting currency labelling entirely left all six cases green. The symbol only
    // renders inside the data table, which is why no round-1 case could see it — open
    // it and assert the thing the tracker named as its anti-regression guarantee.
    await openTable();
    expect(await screen.findByText(/€/)).toBeTruthy();
  });

  it('R2 SM2-F1: a territory whose OWN deals are mixed poisons the label', async () => {
    // `currencyMixed` means the deals behind this total span currencies. The sibling
    // Territories console reads it on the identical row and withholds the symbol; the
    // map — the more authoritative-looking of the two — never read it.
    getAttainment.mockResolvedValue({ territories: [{ ...terr('France', 100, 'EUR'), currencyMixed: true }] });
    await view();
    expect(await screen.findByText(/more than one currency/i)).toBeTruthy();
    await openTable();
    expect(screen.queryByText(/€/)).toBeNull();
  });

  it('R2 SM2-F2: one quota currency does not denominate quota-less territories', async () => {
    // `TerritoryAttainment.currency` is the QUOTA's currency; a territory with no quota
    // carries none, so a single EUR quota anywhere used to label all 176 countries.
    getAttainment.mockResolvedValue({ territories: [terr('France', 100, 'EUR'), terr('Spain', 200)] });
    await view();
    await openTable();
    expect(screen.queryByText(/€/)).toBeNull();
  });

  it('R2 SM2-F5: territories the map cannot place are disclosed', async () => {
    getAttainment.mockResolvedValue({ territories: [terr('France', 100, 'EUR'), terr('EMEA', 500, 'EUR')] });
    await view();
    // "EMEA" is not a country: its revenue is absent from the map AND the table, which
    // is exactly the impression SM-G2 exists to prevent, at the sibling call site.
    expect(await screen.findByText(/no matching country on this map/i)).toBeTruthy();
  });

  it('R2 SM2-F5: says nothing when every territory placed (the negative control)', async () => {
    getAttainment.mockResolvedValue({ territories: [terr('France', 100, 'EUR')] });
    await view();
    expect(screen.queryByText(/no matching country on this map/i)).toBeNull();
  });

  it('MIXED currencies drop the symbol and say why', async () => {
    getAttainment.mockResolvedValue({ territories: [terr('France', 100, 'EUR'), terr('UK', 200, 'GBP')] });
    await view();
    expect(await screen.findByText(/more than one currency/i)).toBeTruthy();
    expect(screen.getByText(/not converted/i)).toBeTruthy();
  });

  it('NO currency anywhere is unlabelled, and says nothing — unchanged behaviour', async () => {
    getAttainment.mockResolvedValue({ territories: [terr('France', 100), terr('UK', 200)] });
    await view();
    expect(screen.queryByText(/more than one currency/i)).toBeNull();
  });
});

describe('TER2 review B1 — the map reads what denominates the number it plots', () => {
  it('a JPY total against a USD quota is not labelled $', async () => {
    // The territories round-2 pass added `valueCurrency`/`quotaCurrencyMismatch` for
    // exactly this row and this page ignored both, so its headline example — ¥12,000,000
    // rendered as $12,000,000 — survived on the more authoritative-looking of the two
    // surfaces. `currency` here is the QUOTA's and denominates nothing on this map.
    getAttainment.mockResolvedValue({
      territories: [{
        ...terr('Japan', 12_000_000), currency: 'USD', valueCurrency: 'JPY', quotaCurrencyMismatch: true,
      } as TerritoryAttainment],
    });
    await view();
    await openTable();
    expect(screen.queryByText(/\$/)).toBeNull();
    expect(await screen.findByText(/more than one currency|not converted/i)).toBeTruthy();
  });

  it('two territories whose DEALS differ are mixed even with no quota currency anywhere', async () => {
    // The discriminating case for reading `valueCurrency` rather than `currency`: with
    // no quota currency on either row there is nothing for the old set to see, and no
    // per-row mismatch flag either — each territory is internally uniform. So the map
    // plotted EUR beside GBP, ranked them by magnitude, and said nothing.
    // (My first version of this fold-in had a test that stayed GREEN when the field was
    // reverted, because its row also carried `quotaCurrencyMismatch`. A green sabotage
    // probe is a finding: the assertion could not see the change it was written for.)
    getAttainment.mockResolvedValue({
      territories: [
        { ...terr('France', 100), valueCurrency: 'EUR' } as TerritoryAttainment,
        { ...terr('Spain', 900), valueCurrency: 'GBP' } as TerritoryAttainment,
      ],
    });
    await view();
    expect(await screen.findByText(/more than one currency/i)).toBeTruthy();
  });

  it('a territory with no WON money cannot make the total ambiguous', async () => {
    // A quota-less or dealless territory carries no `valueCurrency`. Treating that as
    // "we cannot tell" would blank the symbol on almost every real model — the same
    // over-firing the B2 fold-in above had to undo one layer down.
    getAttainment.mockResolvedValue({
      territories: [terr('France', 100, 'EUR'), { ...terr('Spain', 0), rolled: { won: 0, quota: 0, attainment: null } } as TerritoryAttainment],
    });
    await view();
    await openTable();
    expect((await screen.findAllByText(/€/)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/more than one currency/i)).toBeNull();
  });
});

describe('R2 review fold-in — defects the independent pass found in the fix', () => {
  it('B2: a territory with no QUOTA is not evidence of a second currency', async () => {
    // `quotaless` fired on the DEFAULT shape of a real model — hierarchy roots carry no
    // quota, and the Territories form ships a blank "no currency" option — so an
    // ordinary single-currency model was told "more than one currency … not converted"
    // AND lost its magnitude ramp: every country rendered at the same flat opacity.
    // Withholding the symbol (SM2-F2, above) is right; claiming a second currency and
    // flattening the shading is not.
    getAttainment.mockResolvedValue({
      territories: [terr('France', 100, 'EUR'), terr('Spain', 900), terr('Brazil', 10)],
    });
    const { container } = render(<MemoryRouter><SalesMapsPage /></MemoryRouter>);
    await act(async () => {});
    await waitFor(() => expect(getAttainment).toHaveBeenCalled());
    expect(screen.queryByText(/more than one currency/i)).toBeNull();
    const opacities = [...container.querySelectorAll('svg[role="img"] path')]
      .map((p2) => p2.getAttribute('fill-opacity'))
      .filter((v): v is string => v !== null);
    expect(new Set(opacities).size).toBeGreaterThan(1);   // the ramp survived
  });

  it('B2: a genuinely mixed model still says so (the negative control)', async () => {
    getAttainment.mockResolvedValue({ territories: [terr('France', 100, 'EUR'), terr('UK', 200, 'GBP')] });
    await view();
    expect(await screen.findByText(/more than one currency/i)).toBeTruthy();
  });

  it('B3: a territory named by an ALIAS is placed, not accused of being unplaceable', async () => {
    // The page had its own weaker matcher: canonical names only. "USA" is the example
    // the app's own copy suggests, and it rendered shaded, in the table, and counted as
    // "1 territory has no matching country on this map" — all three at once.
    getAttainment.mockResolvedValue({ territories: [terr('USA', 500, 'USD'), terr('France', 100, 'USD')] });
    await view();
    expect(screen.queryByText(/no matching country on this map/i)).toBeNull();
  });

  it('M1: a ROLLED-UP parent is not counted as unplaced either', async () => {
    // A hierarchy root ("EMEA") is never meant to land on a country — its children carry
    // the geography. Counting it made the disclosure fire on healthy models, which is
    // how a real disclosure gets learned as noise.
    const parent = { ...terr('EMEA', 600, 'EUR'), territoryId: 't-EMEA' } as TerritoryAttainment;
    const child = { ...terr('France', 100, 'EUR'), parentTerritoryId: 't-EMEA' } as TerritoryAttainment;
    getAttainment.mockResolvedValue({ territories: [parent, child] });
    await view();
    expect(screen.queryByText(/no matching country on this map/i)).toBeNull();
  });
});

describe('SM-G2: outlets missing coordinates are disclosed', () => {
  it('says how many outlets are not on the map', async () => {
    listAllOutlets.mockResolvedValue([outlet('a', true), outlet('b', false), outlet('c', false)]);
    await view();
    expect(await screen.findByText(/2 more outlet\(s\) have no coordinates/i)).toBeTruthy();
  });

  it('says NOTHING when every outlet is plotted', async () => {
    listAllOutlets.mockResolvedValue([outlet('a', true), outlet('b', true)]);
    await view();
    expect(screen.queryByText(/no coordinates/i)).toBeNull();
  });

  it('says nothing when there are no outlets at all', async () => {
    await view();
    expect(screen.queryByText(/no coordinates/i)).toBeNull();
  });
});
