/**
 * UX_UPGRADE-territories — TER-G1 / TER-G2.
 *
 *  - TER-G1: the attainment sums add raw deal amounts across whatever currencies
 *    the deals carry, and the row then labelled that sum with the QUOTA's
 *    symbol — asserting "€1,234,000 won" for a figure that is EUR+GBP added
 *    together. The quota itself is a single authored amount, so it keeps its
 *    symbol; the SUMS lose theirs when the contributing deals disagree.
 *  - TER-G2: the quota editor's currency select defaulted to 'USD' and SAVED it,
 *    so setting a quota on a territory with no currency silently stamped one
 *    onto the data.
 *
 * The fixture carries `valueCurrency: 'EUR'` (the deals agree with the EUR quota):
 * since TER2-B1/I1 a sum is labelled only when the server names the deals'
 * currency, so without it the sums were unlabelled whatever `currencyMixed` said,
 * and both TER-G1 symbol claims were probe-vacuous (w52 round 1). With it, the
 * ONLY thing that removes `€` from the sums in the mixed case is `currencyMixed`.
 *
 * Sabotage-witnessed (w52 /grade-tests, w52g2-ac-*): ignoring `currencyMixed`, never
 * labelling the sums, dropping the mixed chip, unlabelling the quota, defaulting the
 * editor to 'USD', ignoring the territory's currency, and blanking the "no currency"
 * option each turn a case red.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import type { TerritoryAttainment } from '../territoriesClient.js';

vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AttainmentRow } from '../TerritoriesPage.js';

const row = (over: Partial<TerritoryAttainment> = {}): TerritoryAttainment => ({
  territoryId: 't1', name: 'West', parentTerritoryId: null, quota: 10000, currency: 'EUR', valueCurrency: 'EUR',
  direct: { weightedPipeline: 0, won: 0, openCount: 0, wonCount: 0 },
  rolled: { weightedPipeline: 900, won: 5000 },
  attainment: 0.5, coverage: 0.59, repSplits: [],
  ...over,
});

const view = (r: TerritoryAttainment, editable = false) =>
  render(<table><tbody><AttainmentRow row={r} editable={editable} onSaveQuota={async () => {}} /></tbody></table>);

const cellWith = (container: HTMLElement, text: string): HTMLElement => {
  const cell = Array.from(container.querySelectorAll('td')).find((c) => (c.textContent ?? '').includes(text));
  if (!cell) throw new Error(`no cell containing ${text}`);
  return cell;
};

afterEach(cleanup);

describe('TER-G1: a mixed-currency sum carries no symbol', () => {
  it('a single-currency row keeps its symbol', () => {
    const { container } = view(row());
    // The SUMS (not just the quota) carry the agreed currency.
    expect(cellWith(container, '5,000').textContent ?? '').toMatch(/€/);
    expect(cellWith(container, '900').textContent ?? '').toMatch(/€/);
    expect(cellWith(container, '10,000').textContent ?? '').toMatch(/€/);
    expect(screen.queryByText(/mixed currencies/i)).toBeNull();
  });

  it('a MIXED row drops the symbol from the sums and flags it', () => {
    const { container } = view(row({ currencyMixed: true }));
    expect(screen.getByText(/mixed currencies/i)).toBeTruthy();
    // The won and pipeline cells show bare figures — no currency they cannot justify.
    expect(cellWith(container, '5,000').textContent ?? '').not.toMatch(/€/);
    expect(cellWith(container, '900').textContent ?? '').not.toMatch(/€/);
  });

  it('the QUOTA keeps its symbol even when the sums are mixed', () => {
    const { container } = view(row({ currencyMixed: true }));
    // A quota is one authored amount in its own currency — it is not a sum, so
    // it is not ambiguous and must not lose its label.
    expect(cellWith(container, '10,000').textContent ?? '').toMatch(/€/);
  });
});

describe('TER-G2: the quota editor does not invent a currency', () => {
  it('a territory with NO currency starts with none selected', () => {
    // No `currency` key at all — what the server sends for a territory without one.
    const { currency: _quotaCurrency, ...noCurrency } = row();
    const { container } = view(noCurrency, true);
    const select = container.querySelector('select');
    if (!select) throw new Error('no currency select');
    // Was pre-filled 'USD' and saved on submit.
    expect(select.value).toBe('');
    expect(within(select).getByText(/no currency/i)).toBeTruthy();
  });

  it("a territory WITH a currency still starts on it", () => {
    const { container } = view(row({ currency: 'GBP' }), true);
    expect(container.querySelector('select')?.value).toBe('GBP');
  });
});
