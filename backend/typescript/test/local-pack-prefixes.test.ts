/**
 * Pack-pipeline unblock (ADR 0001 §2.4/§6 Phase 3): the dev-mount prefix
 * allowlist is config-driven, and `feature.` is included by default so a
 * separately-distributed feature's packs mount through the existing pipeline.
 *
 * TST-DKE-6 (grade-tests wave 72). The default set is pinned EXACTLY (a literal,
 * not imported) — `vendor.openwop-app.` (ADR 0763, this host's agent packs) was
 * unpinned under three `toContain`s (w72 probe lp-vendorapp was vacuous). Red
 * when: a default prefix is dropped (lp-feature, lp-vendorapp), entries stop
 * being trimmed (lp-trim), or a blank env stops falling back (lp-blank).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { localPackPrefixes } from '../src/bootstrap/mountLocalPacks.js';

const ENV = 'OPENWOP_LOCAL_PACK_PREFIXES';

const DEFAULTS = ['core.openwop.', 'vendor.myndhyve.', 'vendor.openwop-app.', 'feature.'];

describe('localPackPrefixes', () => {
  const saved = process.env[ENV];
  afterEach(() => {
    if (saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
  });

  it('defaults include feature. plus the core + vendor prefixes', () => {
    delete process.env[ENV];
    expect(localPackPrefixes()).toEqual(DEFAULTS);
  });

  it('an env value REPLACES the default set', () => {
    process.env[ENV] = 'core.openwop.,vendor.acme.';
    expect(localPackPrefixes()).toEqual(['core.openwop.', 'vendor.acme.']);
  });

  it('trims and drops empty entries', () => {
    process.env[ENV] = ' core.openwop. , , feature. ';
    expect(localPackPrefixes()).toEqual(['core.openwop.', 'feature.']);
  });

  it('falls back to defaults when the env is blank', () => {
    process.env[ENV] = '   ';
    expect(localPackPrefixes()).toEqual(DEFAULTS);
  });
});
