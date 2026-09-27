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
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import type { TerritoryAttainment } from '../territoriesClient.js';

vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AttainmentRow } from '../TerritoriesPage.js';

const row = (over: Partial<TerritoryAttainment> = {}): TerritoryAttainment => ({
  territoryId: 't1', name: 'West', parentTerritoryId: null, quota: 10000, currency: 'EUR',
  direct: { weightedPipeline: 0, won: 0, openCount: 0, wonCount: 0 },
  rolled: { weightedPipeline: 900, won: 5000 },
  attainment: 0.5, coverage: 0.59, repSplits: [],
  ...over,
} as TerritoryAttainment);

const view = (r: TerritoryAttainment, editable = false) =>
  render(<table><tbody><AttainmentRow row={r} editable={editable} onSaveQuota={async () => {}} /></tbody></table>);

afterEach(cleanup);

describe('TER-G1: a mixed-currency sum carries no symbol', () => {
  it('a single-currency row keeps its symbol', () => {
    view(row());
    expect(screen.getAllByText(/€/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/mixed currencies/i)).toBeNull();
  });

  it('a MIXED row drops the symbol from the sums and flags it', () => {
    const { container } = view(row({ currencyMixed: true }));
    expect(screen.getByText(/mixed currencies/i)).toBeTruthy();
    const cells = Array.from(container.querySelectorAll('td'));
    // The won cell shows a bare 5,000 — no currency it cannot justify.
    const won = cells.find((c) => (c.textContent ?? '').includes('5,000'))!;
    expect(won.textContent ?? '').not.toMatch(/€/);
  });

  it('the QUOTA keeps its symbol even when the sums are mixed', () => {
    const { container } = view(row({ currencyMixed: true }));
    const cells = Array.from(container.querySelectorAll('td'));
    // A quota is one authored amount in its own currency — it is not a sum, so
    // it is not ambiguous and must not lose its label.
    const quota = cells.find((c) => (c.textContent ?? '').includes('10,000'))!;
    expect(quota.textContent ?? '').toMatch(/€/);
  });
});

describe('TER-G2: the quota editor does not invent a currency', () => {
  it('a territory with NO currency starts with none selected', () => {
    const { container } = view(row({ currency: undefined }), true);
    const select = container.querySelector('select') as HTMLSelectElement;
    // Was pre-filled 'USD' and saved on submit.
    expect(select.value).toBe('');
    expect(within(select).getByText(/no currency/i)).toBeTruthy();
  });

  it("a territory WITH a currency still starts on it", () => {
    const { container } = view(row({ currency: 'GBP' }), true);
    expect((container.querySelector('select') as HTMLSelectElement).value).toBe('GBP');
  });
});
