/**
 * gen-distribution (ADR 0366 Phase 1) — the composition gates, pinned:
 *  - default = no generation (the byte-identical guarantee);
 *  - a dependsOn-closure violation FAILS (never a silent partial build);
 *  - an unresolvable excluded id FAILS (typo/convention drift is loud);
 *  - a valid slim manifest excludes the vars from BOTH generated registries.
 */
import { describe, it, expect } from 'vitest';
import { generate, checkBundleCatalog } from '../../../scripts/gen-distribution.mjs';

describe('gen-distribution (ADR 0366 P1)', () => {
  it('default generates nothing — the checked-in registries are the build', () => {
    const r = generate('default', { write: false });
    expect(r.generated).toBe(false);
  });

  it('the slim-proof manifest validates and excludes from both registries', () => {
    const r = generate('slim-proof', { write: false });
    expect(r.generated).toBe(true);
    expect(r.excludedBackend).toContain('sales-maps');
    expect(r.excludedFrontend).toContain('commerce-ucp'); // FE-only entry resolves too
  });

  it('a closure violation fails loudly with the dependent named', () => {
    // The committed fixture excludes 'commerce' but not 'discovery', which
    // hard-depends on it (the exact violation the real slim-proof manifest
    // hit during development).
    expect(() => generate('__test-closure-violation', { write: false })).toThrowError(/'discovery' \(included\) hard-depends on 'commerce'/);
  });

  it('include-mode (Phase 4): excludable universe = registered − core; standalone features default OUT', () => {
    const r = generate('no-sales', { write: false });
    expect(r.generated).toBe(true);
    // the named bundles (commerce + its crm hard-dep) and core stay IN…
    expect(r.excludedBackend).not.toContain('commerce');
    expect(r.excludedBackend).not.toContain('crm');
    expect(r.excludedBackend).not.toContain('orgs'); // core, never excludable
    expect(r.excludedBackend).not.toContain('kb'); // always-on core, stays in
    // …every OTHER grouping is excluded (the sales bundle)…
    for (const f of ['dealers', 'sales-commissions', 'sales-maps', 'territories']) {
      expect(r.excludedBackend).toContain(f);
    }
    // …AND standalone (non-core, non-bundled) features are excluded — the
    // Phase-4 flip; under Phase-2 these unbundled ids silently stayed in.
    expect(r.excludedBackend).toContain('voice');
    expect(r.excludedBackend).toContain('forms');
  });

  it('an unknown distribution fails', () => {
    expect(() => generate('nope', { write: false })).toThrowError(/no such distribution/);
  });
});

describe('gen-distribution catalog invariants (ADR 0366 P4)', () => {
  it('the shipped bundles.json passes every catalog invariant', () => {
    expect(checkBundleCatalog()).toEqual([]);
  });

  it('flags a bundle naming an unregistered feature', () => {
    const errs = checkBundleCatalog({ core: [], bundles: { x: { label: 'X', features: ['not-a-real-feature'] } } });
    expect(errs.some((e) => /unregistered feature 'not-a-real-feature'/.test(e))).toBe(true);
  });

  it('flags a feature placed in both core and a bundle', () => {
    const errs = checkBundleCatalog({ core: ['crm'], bundles: { crmb: { label: 'C', features: ['crm'] } } });
    expect(errs.some((e) => /'crm' is in both core and bundle 'crmb'/.test(e))).toBe(true);
  });

  it('flags a feature placed in two bundles', () => {
    const errs = checkBundleCatalog({ core: [], bundles: { a: { label: 'A', features: ['crm'] }, b: { label: 'B', features: ['crm'] } } });
    expect(errs.some((e) => /'crm' is in both bundle 'a' and bundle 'b'/.test(e))).toBe(true);
  });

  it('flags a core set that is NOT dependsOn-closed (core → non-core hard dep)', () => {
    // commerce hard-depends on crm; core containing commerce but not crm is open.
    const errs = checkBundleCatalog({ core: ['commerce'], bundles: {} });
    expect(errs.some((e) => /core 'commerce' hard-depends on non-core 'crm'/.test(e))).toBe(true);
  });

  it('flags an always-on feature (no toggleDefault) left out of core', () => {
    // goals is always-on (no toggleDefault) — excluding it from core must fail.
    const errs = checkBundleCatalog({ core: [], bundles: {} });
    expect(errs.some((e) => /always-on feature 'goals'.*MUST be in core/.test(e))).toBe(true);
  });
});
