/**
 * RFC 0114 — A2UI surface delta core (diff/apply). Verifies the load-bearing
 * round-trip (apply(prev, diff(prev,next)) deep-equals next) over a2ui-surface-
 * shaped trees, and the fail-closed behaviors (malformed path / `test` op throw).
 */
import { describe, expect, it } from 'vitest';
import {
  diffSurface,
  applyPatch,
  projectA2uiDelivery,
  type PatchOp,
  type A2uiDeltaState,
} from '../src/host/a2uiSurfaceDelta.js';

const BASE = {
  title: 'Schedule the kickoff',
  components: [
    { component: 'text', text: 'A couple of details.' },
    { component: 'field.date', id: 'date', label: 'Date', required: true },
    { component: 'action.button', id: 'confirm', label: 'Confirm', action: { target: 'resume' } },
  ],
};

function roundtrip(prev: unknown, next: unknown) {
  const ops = diffSurface(prev, next);
  expect(applyPatch(prev, ops)).toEqual(next);
  return ops;
}

describe('RFC 0114 — diffSurface/applyPatch round-trip', () => {
  it('replace a primitive deep in the tree', () => {
    const next = { ...BASE, components: BASE.components.map((c, i) => (i === 1 ? { ...c, label: 'Pick a date' } : c)) };
    const ops = roundtrip(BASE, next);
    expect(ops).toEqual([{ op: 'replace', path: '/components/1/label', value: 'Pick a date' }]);
  });

  it('add a new object key', () => {
    const next = { ...BASE, subtitle: 'now' };
    const ops = roundtrip(BASE, next);
    expect(ops).toContainEqual({ op: 'add', path: '/subtitle', value: 'now' });
  });

  it('remove an object key', () => {
    const start = { ...BASE, subtitle: 'x' };
    roundtrip(start, BASE);
  });

  it('array length change → whole-array replace (correct, coarse)', () => {
    const next = { ...BASE, components: BASE.components.slice(0, 2) };
    const ops = roundtrip(BASE, next);
    expect(ops).toEqual([{ op: 'replace', path: '/components', value: next.components }]);
  });

  it('identical surfaces produce no ops', () => {
    expect(diffSurface(BASE, structuredClone(BASE))).toEqual([]);
  });

  it('JSON Pointer escaping (~ and /) round-trips', () => {
    const prev = { 'a/b': 1, 'c~d': 2 };
    roundtrip(prev, { 'a/b': 9, 'c~d': 2 });
  });
});

describe('RFC 0114 — applyPatch fail-closed', () => {
  it('rejects a `test` op (forbidden on the wire)', () => {
    expect(() => applyPatch(BASE, [{ op: 'test', path: '/title', value: 'x' } as unknown as PatchOp])).toThrow();
  });
  it('throws on a missing path (caller re-materializes full)', () => {
    expect(() => applyPatch(BASE, [{ op: 'remove', path: '/nope/0/deep' }])).toThrow();
  });
  it('supports move/copy in apply even though the differ does not emit them', () => {
    const doc = { a: { x: 1 }, b: {} };
    expect(applyPatch(doc, [{ op: 'move', from: '/a/x', path: '/b/y' }])).toEqual({ a: {}, b: { y: 1 } });
    expect(applyPatch(doc, [{ op: 'copy', from: '/a/x', path: '/b/y' }])).toEqual({ a: { x: 1 }, b: { y: 1 } });
  });
});

describe('RFC 0114 — projectA2uiDelivery (per-connection transport)', () => {
  const s1 = { catalogVersion: '0.9.1', surface: BASE };
  const s2 = { catalogVersion: '0.9.1', surface: { ...BASE, title: 'Reschedule' } };

  it('first surface is always full; the next (opted-in, same catalog) is a delta that reconstructs', () => {
    const st: A2uiDeltaState = {};
    expect(projectA2uiDelivery(st, 'evt_1', s1, true)).toEqual({ kind: 'full' });
    const out = projectA2uiDelivery(st, 'evt_2', s2, true);
    expect(out.kind).toBe('delta');
    if (out.kind === 'delta') {
      expect(out.frame.surfaceRef).toBe('evt_1'); // baseline full event id
      expect(out.frame.catalogVersion).toBe('0.9.1');
      // reconstruct: applying the patch to the baseline yields the new surface
      expect(applyPatch(s1.surface, out.frame.patch)).toEqual(s2.surface);
    }
  });

  it('a subscriber WITHOUT opt-in always gets full', () => {
    const st: A2uiDeltaState = {};
    expect(projectA2uiDelivery(st, 'evt_1', s1, false).kind).toBe('full');
    expect(projectA2uiDelivery(st, 'evt_2', s2, false).kind).toBe('full');
  });

  it('a catalogVersion change forces a fresh full (never a cross-version delta)', () => {
    const st: A2uiDeltaState = {};
    projectA2uiDelivery(st, 'evt_1', s1, true);
    const bumped = { catalogVersion: '0.9.2', surface: s2.surface };
    expect(projectA2uiDelivery(st, 'evt_2', bumped, true).kind).toBe('full');
  });

  it('an unchanged surface delivers full (empty diff is not a delta frame)', () => {
    const st: A2uiDeltaState = {};
    projectA2uiDelivery(st, 'evt_1', s1, true);
    expect(projectA2uiDelivery(st, 'evt_2', { ...s1 }, true).kind).toBe('full');
  });

  it('chains: delta N+1 is against the last-delivered tree, surfaceRef stable', () => {
    const st: A2uiDeltaState = {};
    const s3 = { catalogVersion: '0.9.1', surface: { ...BASE, title: 'Final' } };
    projectA2uiDelivery(st, 'evt_1', s1, true);
    projectA2uiDelivery(st, 'evt_2', s2, true);
    const out = projectA2uiDelivery(st, 'evt_3', s3, true);
    expect(out.kind).toBe('delta');
    if (out.kind === 'delta') {
      expect(out.frame.surfaceRef).toBe('evt_1'); // chain keeps the baseline ref
      expect(applyPatch(s2.surface, out.frame.patch)).toEqual(s3.surface); // against last-delivered (s2)
    }
  });
});
