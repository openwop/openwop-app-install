/**
 * ADR 0906 D7 / P4a — the GCP adapter acts as a dedicated service account.
 *
 * With `OPENWOP_CUSTOM_DOMAIN_EDGE_SA` set, every Certificate Manager call
 * carries a token minted for that account through IAM Credentials
 * `generateAccessToken` (using the runtime token), cached until a minute before
 * it expires. Unset, the runtime token is used as before. TST-CWF-3.
 *
 * Red when (sabotage-witnessed, wave 69): the provider ignores `impersonate` or
 * mints with the wrong scope (case 1); the token is never cached, or is cached
 * up to its real expiry instead of a minute before (case 2 — its second read
 * falls INSIDE that last minute); a refused mint stops invalidating the runtime
 * token (case 3); a malformed SA email is accepted (config case 2).
 *
 * CEILING (recorded): config case 1 shows the SA reaches `loadEdgeConfig` and
 * that `resolveEdgeProvider` builds the GCP provider. That the built provider
 * then impersonates is not observable here — it is built with the real egress
 * fetch and no injection point — so that wiring (`edgeCertificates/index.ts`)
 * is covered by reading only; case 1 covers the provider-level wiring.
 */
import { describe, expect, it } from 'vitest';
import { EdgeProviderError, IAM_CREDENTIALS, createGcpCertificateManagerProvider, impersonatedMetadata, type EdgeMetadata } from '../src/host/edgeCertificates/gcpCertificateManager.js';
import { loadEdgeConfig } from '../src/host/edgeCertificates/config.js';
import { resolveEdgeProvider } from '../src/host/edgeCertificates/index.js';

const SA = 'owp-custom-domains@openwop-dev.iam.gserviceaccount.com';

function runtime(): EdgeMetadata & { invalidated: number } {
  const m = { invalidated: 0, accessToken: async () => 'runtime-tok', projectId: async () => 'edge-proj', invalidate() { m.invalidated++; } };
  return m;
}

function fakeGoogle(opts: { iamStatus?: number } = {}) {
  const calls: Array<{ url: string; auth?: string; body?: string }> = [];
  let minted = 0;
  const fetch = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    calls.push({ url, auth: init.headers['authorization'], body: init.body });
    if (url.startsWith('https://iamcredentials.googleapis.com/')) {
      if (opts.iamStatus) return { ok: false, status: opts.iamStatus, text: async () => '{}' };
      minted++;
      return { ok: true, status: 200, text: async () => JSON.stringify({ accessToken: `sa-tok-${minted}`, expireTime: new Date(Date.parse('2026-10-18T12:00:00Z') + 3600_000).toISOString() }) };
    }
    // Certificate Manager: the DNS authorization already exists.
    return { ok: true, status: 200, text: async () => JSON.stringify({ name: 'projects/edge-proj/locations/global/dnsAuthorizations/x', dnsResourceRecord: { name: '_acme-challenge_x.edge-test.example.com.', data: 'x.authorize.certificatemanager.goog.' } }) };
  };
  return { fetch, calls, get minted() { return minted; } };
}

describe('impersonation', () => {
  it('Certificate Manager calls carry the minted SA token, never the runtime token', async () => {
    const g = fakeGoogle();
    const p = createGcpCertificateManagerProvider({ certMap: 'm1', fetch: g.fetch, metadata: runtime(), impersonate: SA, now: () => Date.parse('2026-10-18T12:00:00Z') });
    const out = await p.prepare('edge-test.example.com');
    expect(out.done).toBe(true);
    const iam = g.calls.find((c) => c.url.includes('iamcredentials'))!;
    expect(iam.url).toBe(`${IAM_CREDENTIALS}/projects/-/serviceAccounts/${encodeURIComponent(SA)}:generateAccessToken`); // Google's API prefix, not ours
    expect(iam.auth).toBe('Bearer runtime-tok');
    expect(JSON.parse(iam.body!)).toMatchObject({ scope: ['https://www.googleapis.com/auth/cloud-platform'] });
    const cm = g.calls.filter((c) => c.url.includes('certificatemanager'));
    expect(cm.length).toBeGreaterThan(0);
    for (const c of cm) expect(c.auth).toBe('Bearer sa-tok-1');
  });

  it('the minted token is cached until a minute before it expires', async () => {
    const g = fakeGoogle();
    let now = Date.parse('2026-10-18T12:00:00Z');
    const m = impersonatedMetadata(runtime(), SA, g.fetch, () => now);
    expect(await m.accessToken()).toBe('sa-tok-1');
    now += 58 * 60_000; // 12:58 — two minutes before expiry: cached
    expect(await m.accessToken()).toBe('sa-tok-1');
    now += 90_000; // 12:59:30 — inside the last minute: re-minted, never served stale
    expect(await m.accessToken()).toBe('sa-tok-2');
  });

  it('a refused mint is a typed failure that names the missing grant, and drops the runtime token', async () => {
    const g = fakeGoogle({ iamStatus: 403 });
    const rt = runtime();
    const m = impersonatedMetadata(rt, SA, g.fetch);
    const err = await m.accessToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EdgeProviderError);
    expect((err as EdgeProviderError).status).toBe(403);
    expect((err as EdgeProviderError).message).toContain('serviceAccountTokenCreator');
    expect(rt.invalidated).toBe(1);
  });

  it('without a service account, the runtime token is used (unchanged behaviour)', async () => {
    const g = fakeGoogle();
    const p = createGcpCertificateManagerProvider({ certMap: 'm1', fetch: g.fetch, metadata: runtime() });
    await p.prepare('edge-test.example.com');
    expect(g.calls.some((c) => c.url.includes('iamcredentials'))).toBe(false);
    for (const c of g.calls) expect(c.auth).toBe('Bearer runtime-tok');
  });
});

describe('configuration', () => {
  const base = { OPENWOP_CUSTOM_DOMAIN_EDGE: 'gcp-certificate-manager', OPENWOP_CUSTOM_DOMAIN_CERT_MAP: 'm1' };
  it('a valid service-account email is carried into the provider config (and the GCP provider is built)', () => {
    expect(loadEdgeConfig({ ...base, OPENWOP_CUSTOM_DOMAIN_EDGE_SA: SA } as NodeJS.ProcessEnv)).toMatchObject({ ready: true, serviceAccount: SA });
    expect(resolveEdgeProvider(loadEdgeConfig({ ...base, OPENWOP_CUSTOM_DOMAIN_EDGE_SA: SA } as NodeJS.ProcessEnv))?.id).toBe('gcp-certificate-manager');
  });
  it('a malformed one makes the edge not ready (no calls), never a silent fallback to the runtime SA', () => {
    const cfg = loadEdgeConfig({ ...base, OPENWOP_CUSTOM_DOMAIN_EDGE_SA: 'someone@gmail.com' } as NodeJS.ProcessEnv);
    expect(cfg).toMatchObject({ ready: false });
    expect(resolveEdgeProvider(cfg)).toBeNull();
  });
});
