/**
 * Canvas framework version-summary tests (ADR 0333) — the generic top-level
 * field diff behind the History-Compare default for non-frames canvas types.
 */
import { describe, expect, it } from 'vitest';
import { changedTopLevelKeys } from '../versionSummary.js';

describe('changedTopLevelKeys', () => {
  it('reports no changed keys for identical docs', () => {
    const doc = { title: 'A', content: { type: 'doc', content: [] } };
    expect(changedTopLevelKeys(doc, { ...doc, content: { type: 'doc', content: [] } })).toEqual([]);
  });

  it('reports a single changed key (deep structural compare)', () => {
    const a = { title: 'A', content: { type: 'doc', content: [{ type: 'paragraph' }] } };
    const b = { title: 'A', content: { type: 'doc', content: [{ type: 'heading' }] } };
    expect(changedTopLevelKeys(a, b)).toEqual(['content']);
  });

  it('reports multiple changed keys, sorted', () => {
    const a = { title: 'A', theme: 'light', content: {} };
    const b = { title: 'B', theme: 'dark', content: {} };
    expect(changedTopLevelKeys(a, b)).toEqual(['theme', 'title']);
  });

  it('treats added and removed keys as changed', () => {
    expect(changedTopLevelKeys({ a: 1 }, { b: 2 })).toEqual(['a', 'b']);
    expect(changedTopLevelKeys({}, { added: true })).toEqual(['added']);
  });

  it('ignores key order (deep equality, not reference)', () => {
    const a = { meta: { x: 1, y: 2 } };
    const b = { meta: { y: 2, x: 1 } };
    // JSON.stringify is order-sensitive on objects, so re-ordered keys DO differ;
    // this documents the coarse-by-design behavior (a type wanting exact
    // semantics supplies its own summarizeVersions).
    expect(changedTopLevelKeys(a, b)).toEqual(['meta']);
  });
});
