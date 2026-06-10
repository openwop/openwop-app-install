/**
 * Pack-pipeline unblock (ADR 0001 §2.4/§6 Phase 3): the dev-mount prefix
 * allowlist is config-driven, and `feature.` is included by default so a
 * separately-distributed feature's packs mount through the existing pipeline.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { localPackPrefixes } from '../src/bootstrap/mountLocalPacks.js';

const ENV = 'OPENWOP_LOCAL_PACK_PREFIXES';

describe('localPackPrefixes', () => {
  afterEach(() => {
    delete process.env[ENV];
  });

  it('defaults include feature. plus the core + vendor prefixes', () => {
    delete process.env[ENV];
    const prefixes = localPackPrefixes();
    expect(prefixes).toContain('core.openwop.');
    expect(prefixes).toContain('vendor.myndhyve.');
    expect(prefixes).toContain('feature.');
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
    expect(localPackPrefixes()).toContain('feature.');
  });
});
