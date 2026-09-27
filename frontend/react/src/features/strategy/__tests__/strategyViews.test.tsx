/**
 * SPU-12 (ADR 0598) — `StrategyViews`'s docblock claimed Card and Row "derive
 * their chips + sub-line from the SAME helpers below … so the grid and list views
 * never diverge". The Row did; the Card re-inlined the whole chip set and
 * rendered `{s.summary ? … : null}` instead of `strategySubLine`.
 *
 * These are the assertions that make the claim checkable instead of decorative.
 * `StrategyViews` was one of six surfaces the whole feature had NO spec for.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { Strategy, StrategyHealthState } from '../strategyClient.js';
import { StrategyCard, StrategyRow } from '../StrategyViews.js';

const S: Strategy = {
  id: 's1', tenantId: 'user:t1', orgId: 'org-1', scope: 'org',
  title: 'Win the mid-market', planningHorizon: 'annual',
  period: { label: '2026' }, status: 'active',
  objectives: [], initiatives: [], links: [],
  createdBy: 'user:t1', createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-07-01T00:00:00.000Z',
};
const health = new Map<string, StrategyHealthState>([['s1', 'at-risk']]);
const cell = (node: JSX.Element): HTMLElement => {
  const { container } = render(<MemoryRouter>{node}</MemoryRouter>);
  return container;
};
afterEach(cleanup);

describe('SPU-12 — the grid and list cells really do share their helpers', () => {
  it('a strategy with NO summary reads the same in both views', () => {
    // The proven divergence: "No summary yet" in list, a blank gap in grid.
    const card = cell(<StrategyCard s={S} health={health} kbEnabled />);
    expect(within(card).getByText('No summary yet')).toBeTruthy();
    cleanup();
    const row = cell(<StrategyRow s={S} health={health} kbEnabled />);
    expect(within(row).getByText('No summary yet')).toBeTruthy();
  });

  it('a strategy WITH a summary shows it in both views (the negative control)', () => {
    const withSummary = { ...S, summary: 'Beat the incumbent on onboarding.' };
    const card = cell(<StrategyCard s={withSummary} health={health} kbEnabled />);
    expect(within(card).getByText('Beat the incumbent on onboarding.')).toBeTruthy();
    cleanup();
    const row = cell(<StrategyRow s={withSummary} health={health} kbEnabled />);
    expect(within(row).getByText('Beat the incumbent on onboarding.')).toBeTruthy();
  });

  it('both views carry the SAME chip set — the drift the docblock claims is impossible', () => {
    const rich = { ...S, confidence: 'high' as const, risk: 'medium' as const };
    const card = cell(<StrategyCard s={rich} health={health} kbEnabled parentTitle="Portfolio 2026" />);
    const cardChips = [...card.querySelectorAll('.chip')].map((n) => n.textContent?.trim()).sort();
    cleanup();
    const row = cell(<StrategyRow s={rich} health={health} kbEnabled parentTitle="Portfolio 2026" />);
    const rowChips = [...row.querySelectorAll('.chip')].map((n) => n.textContent?.trim()).sort();
    expect(cardChips).toEqual(rowChips);
    // Not vacuous: the set is non-trivial and includes the ones the Card used to
    // re-inline (health, status, scope, parent, KB, horizon, confidence, risk, count).
    expect(cardChips.length).toBeGreaterThanOrEqual(9);
  });
});
