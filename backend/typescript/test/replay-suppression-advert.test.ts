/**
 * RFC 0140 — what this host advertises for `replay.sideEffectSuppression`, and
 * why it is currently `none`.
 *
 * The value was `recorded-outcome` and is WITHDRAWN (ADR 0572's ruling note,
 * upstream #999 / suite 1.104.0). Nothing about the runtime got weaker: both the
 * ADR 0341 fast path and the ADR 0531 seam guards are still in place and nothing
 * escapes a replay. What changed is the reading of the requirement — requirements
 * 1 and 2 are two obligations, a guarded seam discharges "do not perform" and
 * NOT "resolve the outcome", so a throw-only path is **safe and non-conformant**.
 *
 * WHY THIS FILE EXISTS AT ALL. Before this, `sideEffectSuppression` was
 * advertised on the wire with **no test anywhere pinning its value** — grep
 * `test/` for the field and it returned nothing. So the strongest replay claim
 * this host made could have changed in either direction, silently. That is the
 * same shape as the ADR 0533 tripwire that scanned for the wrong syntax: an
 * assurance nobody could observe breaking.
 *
 * Restoring `recorded-outcome` should therefore require deleting a test that
 * says, in words, why it was withdrawn — not editing a string.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DISCOVERY = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'routes', 'discovery.ts');

describe('RFC 0140 — the replay side-effect-suppression advertisement', () => {
  it('advertises `none`, not `recorded-outcome`', () => {
    const src = readFileSync(DISCOVERY, 'utf8');
    // Match the ADVERTISED value: the object literal key, not the prose above
    // it (the docblock names `recorded-outcome` repeatedly, on purpose).
    const m = src.match(/^\s*sideEffectSuppression:\s*'([a-z-]+)',/m);
    expect(m, 'no `sideEffectSuppression` literal found — this test would pass vacuously').not.toBeNull();
    expect(m![1]).toBe('none');
  });

  it('the withdrawal carries its reason and its restore condition', () => {
    // A bare value change is a fact; a value change with the ruling attached is
    // reviewable. If someone flips this back, they have to confront both.
    const src = readFileSync(DISCOVERY, 'utf8');
    expect(src).toContain('WITHDRAWN 2026-08-15');
    expect(src).toContain('safe and non-conformant');
    // ADR 0572 Phase 3 landed (the derived floor IS the classifier now), so the
    // restore condition this used to pin — "when Phase 2 lands" — is spent. The
    // pin moves to what Phase 3 established is still MISSING, because a restore
    // condition that has already been met stops being a condition.
    expect(src).toContain('ADR 0572 PHASE 3');
    // Requirement 5 is whole-run: the ratchet reaching zero is necessary and
    // NOT sufficient, since the floor is manifest-only while requirement 5
    // binds the catalogue. Pinning this stops the next reader restoring the
    // advert on the strength of a good-looking number.
    expect(src).toContain('NECESSARY BUT NOT SUFFICIENT');
    // And the sharpest live counterexample, named rather than summarised: a
    // node whose AI reach the build-time analysis cannot follow, so a replay of
    // it THROWS instead of reproducing. (This pinned the metered media class
    // until ADR 0572 P3's mid-phase correction moved that class to SERVED —
    // a pin on a fixed problem is a pin that cannot fail.)
    expect(src).toContain('core.agents.run');
  });

  it('the runtime guards the advert used to rest on are STILL present', () => {
    // The load-bearing assertion. Withdrawing the claim must not be mistaken
    // for — or quietly become — removing the protection. If someone reads
    // `none` as "suppression is off" and deletes a seam, this goes red.
    const guard = readFileSync(join(dirname(DISCOVERY), '..', 'host', 'runEffectContext.ts'), 'utf8');
    expect(guard).toContain('replay_source_missing');
    const classifier = readFileSync(join(dirname(DISCOVERY), '..', 'executor', 'sideEffects.ts'), 'utf8');
    expect(classifier).toContain('SIDE_EFFECTING_TYPE_PATTERNS');
    // ADR 0572 P3 — and the DERIVED half, which is now the primary mechanism.
    // Deleting it would silently return 196 pack nodes to hand-list-only
    // protection, which is the drift requirement 4 exists to stop.
    expect(classifier).toContain('MANIFEST_FAST_PATH_SERVED.has(typeId)');
  });
});
