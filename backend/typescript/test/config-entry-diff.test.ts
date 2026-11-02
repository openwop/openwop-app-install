/**
 * ADR 0387 § value-level preview — the generic entry differ.
 *
 * Generic rather than a per-domain method because the determinism contract in
 * `configDomains.ts` already guarantees payloads are order-normalized MAPS
 * keyed by stable ids. These pin the properties that generality rests on: the
 * nested case (publish-pointers is `{orgId: {funnelId: status}}`), the flat case
 * (workflow-pins; `feature-toggles` was removed by ADR 0819 §2 but had the same
 * shape), stable ordering, and an honest truncation count — a capped list that
 * looked complete would recreate the very "counts you cannot verify" problem the
 * feature exists to fix. Tracker: TST-CGH-1.
 *
 * Red when (configDomains.ts `diffEntries`): the path sort is dropped (the
 * ordering fixtures are inserted in REVERSE, so only the sort yields k00…); the
 * truncation count is lost; an unchanged entry is reported; or nested keys stop
 * flattening to `a/b`.
 */
import { describe, it, expect } from 'vitest';
import { diffEntries } from '../src/host/configDomains.js';

describe('diffEntries — flat payloads (feature-toggles / workflow-pins shape)', () => {
  it('reports added / changed / removed with both sides of the value', () => {
    const from = { alpha: 'on', beta: 'on', gone: 'on' };
    const to = { alpha: 'on', beta: 'off', fresh: 'on' };
    const d = diffEntries(from, to);
    expect(d.truncated).toBe(0);
    expect(d.changes).toEqual([
      { path: 'beta', kind: 'changed', from: 'on', to: 'off' },
      { path: 'fresh', kind: 'added', to: 'on' },
      { path: 'gone', kind: 'removed', from: 'on' },
    ]);
  });

  it('omits an unchanged entry entirely', () => {
    expect(diffEntries({ a: '1' }, { a: '1' }).changes).toEqual([]);
  });

  it('treats a missing `from` (first promotion) as all-added, not all-changed', () => {
    const d = diffEntries(undefined, { a: '1', b: '2' });
    expect(d.changes.map((c) => c.kind)).toEqual(['added', 'added']);
    // `from` must be ABSENT, not undefined-valued — there was no prior value to show.
    expect(d.changes.every((c) => !('from' in c))).toBe(true);
  });
});

describe('diffEntries — nested payloads (publish-pointers shape)', () => {
  it('flattens to `orgId/funnelId`, matching how that domain flattens itself', () => {
    const from = { org1: { fnl1: 'published', fnl2: 'draft' } };
    const to = { org1: { fnl1: 'draft' }, org2: { fnl9: 'published' } };
    const d = diffEntries(from, to);
    expect(d.changes).toEqual([
      { path: 'org1/fnl1', kind: 'changed', from: 'published', to: 'draft' },
      { path: 'org1/fnl2', kind: 'removed', from: 'draft' },
      { path: 'org2/fnl9', kind: 'added', to: 'published' },
    ]);
  });
});

describe('diffEntries — truncation is stated, not silent', () => {
  it('caps the list and reports how many were left out', () => {
    const to = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`k${String(i).padStart(2, '0')}`, 'on']));
    const d = diffEntries({}, to, 50);
    expect(d.changes).toHaveLength(50);
    expect(d.truncated).toBe(10);
  });

  it('orders stably, so the capped slice is deterministic across calls', () => {
    // Inserted in REVERSE (k59 … k00), with a REMOVED entry that sorts first: the
    // insertion order and the added-then-removed loop order both disagree with the
    // path order, so only a real sort yields this slice.
    const to = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`k${String(59 - i).padStart(2, '0')}`, 'on']));
    const from = { a00: 'on' };
    const a = diffEntries(from, to, 5).changes.map((c) => c.path);
    const b = diffEntries(from, { ...to }, 5).changes.map((c) => c.path);
    expect(a).toEqual(b);
    expect(a).toEqual(['a00', 'k00', 'k01', 'k02', 'k03']);
  });
});
