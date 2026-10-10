/**
 * gen-distribution (ADR 0366 Phase 1) — the composition gates, pinned:
 *  - default = no generation (the byte-identical guarantee);
 *  - a dependsOn-closure violation FAILS (never a silent partial build);
 *  - an unresolvable excluded id FAILS (typo/convention drift is loud);
 *  - a valid slim manifest excludes the vars from BOTH generated registries.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generate, checkBundleCatalog, subToggleParents } from '../../../scripts/gen-distribution.mjs';

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

  it('flags a frontend-only always-on feature left out of core (core-audit M10)', () => {
    // access-hub has no backend half and no toggle names it — the old
    // backend-directory scan could not see it, so dropping it from core passed.
    const real = JSON.parse(JSON.stringify(catalogOf())) as { core: string[]; bundles: Record<string, { label: string; features: string[] }> };
    real.core = real.core.filter((f) => f !== 'access-hub');
    const errs = checkBundleCatalog(real);
    expect(errs.some((e) => /always-on feature 'access-hub'.*MUST be in core/.test(e))).toBe(true);
  });

  it('a frontend-only feature gated by a registered toggle is NOT always-on (positive control)', () => {
    // design-system-gallery is frontend-only, standalone, and gated on `developer-tools`.
    expect(checkBundleCatalog().some((e) => /'design-system-gallery'/.test(e))).toBe(false);
  });
});

describe('gen-distribution store groups (ADR 0820 §7 UI — grouping is data)', () => {
  type Cat = { core: string[]; groups?: unknown; bundles: Record<string, { label: string; group?: unknown; features: string[] }> };
  const real = (): Cat => JSON.parse(JSON.stringify(catalogOf())) as Cat;

  it('the shipped catalog declares groups and every bundle names a declared one (positive control)', () => {
    const cat = real();
    expect(Array.isArray(cat.groups)).toBe(true);
    for (const def of Object.values(cat.bundles)) expect((cat.groups as string[]).includes(def.group as string)).toBe(true);
    expect(checkBundleCatalog(cat).filter((e) => /group/.test(e))).toEqual([]);
  });

  it('flags a bundle whose group is not declared in `groups`', () => {
    const cat = real();
    cat.bundles.crm!.group = 'not-a-group';
    expect(checkBundleCatalog(cat).some((e) => /bundle 'crm' names group 'not-a-group'/.test(e))).toBe(true);
  });

  it('flags a non-string group and a malformed or duplicated `groups` list', () => {
    const cat = real();
    cat.bundles.crm!.group = 7;
    expect(checkBundleCatalog(cat).some((e) => /bundle 'crm' names group '7'/.test(e))).toBe(true);
    expect(checkBundleCatalog({ ...real(), groups: ['Sell Grow'] }).some((e) => /kebab-case group ids/.test(e))).toBe(true);
    expect(checkBundleCatalog({ ...real(), groups: ['a', 'a'] }).some((e) => /lists a group id twice/.test(e))).toBe(true);
  });

  it('a bundle with no group is allowed (the field is optional)', () => {
    const cat = real();
    delete cat.bundles.crm!.group;
    expect(checkBundleCatalog(cat).filter((e) => /group/.test(e))).toEqual([]);
  });
});

describe('gen-distribution sub-toggle bundle members (ADR 0820 §1 alt (b) / §4)', () => {
  it('reads sub-toggles from all three declaration shapes, each mapped to its parent', () => {
    const subs = subToggleParents();
    expect(subs.get('code-export')).toBe('app-builder'); // imperative registerToggleDefault
    expect(subs.get('service-desk.widget')).toBe('service-desk'); // extraToggleDefaults
    expect(subs.get('settings-shell')).toBe('settings'); // primary toggleDefault id ≠ package id
    expect(subs.has('app-builder')).toBe(false); // a FEATURE id is never a sub-toggle
  });

  it('accepts a sub-toggle whose parent is in the same bundle', () => {
    const errs = checkBundleCatalog({ core: [], bundles: { ab: { label: 'AB', features: ['app-builder', 'code-export'] } } });
    expect(errs.filter((e) => /code-export/.test(e))).toEqual([]);
  });

  it('accepts a sub-toggle whose parent is core', () => {
    const errs = checkBundleCatalog({ core: ['cms'], bundles: { c: { label: 'C', features: ['cms-localization'] } } });
    expect(errs.filter((e) => /cms-localization/.test(e))).toEqual([]);
  });

  it('flags a sub-toggle whose parent ships in neither the bundle nor core', () => {
    const errs = checkBundleCatalog({ core: [], bundles: { x: { label: 'X', features: ['code-export'] } } });
    expect(errs.some((e) => /sub-toggle 'code-export' but not its parent feature 'app-builder'/.test(e))).toBe(true);
  });

  it('still flags an id that is neither a feature nor a toggle', () => {
    const errs = checkBundleCatalog({ core: [], bundles: { x: { label: 'X', features: ['code-exportt'] } } });
    expect(errs.some((e) => /unregistered feature 'code-exportt'/.test(e))).toBe(true);
  });

  it('a sub-toggle strips nothing: it never joins the excludable universe', () => {
    const r = generate('no-sales', { write: false });
    expect(r.excludedBackend).not.toContain('code-export');
    expect(r.excludedBackend).toContain('app-builder'); // its parent is excluded as a FEATURE
  });

  it('an include manifest naming a sub-toggle without its parent fails loudly', () => {
    expect(() => generate('__test-orphan-subtoggle', { write: false })).toThrowError(/'code-export' \(parent 'app-builder'\)/);
  });
});

function catalogOf(): unknown {
  return JSON.parse(readFileSync(join(import.meta.dirname, '../../../distributions/bundles.json'), 'utf8'));
}

