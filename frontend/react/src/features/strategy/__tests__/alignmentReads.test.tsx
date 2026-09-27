/**
 * UX_UPGRADE-strategy — STR-G1 / STR-G2.
 *
 * Both reads used `catch(() => {})` — the most invisible form of swallowing:
 * state stays `[]`, and DOWNSTREAM that emptiness becomes a positive claim.
 *  - STR-G1: an empty `projects` makes the align select say "no more projects",
 *    i.e. "every project is already linked", and strips already-linked projects
 *    back to their raw ids.
 *  - STR-G2: an empty `allStrategies` makes the parent picker offer nothing,
 *    reading as "there are no eligible parents".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { Strategy, ProjectRef } from '../strategyClient.js';

const getStrategy = vi.fn();
const listStrategies = vi.fn();
const listProjects = vi.fn();

vi.mock('../strategyClient.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  getStrategy: () => getStrategy(),
  listStrategies: (...a: unknown[]) => listStrategies(...a),
  listProjects: () => listProjects(),
  getStrategyDetailContext: vi.fn(async () => null),
  replaceLinks: vi.fn(async () => ({})),
}));
vi.mock('../../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { StrategyDetailPage } from '../StrategyDetailPage.js';

/**
 * SPU-14 — this was `as Strategy` over EIGHT missing required fields, in the file
 * that says twelve lines below "a fixture that does not typecheck is not evidence
 * about the real shape". The lesson had been applied to the secondary `PARENT`
 * fixture and not to the primary strategy actually under test.
 *
 * It is not cosmetic. With `scope`/`planningHorizon` undefined the page renders
 * `t('scope_undefined')` and `t('horizon_undefined')` — the raw KEY STRINGS as
 * visible chip text — and `structuredClone(strategy.objectives)` throws on
 * `undefined`, which is very likely why no spec here ever opened the Objectives
 * tab through this fixture. A cast defeats the type checker regardless, and the
 * build's `tsc` EXCLUDES test files, so nothing could have flagged it.
 */
const STRATEGY: Strategy = {
  id: 's1', tenantId: 'user:t1', orgId: 'org-1', scope: 'org',
  title: 'Win the mid-market', planningHorizon: 'annual',
  period: { label: '2026' }, status: 'active',
  objectives: [], initiatives: [],
  links: [{ kind: 'project', projectId: 'p-known' }],
  createdBy: 'user:t1', createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
};

// SPU-14 — the removed cast exposed a genuinely missing `orgId`. That is the row
// working: a cast is not a fixture, it is a way of not having one.
const PROJECT: ProjectRef = { id: 'p-known', name: 'Atlas', orgId: 'org-1', status: 'active' };

/**
 * An ELIGIBLE parent (`OverviewEditor`'s filter: a different id, the same org,
 * and no parent of its own). It exists so the STR-G2 healthy arm has a
 * post-settle anchor — an option that can only be in the DOM once
 * `listStrategies` has RESOLVED into the parent picker.
 */
// Complete fixture, no cast. `as Strategy` was suppressing SEVEN missing required
// fields — a fixture that does not typecheck is not evidence about the real shape.
const PARENT: Strategy = {
  id: 's2', tenantId: 'user:t1', orgId: 'org-1', scope: 'org',
  title: 'Portfolio 2026', planningHorizon: 'annual',
  period: { label: '2026' }, status: 'active',
  objectives: [], initiatives: [], links: [],
  createdBy: 'user:t1', createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
};

const view = async (tab: string): Promise<void> => {
  render(
    <MemoryRouter initialEntries={[`/strategy/s1?tab=${tab}`]}>
      <Routes><Route path="/strategy/:strategyId" element={<StrategyDetailPage />} /></Routes>
    </MemoryRouter>,
  );
  await act(async () => {});
  await waitFor(() => expect(getStrategy).toHaveBeenCalled());
};

beforeEach(() => {
  getStrategy.mockReset(); listStrategies.mockReset(); listProjects.mockReset();
  getStrategy.mockResolvedValue(STRATEGY);
  listStrategies.mockResolvedValue([]);
  listProjects.mockResolvedValue([PROJECT]);
});
afterEach(cleanup);

describe('STR-G1: a failed projects read does not claim every project is linked', () => {
  it('says projects are unavailable instead of "no more projects"', async () => {
    listProjects.mockRejectedValue(new Error('projects down'));
    await view('alignment');
    expect(await screen.findByText(/projects unavailable/i)).toBeTruthy();
    expect(screen.queryByText(/no more projects/i)).toBeNull();
  });

  it('warns that linked projects may show an id instead of a name', async () => {
    listProjects.mockRejectedValue(new Error('projects down'));
    await view('alignment');
    // The consequence the reader will actually SEE is the id in the link row.
    expect(await screen.findByText(/may show their id instead of their name/i)).toBeTruthy();
    expect(screen.getByText('p-known')).toBeTruthy();
  });

  it('a genuinely exhausted project list still says "no more projects"', async () => {
    // The one project is already linked, so there is genuinely nothing to add.
    await view('alignment');
    expect(await screen.findByText(/no more projects/i)).toBeTruthy();
    expect(screen.queryByText(/could not be loaded/i)).toBeNull();
  });

  it('a healthy read resolves the linked project NAME', async () => {
    listProjects.mockResolvedValue([PROJECT]);
    await view('alignment');
    expect(await screen.findByText('Atlas')).toBeTruthy();
  });
});

describe('STR-G2: a failed strategies read does not claim there are no parents', () => {
  it('says the list could not be loaded', async () => {
    listStrategies.mockRejectedValue(new Error('strategies down'));
    await view('overview');
    expect(await screen.findByText(/strategies could not be loaded/i)).toBeTruthy();
  });

  it('a healthy read keeps the normal help text', async () => {
    // This arm used to be a lone ABSENCE assertion, and `view()` settles only on
    // `getStrategy` having been CALLED — so it would have passed against a tree
    // in which the parent field never rendered at all, or in which
    // `listStrategies` had not yet settled (the failure copy is absent in both
    // of those states too). Two fixes:
    //  1. a POST-SETTLE ANCHOR — the eligible-parent OPTION, which cannot be in
    //     the DOM until `listStrategies` RESOLVED and fed the picker;
    //  2. the POSITIVE claim the row actually makes — the normal help text is
    //     the copy on screen, not merely "the failure copy is missing".
    listStrategies.mockResolvedValue([STRATEGY, PARENT]);
    await view('overview');
    expect(await screen.findByRole('option', { name: 'Portfolio 2026' })).toBeTruthy();
    expect(screen.getByText(/one-level grouping lens/i)).toBeTruthy();
    expect(screen.queryByText(/strategies could not be loaded/i)).toBeNull();
  });
});
