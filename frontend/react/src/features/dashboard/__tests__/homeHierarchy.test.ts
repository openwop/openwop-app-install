/**
 * ADR 0844 — the home-hierarchy tiles' pure logic.
 *
 * The run statistics are computed client-side from at most RUN_WINDOW rows, so
 * the load-bearing property is HONESTY about that sample: a window the rows do
 * not reach must report `covered: false`, and a previous period they do not
 * reach must produce NO comparison rather than a comparison against zero.
 */
import { describe, it, expect } from 'vitest';
import type { RunListItem } from '../../../client/runsClient.js';
import { computeRunHealth, formatDuration, RUN_WINDOW } from '../runsWindow.js';
import { needsYouItems } from '../tiles/NeedsYouTile.js';
import { filterRuns } from '../tiles/RunActivityTile.js';

const NOW = Date.parse('2026-10-06T12:00:00Z');
const H = 3_600_000;
const D = 24 * H;
const iso = (ms: number): string => new Date(ms).toISOString();

function run(id: string, status: string, startAgoMs: number, durMs?: number): RunListItem {
  const startedAt = iso(NOW - startAgoMs);
  return { runId: id, workflowId: `wf-${id}`, status, startedAt, ...(durMs !== undefined ? { completedAt: iso(NOW - startAgoMs + durMs) } : {}) };
}

describe('computeRunHealth', () => {
  it('counts runs, success rate over FINISHED runs, and the median succeeded duration', () => {
    const rows = [
      run('a', 'completed', 1 * H, 10_000),
      run('b', 'completed', 2 * H, 30_000),
      run('c', 'failed', 3 * H, 5_000),
      run('d', 'running', 4 * H),
      run('e', 'completed', 5 * H, 20_000),
    ];
    const h = computeRunHealth(rows, '24h', NOW, false);
    expect(h.runs).toBe(5);
    expect(h.successRate).toBeCloseTo(3 / 4); // running is not finished
    expect(h.medianMs).toBe(20_000);
    expect(h.covered).toBe(true);
  });

  it('a full page that does not reach the window start is NOT covered, and has no comparison', () => {
    // 100 runs all inside the last 2 days: the 7-day window is only partly seen.
    const rows = Array.from({ length: RUN_WINDOW }, (_, i) => run(String(i), 'completed', (i + 1) * (2 * D / RUN_WINDOW), 1000));
    const h = computeRunHealth(rows, '7d', NOW, true);
    expect(h.covered).toBe(false);
    expect(h.previous).toBeNull();
  });

  it('a short list that ENDED is complete, so the previous period compares (even against nothing)', () => {
    const rows = [run('a', 'completed', 1 * D, 1000), run('b', 'failed', 8 * D, 1000)];
    const h = computeRunHealth(rows, '7d', NOW, false);
    expect(h.covered).toBe(true);
    expect(h.previous).not.toBeNull();
    expect(h.previous!.runs).toBe(1);
    expect(h.previous!.successRate).toBe(0);
  });

  it('counts waiting runs regardless of age, and buckets the sparkline oldest-first', () => {
    const rows = [run('a', 'paused', 20 * D), run('b', 'suspended', 1 * H), run('c', 'completed', 6.5 * D, 1000)];
    const h = computeRunHealth(rows, '7d', NOW, false);
    expect(h.waiting).toBe(2);
    expect(h.series).toHaveLength(7);
    expect(h.series[0]).toBe(1); // 6.5 days ago → first daily bucket
    expect(h.series[6]).toBe(1); // 1 hour ago → last bucket
  });

  it('reports no rate and no median when nothing finished', () => {
    const h = computeRunHealth([run('a', 'running', H)], '24h', NOW, false);
    expect(h.successRate).toBeNull();
    expect(h.medianMs).toBeNull();
  });
});

describe('formatDuration', () => {
  it('formats seconds, minutes and hours compactly', () => {
    expect(formatDuration(22_000)).toBe('22s');
    expect(formatDuration(64_000)).toBe('1m 04s');
    expect(formatDuration(3 * H + 5 * 60_000)).toBe('3h 05m');
  });
});

describe('needsYouItems', () => {
  const t = (k: string): string => k;
  const approval = { approvalId: 'p1', kind: 'agent', proposal: 'Pay invoice', createdAt: iso(NOW - 10 * 60_000), cardTitle: 'Invoice review' } as unknown as Parameters<typeof needsYouItems>[0][number];
  const conn = (status: string) => ({ connectionId: `c-${status}`, provider: 'google', kind: 'oauth2', displayName: 'Drive', status, scopes: [], connectedAt: iso(NOW - D) });

  it('ranks newest first across sources and only includes failures from the last day', () => {
    const items = needsYouItems(
      [approval],
      [run('w', 'paused', 2 * H), run('f', 'failed', 3 * H, 1000), run('old', 'failed', 3 * D, 1000), run('ok', 'completed', H, 1000)],
      [conn('expired'), conn('active')],
      NOW, t, true,
    );
    expect(items.map((i) => i.key)).toEqual(['a:p1', 'w:w', 'f:f', 'c:c-expired']);
  });

  it('drops the run link for a caller who cannot open run pages', () => {
    const items = needsYouItems([], [run('f', 'failed', H, 1000)], [], NOW, t, false);
    expect(items[0]!.to).toBeUndefined();
  });
});

describe('filterRuns', () => {
  const rows = [run('a', 'completed', H, 1), run('b', 'failed', H, 1), run('c', 'paused', H), run('d', 'running', H)];
  it('attention = failed + waiting; running = in flight', () => {
    expect(filterRuns(rows, 'attention').map((r) => r.runId)).toEqual(['b', 'c']);
    expect(filterRuns(rows, 'running').map((r) => r.runId)).toEqual(['d']);
    expect(filterRuns(rows, 'all')).toHaveLength(4);
  });
});
