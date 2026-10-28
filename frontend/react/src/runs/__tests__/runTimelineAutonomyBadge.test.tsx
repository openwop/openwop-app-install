/**
 * ADR 0942 P5 — the run timeline's autonomy badge. It reads ONLY the campaign
 * autonomy gate's own result shape: `{decision, ruleId}` outputs on node.completed
 * (ruleId a policy rule or a resolver layer) or the `autonomy_blocked` /
 * `autonomy_rejected` failure codes.
 *
 * What turns it red: badging any node whose outputs merely carry `decision`
 * (the negative controls); reading the segment's LAST event instead of its
 * terminal one (the trailing-event case); dropping the failure codes.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen } from '@testing-library/react';
import type { RunEventDoc } from '@openwop/openwop';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string, o?: Record<string, unknown>) => (o ? `${k}:${JSON.stringify(o)}` : k) }),
}));

const { RunTimeline, autonomyBadgeOf } = await import('../RunTimeline.js');

afterEach(cleanup);

const ev = (sequence: number, type: string, nodeId?: string, payload: Record<string, unknown> = {}): RunEventDoc => ({
  eventId: `e${sequence}`, runId: 'r1', sequence, type, ...(nodeId ? { nodeId } : {}),
  timestamp: new Date(Date.UTC(2026, 8, 1, 0, 0, sequence)).toISOString(), payload, schemaVersion: 1,
});
const completed = (outputs: unknown): RunEventDoc => ev(2, 'node.completed', 'gate', { nodeId: 'gate', outputs });
const failed = (code: string): RunEventDoc => ev(2, 'node.failed', 'gate', { nodeId: 'gate', error: { code, message: 'x' } });

describe('autonomyBadgeOf', () => {
  it.each([
    [{ decision: 'auto', ruleId: 'ads.budget#esc0' }, { kind: 'auto', ruleId: 'ads.budget#esc0' }],
    [{ decision: 'notify-after', ruleId: 'social.post#default#preset' }, { kind: 'notify-after', ruleId: 'social.post#default#preset' }],
    [{ decision: 'approved', ruleId: 'creative.review:client#default' }, { kind: 'approved', ruleId: 'creative.review:client#default' }],
    [{ decision: 'approved', ruleId: 'floor:fork-posture' }, { kind: 'approved', ruleId: 'floor:fork-posture' }],
  ])('reads the gate result %j', (outputs, badge) => {
    expect(autonomyBadgeOf(completed(outputs))).toEqual(badge);
  });

  it.each([
    [{ decision: 'auto' }],
    [{ decision: 'approve', ruleId: 'ads.budget#esc0' }],
    [{ decision: 'auto', ruleId: 'Some free text' }],
    [{ decision: 'auto', ruleId: 'mystery:thing' }],
    [{ verdict: 'auto', ruleId: 'ads.budget#esc0' }],
    ['auto'],
  ])('NEGATIVE: an unrelated node output %j gets no badge', (outputs) => {
    expect(autonomyBadgeOf(completed(outputs))).toBeNull();
  });

  it('reads the two failure codes, and nothing else', () => {
    expect(autonomyBadgeOf(failed('autonomy_blocked'))).toEqual({ kind: 'blocked' });
    expect(autonomyBadgeOf(failed('autonomy_rejected'))).toEqual({ kind: 'rejected' });
    expect(autonomyBadgeOf(failed('timeout'))).toBeNull();
  });
});

describe('RunTimeline — the badge on the lane', () => {
  it('shows the decision and rule from the terminal event, even when a later event lands on the segment', () => {
    render(<RunTimeline readState="ready" events={[
      ev(1, 'node.started', 'gate'),
      completed({ decision: 'auto', ruleId: 'ads.budget#esc0' }),
      ev(3, 'memory.written', 'gate', { memoryRef: 'm1' }),
      ev(4, 'run.completed'),
    ]} />);
    const chip = screen.getByText(/timelineAutonomyWithRule/);
    expect(chip.className).toContain('chip--success');
    expect(chip.textContent).toContain('ads.budget#esc0');
  });

  it('a blocked step shows Blocked; an ordinary node shows no badge', () => {
    render(<RunTimeline readState="ready" events={[
      ev(1, 'node.started', 'gate'), failed('autonomy_blocked'),
      ev(3, 'node.started', 'other'), ev(4, 'node.completed', 'other', { nodeId: 'other', outputs: { decision: 'auto' } }),
    ]} />);
    expect(screen.getAllByText('timelineAutonomy_blocked')).toHaveLength(1);
    expect(screen.queryByText(/timelineAutonomyWithRule/)).toBeNull();
  });
});
