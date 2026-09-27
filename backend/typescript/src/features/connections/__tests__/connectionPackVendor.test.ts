/**
 * RFC 0123 — connection-pack `provider.vendor` host honoring (ADR 0185 follow-on).
 *
 * The witness that graduates RFC 0123 on this host: a pack-delivered connector that
 * declares the additive OPTIONAL `provider.vendor` (1) VALIDATES against the §A schema
 * (previously `additionalProperties:false` rejected it), and (2) is surfaced with that
 * vendor on its `ProviderManifest`, so the ADR 0185 connector catalog groups it under
 * its declared commercial vendor exactly as the built-ins group. A pack WITHOUT vendor
 * stays valid and falls back to its own label — presentational only, gates nothing.
 */
import { describe, it, expect } from 'vitest';
import { installConnectionPackManifest, resolveConnectionProviderOrThrow } from '../connectionPackLoader.js';

function manifest(providerId: string, vendor?: string): unknown {
  return {
    name: `community.test.${providerId}`,
    version: '1.0.0',
    kind: 'connection',
    engines: { openwop: '>=1.0.0' },
    provider: {
      id: providerId,
      displayName: 'RFC 0123 Test Connector',
      ...(vendor ? { vendor } : {}),
      category: 'other',
      auth: { kind: 'api_key' },
      reach: { integration: { node: 'core.openwop.integration.test' } },
    },
  };
}

describe('RFC 0123 connection-pack provider.vendor', () => {
  it('accepts a pack declaring provider.vendor and surfaces it for catalog grouping', () => {
    const outcome = installConnectionPackManifest(manifest('v123google', 'Google'));
    expect(outcome.installed, JSON.stringify(outcome.errors)).toBe(true);
    // Honored: the resolved provider carries the declared vendor → ADR 0185 catalog
    // groups this pack-delivered connector under "Google" (same field the built-ins use).
    expect(resolveConnectionProviderOrThrow('v123google').vendor).toBe('Google');
  });

  it('stays valid WITHOUT provider.vendor and falls back to own-label grouping', () => {
    const outcome = installConnectionPackManifest(manifest('v123novendor'));
    expect(outcome.installed, JSON.stringify(outcome.errors)).toBe(true);
    expect(resolveConnectionProviderOrThrow('v123novendor').vendor).toBeUndefined();
  });

  it('honors an arbitrary free-form vendor string (no enum — RFC 0123 is presentational)', () => {
    const outcome = installConnectionPackManifest(manifest('v123workday', 'Workday'));
    expect(outcome.installed, JSON.stringify(outcome.errors)).toBe(true);
    expect(resolveConnectionProviderOrThrow('v123workday').vendor).toBe('Workday');
  });

  it('rejects a non-string vendor at the §A schema (free-form ≠ untyped)', () => {
    // vendor is `type:string` — a number/object must fail validation, not silently install.
    const outcome = installConnectionPackManifest({
      name: 'community.test.v123badtype',
      version: '1.0.0',
      kind: 'connection',
      engines: { openwop: '>=1.0.0' },
      provider: {
        id: 'v123badtype',
        displayName: 'RFC 0123 Test Connector',
        vendor: 123,
        category: 'other',
        auth: { kind: 'api_key' },
        reach: { integration: { node: 'core.openwop.integration.test' } },
      },
    });
    expect(outcome.installed).toBe(false);
  });

  it('accepts a long vendor string — the ACCEPTED RFC 0123 schema dropped the draft maxLength bound (openwop#851)', () => {
    // The draft schema bounded vendor to 128 chars ("catalog-heading length");
    // the Accepted wording made it free-form so a new vendor never needs a
    // schema change. The app validates against the vendored canonical schema,
    // so a conformant host accepts it (the catalog UI truncates for display).
    const outcome = installConnectionPackManifest(manifest('v123long', 'V'.repeat(129)));
    expect(outcome.installed).toBe(true);
  });
});
