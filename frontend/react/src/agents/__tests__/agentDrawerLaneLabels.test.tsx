/**
 * #5912 — the drawer's lane labels are translated copy, not raw keys.
 *
 * The labels were looked up from a variable (`t(laneKey)`), so the catalog
 * checks never saw the four keys, they were never added, and the drawer showed
 * `drawerLaneTodo` and its siblings verbatim. Breaks if a lane label stops
 * resolving through the agents catalog. (Locale parity is `check-i18n`'s job.)
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { AgentView } from '../agentViewModel.js';

vi.mock('../../client/useDemoMode.js', () => ({ useDemoMode: () => false }));
import { AgentDrawer } from '../AgentDrawer.js';

afterEach(cleanup);

const view: AgentView = {
  entry: {
    rosterId: 'r1', persona: 'Ada', label: 'Ada', roleKey: 'engineer',
    autonomyLevel: 'review', agentRef: { agentId: 'a1' },
    workflows: [], tenantId: 't1', enabled: true,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  },
  board: null,
  cards: [],
  laneCounts: { todo: 2, working: 1, waiting: 0, done: 3 },
  status: 'active',
  jobs: [],
  nextSchedule: null,
  failureCheckUnavailable: false,
};

const LANE_KEYS = ['drawerLaneTodo', 'drawerLaneWorking', 'drawerLaneWaiting', 'drawerLaneDone'] as const;

describe('#5912 — agent drawer lane labels', () => {
  it('renders translated labels, never the raw keys', () => {
    render(
      <MemoryRouter>
        <AgentDrawer view={view} approvals={[]} tab="overview" onTab={vi.fn()} onClose={vi.fn()} onCheckNow={vi.fn()} busy={false} onResolved={vi.fn()} onChat={vi.fn()} />
      </MemoryRouter>,
    );
    for (const label of ['To Do', 'Working', 'Waiting', 'Done']) expect(screen.getByText(label)).toBeTruthy();
    for (const key of LANE_KEYS) expect(screen.queryByText(new RegExp(key, 'i'))).toBeNull();
  });
});
