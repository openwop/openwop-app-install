/**
 * ADR 0820 §1 — every id in `distributions/bundles.json` is a REGISTERED toggle id.
 *
 * The paywall keys on the TOGGLE id: `isSellableBundleFeature(id)` is asked with the
 * id a gate resolves, and `resolveEntitlements` unions a grant's bundle ids into
 * `allowedFeatures`. `gen-distribution --check` validates bundle ids against the
 * FEATURE ids it derives from import names, and those are not always the toggle id.
 * MEASURED 2026-10-05: the priced `agents` bundle listed `twin`, whose toggle is
 * `twin-recall`, so the twin was never paywalled on any lane — buyers paid for a
 * feature every tenant already had, and `--check` stayed green.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { listToggleDefaults, registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { BACKEND_FEATURES } from '../src/features/index.js';

const BUNDLES = join(import.meta.dirname, '../../../distributions/bundles.json');
const SRC = join(import.meta.dirname, '../src');

/** Toggles a feature registers imperatively inside its route registrar
 *  (`registerToggleDefault({ id: '…' })`, e.g. commerce's `commerce-ucp`), which a
 *  boot-free test cannot run. Read from source so they count as registered. */
function imperativeToggleIds(dir = SRC, out = new Set<string>()): Set<string> {
  for (const e of readdirSync(dir)) {
    if (e === '__tests__') continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) imperativeToggleIds(p, out);
    else if (p.endsWith('.ts')) {
      for (const m of readFileSync(p, 'utf8').matchAll(/registerToggleDefault\(\{\s*id:\s*'([^']+)'/g)) out.add(m[1]!);
    }
  }
  return out;
}

describe('ADR 0820 — bundle ids are toggle ids', () => {
  for (const f of BACKEND_FEATURES) {
    if (f.toggleDefault) registerToggleDefault(f.toggleDefault);
    for (const t of f.extraToggleDefaults ?? []) registerToggleDefault(t);
  }
  const registered = new Set([...listToggleDefaults().map((t) => t.id), ...imperativeToggleIds()]);
  const catalog = JSON.parse(readFileSync(BUNDLES, 'utf8')) as { bundles: Record<string, { features: string[] }> };
  const bundled = Object.entries(catalog.bundles).flatMap(([b, d]) => d.features.map((f) => [b, f] as const));

  it('non-vacuity: the registry and the catalog are both populated', () => {
    expect(registered.size).toBeGreaterThan(50);
    expect(bundled.length).toBeGreaterThan(10);
  });

  it('every bundle feature names a registered toggle default (else it can never be paywalled)', () => {
    const offenders = bundled.filter(([, f]) => !registered.has(f)).map(([b, f]) => `${b} → '${f}'`);
    expect(offenders, 'a bundle id that is not a toggle id is sold but never gated').toEqual([]);
  });
});
