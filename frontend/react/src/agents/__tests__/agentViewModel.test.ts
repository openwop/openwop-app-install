/**
 * BLD-1 (grade-code gap): the agent view-model derives the dashboard's
 * lane-classification (laneOf), lane counts (buildView), and status badge
 * (deriveStatus) from the underlying roster/board/schedule surfaces. Those
 * three reducers are private, so we drive them through the EXPORTED
 * loadAgentView / loadAgentViews by mocking the client modules — the public
 * surface. The pure helpers (statusMeta, statusRingColor, relativeTime) are
 * tested directly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RosterEntry } from '../rosterClient.js';
import type { KanbanBoard, KanbanCard } from '../../kanban/kanbanClient.js';
import type { ScheduledJob } from '../scheduleClient.js';

// --- Mock the three client modules the view-model composes. ----------------
const m = vi.hoisted(() => ({
  roster: [] as RosterEntry[],
  boards: [] as (KanbanBoard & { cards?: KanbanCard[] })[],
  jobs: [] as ScheduledJob[],
  failures: { items: [] as { rosterId?: string }[], truncated: false },
  oneEntry: null as RosterEntry | null,
  oneBoardCards: [] as KanbanCard[],
}));

vi.mock('../rosterClient.js', () => ({
  listRoster: vi.fn(async () => m.roster),
  getRosterEntry: vi.fn(async (id: string) => {
    if (!m.oneEntry) throw new Error('not found');
    return { ...m.oneEntry, rosterId: id };
  }),
  getFleetActivity: vi.fn(async () => m.failures),
}));
vi.mock('../../kanban/kanbanClient.js', () => ({
  listBoards: vi.fn(async () => m.boards),
  listBoardsWithCards: vi.fn(async () => m.boards),
  getBoard: vi.fn(async (boardId: string) => ({
    board: m.boards.find((b) => b.id === boardId)!,
    cards: m.oneBoardCards,
  })),
}));
vi.mock('../scheduleClient.js', () => ({
  listJobs: vi.fn(async () => m.jobs),
}));

import {
  loadAgentViews,
  loadAgentView,
  statusMeta,
  statusRingColor,
  relativeTime,
} from '../agentViewModel.js';

// --- Builders --------------------------------------------------------------
function entry(over: Partial<RosterEntry> = {}): RosterEntry {
  return {
    rosterId: 'r1', persona: 'Sally', agentRef: { agentId: 'a1' },
    workflows: ['wf1'], tenantId: 't1', enabled: true,
    createdAt: 'now', updatedAt: 'now', ...over,
  };
}
function board(columns: { id: string; name: string }[], over: Partial<KanbanBoard> = {}): KanbanBoard {
  return {
    id: 'b1', tenantId: 't1', name: 'Board', rosterId: 'r1',
    columns: columns.map((c) => ({ ...c })), createdAt: 'now', updatedAt: 'now', ...over,
  };
}
function card(columnId: string): KanbanCard {
  return {
    id: `c-${Math.random()}`, boardId: 'b1', columnId, title: 'T',
    order: 0, createdAt: 'now', updatedAt: 'now',
  };
}
const STD_COLUMNS = [
  { id: 'todo', name: 'To do' },
  { id: 'working', name: 'Working' },
  { id: 'waiting', name: 'Waiting' },
  { id: 'done', name: 'Done' },
];

beforeEach(() => {
  m.roster = [];
  m.boards = [];
  m.jobs = [];
  m.failures = { items: [], truncated: false };
  m.oneEntry = null;
  m.oneBoardCards = [];
});

describe('loadAgentViews — lane counts (laneOf / buildView)', () => {
  it('classifies cards into todo/working/waiting/done by column id', async () => {
    m.roster = [entry()];
    m.boards = [{
      ...board(STD_COLUMNS),
      cards: [card('todo'), card('todo'), card('working'), card('waiting'), card('done')],
    }];
    const [view] = await loadAgentViews();
    expect(view!.laneCounts).toEqual({ todo: 2, working: 1, waiting: 1, done: 0 + 1 });
  });

  it('classifies by case-insensitive display name when id is non-canonical', async () => {
    m.roster = [entry()];
    m.boards = [{
      ...board([
        { id: 'col-1', name: 'Doing' },          // → working (name)
        { id: 'col-2', name: 'Waiting on you' }, // → waiting (startsWith)
        { id: 'col-3', name: 'Backlog' },        // → null (uncounted)
      ]),
      cards: [card('col-1'), card('col-2'), card('col-3')],
    }];
    const [view] = await loadAgentViews();
    expect(view!.laneCounts).toEqual({ todo: 0, working: 1, waiting: 1, done: 0 });
  });
});

describe('loadAgentViews — status derivation (deriveStatus)', () => {
  async function statusFor(over: {
    entry?: Partial<RosterEntry>;
    cards?: KanbanCard[];
    noBoard?: boolean;
    failed?: boolean;
  }): Promise<string> {
    m.roster = [entry(over.entry)];
    m.boards = over.noBoard ? [] : [{ ...board(STD_COLUMNS), cards: over.cards ?? [] }];
    m.failures = over.failed ? { items: [{ rosterId: 'r1' }], truncated: false } : { items: [], truncated: false };
    const [view] = await loadAgentViews();
    return view!.status;
  }

  it('paused when the entry is disabled', async () => {
    expect(await statusFor({ entry: { enabled: false } })).toBe('paused');
  });
  it('needs-setup with no workflows', async () => {
    expect(await statusFor({ entry: { workflows: [] } })).toBe('needs-setup');
  });
  it('needs-setup with no board', async () => {
    expect(await statusFor({ noBoard: true })).toBe('needs-setup');
  });
  it('error (overrides working/waiting) when a recent run failed', async () => {
    expect(await statusFor({ cards: [card('working')], failed: true })).toBe('error');
  });
  it('working when a card sits in the Working lane', async () => {
    expect(await statusFor({ cards: [card('working')] })).toBe('working');
  });
  it('waiting when a card sits in the Waiting lane (and none working)', async () => {
    expect(await statusFor({ cards: [card('waiting')] })).toBe('waiting');
  });
  it('active (Ready) when set up but idle', async () => {
    expect(await statusFor({ cards: [card('done')] })).toBe('active');
  });
});

describe('loadAgentViews — schedules', () => {
  it('attaches only the agent\'s own jobs and picks the first enabled as nextSchedule', async () => {
    m.roster = [entry()];
    m.boards = [{ ...board(STD_COLUMNS), cards: [] }];
    m.jobs = [
      { jobId: 'j-other', tenantId: 't1', cronExpr: '* * * * *', lastFiredTick: null, rosterId: 'other', enabled: true },
      { jobId: 'j-disabled', tenantId: 't1', cronExpr: '* * * * *', lastFiredTick: null, rosterId: 'r1', enabled: false },
      { jobId: 'j-mine', tenantId: 't1', cronExpr: '* * * * *', lastFiredTick: null, rosterId: 'r1', enabled: true },
    ];
    const [view] = await loadAgentViews();
    expect(view!.jobs.map((j) => j.jobId)).toEqual(['j-disabled', 'j-mine']);
    expect(view!.nextSchedule?.jobId).toBe('j-mine');
  });
});

describe('loadAgentView — single agent', () => {
  it('returns null when the roster entry cannot be loaded', async () => {
    m.oneEntry = null;
    expect(await loadAgentView('missing')).toBeNull();
  });

  it('hydrates one agent from getBoard cards', async () => {
    m.oneEntry = entry();
    m.boards = [board(STD_COLUMNS)];
    m.oneBoardCards = [card('working')];
    const view = await loadAgentView('r1');
    expect(view).not.toBeNull();
    expect(view!.laneCounts.working).toBe(1);
    expect(view!.status).toBe('working');
  });
});

describe('exported pure helpers', () => {
  it('statusMeta returns a label/chip/help for every status', () => {
    for (const st of ['active', 'working', 'waiting', 'paused', 'needs-setup', 'error'] as const) {
      const meta = statusMeta(st);
      expect(meta.label).toBeTruthy();
      expect(meta.chip).toMatch(/^chip--/);
      expect(meta.help).toBeTruthy();
    }
  });

  it('statusRingColor maps statuses to CSS token vars', () => {
    expect(statusRingColor('waiting')).toBe('var(--color-warning)');
    expect(statusRingColor('active')).toBe('var(--color-success)');
    expect(statusRingColor('error')).toBe('var(--color-danger)');
    expect(statusRingColor('paused')).toBe('var(--rule)'); // default branch
  });

  it('relativeTime renders compact buckets and falls back gracefully', () => {
    expect(relativeTime(undefined)).toBeNull();
    expect(relativeTime('not-a-date')).toBeNull();
    expect(relativeTime(new Date().toISOString())).toBe('just now');
    expect(relativeTime(new Date(Date.now() - 5 * 60_000).toISOString())).toBe('5m ago');
    expect(relativeTime(new Date(Date.now() - 3 * 3_600_000).toISOString())).toBe('3h ago');
    expect(relativeTime(new Date(Date.now() - 2 * 86_400_000).toISOString())).toBe('2d ago');
    // Past a week → ISO date prefix.
    const old = new Date(Date.now() - 30 * 86_400_000).toISOString();
    expect(relativeTime(old)).toBe(old.slice(0, 10));
  });
});
