/**
 * CDP-1d — RFC 0128 permitted-purpose label algebra (pure). Exhaustively pins the
 * never-widen invariants the steward's `purpose-propagation-onward` scenario gates:
 * intersection composition, unlabelled = top element, `[]` = contagious/no-onward-use,
 * and the widen prohibition.
 *
 * Sabotage-witnessed (/grade-tests w38): `normalizeLabel`'s `out.sort()` → `out`, `isNoOnwardUse`
 * dropping the length check, `isNonWidening`'s `onw.every(...)` → `true`, `reEmitLabel`'s narrowTo
 * intersection → `normalizeLabel(narrowTo)` each turn a case below red. (The `selectEligible`
 * drop is witnessed in `adr1024-destination-sync-egress.test.ts` since ADR 1024 made it
 * unconditional.)
 */
import { describe, expect, it } from 'vitest';
import {
  normalizeLabel,
  isNoOnwardUse,
  intersectLabels,
  isNonWidening,
  reEmitLabel,
} from '../src/features/cdp/purposeLabels.js';

describe('CDP-1d purpose-label algebra (RFC 0128)', () => {
  it('normalize: absent vs [] vs set are distinct; dedupes + sorts; malformed → undefined', () => {
    expect(normalizeLabel(undefined)).toBeUndefined();
    expect(normalizeLabel(null)).toBeUndefined();
    expect(normalizeLabel('nope')).toBeUndefined(); // non-array → unlabelled (read side fail-open)
    expect(normalizeLabel([])).toEqual([]);
    expect(normalizeLabel(['marketing', 'analytics', 'analytics'])).toEqual(['analytics', 'marketing']);
  });

  it('isNoOnwardUse: only [] is the contagious no-onward-use marker', () => {
    expect(isNoOnwardUse([])).toBe(true);
    expect(isNoOnwardUse(undefined)).toBe(false); // unlabelled ≠ no-use
    expect(isNoOnwardUse(['analytics'])).toBe(false);
  });

  it('intersect: the never-widening composition of a derived output', () => {
    expect(intersectLabels([['analytics', 'marketing'], ['analytics']])).toEqual(['analytics']);
    expect(intersectLabels([['analytics'], ['marketing']])).toEqual([]); // disjoint → no shared grant
  });

  it('intersect: unlabelled inputs are the top element (contribute no constraint)', () => {
    expect(intersectLabels([undefined, ['analytics']])).toEqual(['analytics']);
    expect(intersectLabels([undefined, undefined])).toBeUndefined(); // all unlabelled ⇒ unlabelled
  });

  it('intersect: a [] input is contagious through a join', () => {
    // Asserts the RESULT, not the short-circuit: `intersectLabels`' `some(l => l.length === 0)`
    // guard is behaviourally dead (an intersection with the empty set is already []), so no
    // sabotage of that guard can redden this — w38 probe `lbl-contagious` was vacuous by
    // construction. Recorded as a grade-code row (dead guard), not a test gap.
    expect(intersectLabels([[], ['analytics']])).toEqual([]);
    expect(intersectLabels([['analytics', 'marketing'], []])).toEqual([]);
  });

  it('isNonWidening: the conformance-tested MUST NOT (widening is the violation)', () => {
    // unlabelled inbound = no constraint ⇒ anything allowed
    expect(isNonWidening(undefined, ['analytics', 'advertising'])).toBe(true);
    // narrowing / equal ⇒ ok
    expect(isNonWidening(['analytics', 'marketing'], ['analytics'])).toBe(true);
    expect(isNonWidening(['analytics'], ['analytics'])).toBe(true);
    // dropping the label is a narrowing ⇒ ok
    expect(isNonWidening(['analytics'], undefined)).toBe(true);
    // WIDENING ⇒ violation
    expect(isNonWidening(['analytics'], ['analytics', 'advertising'])).toBe(false);
    // [] inbound ⇒ nothing may be forwarded (only []/unlabelled onward)
    expect(isNonWidening([], ['analytics'])).toBe(false);
    expect(isNonWidening([], [])).toBe(true);
  });

  it('reEmit: carries the inbound grant verbatim by default; narrowTo can only tighten', () => {
    expect(reEmitLabel(['analytics', 'marketing'])).toEqual(['analytics', 'marketing']); // verbatim
    expect(reEmitLabel(['analytics', 'marketing'], ['analytics'])).toEqual(['analytics']); // narrowed
    // narrowTo cannot widen — intersection guards it
    expect(reEmitLabel(['analytics'], ['analytics', 'advertising'])).toEqual(['analytics']);
    expect(reEmitLabel(undefined)).toBeUndefined(); // unlabelled stays unlabelled
    // every reEmit result is non-widening vs its inbound (the invariant, property-checked)
    for (const inbound of [undefined, [], ['analytics'], ['analytics', 'marketing']] as const) {
      for (const narrow of [undefined, [], ['analytics'], ['advertising']] as const) {
        expect(isNonWidening(inbound, reEmitLabel(inbound, narrow))).toBe(true);
      }
    }
  });

  // The destination-sync `[]` drop moved to `adr1024-destination-sync-egress.test.ts` (D2):
  // it now also reads the erasure barrier, which needs booted persistence, and it is no
  // longer opt-in, so the "flag off ships all three" leg this file pinned is gone.
});
