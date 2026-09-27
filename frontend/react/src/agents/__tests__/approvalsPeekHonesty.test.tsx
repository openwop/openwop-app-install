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
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AgentDrawer } from '../AgentDrawer.js';
import type { AgentView } from '../agentViewModel.js';

// A COMPLETE fixture (the sibling test file's lesson: an incomplete one throws
// inside render and fails every assertion for an unrelated reason).
const view = {
  entry: {
    rosterId: 'r1', persona: 'Ada', label: 'Ada', roleKey: 'engineer',
    autonomyLevel: 'review', agentRef: { agentId: 'a1' },
    workflows: [], tenantId: 't1', enabled: true,
  },
  board: null,
  cards: [],
  laneCounts: { todo: 0, working: 0, waiting: 0, done: 0 },
  status: 'active',
  jobs: [],
  nextSchedule: null,
  failureCheckUnavailable: false,
} as unknown as AgentView;

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
    expect(screen.getByText(/Couldn't check what's waiting on you/i)).toBeTruthy();
  });

  it('CLEAN zero: no failure line — silence stays a truthful "nothing waiting"', () => {
    mount(false);
    expect(screen.queryByText(/Couldn't check what's waiting on you/i)).toBeNull();
  });
});
