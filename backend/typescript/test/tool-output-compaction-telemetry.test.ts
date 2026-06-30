/**
 * ADR 0099 Phase 4 — savings observability. The seam reports a CompactionSaving
 * to a swappable observer (default: debug log) when compaction shrinks output.
 * Side-channel only — never touches the event log / wire, never throws.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  registerToolResultTransform,
  applyToolResultTransform,
  setCompactionObserver,
  __resetToolResultTransform,
  __resetCompactionObserver,
  type CompactionSaving,
} from '../src/host/toolResultTransform.js';
import { compactToolOutput } from '../src/features/tool-output-compaction/compact.js';

const sparse = JSON.stringify({ items: [{ id: 1, tags: [], note: null }, { id: 2, tags: [], note: '' }] }, null, 2);

beforeEach(() => {
  registerToolResultTransform((content, ctx) => (ctx.decision ? compactToolOutput(content, ctx.decision) : content));
});
afterEach(() => {
  __resetToolResultTransform();
  __resetCompactionObserver();
});

describe('compaction savings telemetry', () => {
  it('reports charsSaved + toolName + tenantId when output shrinks', () => {
    const seen: CompactionSaving[] = [];
    setCompactionObserver((s) => seen.push(s));
    const out = applyToolResultTransform(sparse, { decision: { mode: 'lossless' }, toolName: 'list', tenantId: 't1' });
    expect(out.length).toBeLessThan(sparse.length);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ toolName: 'list', tenantId: 't1', charsBefore: sparse.length, charsAfter: out.length });
    expect(seen[0].charsSaved).toBe(sparse.length - out.length);
  });

  it('does NOT report when the decision is off / absent (identity)', () => {
    const seen: CompactionSaving[] = [];
    setCompactionObserver((s) => seen.push(s));
    applyToolResultTransform(sparse, { decision: { mode: 'off' } });
    applyToolResultTransform(sparse, {});
    expect(seen).toHaveLength(0);
  });

  it('does NOT report when content did not shrink (non-JSON pass-through)', () => {
    const seen: CompactionSaving[] = [];
    setCompactionObserver((s) => seen.push(s));
    const prose = 'connection refused at db';
    expect(applyToolResultTransform(prose, { decision: { mode: 'lossless' } })).toBe(prose);
    expect(seen).toHaveLength(0);
  });

  it('a throwing observer never breaks the transform (telemetry is fire-and-forget)', () => {
    setCompactionObserver(() => {
      throw new Error('telemetry backend down');
    });
    expect(() => applyToolResultTransform(sparse, { decision: { mode: 'lossless' } })).not.toThrow();
  });

  it('emits via the default observer without throwing (info log path)', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(() => applyToolResultTransform(sparse, { decision: { mode: 'lossless' }, toolName: 't' })).not.toThrow();
    spy.mockRestore();
  });
});
