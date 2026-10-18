/**
 * R3 F10 — no request-ignore token on either fetch meant org A's slower answer
 * could land under org B's header (attainment and pins alike). The seq guard
 * closes it; this pins the exact interleave for EACH stage that awaits:
 *   1. the models read   (`listModels(...).then` → `if (seq !== seqRef.current) return;`)
 *   2. the attainment read (after `await getAttainment(...)`, the same check)
 *   3. the outlet pins    (`listAllOutlets(...).then` → `if (seq === seqRef.current)`)
 * Each case holds ONE of org A's reads open across the switch, lets org B settle,
 * then releases org A's answer. Every mock is routed by its `orgId` argument, so the
 * interleave cannot depend on call order.
 *
 * Sabotage-witnessed (wave 52): deleting the models-stage check, deleting the
 * attainment-stage check, never bumping the token (`++seqRef.current`), and deleting
 * the pins-stage check each turn exactly one case red (the token reds all three).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type * as TC from '../../territories/territoriesClient.js';
import type * as DC from '../../dealers/dealersClient.js';
import type { Org } from '../../crm/crmOrgClient.js';

const m = vi.hoisted(() => ({
  listModels: vi.fn<typeof TC.listModels>(),
  getAttainment: vi.fn<typeof TC.getAttainment>(),
  listAllOutlets: vi.fn<typeof DC.listAllOutlets>(),
}));
const ORGS: Org[] = [{ orgId: 'org-1', name: 'Acme' }, { orgId: 'org-2', name: 'Globex' }];
vi.mock('../../crm/crmOrgClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listOrgs: vi.fn(async () => ORGS),
}));
vi.mock('../../territories/territoriesClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listModels: (...a: Parameters<typeof TC.listModels>) => m.listModels(...a),
  getAttainment: (...a: Parameters<typeof TC.getAttainment>) => m.getAttainment(...a),
}));
vi.mock('../../dealers/dealersClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listAllOutlets: (...a: Parameters<typeof DC.listAllOutlets>) => m.listAllOutlets(...a),
}));

import { SalesMapsPage } from '../SalesMapsPage.js';

type Attainment = Awaited<ReturnType<typeof TC.getAttainment>>;
type Models = Awaited<ReturnType<typeof TC.listModels>>;

const terr = (name: string, won: number): TC.TerritoryAttainment => ({
  territoryId: `t-${name}`, name, parentTerritoryId: null, quota: 1000,
  currency: 'EUR', valueCurrency: 'EUR',
  direct: { weightedPipeline: 0, won, openCount: 0, wonCount: 1 },
  rolled: { weightedPipeline: 0, won },
  attainment: won / 1000, coverage: null, repSplits: [],
});
const attainment = (territories: TC.TerritoryAttainment[]): Attainment => ({
  period: null, territories, unassigned: { weightedPipeline: 0, won: 0 },
});
const MODELS: Models = { activeModelId: 'm-1', models: [] };
const GLOBEX = attainment([terr('Spain', 200)]);

/** A promise the case resolves by hand, after the org switch. */
function deferred<T>(): { promise: Promise<T>; release: (v: T) => void } {
  let release!: (v: T) => void;
  const promise = new Promise<T>((res) => { release = res; });
  return { promise, release };
}

/** Mount on org-1, switch to org-2 while org-1's held read is in flight, and wait
 *  until org-2's map has settled (the svg summary exists only in the `ok` state). */
async function mountAndSwitch(): Promise<void> {
  render(<MemoryRouter><SalesMapsPage /></MemoryRouter>);
  await act(async () => {});
  fireEvent.change(screen.getByLabelText('Organization'), { target: { value: 'org-2' } });
  await screen.findByRole('img', { name: /regions shaded/i });
  fireEvent.click(screen.getByRole('button', { name: 'Show data table' }));
  // Spain's 200 is org-2's answer — the data table lists every region by name, so
  // the VALUE is the tell.
  expect(screen.getByText(/\b200\b/)).toBeTruthy();
}

beforeEach(() => {
  m.listModels.mockReset(); m.getAttainment.mockReset(); m.listAllOutlets.mockReset();
  m.listModels.mockResolvedValue(MODELS);
  m.getAttainment.mockImplementation(async (orgId) => (orgId === 'org-2' ? GLOBEX : attainment([terr('France', 100)])));
  m.listAllOutlets.mockResolvedValue([]);
});
afterEach(cleanup);

describe('R3 F10 — an org switch discards the previous org\'s in-flight answer', () => {
  it('org A\'s slow attainment resolving AFTER the switch never paints under org B', async () => {
    const slowA = deferred<Attainment>();
    m.getAttainment.mockImplementation((orgId) => (orgId === 'org-1' ? slowA.promise : Promise.resolve(GLOBEX)));
    await mountAndSwitch();
    expect(m.getAttainment).toHaveBeenCalledWith('org-1', 'm-1');
    expect(m.getAttainment).toHaveBeenCalledWith('org-2', 'm-1');
    await act(async () => { slowA.release(attainment([terr('France', 100)])); });
    expect(screen.queryByText(/\b100\b/)).toBeNull();
    expect(screen.getByText(/\b200\b/)).toBeTruthy();
  });

  it('org A\'s slow MODELS read resolving after the switch never repaints org B as "no model"', async () => {
    // Org A has no active model; org B does. Without the models-stage check org A's
    // late `{ activeModelId: null }` replaces org B's map with org A's empty state —
    // the attainment-stage check never runs on that branch, so it cannot cover it.
    const slowModelsA = deferred<Models>();
    m.listModels.mockImplementation((orgId) => (orgId === 'org-1' ? slowModelsA.promise : Promise.resolve(MODELS)));
    await mountAndSwitch();
    await act(async () => { slowModelsA.release({ activeModelId: null, models: [] }); });
    expect(screen.queryByText('No active territory model')).toBeNull();
    expect(screen.getByRole('img', { name: /regions shaded/i })).toBeTruthy();
    expect(screen.getByText(/\b200\b/)).toBeTruthy();
    expect(m.getAttainment).not.toHaveBeenCalledWith('org-1', 'm-1');
  });

  it('org A\'s slow OUTLETS resolving after the switch never pin under org B', async () => {
    const slowPinsA = deferred<DC.Outlet[]>();
    m.listAllOutlets.mockImplementation((orgId) => (orgId === 'org-1' ? slowPinsA.promise : Promise.resolve([])));
    await mountAndSwitch();
    expect(m.listAllOutlets).toHaveBeenCalledWith('org-1');
    expect(m.listAllOutlets).toHaveBeenCalledWith('org-2');
    await act(async () => {
      slowPinsA.release([{ outletId: 'o-acme', dealerId: 'd-acme', name: 'Acme Depot', lat: 48.85, lng: 2.35, status: 'active' }]);
    });
    expect(screen.getByRole('img', { name: /regions shaded/i }).querySelectorAll('circle')).toHaveLength(0);
    expect(screen.queryByText('Acme Depot')).toBeNull();
    expect(screen.queryByText(/located outlets? plotted/)).toBeNull();
    expect(screen.getByRole('heading', { name: 'Territory attainment' })).toBeTruthy();
  });
});
