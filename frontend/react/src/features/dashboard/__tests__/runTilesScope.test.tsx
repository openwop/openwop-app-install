/**
 * Issue 4511 — the home's run tiles show a MEMBER only what is theirs.
 *
 *  - Run health / Run activity read the workspace's runs, so they are admin-tier
 *    like the /runs pages.
 *  - Needs you: a member reads their OWN runs (the server-filtered `my-runs`
 *    read), never the workspace list; an admin keeps the workspace view.
 *  - Needs you never links a member into the admin-tier Access page, and does
 *    not list a workspace connection they cannot fix.
 *  - Get started ticks "Run a workflow" from the viewer's own runs.
 *  - Coming back to the home re-reads the activity reads (no 30 s stale tick).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import type { RunListItem } from '../../../client/runsClient.js';

const access = vi.hoisted(() => ({ admin: false }));
const listMyRuns = vi.fn();
const listOwnRuns = vi.fn();
const listConnections = vi.fn();

vi.mock('../../../client/useEffectiveAccess.js', () => ({
  useEffectiveAccessState: () => ({ access: { admin: access.admin }, resolved: true }),
  isAdminCaller: (a: { admin?: boolean }) => a.admin === true,
}));
vi.mock('../../../client/runsClient.js', () => ({ listMyRuns: (...a: unknown[]) => listMyRuns(...a) }));
vi.mock('../dashboardClient.js', () => ({ listOwnRuns: (...a: unknown[]) => listOwnRuns(...a) }));
vi.mock('../../connections/connectionsClient.js', () => ({ listConnections: () => listConnections() }));
vi.mock('../../../agents/approvalsClient.js', () => ({ listApprovals: async () => [] }));
vi.mock('../../../client/chatSessionsClient.js', () => ({ listChatSessions: async () => [] }));
vi.mock('../../../byok/lib/byokClient.js', () => ({ listStoredRefs: async () => [] }));
vi.mock('../../../auth/useAuth.js', () => ({ useAuth: () => ({ user: { uid: 'u1' }, loading: false }) }));

const { default: NeedsYouTile, needsYouItems } = await import('../tiles/NeedsYouTile.js');
const { default: GetStartedTile } = await import('../tiles/GetStartedTile.js');
const { default: ActiveRunsTile } = await import('../tiles/ActiveRunsTile.js');
const { ALL_DASHBOARD_TILES } = await import('../allTiles.js');
const { resolveTiles } = await import('../resolveTiles.js');
const { readMyRuns } = await import('../runsWindow.js');
const { invalidateHomeActivity, __resetSharedReads } = await import('../sharedRead.js');

const recent = (min: number): string => new Date(Date.now() - min * 60_000).toISOString();
const run = (runId: string, workflowId: string, status: string): RunListItem =>
  ({ runId, workflowId, status, startedAt: recent(30), completedAt: recent(20) });

// The workspace list holds a colleague's failure; the caller's own list holds theirs.
const COLLEAGUE_FAILED = run('r-other', 'colleague-workflow', 'failed');
const MY_FAILED = run('r-mine', 'my-workflow', 'failed');

beforeEach(() => {
  __resetSharedReads();
  listMyRuns.mockResolvedValue([COLLEAGUE_FAILED, MY_FAILED]);
  listOwnRuns.mockResolvedValue({ runs: [MY_FAILED], truncated: false });
  listConnections.mockResolvedValue([]);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); access.admin = false; });

describe('tier gating', () => {
  const visible = (isAdmin: boolean): string[] =>
    resolveTiles({ registry: ALL_DASHBOARD_TILES, saved: null, toggleEnabled: () => true, isAdmin }).map((r) => r.def.id);

  it('hides run-health and run-activity from a member, even from a saved layout', () => {
    expect(visible(false)).not.toContain('run-health');
    expect(visible(false)).not.toContain('run-activity');
    const saved = [{ id: 'run-health', order: 0, size: 'full' as const, enabled: true }, { id: 'run-activity', order: 1, size: 'half' as const, enabled: true }];
    const ids = resolveTiles({ registry: ALL_DASHBOARD_TILES, saved, toggleEnabled: () => true, isAdmin: false }).map((r) => r.def.id);
    expect(ids).not.toContain('run-health');
    expect(ids).not.toContain('run-activity');
  });

  it('shows them to an admin', () => {
    expect(visible(true)).toEqual(expect.arrayContaining(['run-health', 'run-activity']));
  });
});

describe('Needs you', () => {
  it("a member sees only their own runs — never a colleague's failure — and no run link", async () => {
    render(<MemoryRouter><NeedsYouTile compact={false} /></MemoryRouter>);
    expect(await screen.findByText('my-workflow')).toBeTruthy();
    expect(screen.queryByText('colleague-workflow')).toBeNull();
    expect(listOwnRuns).toHaveBeenCalled();
    expect(listMyRuns).not.toHaveBeenCalled(); // the workspace list never reaches a member's browser
    expect(screen.queryByRole('link', { name: /inspect/i })).toBeNull();
  });

  it('an admin sees the workspace, with links', async () => {
    access.admin = true;
    render(<MemoryRouter><NeedsYouTile compact={false} /></MemoryRouter>);
    expect(await screen.findByText('colleague-workflow')).toBeTruthy();
    expect(screen.getByText('my-workflow')).toBeTruthy();
    expect(listMyRuns).toHaveBeenCalled();
    expect(screen.getAllByRole('link').some((a) => a.getAttribute('href') === '/runs/r-other')).toBe(true);
  });

  const t = (k: string): string => k;
  const conn = (id: string, userId?: string) => ({
    connectionId: id, provider: 'google', kind: 'oauth2', displayName: id, status: 'expired', scopes: [], connectedAt: recent(60),
    ...(userId ? { userId } : {}),
  });

  it('a member gets their own expired connection as text — no link to the admin-tier Access page — and not a workspace one', () => {
    const items = needsYouItems([], [], [conn('workspace-conn'), conn('my-conn', 'user:me')], Date.now(), t, false);
    expect(items.map((i) => i.key)).toEqual(['c:my-conn']);
    expect(items[0]!.to).toBeUndefined();
  });

  it('an admin gets every expired connection with the reconnect link', () => {
    const items = needsYouItems([], [], [conn('workspace-conn'), conn('my-conn', 'user:me')], Date.now(), t, true);
    expect(items.map((i) => i.key).sort()).toEqual(['c:my-conn', 'c:workspace-conn']);
    expect(items.every((i) => i.to === '/access?tab=connections')).toBe(true);
  });
});

describe('Get started', () => {
  it("does not tick 'Run a workflow' because a colleague ran one", async () => {
    listOwnRuns.mockResolvedValue({ runs: [], truncated: false });
    render(<MemoryRouter><GetStartedTile compact={false} /></MemoryRouter>);
    const step = (await screen.findByText('Run a workflow')).closest('li')!;
    expect(step.className).not.toContain('is-done');
    expect(listMyRuns).not.toHaveBeenCalled();
  });

  it("ticks it from the viewer's own run", async () => {
    render(<MemoryRouter><GetStartedTile compact={false} /></MemoryRouter>);
    await waitFor(() => expect(screen.getByText('Run a workflow').closest('li')!.className).toContain('is-done'));
  });
});

describe('Active runs', () => {
  it("a member sees only their own running runs, as text (run pages are admin-tier)", async () => {
    listMyRuns.mockResolvedValue([run('r-x', 'colleague-running', 'running')]);
    listOwnRuns.mockResolvedValue({ runs: [run('r-y', 'my-running', 'running'), MY_FAILED], truncated: false });
    render(<MemoryRouter><ActiveRunsTile compact={false} /></MemoryRouter>);
    expect(await screen.findByText('my-running')).toBeTruthy();
    expect(screen.queryByText('colleague-running')).toBeNull();
    expect(screen.queryByText('my-workflow')).toBeNull(); // failed is not active
    expect(screen.queryByRole('link')).toBeNull();
    expect(listMyRuns).not.toHaveBeenCalled();
  });
});

describe('cache invalidation on returning home', () => {
  it('re-reads the caller runs after invalidateHomeActivity, and shares within one paint', async () => {
    await Promise.all([readMyRuns(), readMyRuns()]);
    expect(listOwnRuns).toHaveBeenCalledTimes(1); // two tiles, one request
    await readMyRuns();
    expect(listOwnRuns).toHaveBeenCalledTimes(1); // inside the TTL: cached
    invalidateHomeActivity();
    await readMyRuns();
    expect(listOwnRuns).toHaveBeenCalledTimes(2);
  });
});
