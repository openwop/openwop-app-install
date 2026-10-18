/**
 * ADR 0662 D3 / ADR 0862 — a perception loop whose last run FAILED says so, says why, and
 * points at the fix.
 *
 * The server projected `lastRunStatus` from it.14 on; the panel never read it. In
 * production the calendar loop failed most of its runs on a lapsed Google connection and
 * read "Last run …" beside a green "On" the whole time.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import type { AssistantHealth, AssistantLoop } from '../../features/assistant/assistantClient.js';
import { MemoryRouter } from 'react-router-dom';

type AssistantClient = typeof import('../../features/assistant/assistantClient.js');
const { listLoops } = vi.hoisted(() => ({ listLoops: vi.fn<AssistantClient['listLoops']>() }));
vi.mock('../../features/assistant/assistantClient.js', () => ({
  listLoops,
  setLoopEnabled: vi.fn<AssistantClient['setLoopEnabled']>(),
}));

import { RecurringTasksPanel } from '../RecurringTasksPanel.js';

afterEach(() => { cleanup(); vi.resetAllMocks(); });

const loop = (over: Partial<AssistantLoop>): AssistantLoop => ({
  loopId: 'calendar-ingest', label: 'Calendar ingestion', description: 'Reads your calendar', enabled: true,
  lastRunAt: '2026-10-07T09:00:00Z', lastRunId: 'run-9', ...over,
});

describe('a failed last run is visible', () => {
  it('names a lapsed connection and links to Connections', async () => {
    listLoops.mockResolvedValue([loop({ lastRunStatus: 'failed', lastRunErrorCode: 'connection_reauth_required' })]);
    render(<MemoryRouter><RecurringTasksPanel /></MemoryRouter>);
    expect(await screen.findByText(/Google needs you to sign in again/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Reconnect Google' }).getAttribute('href')).toBe('/connections');
  });

  it('an unmapped failure links to the run rather than inventing a cause', async () => {
    listLoops.mockResolvedValue([loop({ lastRunStatus: 'failed', lastRunErrorCode: 'internal_error' })]);
    render(<MemoryRouter><RecurringTasksPanel /></MemoryRouter>);
    expect(await screen.findByText(/see the run for details/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'View run' }).getAttribute('href')).toBe('/runs/run-9');
  });

  it('a completed last run shows no failure line (negative control)', async () => {
    // Asymmetric fixture: a FAILING loop beside the completed one. The failure
    // copy lives in a lazily loaded namespace, so waiting for the completed
    // loop's label alone could assert absence before that copy can render at
    // all. Waiting for the failing row's line proves it is loaded.
    listLoops.mockResolvedValue([
      loop({ lastRunStatus: 'completed' }),
      loop({ loopId: 'drive-ingest', label: 'Drive ingestion', lastRunId: 'run-7', lastRunStatus: 'failed', lastRunErrorCode: 'connection_reauth_required' }),
    ]);
    render(<MemoryRouter><RecurringTasksPanel /></MemoryRouter>);
    await screen.findByText(/Google needs you to sign in again/);
    const completedRow = screen.getByText('Calendar ingestion').closest('li')!;
    expect(within(completedRow).queryByText(/Last run failed/)).toBeNull();
    expect(screen.getAllByText(/Last run failed/)).toHaveLength(1);
  });
});

describe('COS2UX-12 — the health verdict does not read healthy over a failing loop', () => {
  it('a failing enabled loop is the danger verdict, ahead of everything else', async () => {
    const { AgentHealthView } = await import('../AgentHealthPanel.js');
    // Every OTHER alarm is raised too (failed actions, stale commitments, a
    // pending approval), so the loop verdict must OUTRANK them, not merely beat
    // "healthy".
    const health: AssistantHealth = {
      generatedAt: '2026-10-07T09:00:00Z',
      actions: { pending: 1, approved: 0, rejected: 0, sent: 3, failed: 2, suppressed: 0, approvalRate: 1, editRate: 0, citationCoverage: 1, taintedShare: 0 },
      commitments: { open: 4, stale: 1, citationCoverage: 1 },
      loops: [{ loopId: 'calendar-ingest', label: 'Calendar', enabled: true, lastRunStatus: 'failed' }],
    };
    render(<MemoryRouter><AgentHealthView health={health} persona="Iris" /></MemoryRouter>);
    expect(await screen.findByText('A recurring task is failing')).toBeTruthy();
  });
});

describe('ADR 0862 — a loop that paused itself says so', () => {
  it('names the refusal and links to Connections', async () => {
    listLoops.mockResolvedValue([loop({ enabled: false, autoPausedCode: 'connection_scope_missing', autoPausedAt: '2026-10-07T09:30:00Z' })]);
    render(<MemoryRouter><RecurringTasksPanel /></MemoryRouter>);
    expect(await screen.findByText(/Paused automatically/)).toBeTruthy();
    expect(screen.getByText(/connected without access/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Reconnect Google' }).getAttribute('href')).toBe('/connections');
  });
});
