/**
 * UX_UPGRADE-strategy ROUND 2 — the reads round 1 did not open.
 *
 * Round 1's scope line is "the strategy detail's Overview and Alignment tabs", and it
 * fixed both reads there. Every OTHER read on the feature kept the identical shape:
 *
 *  - STR2-B1  a failed health read blanks the whole portfolio's health column. The
 *             backend guarantees a verdict for every readable strategy, so a missing
 *             chip cannot arise naturally — an empty map is only ever a failed read,
 *             and it reads as "nothing here is at risk".
 *  - STR2-B2  a failed orgs read says "No organizations available" AND leaves Create
 *             permanently disabled, with no error anywhere on screen.
 *  - STR2-M1  a failed list rendered the error Notice AND an eternal loading card.
 *
 * The repo's own gate cannot catch these: `check-failed-read-sentinels.mjs` deliberately
 * does not count the `try {} catch { setX([]) }` await form (its docblock, note 2).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { currentAnnouncements } from '../../../ui/announce.js';
import type { Strategy } from '../strategyClient.js';

const listStrategies = vi.fn();
const getStrategyHealth = vi.fn();
const listOrgs = vi.fn();

vi.mock('../strategyClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  listStrategies: (...a: unknown[]) => listStrategies(...a),
  getStrategyHealth: () => getStrategyHealth(),
  listOrgs: () => listOrgs(),
}));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { StrategyPage } from '../StrategyPage.js';

const STRATEGY = {
  id: 's1', tenantId: 't', orgId: 'org-1', title: 'Grow revenue', scope: 'org',
  planningHorizon: 'annual', status: 'active', objectives: [], initiatives: [], links: [],
  createdBy: 'u', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
} as unknown as Strategy;

const view = async (): Promise<void> => {
  render(<MemoryRouter><StrategyPage /></MemoryRouter>);
  await act(async () => {});
  await waitFor(() => expect(listStrategies).toHaveBeenCalled());
};

beforeEach(() => {
  for (const m of [listStrategies, getStrategyHealth, listOrgs]) m.mockReset();
  listStrategies.mockResolvedValue([STRATEGY]);
  getStrategyHealth.mockResolvedValue([{ id: 's1', health: 'off-track' }]);
  listOrgs.mockResolvedValue([{ orgId: 'org-1', name: 'Acme' }]);
});
afterEach(cleanup);

describe('STR2-B1 — a blank health column is a claim', () => {
  it('says the rollup could not be loaded, instead of showing a clean portfolio', async () => {
    getStrategyHealth.mockRejectedValue(new Error('health rollup 500'));
    await view();
    // "fail-soft: empty map ⇒ no chip" reads as harmless. It is not: the backend defaults
    // every readable strategy to a verdict, so no-chip cannot happen naturally. The exec
    // scans the column, sees nothing at risk, and closes the tab.
    expect(await screen.findByText(/could not load the health rollup/i)).toBeTruthy();
  });

  it('says nothing when the rollup loads (the negative control)', async () => {
    await view();
    expect(screen.queryByText(/could not load the health rollup/i)).toBeNull();
  });
});

describe('STR2-B2 — "No organizations available" is a claim about the workspace', () => {
  it('says the orgs could not be loaded instead', async () => {
    listOrgs.mockRejectedValue(new Error('orgs 429'));
    await view();
    fireEvent.click(screen.getByRole('button', { name: /new strategy/i }));
    // The bare `catch(() => {})` left `orgs: []`, which renders "No organizations
    // available" and disables Create (`!orgId`) — so the user is told their workspace has
    // no orgs and files a bug against Access Control.
    expect(await screen.findByText(/organizations could not be loaded/i)).toBeTruthy();
    expect(screen.queryByText(/no organizations available/i)).toBeNull();
  });

  it('a genuinely empty org list still says so (the negative control)', async () => {
    listOrgs.mockResolvedValue([]);
    await view();
    fireEvent.click(screen.getByRole('button', { name: /new strategy/i }));
    expect(await screen.findByText(/no organizations available/i)).toBeTruthy();
  });
});

describe('STR2-M1 — a failed list is not an empty portfolio, and not a spinner', () => {
  it('offers a retry instead of an eternal loading card', async () => {
    listStrategies.mockRejectedValue(new Error('list 500'));
    await view();
    expect(await screen.findByText(/could not load your strategies/i)).toBeTruthy();
    // The catch set the error and left `strategies === null`, so the page rendered the
    // error Notice AND `<StateCard loading />` at the same time, forever.
    expect(screen.queryByText(/^loading/i)).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: /retry/i })[0]!);
    await waitFor(() => expect(listStrategies.mock.calls.length).toBeGreaterThan(1));
  });

  /**
   * `SPU-3` (= code `SPC-13`) — `setError(null)` appeared NOWHERE in the feature.
   *
   * The arm above could not see it, and the reason is the mock: `mockRejectedValue`
   * makes the retry fail too, so the SUCCESS-AFTER-FAILURE state — the only state
   * in which the defect renders — was never reached, and the assertion was a call
   * COUNT, which cannot tell a successful retry from a failed one.
   *
   * With `…Once`, the retry succeeds: `listFailed` flips false while `error` still
   * holds 'list 500', so `error && !listFailed` becomes true and the error Notice
   * MOUNTS FOR THE FIRST TIME over a correctly-loaded portfolio — carrying
   * `announce`, i.e. an ASSERTIVE screen-reader interrupt reading a raw server
   * error that is no longer true. The announcement is asserted as a DELTA rather
   * than an absolute, so the module-global announcer cannot make it order-dependent.
   */
  it('a SUCCESSFUL retry clears the failure instead of raising a stale error banner', async () => {
    listStrategies.mockRejectedValueOnce(new Error('list 500'));
    listStrategies.mockResolvedValue([STRATEGY]);
    await view();
    await screen.findByText(/could not load your strategies/i);
    const assertiveBefore = currentAnnouncements().assertive;

    fireEvent.click(screen.getAllByRole('button', { name: /retry/i })[0]!);
    await waitFor(() => expect(listStrategies.mock.calls.length).toBeGreaterThan(1));

    // Positive control: the retry genuinely SUCCEEDED, so an absent banner cannot
    // pass by the page having rendered nothing at all.
    expect(await screen.findByText('Grow revenue')).toBeTruthy();
    expect(screen.queryByText(/could not load your strategies/i)).toBeNull();
    expect(screen.queryByText('list 500')).toBeNull();
    expect(currentAnnouncements().assertive).toBe(assertiveBefore);
  });

  it('an empty portfolio still shows its empty state (the negative control)', async () => {
    listStrategies.mockResolvedValue([]);
    await view();
    expect(screen.queryByText(/could not load your strategies/i)).toBeNull();
  });
});

describe('SPU-8 — the template confirmation is pluralized and names the template', () => {
  const openTemplates = async (): Promise<void> => {
    await view();
    fireEvent.click(screen.getByRole('button', { name: /new strategy/i }));
    await act(async () => {});
  };

  it('a ONE-objective template does not say "1 objectives"', async () => {
    await openTemplates();
    fireEvent.click(screen.getByRole('button', { name: /portfolio bet/i }));
    // `templateApplied` interpolated `{{n}}`, not i18next's magic `count`, so NO
    // plural resolution happened in ANY of the four locales — and this template
    // scaffolds exactly one objective, in the first thing a new user reads.
    expect(await screen.findByText(/pre-filled 1 objective\./i)).toBeTruthy();
    expect(screen.queryByText(/1 objectives/i)).toBeNull();
  });

  it('switching between the two ONE-objective templates changes the text', async () => {
    await openTemplates();
    fireEvent.click(screen.getByRole('button', { name: /portfolio bet/i }));
    expect(await screen.findByText(/applied portfolio bet/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /working backwards/i }));
    // Both scaffold ONE objective, so before this the two messages were
    // BYTE-IDENTICAL: the DOM did not mutate, and a live region only speaks on
    // mutation. Naming the template is what makes the switch audible.
    expect(await screen.findByText(/applied working backwards/i)).toBeTruthy();
    expect(screen.queryByText(/applied portfolio bet/i)).toBeNull();
  });

  it('a MULTI-objective template still reads as a plural', async () => {
    await openTemplates();
    fireEvent.click(screen.getByRole('button', { name: /^okr$/i }));
    expect(await screen.findByText(/pre-filled 2 objectives/i)).toBeTruthy();
  });

  /**
   * ADR 0598 §Correction 11 — the CLEAR arm of the same control.
   *
   * SPU-8 fixed three defects in the APPLIED message and left `applyTemplate`'s
   * blank branch at `setTplAnnounce('')`. So the most destructive choice in the
   * picker — the one that DISCARDS the scaffolded objectives and initiatives —
   * was the only one that said nothing, while the row read as closed.
   */
  it('choosing Blank AFTER a template says what it discarded', async () => {
    await openTemplates();
    fireEvent.click(screen.getByRole('button', { name: /^okr$/i }));
    expect(await screen.findByText(/pre-filled 2 objectives/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^blank$/i }));
    expect(await screen.findByText(/pre-filled objectives and initiatives were removed/i)).toBeTruthy();
    expect(screen.queryByText(/pre-filled 2 objectives/i)).toBeNull();
  });

  it('and does NOT claim the whole form was reset — summary and horizon are kept', async () => {
    // An announcement that OVERSTATES is the same family of defect as one that is
    // absent. `applyTemplate` deliberately leaves `summary`/`horizon` alone so a
    // user who typed over the template's summary does not lose it, and the copy
    // has to match the code.
    await openTemplates();
    fireEvent.click(screen.getByRole('button', { name: /^okr$/i }));
    await screen.findByText(/pre-filled 2 objectives/i);
    fireEvent.click(screen.getByRole('button', { name: /^blank$/i }));
    expect(await screen.findByText(/summary and horizon you already have are kept/i)).toBeTruthy();
  });
});
