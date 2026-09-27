/**
 * ADR 0711 option B (SPA half) — a REPORTED default is never laundered into a CHOICE.
 *
 * The server now answers `GET /byok/active-config` with the effective managed default
 * and `stored: false` when nothing is bound. `useBYOKConfig` caches any binding it is
 * given, so without a discriminator the fallback would be written to localStorage as
 * though the user had picked it: it would survive after an operator set a real binding,
 * and the heal path would re-PUT it — which for a plain member now 403s.
 *
 * Absent `stored` must read as "stored", not as "default": an older server omits the
 * field, and treating that as a default would stop caching real bindings.
 *
 * WHAT THIS FILE CAN AND CANNOT SEE, stated rather than implied. Legs 1-3 assert a
 * RE-IMPLEMENTATION of the rule — a mirror, not an oracle, and on its own it would prove
 * that a copy of the rule behaves, exactly the defect an architect pass caught in the
 * steward ratchet. Leg 4 is what ties it to the shipped code: it reads the hook and fails
 * if the predicate is no longer there. Neither is a behavioural test of `useBYOKConfig`
 * (that needs the React harness plus a mocked transport), and that remains the gap — a
 * behavioural witness would assert on `localStorage` after a refresh, and is the right
 * follow-up if this rule ever grows a second branch.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/** The exact rule the hook applies, extracted so it can be asserted directly. */
function shouldCache(envelope: { stored?: boolean }): boolean {
  return envelope.stored !== false;
}

describe('ADR 0711 — the managed default is reported, never cached as a choice', () => {
  it('a reported default (stored:false) is NOT cached', () => {
    expect(shouldCache({ stored: false })).toBe(false);
  });

  it('a chosen binding (stored:true) IS cached', () => {
    expect(shouldCache({ stored: true })).toBe(true);
  });

  it('an OLDER server that omits `stored` is treated as stored — never as a default', () => {
    // The compatibility direction that matters. Reading absent-as-default would stop
    // caching genuine bindings for every client talking to a server that predates this
    // field, which is a worse failure than the one the flag exists to prevent.
    expect(shouldCache({})).toBe(true);
  });

  it('leg 4: the HOOK still applies this exact predicate — legs 1-3 are a mirror without it', () => {
    const src = readFileSync(path.join(import.meta.dirname, '..', 'useBYOKConfig.ts'), 'utf8');
    expect(
      src.includes('envelope.stored !== false'),
      'useBYOKConfig no longer guards the cache write on `stored` — the legs above are now '
      + 'asserting a rule the product does not apply',
    ).toBe(true);
  });
});
