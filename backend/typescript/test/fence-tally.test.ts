/**
 * XCH-F1-2 — fence decisions are OBSERVABLE per tool.
 *
 * The `contentTrust` classification is hand-audited; a second pass over it found
 * 7 errors (5 wrong-`trusted`, 2 over-fenced). Nothing in production reported
 * which way a tool resolved, so a wrong `trusted` was indistinguishable from a
 * correct one. The tally is the instrument that finds the NEXT error rather than
 * reasoning about its likelihood — `unknown` especially, which means a tool
 * reached a model with no registered classification at all.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { toModelToolResult, fenceTally, __resetFenceTally } from '../src/host/toModelToolResult.js';

const FENCE = 'BEGIN UNTRUSTED CONTENT';

describe('XCH-F1-2 — per-tool fence tally', () => {
  beforeEach(() => { __resetFenceTally(); });

  it('counts an UNKNOWN tool as fenced — the fail-closed path is the one worth seeing', () => {
    // A tool that is not a registered builtin (MCP, pack-provided, node-as-tool)
    // resolves to `undefined` and MUST be fenced. That path was a live fail-open
    // regression once; the tally makes it visible instead of silent.
    const out = toModelToolResult('openwop:definitely.not.registered', 'payload');
    expect(out).toContain(FENCE);
    expect(fenceTally()['openwop:definitely.not.registered']).toEqual({ fenced: 1, passed: 0 });
  });

  it('accumulates across calls rather than overwriting', () => {
    toModelToolResult('openwop:x.unknown', 'a');
    toModelToolResult('openwop:x.unknown', 'b');
    expect(fenceTally()['openwop:x.unknown']?.fenced).toBe(2);
  });

  it('an ERROR result is neither fenced nor tallied — it is host-authored', () => {
    const out = toModelToolResult('openwop:x.unknown', 'boom', true);
    expect(out).toBe('boom');
    expect(fenceTally()['openwop:x.unknown']).toBeUndefined();
  });

  it('the tally is a SNAPSHOT — mutating it cannot corrupt the counters', () => {
    toModelToolResult('openwop:x.unknown', 'a');
    const snap = fenceTally();
    snap['openwop:x.unknown']!.fenced = 999;
    expect(fenceTally()['openwop:x.unknown']?.fenced, 'the snapshot aliased internal state').toBe(1);
  });

  it('reset clears it — a process-global counter must be resettable between suites', () => {
    toModelToolResult('openwop:x.unknown', 'a');
    __resetFenceTally();
    expect(Object.keys(fenceTally())).toHaveLength(0);
  });
});
