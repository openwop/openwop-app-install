/**
 * ADR 0099 Phase 4 — savings observability. The seam reports a CompactionSaving
 * to a swappable observer (default: debug log) when compaction shrinks output.
 * Side-channel only — never touches the event log / wire, never throws.
 *
 * Sabotages that turn it red (w22 probes): zero `charsSaved` or drop
 * `tenantId` from the saving; drop the seam's off/absent short-circuit; report
 * on `<=` instead of `<`; rethrow from the observer; demote the default
 * observer from `log.info` to `log.debug` (the ADR 0099 Phase 4 point: a debug
 * default was invisible in a standard info-level deployment).
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
    // A decision-BLIND transform: if the seam failed to short-circuit, it would
    // shrink the payload and report. (With the feature's own decision-guarded
    // transform, off/absent were identity anyway — w22 tel-guard, vacuous.)
    registerToolResultTransform((c) => compactToolOutput(c, { mode: 'lossless' }));
    const seen: CompactionSaving[] = [];
    setCompactionObserver((s) => seen.push(s));
    expect(applyToolResultTransform(sparse, { decision: { mode: 'off' } })).toBe(sparse);
    expect(applyToolResultTransform(sparse, {})).toBe(sparse);
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
    // …and the run still gets the compacted output, not the original.
    expect(applyToolResultTransform(sparse, { decision: { mode: 'lossless' } })).toBe(JSON.stringify(JSON.parse(sparse)));
  });

  it('the default observer logs the saving at INFO', () => {
    // The logger writes `process.stdout.write`, not `console.log` (the old spy
    // watched the wrong sink and its `not.toThrow` could not fail, since the seam
    // swallows observer throws — w22 tel-default-info, vacuous). Relies on the
    // logger's default level `info` (OPENWOP_LOG_LEVEL unset in the test env).
    const lines: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => {
      lines.push(typeof c === 'string' ? c : Buffer.from(c).toString());
      return true;
    });
    let out: string;
    try {
      out = applyToolResultTransform(sparse, { decision: { mode: 'lossless' }, toolName: 't' });
    } finally {
      spy.mockRestore();
    }
    const hits = lines
      .flatMap((l) => l.split('\n'))
      .filter((l) => l.includes('tool_output_compacted'))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      level: 'info',
      component: 'host.toolResultTransform',
      msg: 'tool_output_compacted',
      toolName: 't',
      charsSaved: sparse.length - out.length,
    });
  });
});
