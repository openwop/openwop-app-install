import { describe, it, expect } from 'vitest';

import { MAJOR2_UNDECLARED_FAMILIES } from '../conformance/major2Ledger.js';
import { buildV2Advertisement } from '../src/routes/discovery.js';
import type { AppConfig } from '../src/index.js';

/**
 * RFC 0148 §B — a host MUST NOT both advertise a profile and opt out of it.
 *
 * THE CHECK THIS FILE REPLACES DID NOT EXIST. `conformance/run.ts` carried a
 * docblock asserting the ledger "is checked against the served v2 root by the
 * certify lane"; nothing did. `family.idempotency` was advertised on the v2 root
 * while still sitting on the ledger, and every local gate stayed green — the
 * corpus caught it at suite time instead (suite 2.0.3,
 * `v2-effect-identity-business-key`), which is the expensive place to find it.
 *
 * The other side is DERIVED, never listed: `buildV2Advertisement()` is the same
 * function the route serves, so a family that starts or stops being advertised
 * moves this test with it. A hand-written mirror of the advert would reproduce
 * exactly the drift being guarded against — two lists agreeing by maintenance
 * rather than by construction.
 */
describe('RFC 0148 §B — the major-2 opt-out ledger and the served v2 root cannot both claim a family', () => {
  // A stub config is SAFE here, and the reason is worth stating rather than
  // assuming: inside `buildV2Advertisement` the config is read at exactly three
  // points — `service.{name,version,vendor}` — and at none of them does it gate
  // whether a capability family is emitted. If that ever changes, this stub would
  // start deciding the answer, and the assertion below would be measuring the
  // stub instead of the host. The `family.interrupt` floor in the vacuity test is
  // what would catch that.
  const CONFIG = { serviceName: 'test', serviceVersion: '0.0.0' } as unknown as AppConfig;

  function advertisedV2Paths(): Set<string> {
    const advert = buildV2Advertisement(CONFIG);
    const paths = new Set<string>();
    for (const [k, v] of Object.entries(advert)) {
      paths.add(`family.${k}`);
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        for (const sub of Object.keys(v as Record<string, unknown>)) paths.add(`${k}.${sub}`);
      }
    }
    return paths;
  }

  it('no ledger entry names a family the v2 root advertises', () => {
    const advertised = advertisedV2Paths();
    const contradictions = MAJOR2_UNDECLARED_FAMILIES.filter((e) => advertised.has(e));
    expect(
      contradictions,
      `these are BOTH advertised on the v2 root and listed as an honest opt-out: ${contradictions.join(', ')}. `
        + 'RFC 0148 §B forbids the pair — a reader cannot tell which claim is true. Remove the ledger row in the '
        + 'SAME commit that starts advertising (that is precisely what did not happen for `family.idempotency`).',
    ).toEqual([]);
  });

  it('the ledger is non-empty and the derivation is non-vacuous', () => {
    // Guards BOTH directions of vacuity. An empty ledger, or an `advertisedV2Paths()`
    // that returned nothing, would make the assertion above pass while measuring
    // nothing at all — the failure mode of the empty `HONESTY_PAIRS` loop this
    // test exists to replace.
    expect(MAJOR2_UNDECLARED_FAMILIES.length).toBeGreaterThan(0);
    const advertised = advertisedV2Paths();
    expect(advertised.size).toBeGreaterThan(0);
    // And the two sets must be drawn from the same namespace, or "no overlap" is
    // trivially true for the wrong reason. `family.interrupt` is advertised today.
    expect(advertised.has('family.interrupt')).toBe(true);
  });

  it('a ledger row for an advertised family is CAUGHT (sabotage)', () => {
    const advertised = advertisedV2Paths();
    const sabotaged = [...MAJOR2_UNDECLARED_FAMILIES, 'family.interrupt'];
    expect(sabotaged.filter((e) => advertised.has(e))).toEqual(['family.interrupt']);
  });
});
