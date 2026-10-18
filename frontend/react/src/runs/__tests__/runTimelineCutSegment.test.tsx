/**
 * ADR 0772 D1 — a run-duration breach (and a cancel) stops an in-flight node
 * WITHOUT a terminal node event: the breach is the run's fact. The timeline must
 * then stop drawing that node as live work. Before, its bar kept pulsing
 * "running" on a run that had already failed.
 *
 * Both run terminals the header names are driven (`run.failed`, `run.cancelled`),
 * and the cut segment must be CLOSED (a finite duration), not just relabelled.
 * The positive control carries a NON-terminal run event after the node starts,
 * so a timeline that cut on ANY run-level event would fail it.
 *
 * What turns it red: the segment not marked `cut`; marked but left open
 * (`timelineRunning` duration); a cut bar that still pulses; `run.cancelled`
 * missing from the terminal set; any run event cutting a live node.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import type { RunEventDoc } from '@openwop/openwop';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => (o ? `${k}:${JSON.stringify(o)}` : k) }),
}));

const { RunTimeline } = await import('../RunTimeline.js');

afterEach(cleanup);

const ev = (sequence: number, type: string, nodeId?: string): RunEventDoc => ({
  eventId: `e${sequence}`, runId: 'r1', sequence, type, ...(nodeId ? { nodeId } : {}),
  timestamp: new Date(Date.UTC(2026, 8, 1, 0, 0, sequence)).toISOString(), payload: {}, schemaVersion: 1,
});

describe('RunTimeline — a node cut by the run is not drawn as running', () => {
  it.each(['run.failed', 'run.cancelled'])('an open segment is closed as `cut` at %s', (terminal) => {
    render(<RunTimeline events={[ev(1, 'run.started'), ev(2, 'node.started', 'wait'), ev(3, terminal)]} readState="ready" />);
    const bar = screen.getByRole('button', { name: /"nodeId":"wait"/ });
    const label = bar.getAttribute('aria-label') ?? '';
    expect(label).toContain('segStatusCut');
    // CLOSED at the terminal: a finite duration, never the open-segment label.
    expect(label).not.toContain('timelineRunning');
    expect(bar.style.animation).toBe('none');
  });

  it('POSITIVE CONTROL: a node still running on a live run keeps its running state', () => {
    // `run.resumed` is a run-level, NON-terminal event after the node started.
    render(<RunTimeline events={[ev(1, 'run.started'), ev(2, 'node.started', 'wait'), ev(3, 'run.resumed')]} readState="ready" />);
    const bar = screen.getByRole('button', { name: /"nodeId":"wait"/ });
    expect(bar.getAttribute('aria-label')).toContain('segStatusRunning');
    expect(bar.getAttribute('aria-label')).toContain('timelineRunning');
  });
});
