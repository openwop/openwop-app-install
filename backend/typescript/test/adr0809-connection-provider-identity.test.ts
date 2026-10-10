/**
 * ADR 0809 — connection-pack provider identity at major 2 (`connection-packs.md`
 * §"Provider identity" + §"The qualified form", RFC 0177 §D.1), with v1 §B.6
 * precedence kept for every pack that still admits major 1.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { installConnectionPackManifest, seamResolveProvider } from '../src/features/connections/connectionPackLoader.js';
import { getProvider, listProviders } from '../src/features/connections/providerRegistry.js';

type Manifest = Record<string, unknown> & { name: string; version: string; provider: Record<string, unknown> & { id: string } };
const BASE = JSON.parse(readFileSync(join(process.cwd(), '../../conformance-fixtures/connection-packs/connection-pack-acme-widgets.json'), 'utf8')) as Manifest;
let n = 0;
/** A manifest with a FRESH provider id per test, so tests cannot see each other. */
function pack(over: { id?: string; name?: string; version?: string; engines?: string }): Manifest {
  return {
    ...BASE,
    name: over.name ?? `vendor.test.adr0809-${n++}`,
    version: over.version ?? '1.0.0',
    engines: { openwop: over.engines ?? '>=2.0.0 <3.0.0' },
    provider: { ...BASE.provider, id: over.id ?? BASE.provider.id },
  };
}
const codes = (r: ReturnType<typeof installConnectionPackManifest>): string[] => (r.errors ?? []).map((e) => e.code);
/** A BUILT-IN id, captured before any test installs a pack: `listProviders()` is
 *  label-sorted, so after an install its first entry can be a pack. */
const BUILTIN = listProviders()[0]!.id;

describe('ADR 0809 — a v2-only pack: one definition per bare id, no version precedence', () => {
  it('the later registration of a bare id is refused, even at a HIGHER version', () => {
    const id = `acme-0809-a-${Date.now()}`;
    expect(installConnectionPackManifest(pack({ id, name: 'vendor.test.first-a' })).installed).toBe(true);
    const later = installConnectionPackManifest(pack({ id, name: 'vendor.test.second-a', version: '9.0.0' }));
    expect(later.installed).toBe(false);
    expect(codes(later)).toContain('connection_provider_conflict');
  });

  it('a v2-only pack may not shadow a built-in', () => {
    const r = installConnectionPackManifest(pack({ id: BUILTIN, name: 'vendor.test.shadow' }));
    expect(r.installed).toBe(false);
    expect(codes(r)).toContain('connection_provider_conflict');
  });

  it('re-registering the SAME pack is not a second definition', () => {
    const id = `acme-0809-b-${Date.now()}`;
    const m = pack({ id, name: 'vendor.test.same' });
    expect(installConnectionPackManifest(m).installed).toBe(true);
    expect(installConnectionPackManifest(m).installed).toBe(true);
  });

  it('the qualified form resolves only to the named pack\'s definition', () => {
    const id = `acme-0809-c-${Date.now()}`;
    expect(installConnectionPackManifest(pack({ id, name: 'vendor.test.owner' })).installed).toBe(true);
    expect(seamResolveProvider(`vendor.test.owner#${id}`)).toMatchObject({ resolved: true, source: 'pack' });
    expect(getProvider(`vendor.test.owner#${id}`)?.id).toBe(id);
    // Another pack's name, or a built-in's id, never resolves through the qualified form.
    expect(seamResolveProvider(`vendor.test.someone-else#${id}`)).toMatchObject({ resolved: false, code: 'connection_provider_unresolved' });
    expect(getProvider(`vendor.test.owner#${BUILTIN}`)).toBeNull();
  });
});

describe('ADR 0809 — a pack that still admits major 1 keeps v1 §B.6 precedence', () => {
  it('a higher version supersedes; a lower one is refused', () => {
    const id = `acme-0809-d-${Date.now()}`;
    expect(installConnectionPackManifest(pack({ id, name: 'vendor.test.v1-a', engines: '>=1.0.0 <3.0.0', version: '1.0.0' })).installed).toBe(true);
    expect(installConnectionPackManifest(pack({ id, name: 'vendor.test.v1-b', engines: '>=1.0.0 <3.0.0', version: '1.1.0' })).installed).toBe(true);
    const lower = installConnectionPackManifest(pack({ id, name: 'vendor.test.v1-c', engines: '>=1.0.0 <3.0.0', version: '1.0.5' }));
    expect(lower.installed).toBe(false);
    expect(codes(lower)).toContain('connection_provider_conflict');
  });
});
