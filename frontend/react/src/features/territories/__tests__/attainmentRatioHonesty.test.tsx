/**
 * UX_UPGRADE-territories ROUND 2 — the percentage is the number this screen is for.
 *
 * Round 1 stopped the SUMS wearing a currency they could not justify. It compared
 * the deals against each other and never against the quota, and it left the
 * attainment/coverage percentages computed from the same figures:
 *
 *  - TER2-B1  deals uniformly in one currency against a quota in another were
 *             neither flagged nor unlabelled — `¥` money rendered with `$`, and a
 *             percentage roughly 150× too high rendered as fact.
 *  - TER2-B1  a null ratio rendered as a bare em-dash, which reads as "no deals
 *             yet" — the one thing it never means once a quota exists.
 *  - TER2-B2  a quota summed across periods with different currencies.
 *  - TER2-B3  an amount was saveable with no currency at all.
 *
 * Sabotage-witnessed (w52 /grade-tests, w52g2-rh-*): ignoring the quota mismatch,
 * blanking the mismatch chip, dropping the sr-only reason or collapsing two reasons
 * into one, a wrong percentage, falling back to the quota symbol for an unknown sum
 * currency (and never labelling a known one), dropping the rep splits on save,
 * blanking the mixed-quota chip, and the currency-required guard removed or applied
 * to a zero amount each turn a case red.
 */
import type * as React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import type { TerritoryAttainment } from '../territoriesClient.js';

vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { AttainmentRow } from '../TerritoriesPage.js';

/** `exactOptionalPropertyTypes` makes `Partial<T>` reject an EXPLICIT `undefined`,
 *  and several cases here are precisely "the server did not send this field" — so the
 *  override type has to allow writing it. */
type RowOverride = { [K in keyof TerritoryAttainment]?: TerritoryAttainment[K] | undefined };

const row = (over: RowOverride = {}): TerritoryAttainment => ({
  territoryId: 't1', name: 'West', parentTerritoryId: null, quota: 10000, currency: 'USD',
  direct: { weightedPipeline: 0, won: 0, openCount: 0, wonCount: 0 },
  rolled: { weightedPipeline: 900, won: 5000 },
  attainment: 0.5, coverage: 0.59, repSplits: [],
  ...over,
} as TerritoryAttainment);

const view = (r: TerritoryAttainment, editable = false) =>
  render(<table><tbody><AttainmentRow row={r} editable={editable} onSaveQuota={async () => {}} /></tbody></table>);

const cellWith = (container: HTMLElement, text: string): HTMLElement =>
  Array.from(container.querySelectorAll('td')).find((c) => (c.textContent ?? '').includes(text))!;

afterEach(cleanup);

describe('TER2-B1 — a quota/deal currency mismatch is stated, not averaged over', () => {
  const mismatched = row({
    currency: 'USD', valueCurrency: 'JPY', quotaCurrencyMismatch: true,
    attainment: null, coverage: null, ratioUnavailable: 'quota-currency-mismatch',
  });

  it('the summed money loses the QUOTA symbol it never earned', () => {
    const { container } = view(mismatched);
    const won = cellWith(container, '5,000');
    expect(won.textContent ?? '').not.toMatch(/\$/);
    // …and it does not silently acquire the deals' symbol either: the figure is a
    // sum this row can name the currency OF, but the quota beside it is not, so
    // showing them side by side under different symbols would invite the same
    // comparison the percentage was removed for.
    expect(won.textContent ?? '').not.toMatch(/¥/);
  });

  it('names BOTH currencies — the reader has to know which is which', () => {
    const { container } = view(mismatched);
    // Scoped to the CHIP: an unscoped /JPY.*USD/ was also satisfied by the sr-only
    // ratio reason below, so deleting the chip stayed green (w52 round 1, vacuous).
    expect(container.querySelector('.chip--warning')?.textContent).toBe('JPY vs USD quota');
  });

  it('the absent percentage carries its reason as TEXT, not a hover title', () => {
    const { container } = view(mismatched);
    // Review I4 — this asserted an `aria-label` on an `<abbr>`: hover-only for sighted
    // users, and a name calculation on a role-less element that assistive tech does not
    // reliably announce. The assertion passed against a version nobody could read. The
    // reason is now real text in the DOM, so a screen reader reads it verbatim.
    const why = Array.from(container.querySelectorAll('.sr-only'))
      .filter((el) => /Why there is no percentage for West/i.test(el.textContent ?? ''));
    expect(why.length).toBe(2);                       // attainment AND coverage
    expect(why[0]!.textContent ?? '').toMatch(/JPY/);
    expect(why[0]!.textContent ?? '').toMatch(/USD/);
  });

  it('a matching currency keeps its percentage (the negative control)', () => {
    const { container } = view(row({ valueCurrency: 'USD' }));
    expect(screen.getByText('50%')).toBeTruthy();
    expect(container.querySelector('.sr-only')).toBeNull();
  });

  it('each null reason is DIFFERENT — a helper returning one string is not a reason', () => {
    const seen = new Set<string>();
    for (const reason of ['no-quota', 'mixed-deal-currencies', 'mixed-quota-currencies'] as const) {
      const { container } = view(row({ attainment: null, coverage: null, ratioUnavailable: reason }));
      seen.add(container.querySelector('.sr-only')?.textContent ?? '');
      // A null ratio (no quota / unknown target) is never rendered as a number —
      // not 0%, not 100%, no percentage at all.
      expect(container.textContent ?? '').not.toMatch(/\d%/);
      cleanup();
    }
    expect(seen.size).toBe(3);
  });
});

describe('review fold-ins — defects the independent pass found in the fix', () => {
  it('I1: an UNKNOWN sum currency does not fall back to the quota symbol', () => {
    // `valueCurrency ?? row.currency` looked like harmless back-compat and was the
    // original defect restored for the commonest shape: the backend omits
    // `valueCurrency` precisely to say "the deals do not tell us".
    const { container } = view(row({ currency: 'USD', valueCurrency: undefined }));
    expect(cellWith(container, '5,000').textContent ?? '').not.toMatch(/\$/);
    // …and the QUOTA, which is a single authored amount, keeps its symbol.
    expect(cellWith(container, '10,000').textContent ?? '').toMatch(/\$/);
  });

  it('I1: a known sum currency is still labelled (the negative control)', () => {
    const { container } = view(row({ currency: 'USD', valueCurrency: 'USD' }));
    expect(cellWith(container, '5,000').textContent ?? '').toMatch(/\$/);
  });

  it('I8: saving a quota carries the rep splits back, instead of deleting them', async () => {
    // `setQuota` REBUILDS `repSplits` from its input, so a save that sent none wiped
    // every split — including the `user:[erased]` sentinel the erasure writes, quietly
    // undoing an erasure's accounting.
    const calls: Array<Parameters<React.ComponentProps<typeof AttainmentRow>['onSaveQuota']>> = [];
    render(<table><tbody><AttainmentRow
      row={row({ currency: 'USD', valueCurrency: 'USD', repSplits: [{ subjectId: 'user:a', quota: 4000, won: 0, weightedPipeline: 0 }] })}
      editable
      onSaveQuota={async (...args) => { calls.push(args); }}
    /></tbody></table>);
    fireEvent.change(screen.getByLabelText(/quota period/i), { target: { value: '2026-Q1' } });
    fireEvent.change(screen.getByLabelText(/quota amount/i), { target: { value: '9000' } });
    fireEvent.click(screen.getByRole('button', { name: /set quota/i }));
    await Promise.resolve();
    // The WHOLE save: territory, period, amount, currency — and the splits carried back.
    expect(calls).toEqual([['t1', '2026-Q1', 9000, 'USD', [{ subjectId: 'user:a', amount: 4000 }]]]);
  });
});

describe('TER2-B2 — a quota summed across currencies is not one number', () => {
  // Retitled w52: this case used to claim it "drops the quota symbol", but the
  // unlabelled quota is a FIXTURE fact — the server sends no `currency` for a mixed
  // quota, and no product code reads `quotaCurrencyMixed` to drop a symbol. That
  // half (`not.toMatch(/\$|€|£/)` on the quota cell) could not fail and is removed;
  // what the row itself decides is the chip.
  it('flags a quota summed across currencies with the mixed-quota chip', () => {
    view(row({ currency: undefined, quotaCurrencyMixed: true, attainment: null, coverage: null, ratioUnavailable: 'mixed-quota-currencies' }));
    expect(screen.getByText('mixed quota currencies')).toBeTruthy();
  });
});

describe('TER2-B3 — an amount with no currency cannot be saved', () => {
  it('blocks the save and names the field, before the round trip', () => {
    const { container } = view(row({ currency: undefined }), true);
    const amount = screen.getByLabelText(/quota amount/i);
    fireEvent.change(amount, { target: { value: '5000' } });
    fireEvent.change(screen.getByLabelText(/quota period/i), { target: { value: '2026-Q1' } });
    const save = screen.getByRole('button', { name: /set quota/i }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    const select = container.querySelector('select') as HTMLSelectElement;
    expect(select.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').textContent ?? '').toMatch(/currency/i);
  });

  it('picking a currency unblocks it (the negative control)', () => {
    const { container } = view(row({ currency: undefined }), true);
    fireEvent.change(screen.getByLabelText(/quota amount/i), { target: { value: '5000' } });
    fireEvent.change(screen.getByLabelText(/quota period/i), { target: { value: '2026-Q1' } });
    fireEvent.change(container.querySelector('select')!, { target: { value: 'EUR' } });
    expect((screen.getByRole('button', { name: /set quota/i }) as HTMLButtonElement).disabled).toBe(false);
    expect(within(container.querySelector('select') as HTMLSelectElement).getByText('EUR')).toBeTruthy();
  });

  it('a ZERO amount still saves without one — there is no unit to get wrong', () => {
    const { container } = view(row({ currency: undefined }), true);
    fireEvent.change(screen.getByLabelText(/quota amount/i), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText(/quota period/i), { target: { value: '2026-Q1' } });
    expect((screen.getByRole('button', { name: /set quota/i }) as HTMLButtonElement).disabled).toBe(false);
    expect(container.querySelector('select')!.getAttribute('aria-invalid')).toBeNull();
  });
});
