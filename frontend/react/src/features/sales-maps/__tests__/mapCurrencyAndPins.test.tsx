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
 *
 * Every absence assertion runs after the page has SETTLED: `view()` waits for the svg's
 * "regions shaded" summary, which exists only in the `ok` state — an absence checked
 * against the loading skeleton would pass for the wrong reason (wave 43 lesson).
 * Fixtures are typed against the real `TerritoryAttainment` / `Outlet`, no casts.
 *
 * Sabotage-witnessed (wave 52): resolving the symbol from the quota `currency` instead of
 * `valueCurrency`, ignoring `currencyMixed` / `quotaCurrencyMismatch`, letting a quota-less
 * territory denominate the map, counting no-won territories as unknown, flattening the
 * ramp when the currency is merely UNKNOWN, dropping the mixed note, the unplaced and
 * unplottable disclosures (and their zero-count guards), the alias matcher, and the
 * rolled-up-parent exclusion each turn a case red.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type * as TC from '../../territories/territoriesClient.js';
import type { TerritoryAttainment } from '../../territories/territoriesClient.js';
import type * as DC from '../../dealers/dealersClient.js';
import type { Outlet } from '../../dealers/dealersClient.js';
import type { Org } from '../../crm/crmOrgClient.js';

const m = vi.hoisted(() => ({
  getAttainment: vi.fn<typeof TC.getAttainment>(),
  listAllOutlets: vi.fn<typeof DC.listAllOutlets>(),
}));
const getAttainment = m.getAttainment;
const listAllOutlets = m.listAllOutlets;
const ORGS: Org[] = [{ orgId: 'org-1', name: 'Acme' }];

vi.mock('../../crm/crmOrgClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listOrgs: vi.fn(async () => ORGS),
}));
vi.mock('../../territories/territoriesClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listModels: vi.fn(async (): ReturnType<typeof TC.listModels> => ({ activeModelId: 'm-1', models: [] })),
  getAttainment: (...a: Parameters<typeof TC.getAttainment>) => m.getAttainment(...a),
}));
vi.mock('../../dealers/dealersClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listAllOutlets: (...a: Parameters<typeof DC.listAllOutlets>) => m.listAllOutlets(...a),
}));

import { SalesMapsPage } from '../SalesMapsPage.js';

/** A territory whose quota AND deals are in the same currency — the ordinary case.
 *  `currency` is the QUOTA's; `valueCurrency` is what the plotted `rolled.won` is in,
 *  and it is the one this map must read (TER2 review B1). */
const terr = (name: string, won: number, currency?: string): TerritoryAttainment => ({
  territoryId: `t-${name}`, name, parentTerritoryId: null, quota: 1000,
  ...(currency ? { currency, valueCurrency: currency } : {}),
  direct: { weightedPipeline: 0, won, openCount: 0, wonCount: won > 0 ? 1 : 0 },
  rolled: { weightedPipeline: 0, won },
  attainment: won / 1000, coverage: null, repSplits: [],
});
type Attainment = Awaited<ReturnType<typeof TC.getAttainment>>;
const attainment = (territories: TerritoryAttainment[]): Attainment => ({
  period: null, territories, unassigned: { weightedPipeline: 0, won: 0 },
});

const outlet = (id: string, geo: boolean): Outlet => ({
  outletId: id, dealerId: 'd-1', name: `Outlet ${id}`, status: 'active',
  ...(geo ? { lat: 51.5, lng: -0.12 } : {}),
});

/** The values are only rendered inside the collapsed data table — the reason no
 *  round-1 case could assert a currency symbol at all. */
const openTable = async (): Promise<void> => {
  fireEvent.click(screen.getByRole('button', { name: 'Show data table' }));
  expect(screen.getAllByRole('table').length).toBeGreaterThan(0);
};

/** Render and wait for the SETTLED map: the svg's "regions shaded" summary renders only
 *  in the `ok` state, so every later absence is checked against the real page. */
const view = async (): Promise<HTMLElement> => {
  const { container } = render(<MemoryRouter><SalesMapsPage /></MemoryRouter>);
  await screen.findByRole('img', { name: /regions shaded/i });
  expect(getAttainment).toHaveBeenCalledWith('org-1', 'm-1');
  return container;
};

beforeEach(() => {
  getAttainment.mockReset(); listAllOutlets.mockReset();
  getAttainment.mockResolvedValue(attainment([terr('France', 100, 'EUR')]));
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
    getAttainment.mockResolvedValue(attainment([{ ...terr('France', 100, 'EUR'), currencyMixed: true }]));
    await view();
    expect(await screen.findByText(/more than one currency/i)).toBeTruthy();
    await openTable();
    expect(screen.queryByText(/€/)).toBeNull();
  });

  it('R2 SM2-F2: one quota currency does not denominate quota-less territories', async () => {
    // `TerritoryAttainment.currency` is the QUOTA's currency; a territory with no quota
    // carries none, so a single EUR quota anywhere used to label all 176 countries.
    getAttainment.mockResolvedValue(attainment([terr('France', 100, 'EUR'), terr('Spain', 200)]));
    await view();
    await openTable();
    expect(screen.queryByText(/€/)).toBeNull();
  });

  it('R2 SM2-F5: territories the map cannot place are disclosed', async () => {
    getAttainment.mockResolvedValue(attainment([terr('France', 100, 'EUR'), terr('EMEA', 500, 'EUR')]));
    await view();
    // "EMEA" is not a country: its revenue is absent from the map AND the table, which
    // is exactly the impression SM-G2 exists to prevent, at the sibling call site.
    expect(await screen.findByText(/no matching country on this map/i)).toBeTruthy();
  });

  it('R2 SM2-F5: says nothing when every territory placed (the negative control)', async () => {
    getAttainment.mockResolvedValue(attainment([terr('France', 100, 'EUR')]));
    await view();
    expect(screen.queryByText(/no matching country on this map/i)).toBeNull();
  });

  it('MIXED currencies drop the symbol and say why', async () => {
    getAttainment.mockResolvedValue(attainment([terr('France', 100, 'EUR'), terr('UK', 200, 'GBP')]));
    await view();
    expect(await screen.findByText(/more than one currency/i)).toBeTruthy();
    expect(screen.getByText(/not converted/i)).toBeTruthy();
    await openTable();
    expect(screen.queryByText(/€|£/)).toBeNull();
  });

  it('NO currency anywhere is unlabelled, and says nothing — unchanged behaviour', async () => {
    getAttainment.mockResolvedValue(attainment([terr('France', 100), terr('UK', 200)]));
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
    getAttainment.mockResolvedValue(attainment([
      { ...terr('Japan', 12_000_000), currency: 'USD', valueCurrency: 'JPY', quotaCurrencyMismatch: true },
    ]));
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
    getAttainment.mockResolvedValue(attainment([
      { ...terr('France', 100), valueCurrency: 'EUR' },
      { ...terr('Spain', 900), valueCurrency: 'GBP' },
    ]));
    await view();
    expect(await screen.findByText(/more than one currency/i)).toBeTruthy();
  });

  it('a territory with no WON money cannot make the total ambiguous', async () => {
    // A quota-less or dealless territory carries no `valueCurrency`. Treating that as
    // "we cannot tell" would blank the symbol on almost every real model — the same
    // over-firing the B2 fold-in above had to undo one layer down.
    // Spain: no quota, no deals, so no `valueCurrency` — and nothing plotted.
    getAttainment.mockResolvedValue(attainment([
      terr('France', 100, 'EUR'), { ...terr('Spain', 0), quota: 0, attainment: null, ratioUnavailable: 'no-quota' },
    ]));
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
    getAttainment.mockResolvedValue(attainment([terr('France', 100, 'EUR'), terr('Spain', 900), terr('Brazil', 10)]));
    const container = await view();
    expect(screen.queryByText(/more than one currency/i)).toBeNull();
    // Only the MATCHED regions (data colour): unmatched countries are always 0.6 and a
    // presence map is always 0.45, so a set over every path has two members either way
    // and could never see the ramp flattened. Three matched values (10/100/900) on a
    // ramp give three distinct opacities; presence gives one.
    const opacities = [...container.querySelectorAll('svg[role="img"] path[fill="var(--clay-text)"]')]
      .map((p2) => p2.getAttribute('fill-opacity'));
    expect(opacities).toHaveLength(3);
    expect(new Set(opacities).size).toBe(3);   // the ramp survived
  });

  it('B2: a genuinely mixed model still says so (the negative control)', async () => {
    getAttainment.mockResolvedValue(attainment([terr('France', 100, 'EUR'), terr('UK', 200, 'GBP')]));
    await view();
    expect(await screen.findByText(/more than one currency/i)).toBeTruthy();
  });

  it('B3: a territory named by an ALIAS is placed, not accused of being unplaceable', async () => {
    // The page had its own weaker matcher: canonical names only. "USA" is the example
    // the app's own copy suggests, and it rendered shaded, in the table, and counted as
    // "1 territory has no matching country on this map" — all three at once.
    getAttainment.mockResolvedValue(attainment([terr('USA', 500, 'USD'), terr('France', 100, 'USD')]));
    await view();
    expect(screen.queryByText(/no matching country on this map/i)).toBeNull();
  });

  it('M1: a ROLLED-UP parent is not counted as unplaced either', async () => {
    // A hierarchy root ("EMEA") is never meant to land on a country — its children carry
    // the geography. Counting it made the disclosure fire on healthy models, which is
    // how a real disclosure gets learned as noise.
    const parent: TerritoryAttainment = { ...terr('EMEA', 600, 'EUR'), territoryId: 't-EMEA' };
    const child: TerritoryAttainment = { ...terr('France', 100, 'EUR'), parentTerritoryId: 't-EMEA' };
    getAttainment.mockResolvedValue(attainment([parent, child]));
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
