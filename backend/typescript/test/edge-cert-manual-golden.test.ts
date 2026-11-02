/**
 * ADR 0906 D1 — edge-certificate CONFIGURATION fails closed, and the `manual`
 * provider is today's behaviour byte for byte (golden). Tracker TST-CXA-1.
 *
 * Scope: D1 only. Crash-resume, release order, nothing-before-TXT and the TLS
 * state mapping (D2–D4) are pinned by `edge-cert-gcp-adapter.test.ts` and
 * `edge-cert-lifecycle.test.ts`, not here.
 *
 * Red when: `OPENWOP_CUSTOM_DOMAIN_EDGE=manual` stops resolving to manual
 * (config.ts); an unknown provider is downgraded to manual instead of
 * reported not-ready; `resolveEdgeProvider` returns a provider for a not-ready
 * config (index.ts `cfg.ready`); the engine's manual short-circuit is removed
 * (engine.ts — the row gains an `edge` field); a null (unready) provider writes
 * an edge field (customDomains.ts `advanceDomainEdge`). "Makes no call" is
 * observed by a spy on the global `fetch`, with a positive control that the spy
 * records a call when one is made.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { __resetCustomDomains, addDomain, listDomains, verifyDomain, advanceDomainEdge, type CustomDomain } from '../src/host/customDomains.js';
import { loadEdgeConfig } from '../src/host/edgeCertificates/config.js';
import { manualEdgeProvider } from '../src/host/edgeCertificates/manual.js';
import { resolveEdgeProvider } from '../src/host/edgeCertificates/index.js';

const MAP = 'owp-edge-certmap';

/** A spy on the global fetch that never touches the network (answers 599). */
function spyFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 599 }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  await __resetCustomDomains();
});

async function liveDomain(hostname: string, edge: Parameters<typeof verifyDomain>[4]): Promise<CustomDomain> {
  await addDomain({ tenantId: 't1', orgId: 'o1', createdBy: 'u1', hostname });
  const [row] = (await listDomains('t1', 'o1')).filter((d) => d.hostname === hostname);
  return (await verifyDomain('t1', 'o1', hostname, async () => [[row!.verificationToken]], edge))!;
}

describe('ADR 0906 D1 — configuration fails closed', () => {
  it.each<[NodeJS.ProcessEnv, string]>([
    [{}, 'manual'],
    [{ OPENWOP_CUSTOM_DOMAIN_EDGE: 'manual' }, 'manual'],
  ])('%j → %s', (env, provider) => {
    expect(loadEdgeConfig(env)).toEqual({ provider });
  });

  it.each<[NodeJS.ProcessEnv, RegExp]>([
    [{ OPENWOP_CUSTOM_DOMAIN_EDGE: 'cloudflare' }, /not a known provider/],
    [{ OPENWOP_CUSTOM_DOMAIN_EDGE: 'gcp-certificate-manager' }, /CERT_MAP is not set/],
    [{ OPENWOP_CUSTOM_DOMAIN_EDGE: 'gcp-certificate-manager', OPENWOP_CUSTOM_DOMAIN_CERT_MAP: 'Bad/Map' }, /not a valid/],
    [{ OPENWOP_CUSTOM_DOMAIN_EDGE: 'gcp-certificate-manager', OPENWOP_CUSTOM_DOMAIN_CERT_MAP: 'm1', OPENWOP_CUSTOM_DOMAIN_EDGE_PROJECT: 'X' }, /project id/],
  ])('%j is not ready, and resolves to no provider', (env, reason) => {
    const cfg = loadEdgeConfig(env);
    expect(cfg).toMatchObject({ ready: false });
    if (!('reason' in cfg)) throw new Error('a not-ready config must carry a reason');
    expect(cfg.reason).toMatch(reason);
    expect(resolveEdgeProvider(cfg)).toBeNull();
  });

  it('a complete gcp configuration is ready', () => {
    const cfg = loadEdgeConfig({ OPENWOP_CUSTOM_DOMAIN_EDGE: 'gcp-certificate-manager', OPENWOP_CUSTOM_DOMAIN_CERT_MAP: MAP, OPENWOP_CUSTOM_DOMAIN_LB_IP: '203.0.113.7' });
    expect(cfg).toEqual({ provider: 'gcp-certificate-manager', ready: true, certMap: MAP, lbIp: '203.0.113.7' });
    expect(resolveEdgeProvider(cfg)?.id).toBe('gcp-certificate-manager');
  });
});

describe('ADR 0906 D1 — manual is today, byte for byte', () => {
  it('verify under manual writes no edge field and makes no call', async () => {
    const fetchSpy = spyFetch();
    const row = await liveDomain('pages.example.com', manualEdgeProvider);
    expect(row.status).toBe('live');
    expect('edge' in row).toBe(false);
    const again = await advanceDomainEdge('pages.example.com', manualEdgeProvider);
    expect(again).toEqual(row);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
    // Positive control: the spy is live on the global the host would call.
    await globalThis.fetch('https://edge-probe.invalid/');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('a configured-but-unready provider (null) makes no call and writes nothing', async () => {
    const fetchSpy = spyFetch();
    const row = await liveDomain('pages.example.com', null);
    expect(row.status).toBe('live');
    expect('edge' in row).toBe(false);
    expect(await advanceDomainEdge('pages.example.com', null)).toEqual(row);
    expect(fetchSpy).toHaveBeenCalledTimes(0);
    await globalThis.fetch('https://edge-probe.invalid/');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});

