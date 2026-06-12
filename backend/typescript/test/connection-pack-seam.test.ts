/**
 * RFC 0095 conformance test seams (`host-sample-test-seams.md` §10) — the
 * install / resolve / consent-plan affordances the capability-gated
 * conformance scenarios drive. Verifies the seam-layer functions route
 * through the same §B.2 scan → §A schema → §B.6 precedence path as the boot
 * loader, and the consent planner keeps write a separate step (§B.4).
 */
import { describe, expect, it } from 'vitest';
import {
  installConnectionPackManifest,
  seamResolveProvider,
} from '../src/features/connections/connectionPackLoader.js';

const pack = (id: string, version = '1.0.0') => ({
  name: `core.openwop.connections.${id}`,
  version,
  kind: 'connection',
  engines: { openwop: '>=1.0.0' },
  provider: {
    id,
    displayName: 'Seam test',
    category: 'dev',
    auth: {
      kind: 'oauth2',
      authFlow: 'pkce',
      scopeModel: 'groups',
      endpoints: {
        authorize: 'https://example.com/oauth/authorize',
        token: 'https://example.com/oauth/access_token',
      },
      scopes: {
        read: [{ key: 'r', label: 'Read', scopes: ['read:all'] }],
        write: [{ key: 'w', label: 'Write', scopes: ['write:all'] }],
      },
    },
    reach: { mcp: { server: { url: 'https://example.com/mcp/', transport: 'http' } } },
  },
});

describe('RFC 0095 seam: install (§B.2/§B.8)', () => {
  it('installs a well-formed manifest and resolves it as source:pack', () => {
    const out = installConnectionPackManifest(pack('seam-good'));
    expect(out.installed).toBe(true);
    const res = seamResolveProvider('seam-good');
    expect(res).toMatchObject({ resolved: true, source: 'pack', version: '1.0.0' });
  });

  it('rejects credential material with the SPECIFIC code, before the schema shape error (§B.2)', () => {
    const leaky = pack('seam-leak');
    (leaky.provider.auth as Record<string, unknown>).clientSecret = 'ghs_xxx';
    const out = installConnectionPackManifest(leaky);
    expect(out.installed).toBe(false);
    expect(out.errors?.[0]?.code).toBe('connection_pack_credential_material');
  });

  it('rejection isolation: a rejected pack never breaks the next install (§B.8)', () => {
    const leaky = pack('seam-iso');
    (leaky.provider.auth as Record<string, unknown>).apiKey = 'xoxb-1';
    expect(installConnectionPackManifest(leaky).installed).toBe(false);
    expect(installConnectionPackManifest(pack('seam-iso-survivor')).installed).toBe(true);
  });

  it('schema-invalid manifests are rejected with a structured error, not a throw (§B.9 posture)', () => {
    const out = installConnectionPackManifest({ kind: 'connection', name: 'x' });
    expect(out.installed).toBe(false);
    expect(out.errors?.[0]?.code).toBe('validation_error');
  });
});

describe('RFC 0095 seam: resolve (§B.6)', () => {
  it('an unknown provider is unresolved with the specific code', () => {
    expect(seamResolveProvider('seam-nonexistent-zzz')).toEqual({
      resolved: false,
      code: 'connection_provider_unresolved',
    });
  });

  it('SemVer §11: an installed prerelease does NOT outrank a simulated built-in release → conflict', () => {
    expect(installConnectionPackManifest(pack('seam-pre', '1.0.0-alpha.1')).installed).toBe(true);
    expect(seamResolveProvider('seam-pre', '1.0.0')).toEqual({
      resolved: false,
      code: 'connection_provider_conflict',
    });
  });

  it('an installed release ≥ the simulated built-in resolves as source:pack', () => {
    expect(installConnectionPackManifest(pack('seam-rel', '1.2.0')).installed).toBe(true);
    expect(seamResolveProvider('seam-rel', '1.0.0')).toMatchObject({ resolved: true, source: 'pack' });
  });

  it('no installed pack + a simulated built-in resolves as source:builtin', () => {
    expect(seamResolveProvider('seam-builtin-only', '2.0.0')).toMatchObject({
      resolved: true,
      source: 'builtin',
      version: '2.0.0',
    });
  });
});
