/** RUN-FORK-1, ADR 0772 §Correction (2026-11-06): a superseded checkpoint span is
 * incomplete, never ghost live work. Breaks if: a superseded open attempt is not marked
 * incomplete; its span runs to the next start instead of its last recorded event; its
 * label omits "observed"; an already-closed prior attempt is re-marked; a non-terminal
 * run event cuts live work; the history hint is gone. */
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { t } from 'i18next';
import type { RunEventDoc } from '@openwop/openwop';
import { RunTimeline } from '../RunTimeline.js';

afterEach(cleanup);
const start = Date.UTC(2026, 10, 6, 2, 0, 0);
const child = start + 341 * 60_000;
const event = (sequence: number, type: string, at: number, nodeId?: string): RunEventDoc => ({
  eventId: `event-${sequence}`, runId: 'controlled-child', sequence, timestamp: new Date(at).toISOString(), type,
  ...(nodeId ? { nodeId } : {}), payload: {}, schemaVersion: 1,
});
it('retains inherited events as an observed incomplete span and the actual completed child attempt', () => {
  const events = [event(0, 'run.started', start), event(1, 'node.started', start + 10, 'sync'),
    event(2, 'node.started', child + 10, 'sync'), event(3, 'node.completed', child + 82, 'sync'), event(4, 'run.completed', child + 335)];
  const before = JSON.stringify(events);
  const select = vi.fn();
  render(<RunTimeline events={[...events].reverse()} readState="ready" onSelectSeq={select} />);
  const earlier = screen.getByRole('button', { name: name => name.includes('sync') && name.includes(t('runs:segStatusIncomplete')) });
  expect(earlier.getAttribute('aria-label')).toContain(t('runs:timelineObservedDuration', { duration: t('runs:timelineDurationMs', { n: '0' }) }));
  expect(earlier.style.animation).toBe('none');
  expect(earlier.getAttribute('aria-label')).not.toContain(t('runs:segStatusRunning'));
  const current = screen.getByRole('button', { name: name => name.includes('sync') && name.includes(t('runs:segStatusCompleted')) });
  expect(current.getAttribute('aria-label')).toContain(t('runs:timelineDurationMs', { n: '72' }));
  fireEvent.click(earlier);
  expect(select).toHaveBeenCalledWith(1);
  expect(screen.getByText('#1')).toBeTruthy();
  expect(screen.getByText(t('runs:timelineHistoryHint'))).toBeTruthy();
  expect(JSON.stringify(events)).toBe(before);
});
it('keeps a genuinely live attempt running after an unrelated nonterminal run event', () => {
  render(<RunTimeline events={[event(0, 'run.started', start), event(1, 'node.started', start + 10, 'sync'), event(2, 'run.resumed', start + 20)]} readState="ready" />);
  const bar = screen.getByRole('button', { name: name => name.includes('sync') });
  expect(bar.getAttribute('aria-label')).toContain(t('runs:segStatusRunning'));
  expect(screen.queryByRole('button', { name: name => name.includes(t('runs:segStatusIncomplete')) })).toBeNull();
});
it('preserves both completed attempts when the prior terminal event is present', () => {
  render(<RunTimeline events={[event(0, 'node.started', start, 'sync'), event(1, 'node.completed', start + 25, 'sync'),
    event(2, 'node.started', child, 'sync'), event(3, 'node.completed', child + 72, 'sync'), event(4, 'run.completed', child + 80)]} readState="ready" />);
  const completed = screen.getAllByRole('button', { name: name => name.includes('sync') && name.includes(t('runs:segStatusCompleted')) });
  expect(completed).toHaveLength(2);
  const [earlier, current] = completed;
  if (!earlier || !current) throw new Error('Expected both completed attempts');
  expect(earlier.getAttribute('aria-label')).toContain(t('runs:timelineDurationMs', { n: '25' }));
  expect(current.getAttribute('aria-label')).toContain(t('runs:timelineDurationMs', { n: '72' }));
});
