/**
 * CDP-1d — RFC 0128 permitted-purpose label algebra (pure). Exhaustively pins the
 * never-widen invariants the steward's `purpose-propagation-onward` scenario gates:
 * intersection composition, unlabelled = top element, `[]` = contagious/no-onward-use,
 * and the widen prohibition.
 *
 * Sabotage-witnessed (/grade-tests w38, re-probed at d5b98aafaa as w115 `w115g2-cdp-*`):
 * `normalizeLabel`'s sort, dedupe and non-array guard, `isNoOnwardUse` dropping the length check,
 * `intersectLabels`' filter (→ a union), its unlabelled skip and its all-unlabelled return,
 * `isNonWidening`'s `onw.every(...)` → `true` and its unlabelled-inbound branch, and each
 * `reEmitLabel` branch each turn a case below red. (The `selectEligible` drop is witnessed in
 * `adr1024-destination-sync-egress.test.ts` since ADR 1024 made it unconditional.)
 *
 * Production reaches this algebra through `reEmitLabel` / `intersectLabels` / `isNoOnwardUse`
 * (`routes/purposePropagationSeam.ts`, `destination-sync/destinationSyncService.ts`).
 * `isNonWidening` has no production caller; it is the invariant checker for the reEmit property
 * loop below. Since 2026-11-18 (TST-NZZ-2, owner decision) a labelled → unlabelled onward hop
 * is a violation, matching RFC 0128's "a host that simply drops the label … also fails", so the
 * property loop now reds if `reEmitLabel` ever drops a labelled grant.
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

  it('isNonWidening: the never-widen predicate (widening is the violation)', () => {
    // unlabelled inbound = no constraint ⇒ anything allowed
    expect(isNonWidening(undefined, ['analytics', 'advertising'])).toBe(true);
    // narrowing / equal ⇒ ok
    expect(isNonWidening(['analytics', 'marketing'], ['analytics'])).toBe(true);
    expect(isNonWidening(['analytics'], ['analytics'])).toBe(true);
    // dropping a label is silent loss ⇒ violation (RFC 0128 negative example; TST-NZZ-2)
    expect(isNonWidening(['analytics'], undefined)).toBe(false);
    expect(isNonWidening([], undefined)).toBe(false);
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
