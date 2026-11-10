/** RUN-FORK-1, ADR 0772 §Correction (2026-11-06) "fork history is not child execution
 * time": actual child analytics must not measure inherited-history idle time.
 * Breaks if: start/end come from inherited events while a snapshot exists; a terminal
 * snapshot without a valid completedAt falls back to an inherited terminal; end < start
 * yields 0 instead of unknown; an inherited parent terminal makes a running child read
 * completed or not live; the event-only fallback is lost. Durations are pinned literals
 * (en `durationMs` = '{{n}} ms'), never computed with the product formatter. */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { t } from 'i18next';
import type { RunEventDoc, RunSnapshot } from '@openwop/openwop';
import { RunAnalyticsPanel } from '../RunAnalyticsPanel.js';

afterEach(cleanup);
const childStart = Date.UTC(2026, 10, 6, 8, 0, 0);
const sourceStart = childStart - 341 * 60_000;
const event = (sequence: number, type: string, at: number, nodeId?: string): RunEventDoc => ({
  eventId: `event-${sequence}`, runId: 'controlled-child', sequence, timestamp: new Date(at).toISOString(), type,
  ...(nodeId ? { nodeId } : {}), payload: {}, schemaVersion: 1,
});
const history = [event(0, 'run.started', sourceStart), event(1, 'node.started', sourceStart + 10, 'sync'),
  event(2, 'node.started', childStart + 10, 'sync'), event(3, 'node.completed', childStart + 82, 'sync'), event(4, 'run.completed', childStart + 335)];
function stat(key: string): string | null {
  const value = screen.getByText(t(`runs:${key}`)).nextElementSibling;
  if (!value) throw new Error(`Missing statistic value ${key}`);
  return value.textContent;
}

describe('authoritative current execution versus inherited events', () => {
  it('shows the 335ms child duration and completed outcome despite hours-old prefix events', () => {
    const snapshot: Pick<RunSnapshot, 'status' | 'startedAt' | 'completedAt'> = {
      status: 'completed', startedAt: new Date(childStart).toISOString(), completedAt: new Date(childStart + 335).toISOString(),
    };
    render(<RunAnalyticsPanel events={[...history].reverse()} snapshot={snapshot} />);
    expect(stat('statDuration')).toBe('335 ms');
    expect(stat('statOutcome')).toBe(t('runs:outcomeCompleted'));
    expect(stat('statNodesDone')).toBe('1');
  });

  it('keeps an active child active even when inherited history includes a parent terminal', () => {
    render(<RunAnalyticsPanel events={[event(0, 'run.started', sourceStart), event(1, 'run.completed', sourceStart + 5), event(2, 'node.started', childStart + 80, 'sync')]}
      snapshot={{ status: 'running', startedAt: new Date(childStart).toISOString() }} />);
    expect(stat('statOutcome')).toBe(t('runs:outcomeRunning'));
    expect(stat('statElapsed')).toBe('80 ms');
    expect(screen.queryByText(t('runs:statDuration'))).toBeNull();
  });

  it.each([undefined, 'invalid', new Date(sourceStart).toISOString()])('does not substitute inherited timing for terminal completion %s', completedAt => {
    render(<RunAnalyticsPanel events={history} snapshot={{ status: 'completed', startedAt: new Date(childStart).toISOString(), ...(completedAt === undefined ? {} : { completedAt }) }} />);
    expect(stat('statDuration')).toBe('—');
    expect(stat('statOutcome')).toBe(t('runs:outcomeCompleted'));
  });

  it('does not invent duration when the authoritative start timestamp is invalid', () => {
    render(<RunAnalyticsPanel events={history} snapshot={{ status: 'completed', startedAt: 'invalid', completedAt: new Date(childStart + 335).toISOString() }} />);
    expect(stat('statDuration')).toBe('—');
  });

  it('retains ordinary event-only duration and outcome for consumers without a snapshot', () => {
    render(<RunAnalyticsPanel events={[event(0, 'run.started', childStart), event(1, 'run.completed', childStart + 72)]} />);
    expect(stat('statDuration')).toBe('72 ms');
    expect(stat('statOutcome')).toBe(t('runs:outcomeCompleted'));
  });
});
