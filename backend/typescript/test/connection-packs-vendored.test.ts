/**
 * RFC 0095 — the VENDORED connection packs (examples/connection-packs/) all
 * load: schema-valid manifests, zero loader errors, every provider resolvable.
 * The loader-mechanics test (connection-packs.test.ts) uses synthetic packs;
 * this sweep pins the real shipped set so a malformed vendored manifest can't
 * ship silently (the pack would just vanish from the provider registry).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';
import { loadConnectionPacks } from '../src/features/connections/connectionPackLoader.js';
import { getProvider } from '../src/features/connections/providerRegistry.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VENDORED = join(__dirname, '..', '..', '..', 'examples', 'connection-packs');

let errors: unknown[] = [];
let installedIds: string[] = [];

beforeAll(() => {
  const out = loadConnectionPacks({ roots: [VENDORED] });
  errors = out.errors;
  installedIds = out.installed.map((r) => r.providerId);
});

describe('vendored connection packs — all load', () => {
  it('every pack dir installs with zero loader errors', () => {
    expect(errors).toEqual([]);
    expect(installedIds.length).toBe(readdirSync(VENDORED).length);
  });

  it('hubspot resolves: CRM category, openapi reach, granular scope groups', () => {
    const p = getProvider('hubspot');
    expect(p).toBeTruthy();
    expect(p?.reach).toBe('openapi');
    expect(p?.scopes.read.some((g) => g.scopes.includes('crm.objects.contacts.read'))).toBe(true);
    expect((p?.scopes.write ?? []).some((g) => g.scopes.includes('crm.objects.deals.write'))).toBe(true);
  });

  it('zendesk resolves: per-subdomain instance template, no fixed endpoints', () => {
    const p = getProvider('zendesk');
    expect(p).toBeTruthy();
    expect(p?.reach).toBe('openapi');
    expect(p?.scopes.read.some((g) => g.scopes.includes('tickets:read'))).toBe(true);
  });

  it('teams rides the existing microsoft365 provider — no duplicate pack', () => {
    // Boundaries guard: Teams scopes live on microsoft365 (teams.read/teams.write);
    // a second Graph-OAuth provider for Teams would drift against it.
    const m365 = getProvider('microsoft365');
    expect(m365?.scopes.read.some((g) => g.key === 'teams.read')).toBe(true);
    expect(installedIds).not.toContain('teams');
  });
});
