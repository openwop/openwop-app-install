/**
 * Web-search key resolution order: TENANT → HOST-GLOBAL → env.
 *
 * THE DEFECT THIS CLOSES. `resolveSearchKey` only ever asked for the TENANT-scoped
 * secret, then fell straight to the env var. But the Secrets Vault on the
 * Connections page writes at `tenant` OR `host` scope — and `resolveSecret`
 * deliberately does NOT fall back from a tenant scope to the host row (a generic
 * fallback would leak host secrets to tenants; see the vuln-scan M3 note in
 * `secretResolver.ts`). So a host-scope `web-search` key was UNREACHABLE: an
 * operator would set it in the Vault, see it listed in the inventory, and every
 * research run would still refuse — the "looks configured, isn't" failure class.
 *
 * The fix is an explicit SCOPELESS read at this call site, mirroring
 * `billing:stripe-key`, the established deliberately-host-global operator
 * credential.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

const resolveSecret = vi.hoisted(() => vi.fn());
// Spread the REAL module: the surface's SSRF guard builds an undici Agent, and a
// wholesale mock of the secret resolver's siblings would break unrelated imports.
vi.mock('../src/byok/secretResolver.js', async (importActual) => ({
  ...(await importActual<typeof import('../src/byok/secretResolver.js')>()),
  resolveSecret,
}));

const { liveWebSearchConfigured } = await import('../src/host/webResearchSurface.js');

const TENANT = 'user:alice';
const savedEnv = process.env.OPENWOP_WEBSEARCH_API_KEY;

beforeEach(() => { resolveSecret.mockReset(); delete process.env.OPENWOP_WEBSEARCH_API_KEY; });
afterEach(() => {
  if (savedEnv === undefined) delete process.env.OPENWOP_WEBSEARCH_API_KEY;
  else process.env.OPENWOP_WEBSEARCH_API_KEY = savedEnv;
});

/** How `resolveSecret` was called: with a tenant scope, or scopeless (host-global). */
const calls = () => resolveSecret.mock.calls.map(([ref, scope]) => ({ ref, scoped: scope !== undefined }));

describe('web-search key resolution', () => {
  it('THE FIX — a HOST-scope Vault key is found (it was previously unreachable)', async () => {
    // Tenant lookup misses; the scopeless (host-global) lookup hits.
    resolveSecret.mockImplementation(async (_ref: string, scope?: unknown) => (scope === undefined ? 'host-key' : null));

    await expect(liveWebSearchConfigured(TENANT)).resolves.toBe(true);

    // It must actually ASK scopelessly — that is the whole fix.
    expect(calls()).toContainEqual({ ref: 'web-search', scoped: false });
  });

  it('a TENANT key wins over the host key (a workspace may bring its own quota)', async () => {
    resolveSecret.mockImplementation(async (_ref: string, scope?: unknown) => (scope === undefined ? 'host-key' : 'tenant-key'));

    await expect(liveWebSearchConfigured(TENANT)).resolves.toBe(true);
    // Tenant is asked FIRST and short-circuits — no scopeless read happens.
    expect(calls()[0]).toEqual({ ref: 'web-search', scoped: true });
    expect(calls()).not.toContainEqual({ ref: 'web-search', scoped: false });
  });

  it('falls through to the ENV key when the Vault has neither', async () => {
    resolveSecret.mockResolvedValue(null);
    process.env.OPENWOP_WEBSEARCH_API_KEY = 'env-key';

    await expect(liveWebSearchConfigured(TENANT)).resolves.toBe(true);
    // Both Vault lanes were tried before falling back.
    expect(calls()).toEqual([
      { ref: 'web-search', scoped: true },
      { ref: 'web-search', scoped: false },
    ]);
  });

  it('NOTHING configured ⇒ not configured (no silent pass)', async () => {
    resolveSecret.mockResolvedValue(null);
    // `liveWebSearchConfigured` also consults the native-provider lane, which
    // resolves to null here (no tenant default) — so the honest answer is false.
    await expect(liveWebSearchConfigured(TENANT)).resolves.toBe(false);
  });

  it('a THROWING Vault lookup degrades to the next lane, never propagates', async () => {
    // The Vault read touches KMS + durable storage; a failure there must not break
    // search, or an outage in the credential store becomes an outage in research.
    resolveSecret.mockRejectedValue(new Error('kms unavailable'));
    process.env.OPENWOP_WEBSEARCH_API_KEY = 'env-key';

    await expect(liveWebSearchConfigured(TENANT)).resolves.toBe(true);
  });
});
