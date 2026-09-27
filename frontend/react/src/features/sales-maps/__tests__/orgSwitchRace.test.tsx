/**
 * R3 F10 — no request-ignore token on either fetch meant org A's slower answer
 * could land under org B's header (attainment and pins alike). The seq guard
 * closes it; this pins the exact interleave.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { TerritoryAttainment } from '../../territories/territoriesClient.js';

const getAttainment = vi.fn();
vi.mock('../../crm/crmOrgClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listOrgs: vi.fn(async () => [{ orgId: 'org-1', name: 'Acme' }, { orgId: 'org-2', name: 'Globex' }]),
}));
vi.mock('../../territories/territoriesClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listModels: vi.fn(async () => ({ activeModelId: 'm-1', models: [] })),
  getAttainment: (...a: unknown[]) => getAttainment(...a),
}));
vi.mock('../../dealers/dealersClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listAllOutlets: vi.fn(async () => []),
}));

import { SalesMapsPage } from '../SalesMapsPage.js';

const terr = (name: string, won: number): TerritoryAttainment => ({
  territoryId: `t-${name}`, name, parentTerritoryId: null, quota: 1000,
  currency: 'EUR', valueCurrency: 'EUR',
  rolled: { won, quota: 1000, attainment: 0.5 },
} as unknown as TerritoryAttainment);

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('R3 F10 — an org switch discards the previous org\'s in-flight answer', () => {
  it('org A\'s slow attainment resolving AFTER the switch never paints under org B', async () => {
    let releaseA!: (v: { territories: TerritoryAttainment[] }) => void;
    getAttainment.mockImplementationOnce(() => new Promise((res) => { releaseA = res; })) // org-1: slow
      .mockResolvedValueOnce({ territories: [terr('Spain', 200)] });                      // org-2: fast
    render(<MemoryRouter><SalesMapsPage /></MemoryRouter>);
    await act(async () => {});
    // Switch to org-2 while org-1's read is still in flight.
    fireEvent.change(screen.getByLabelText(/organization|workspace|org/i), { target: { value: 'org-2' } });
    await act(async () => {});
    // Territory names render inside the collapsed data table — open it.
    const btn = screen.getAllByRole('button').find((b) => /show data table|data table/i.test(b.textContent ?? ''));
    if (btn) await act(async () => { btn.click(); });
    // The data table lists EVERY world region by name; the org's answer is the
    // VALUE — Spain's 200 must render, and after org-1's late answer lands,
    // France's 100 must NOT (the region name row always exists; the value is
    // the tell).
    expect(await screen.findByText(/200/)).toBeTruthy();
    await act(async () => { releaseA({ territories: [terr('France', 100)] }); });
    expect(screen.queryByText(/\b100\b/)).toBeNull();
    expect(screen.getByText(/200/)).toBeTruthy();
  });
});
