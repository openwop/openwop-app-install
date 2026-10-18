/**
 * AG-R2-1 (agents round 2) — the drawer's "waiting on you" peek must
 * distinguish "nothing waiting" from "couldn't check".
 *
 * `AgentDashboardPage` flattened a failed `listApprovals` into `[]`
 * (`:147`/`:175` `catch(() => [])`), and the drawer renders approvals with no
 * empty state — so a failed read produced the exact same silence as a clean
 * zero. The peek is the only place a roster tile answers "is this agent
 * waiting on me?"; silence there reads as "no" (the failure-as-EMPTY family;
 * cf. Relevance AI's To-Review queue, where this surface is load-bearing).
 *
 * Two layers, both asserted: the DRAWER renders the line when told the read
 * failed, and the PAGE tells it so when `listApprovals` rejects (the page-level
 * pair drives the first-load read; the `refresh()` copy of the same mapping is
 * its twin and is not separately reachable without a check-now round trip).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { AgentView } from '../agentViewModel.js';

type AccessState = { access: { roles: string[]; scopes: string[]; basis: string }; resolved: boolean };
const { loadAgentViews, listApprovals, getCapabilities, access } = vi.hoisted(() => ({
  loadAgentViews: vi.fn<typeof import('../agentViewModel.js')['loadAgentViews']>(),
  listApprovals: vi.fn<typeof import('../approvalsClient.js')['listApprovals']>(),
  getCapabilities: vi.fn<typeof import('../../client/runsClient.js')['getCapabilities']>(),
  access: { current: null as AccessState | null },
}));
vi.mock('../../client/useEffectiveAccess.js', async (orig) => ({
  ...(await orig<typeof import('../../client/useEffectiveAccess.js')>()),
  useEffectiveAccessState: () => access.current ?? { access: { roles: ['editor'], scopes: ['workspace:read', 'workspace:write'], basis: 'member' }, resolved: true },
}));
vi.mock('../../client/useDemoMode.js', () => ({ useDemoMode: () => false }));
vi.mock('../agentViewModel.js', async (orig) => ({ ...(await orig<typeof import('../agentViewModel.js')>()), loadAgentViews }));
vi.mock('../approvalsClient.js', async (orig) => ({ ...(await orig<typeof import('../approvalsClient.js')>()), listApprovals }));
vi.mock('../../client/runsClient.js', async (orig) => ({ ...(await orig<typeof import('../../client/runsClient.js')>()), getCapabilities }));

import { AgentDrawer } from '../AgentDrawer.js';
import { AgentDashboardPage } from '../AgentDashboardPage.js';

// A COMPLETE, typed fixture (the sibling test file's lesson: an incomplete one
// throws inside render and fails every assertion for an unrelated reason).
const view: AgentView = {
  entry: {
    rosterId: 'r1', persona: 'Ada', label: 'Ada', roleKey: 'engineer',
    autonomyLevel: 'review', agentRef: { agentId: 'a1' },
    workflows: [], tenantId: 't1', enabled: true,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  },
  board: null,
  cards: [],
  laneCounts: { todo: 0, working: 0, waiting: 0, done: 0 },
  status: 'active',
  jobs: [],
  nextSchedule: null,
  failureCheckUnavailable: false,
};

const FAILED_LINE = /Couldn't check what's waiting on you/i;

beforeEach(() => {
  vi.resetAllMocks();
  loadAgentViews.mockResolvedValue([view]);
});
afterEach(cleanup);

function mount(approvalsUnavailable: boolean): void {
  render(
    <MemoryRouter>
      <AgentDrawer
        view={view}
        approvals={[]}
        approvalsUnavailable={approvalsUnavailable}
        tab="overview"
        onTab={vi.fn()}
        onClose={vi.fn()}
        onCheckNow={vi.fn()}
        busy={false}
        onResolved={vi.fn()}
        onChat={vi.fn()}
      />
    </MemoryRouter>,
  );
}

describe('AG-R2-1 — the approvals peek declares a failed read', () => {
  it('FAILED read: the overview says approvals could not be checked', () => {
    mount(true);
    expect(screen.getByText(FAILED_LINE)).toBeTruthy();
  });

  it('CLEAN zero: no failure line — silence stays a truthful "nothing waiting"', () => {
    mount(false);
    expect(screen.queryByText(FAILED_LINE)).toBeNull();
  });
});

describe('AG-R2-1 — the dashboard PAGE does not flatten a failed approvals read', () => {
  const page = (): void => {
    render(<MemoryRouter initialEntries={['/agents?agent=r1']}><AgentDashboardPage /></MemoryRouter>);
  };

  it('page: a rejected listApprovals reaches the drawer as "couldn\'t check"', async () => {
    listApprovals.mockRejectedValue(new Error('listApprovals returned 503'));
    page();
    expect(await screen.findByText(FAILED_LINE)).toBeTruthy();
  });

  it('page: a clean empty listApprovals shows no failure line', async () => {
    listApprovals.mockResolvedValue([]);
    page();
    // Settle on the read itself (the drawer is open by then), then assert absence.
    await vi.waitFor(() => expect(listApprovals).toHaveBeenCalled());
    await act(async () => { await (listApprovals.mock.results[0]!.value as Promise<unknown>); });
    expect(await screen.findByRole('tab', { name: /overview/i })).toBeTruthy();
    expect(screen.queryByText(FAILED_LINE)).toBeNull();
  });
});
