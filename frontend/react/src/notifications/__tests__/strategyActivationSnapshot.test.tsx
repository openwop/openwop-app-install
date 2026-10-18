/**
 * ADR 0845 D6 — approve what you see. The strategy-activation card renders the content
 * the approval binds to (every digested field, including a KR's metric source), on
 * BOTH deciding surfaces, and says so honestly for a legacy row with no snapshot.
 *
 * Sabotage-witnessed (grade-tests w19, probes w19g5-sn-*): dropping the metric
 * source, the period, the KR target, the accountable executive, the legacy copy,
 * the fold threshold, or the card from either inbox each turns a case red.
 *
 * The four-locale copy check that used to live here is the build gate's job:
 * `scripts/check-i18n.mjs` (in `npm run build`) fails on a `t()` key missing from
 * `en` (check 1) and on any locale that does not match `en` key-for-key (check 4).
 * "Both deciding surfaces" is RENDERED below, not grepped from source — a comment
 * or a dead branch satisfied the old `toContain('<StrategyActivationSnapshot')`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { PendingApproval, StrategyActivationSnapshot as Snapshot } from '../../agents/approvalsClient.js';

const { listApprovals, listApprovalsByKind } = vi.hoisted(() => ({
  listApprovals: vi.fn<() => Promise<PendingApproval[]>>(),
  listApprovalsByKind: vi.fn<() => Promise<PendingApproval[]>>(),
}));
vi.mock('../../agents/approvalsClient.js', async (orig) => ({
  ...(await orig<typeof import('../../agents/approvalsClient.js')>()),
  listApprovals, listApprovalsByKind,
}));
// NeedsYouInbox resolves agent avatars; ApprovalsInbox resolves deciders. Neither
// is asserted here — mocked so no read leaves jsdom (ADR 0661).
vi.mock('../../agents/agentViewModel.js', async (orig) => ({
  ...(await orig<typeof import('../../agents/agentViewModel.js')>()),
  loadAgentViews: vi.fn(async () => []),
}));
vi.mock('../../orgs/orgMembers.js', () => ({ loadOrgMembers: vi.fn(async () => []), invalidateOrgMembers: vi.fn() }));
vi.mock('../../ui/toast.js', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { StrategyActivationSnapshot } from '../ContentReviewContext.js';
import { ApprovalsInbox } from '../ApprovalsInbox.js';
import { NeedsYouInbox } from '../NeedsYouInbox.js';

const SNAPSHOT: Snapshot = {
  orgId: 'o1', scope: 'org', planningHorizon: 'year', period: { label: 'FY27' }, accountableExecutive: 'Dana',
  objectives: [{ id: 'ob', title: 'Grow ARR', keyResults: [{ id: 'k', title: 'ARR to 10M', target: '10', unit: 'M', measure: { kind: 'currency', source: { kind: 'crm-deal-total', orgId: 'o1' } } }] }],
};

beforeEach(() => {
  listApprovals.mockReset(); listApprovalsByKind.mockReset();
  listApprovalsByKind.mockResolvedValue([]);
});
afterEach(cleanup);

describe('ADR 0845 D6 — the strategy approval card shows what is approved', () => {
  it('renders objectives, key results, target and the metric source, plus a link', () => {
    render(<MemoryRouter><StrategyActivationSnapshot strategyId="s1" snapshot={SNAPSHOT} /></MemoryRouter>);
    expect(screen.getByText('Grow ARR')).toBeTruthy();
    // The TARGET, not the KR title: "ARR to 10M" alone matched the title and let the
    // target suffix vanish unnoticed.
    expect(screen.getByText(/ARR to 10M — target 10 M/)).toBeTruthy();
    expect(screen.getByText(/crm-deal-total/)).toBeTruthy();
    expect(screen.getByText(/FY27/)).toBeTruthy();
    expect(screen.getByText(/Horizon: year/)).toBeTruthy();
    expect(screen.getByText(/Accountable: Dana/)).toBeTruthy();
    expect(screen.getByRole('link').getAttribute('href')).toBe('/strategy/s1');
    expect(screen.queryByRole('region'), 'one named region per card multiplies landmarks').toBeNull();
  });

  it('a legacy row with no snapshot says so instead of an empty list', () => {
    render(<MemoryRouter><StrategyActivationSnapshot strategyId="s1" /></MemoryRouter>);
    expect(screen.getByText(/No content preview for this request/)).toBeTruthy();
    expect(screen.queryByRole('list')).toBeNull();
    expect(screen.getByRole('link')).toBeTruthy();
  });

  it('a long plan folds so the decide bar stays reachable', () => {
    const objectives = Array.from({ length: 12 }, (_, i) => ({ id: `o${i}`, title: `Objective ${i}`, keyResults: [] }));
    const { container } = render(<MemoryRouter><StrategyActivationSnapshot strategyId="s1" snapshot={{ orgId: 'o', scope: 'org', planningHorizon: 'year', accountableExecutive: null, objectives }} /></MemoryRouter>);
    expect(container.querySelector('details')?.hasAttribute('open')).toBe(false);
  });

  for (const [name, Surface] of [['ApprovalsInbox', ApprovalsInbox], ['NeedsYouInbox', NeedsYouInbox]] as const) {
    it(`both deciding surfaces render it: ${name}`, async () => {
      const row: PendingApproval = {
        approvalId: 'sa1', rosterId: '', persona: '', workflowId: '',
        kind: 'strategy-activation', strategyId: 's1', strategyTitle: 'North Star', orgId: 'o1',
        proposal: 'Activate "North Star"?', status: 'pending', createdAt: '2026-08-20T00:00:00Z',
        strategySnapshot: SNAPSHOT,
      };
      listApprovals.mockResolvedValue([row]);
      render(<MemoryRouter><Surface /></MemoryRouter>);
      expect(await screen.findByText('Grow ARR')).toBeTruthy();
      expect(screen.getByText(/ARR to 10M — target 10 M/)).toBeTruthy();
    });
  }
});
