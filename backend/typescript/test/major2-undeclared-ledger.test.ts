import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

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
 *
 * TST-DKD-5 (grade-tests wave 72). The stub config is now a typed `AppConfig`
 * (no cast). Red when (w72 probe m2-ledger): a ledger row names a family the
 * v2 root advertises.
 */
describe('RFC 0148 §B — the major-2 opt-out ledger and the served v2 root cannot both claim a family', () => {
  // A stub config is SAFE here, and the reason is worth stating rather than
  // assuming: inside `buildV2Advertisement` the config is read at exactly three
  // points — `service.{name,version,vendor}` — and at none of them does it gate
  // whether a capability family is emitted. If that ever changes, this stub would
  // start deciding the answer, and the assertion below would be measuring the
  // stub instead of the host. The `family.interrupt` floor in the vacuity test is
  // what would catch that.
  const CONFIG: AppConfig = { port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.0', enableConsoleTracer: false };

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

/**
 * Every v2 family the INSTALLED suite gates on is either advertised or on the ledger.
 *
 * Suite 2.49.0 added `gateFamily('budget')` and `gateFamily('production')`. The host
 * serves neither, and neither had a ledger row. The gate's m2 lane runs without
 * `OPENWOP_REQUIRE_BEHAVIOR`, so both read `inapplicable` and the gate stayed green.
 * The strict prod cut (bff8b2dfd) recorded seven `executed-fail` rows on behaviorGate
 * alone. This reads the gates from the pinned suite's own scenario sources, so a pin
 * bump that brings a new gated family fails here, before any cut.
 *
 * Red when (sabotage witness): drop `'family.budget'` from the ledger, or pin a suite
 * that gates on a family the host neither advertises nor opts out of.
 */
describe('every family the pinned suite gates on is advertised or opted out (suite pin bumps)', () => {
  const CONFIG: AppConfig = { port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.0', enableConsoleTracer: false };
  const SCENARIOS = join(dirname(createRequire(import.meta.url).resolve('@openwop/openwop-conformance/package.json')), 'src', 'scenarios');

  function gatedFamilies(): Set<string> {
    const keys = new Set<string>();
    for (const f of readdirSync(SCENARIOS)) {
      if (!f.endsWith('.ts')) continue;
      for (const m of readFileSync(join(SCENARIOS, f), 'utf8').matchAll(/\bgateFamily\(\s*['"]([A-Za-z][A-Za-z0-9]*)['"]\s*\)/g)) keys.add(m[1]!);
    }
    return keys;
  }

  it('reads a real gate list from the installed suite', () => {
    const gated = gatedFamilies();
    // `interrupt` and `replay` are gated by many scenarios and advertised today; an
    // empty read would make the check below pass while measuring nothing.
    expect(gated.has('interrupt')).toBe(true);
    expect(gated.size).toBeGreaterThan(5);
  });

  // A family advertised only when the deploy turns it on. The strict cut reads the
  // DEPLOYED root, and the production deploy sets each of these (the bff8b2dfd cut's
  // discovery carries `loopback`), so this test builds the advertisement with them on.
  // Each entry is checked below to be really env-gated, so a stale row cannot hide a
  // family that is never advertised.
  const ENV_GATED: Record<string, string> = { loopback: 'OPENWOP_BOUNDED_LOOPBACK' };

  function advertWith(on: boolean): Record<string, unknown> {
    const saved = Object.fromEntries(Object.values(ENV_GATED).map((k) => [k, process.env[k]]));
    try {
      for (const k of Object.values(ENV_GATED)) { if (on) process.env[k] = 'true'; else delete process.env[k]; }
      return buildV2Advertisement(CONFIG) as Record<string, unknown>;
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  }

  it('each env-gated family is advertised exactly when its switch is on', () => {
    const off = advertWith(false);
    const on = advertWith(true);
    for (const family of Object.keys(ENV_GATED)) {
      expect(family in off, `${family} is advertised with its switch off — drop it from ENV_GATED`).toBe(false);
      expect(family in on, `${family} is not advertised with ${ENV_GATED[family]} on`).toBe(true);
    }
  });

  it('no gated family is both unadvertised and missing from the ledger', () => {
    const advert = advertWith(true);
    const ledger = new Set<string>(MAJOR2_UNDECLARED_FAMILIES);
    const uncovered = [...gatedFamilies()].filter((k) => !(k in advert) && !ledger.has(`family.${k}`)).sort();
    expect(
      uncovered,
      `the pinned suite gates on ${uncovered.map((k) => `family.${k}`).join(', ')}, which the v2 root does not advertise `
        + 'and the ledger does not opt out of. A strict cut records every leg behind those gates as executed-fail. '
        + 'Advertise the family (if the host serves it) or add an honest ledger row with its reason.',
    ).toEqual([]);
  });
});
