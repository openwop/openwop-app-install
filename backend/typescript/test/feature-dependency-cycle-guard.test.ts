/**
 * ADR 0439 — the dependency cycle guard in `registerFeatureDependencies`.
 *
 * `computeDisableBlockers` is ONE HOP, so a dependency cycle never hangs — it
 * silently makes every feature in the cycle permanently mutually undisableable
 * (each is always "required by" the next) with no error anywhere. Nothing
 * previously prevented that, and the real IMPORT graph already contains 16 cycles,
 * so a future declaration closing one is a live hazard.
 *
 * Two properties matter as much as the detection itself, and both are pinned here
 * because getting either wrong makes the guard worse than the disease:
 *
 *  1. It drops the offending EDGE, never the map KEY. The `dependencies` map's keys
 *     are the authoritative registered-feature set (`listRegisteredFeatureIds`,
 *     consumed by the bundle-catalog projection). Refusing the whole registration
 *     would make the feature look UNREGISTERED and fail `gen-distribution --check`
 *     with "core names unregistered feature" — a worse failure than the cycle.
 *  2. It never throws. This runs at boot for every feature; one bad declaration must
 *     not take the service down over a lock-STRENGTH concern. Dropping the edge
 *     reproduces exactly today's behaviour (the edge does not exist now either).
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  registerFeatureDependencies,
  getFeatureDependencies,
  getFeatureDependents,
  listRegisteredFeatureIds,
  enforcedFeatureDependencies,
  __resetFeatureDependencies,
} from '../src/host/featureToggles/registry.js';

afterEach(() => { __resetFeatureDependencies(); });

describe('ADR 0439 — dependency cycle guard', () => {
  it('keeps an acyclic chain intact', () => {
    registerFeatureDependencies('a', ['b']);
    registerFeatureDependencies('b', ['c']);
    registerFeatureDependencies('c', []);
    expect(getFeatureDependencies('a')).toEqual(['b']);
    expect(getFeatureDependencies('b')).toEqual(['c']);
    expect(getFeatureDependents('c')).toEqual(['b']);
  });

  it('drops the edge that would close a 2-cycle, keeping the other direction', () => {
    registerFeatureDependencies('commerce', ['crm']);
    registerFeatureDependencies('crm', ['commerce']); // would close commerce ⇄ crm
    expect(getFeatureDependencies('commerce')).toEqual(['crm']); // first edge survives
    expect(getFeatureDependencies('crm')).toEqual([]);           // closing edge dropped
  });

  it('drops the edge that would close a LONGER cycle (transitive, not just direct)', () => {
    registerFeatureDependencies('a', ['b']);
    registerFeatureDependencies('b', ['c']);
    registerFeatureDependencies('c', ['a']); // a → b → c → a
    expect(getFeatureDependencies('c')).toEqual([]);
  });

  it('drops a self-edge', () => {
    registerFeatureDependencies('solo', ['solo']);
    expect(getFeatureDependencies('solo')).toEqual([]);
  });

  it('KEEPS THE KEY when every edge is dropped — the registered-feature set is intact', () => {
    // The failure mode this guards: losing the key would drop the id from
    // listRegisteredFeatureIds(), which the bundle catalog uses to decide
    // `registered` — and gen-distribution errors on an unregistered core feature.
    registerFeatureDependencies('x', ['y']);
    registerFeatureDependencies('y', ['x']); // y's only edge is dropped
    expect(getFeatureDependencies('y')).toEqual([]);
    expect(listRegisteredFeatureIds().sort()).toEqual(['x', 'y']);
  });

  it('never throws — a cyclic declaration must not take boot down', () => {
    expect(() => {
      registerFeatureDependencies('p', ['q']);
      registerFeatureDependencies('q', ['p']);
    }).not.toThrow();
  });

  it('keeps non-cyclic siblings when only one edge in the list is cyclic', () => {
    registerFeatureDependencies('a', ['b']);
    registerFeatureDependencies('b', ['a', 'c', 'd']); // only `a` closes a cycle
    expect(getFeatureDependencies('b')).toEqual(['c', 'd']);
  });

  it('is idempotent on hot-reload (last declaration wins, re-checked)', () => {
    registerFeatureDependencies('a', ['b']);
    registerFeatureDependencies('a', ['c']);
    expect(getFeatureDependencies('a')).toEqual(['c']);
  });

  it('the ENFORCED graph is what the source declares — no phantom locks', () => {
    // If the runtime silently drops an edge while the `dependsOn: [...]` stays in
    // source, the source LIES: a reader sees a lock that is not enforced. The
    // parity test asserts the real catalog is acyclic so nothing is ever dropped;
    // this pins the projection those two agree through.
    registerFeatureDependencies('a', ['b']);
    registerFeatureDependencies('b', []);
    expect(enforcedFeatureDependencies()).toEqual({ a: ['b'], b: [] });
  });
});
