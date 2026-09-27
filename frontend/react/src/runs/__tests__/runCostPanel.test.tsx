/**
 * ADR 0482 §6 — the per-node cost table: the stamp is authoritative when
 * present; pre-stamp runs fall back to aggregating the already-loaded
 * provider.usage events by nodeId (no extra fetch, no invented numbers).
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { RunEventDoc } from '@openwop/openwop';
import { aggregateNodeCosts, RunCostPanel } from '../RunCostPanel.js';

let seq = 0;
function usage(nodeId: string | undefined, costEstimateUsd: number, extra: Record<string, unknown> = {}): RunEventDoc {
  seq += 1;
  return {
    eventId: `e${seq}`,
    runId: 'run-1',
    type: 'provider.usage',
    ...(nodeId !== undefined ? { nodeId } : {}),
    payload: { provider: 'anthropic', model: 'claude-sonnet-5', costEstimateUsd, inputTokens: 10, outputTokens: 5, ...extra },
    timestamp: new Date(Date.UTC(2026, 6, 24, 12, 0, seq)).toISOString(),
    sequence: seq,
  } as RunEventDoc;
}

describe('aggregateNodeCosts', () => {
  it('prefers the durable stamp and sorts by spend with __other last', () => {
    const { rows, source } = aggregateNodeCosts([], { small: 0.01, __other: 0.02, big: 0.5 });
    expect(source).toBe('stamp');
    expect(rows.map((r) => r.nodeId)).toEqual(['big', 'small', '__other']);
  });

  it('falls back to folding provider.usage events by nodeId (pre-stamp runs)', () => {
    const events = [usage('a', 0.1), usage('b', 0.4), usage('a', 0.2), usage(undefined, 0.05)];
    const { rows, source } = aggregateNodeCosts(events);
    expect(source).toBe('events');
    expect(rows.map((r) => r.nodeId)).toEqual(['b', 'a', '__other']);
    expect(rows.find((r) => r.nodeId === 'a')!.costUsd).toBeCloseTo(0.3, 9);
    expect(rows.find((r) => r.nodeId === '__other')!.costUsd).toBeCloseTo(0.05, 9);
  });

  it('returns no rows when nothing carries cost', () => {
    expect(aggregateNodeCosts([]).rows).toEqual([]);
    expect(aggregateNodeCosts([], {}).rows).toEqual([]);
  });
});

describe('RunCostPanel per-node table', () => {
  it('renders the fallback per-node rows from events when no stamp exists', () => {
    render(<RunCostPanel events={[usage('summarize', 0.25), usage('draft', 0.1)]} />);
    expect(screen.getByText('Cost by node')).toBeTruthy();
    expect(screen.getByText('summarize')).toBeTruthy();
    expect(screen.getByText('draft')).toBeTruthy();
    // The honesty note names the live-fallback source without promising a
    // stamp that may never land (ux-8 — pre-stamp terminal runs stay honest).
    expect(screen.getByText(/Aggregated from this run/)).toBeTruthy();
    expect(screen.queryByText(/lands when the run finishes/)).toBeNull();
  });

  it('renders the stamp rows (with the localized __other label) when provided', () => {
    render(<RunCostPanel events={[usage('x', 0.01)]} costByNode={{ x: 0.01, __other: 0.002 }} />);
    expect(screen.getByText('Other / unattributed')).toBeTruthy();
    expect(screen.getByText(/Recorded at run completion/)).toBeTruthy();
  });
});
