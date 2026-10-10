/**
 * ADR 0772 D1 — a run-duration breach (and a cancel) stops an in-flight node
 * WITHOUT a terminal node event: the breach is the run's fact. The timeline must
 * then stop drawing that node as live work. Before, its bar kept pulsing
 * "running" on a run that had already failed.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => (o ? `${k}:${JSON.stringify(o)}` : k) }),
}));

const { RunTimeline } = await import('../RunTimeline.js');

afterEach(cleanup);

const ev = (sequence: number, type: string, nodeId?: string) => ({
  eventId: `e${sequence}`, runId: 'r1', sequence, type, ...(nodeId ? { nodeId } : {}),
  timestamp: new Date(Date.UTC(2026, 8, 1, 0, 0, sequence)).toISOString(), payload: {},
});

describe('RunTimeline — a node cut by the run is not drawn as running', () => {
  it('an open segment is closed as `cut` at run.failed', () => {
    render(<RunTimeline events={[ev(1, 'run.started'), ev(2, 'node.started', 'wait'), ev(3, 'run.failed')] as never} readState="ready" />);
    const bar = screen.getByRole('button', { name: /"nodeId":"wait"/ });
    expect(bar.getAttribute('aria-label')).toContain('segStatusCut');
    expect((bar as HTMLElement).style.animation).toBe('none');
  });

  it('POSITIVE CONTROL: a node still running on a live run keeps its running state', () => {
    render(<RunTimeline events={[ev(1, 'run.started'), ev(2, 'node.started', 'wait')] as never} readState="ready" />);
    const bar = screen.getByRole('button', { name: /"nodeId":"wait"/ });
    expect(bar.getAttribute('aria-label')).toContain('segStatusRunning');
  });
});
