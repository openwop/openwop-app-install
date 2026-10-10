/**
 * ADR 0662 D3 / ADR 0862 — a perception loop whose last run FAILED says so, says why, and
 * points at the fix.
 *
 * The server projected `lastRunStatus` from it.14 on; the panel never read it. In
 * production the calendar loop failed most of its runs on a lapsed Google connection and
 * read "Last run …" beside a green "On" the whole time.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const listLoops = vi.fn();
vi.mock('../../features/assistant/assistantClient.js', () => ({
  listLoops: () => listLoops(),
  setLoopEnabled: vi.fn(),
}));

import { RecurringTasksPanel } from '../RecurringTasksPanel.js';

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const loop = (over: Record<string, unknown>) => ({
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
    listLoops.mockResolvedValue([loop({ lastRunStatus: 'completed' })]);
    render(<MemoryRouter><RecurringTasksPanel /></MemoryRouter>);
    await screen.findByText('Calendar ingestion');
    expect(screen.queryByText(/Last run failed/)).toBeNull();
  });
});

describe('COS2UX-12 — the health verdict does not read healthy over a failing loop', () => {
  it('a failing enabled loop is the danger verdict, ahead of everything else', async () => {
    const { AgentHealthView } = await import('../AgentHealthPanel.js');
    const health = {
      generatedAt: '2026-10-07T09:00:00Z',
      actions: { pending: 0, approved: 0, rejected: 0, sent: 3, failed: 0, suppressed: 0, approvalRate: 1, editRate: 0, citationCoverage: 1, taintedShare: 0 },
      commitments: { open: 4, stale: 0, citationCoverage: 1 },
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
