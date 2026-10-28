/**
 * ADR 0941 P4 — consolidation guards (D4 rows "Ads egress" and "Brand").
 *
 *   1. The four ad platforms are adapter-only on this host. Their connection
 *      packs cannot carry the flag (the RFC 0095 manifest's `provider` object is
 *      closed), so `host/governedWriteProviders.ts` applies it at pack load. A
 *      credential for an ad account is then never injected into the generic
 *      `ctx.http.safeFetch`, the path that would step around the ADR 0357 spend
 *      gate, and the catalog stops advertising `core.openwop.http` for them.
 *   2. No shipped workflow-chain pack places a `vendor.myndhyve.ads-publish-*`
 *      node (they publish with `net.outbound` + `ctx.secrets.resolve`, outside
 *      the adsAdapter chokepoint). The forbidden typeIds are read FROM those
 *      packs, so a new platform pack is covered without editing this file.
 *   3. No campaign chain reads the HOST white-label identity
 *      (`feature.brand.nodes.get-app-identity` → `host/systemBrand`), and no
 *      campaign/creative feature module imports `host/brandAssets` or
 *      `host/systemBrand`: client creative uses the client org's brand kit.
 *
 * What this does NOT cover (owned by ADR 0942 D6): a tenant-authored workflow
 * or a registry-installed chain placing those nodes in a campaign run at
 * runtime. These ratchets pin the shipped corpus only.
 *
 * Sabotage witnesses (run 2026-10-20): `isGovernedWriteProvider` returning
 * false reds legs 1a and 1b; adding `ads.publish.meta` to the campaign-channels
 * chain pack reds leg 2; adding `get-app-identity` to the campaign-orchestration
 * chain reds leg 3a; importing `host/systemBrand` from campaign-intel reds 3b.
 * Each scanner also has an in-file negative control (a planted offender is found).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { makeConnectionSafeFetch } from '../src/host/connectionInjection.js';
import { installConnectionPackManifest } from '../src/features/connections/connectionPackLoader.js';
import { getProvider, registerProvider } from '../src/features/connections/providerRegistry.js';
import { __resetConnectionsStore, createSecretConnection } from '../src/features/connections/connectionsService.js';
import { GOVERNED_WRITE_PROVIDER_IDS } from '../src/host/governedWriteProviders.js';
import { PLATFORM_PROVIDER } from '../src/host/adsAdapter.js';

const REPO = join(process.cwd(), '..', '..');
const SRC = join(process.cwd(), 'src');
type Json = Record<string, unknown>;
const readJson = (p: string): Json => JSON.parse(readFileSync(p, 'utf8')) as Json;

const ADS_PACKS = ['meta-ads', 'google-ads', 'tiktok-ads', 'linkedin-ads'] as const;
const adsPack = (id: string): Json => readJson(join(REPO, 'examples', 'connection-packs', id, 'pack.json'));

describe('ADR 0941 P4 — 1. the ad platforms are adapter-only', () => {
  let echo: http.Server;
  let port: number;
  let storage: Storage;
  let lastAuth: string | undefined;

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    process.env.OPENWOP_SAFEFETCH_ALLOW_PRIVATE = 'true';
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    storage = app.locals.storage;
    await __resetConnectionsStore();
    echo = http.createServer((req, res) => { lastAuth = req.headers.authorization; res.writeHead(200); res.end('ok'); });
    await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r));
    port = (echo.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((r) => echo.close(() => r()));
    delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;
    delete process.env.OPENWOP_SAFEFETCH_ALLOW_PRIVATE;
  });

  it('a. every ads pack installs adapter-only, without the generic HTTP node as a consumer', () => {
    for (const id of ADS_PACKS) {
      const out = installConnectionPackManifest(adsPack(id));
      expect(out, id).toEqual({ installed: true });
      const p = getProvider(id);
      expect(p?.adapterOnly, id).toBe(true);
      expect(p?.consumerNodes, id).not.toContain('core.openwop.http');
    }
  });

  it('b. a Meta credential is never injected into the generic safeFetch; an ungoverned twin is (control)', async () => {
    // The provider exactly as the real meta-ads pack loads it, pointed at a loopback
    // host (the manifest schema refuses an IP in apiHosts, so the loopback copy is
    // registered directly). The twin differs ONLY in the policy's flag.
    expect(installConnectionPackManifest(adsPack('meta-ads'))).toEqual({ installed: true });
    const loaded = getProvider('meta-ads');
    if (!loaded) throw new Error('meta-ads did not load');
    registerProvider({ ...loaded, apiHosts: ['127.0.0.1'] });
    registerProvider({ ...loaded, id: 'p4-ungoverned-twin', adapterOnly: false, apiHosts: ['127.0.0.1'] });
    for (const provider of ['meta-ads', 'p4-ungoverned-twin']) {
      await createSecretConnection({ tenantId: 'tp4', provider, kind: 'bearer', secret: `TOKEN-${provider}`, scope: 'user', userId: 'u1' });
    }
    await storage.insertRun({ runId: 'run-p4', workflowId: 'w', tenantId: 'tp4', status: 'pending', inputs: null, metadata: {}, configurable: {}, createdAt: 'x', updatedAt: 'x' });
    const fetchVia = (provider: string) => makeConnectionSafeFetch({ storage, tenantId: 'tp4', runId: 'run-p4', allowedProviders: [provider], actingUserId: 'u1' });
    lastAuth = undefined;
    await (await fetchVia('p4-ungoverned-twin')(`http://127.0.0.1:${port}/act_1/campaigns`)).body?.cancel();
    expect(lastAuth).toBe('Bearer TOKEN-p4-ungoverned-twin');
    lastAuth = undefined;
    await (await fetchVia('meta-ads')(`http://127.0.0.1:${port}/act_1/campaigns`)).body?.cancel();
    expect(lastAuth).toBeUndefined();
    // Restore the real pack so later suites see facebook.com, not loopback.
    installConnectionPackManifest(adsPack('meta-ads'));
  });

  it('c. the policy covers every platform the ads adapter writes to', () => {
    for (const provider of Object.values(PLATFORM_PROVIDER)) expect(GOVERNED_WRITE_PROVIDER_IDS.has(provider), provider).toBe(true);
  });
});

// ── Chain-pack scanners ─────────────────────────────────────────────────────

/** Every workflow-chain pack shipped in the repo. */
function chainPackFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (!existsSync(dir) || depth > 3) return;
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p, depth + 1);
      else if (name === 'pack.json') {
        try { if (readJson(p).kind === 'workflow-chain') out.push(p); } catch { /* not JSON */ }
      }
    }
  };
  walk(join(REPO, 'packs'), 0);
  walk(join(REPO, 'examples', 'workflow-chain-packs'), 0);
  return out;
}

const bare = (typeId: string): string => typeId.replace(/@[^@]+$/, '');

/** typeIds used by each chain of a pack: [chainId, typeIds]. */
function chainsOf(pack: Json): Array<{ chainId: string; typeIds: string[] }> {
  const chains = Array.isArray(pack.chains) ? (pack.chains as Json[]) : [];
  return chains.map((c) => {
    const nodes = ((c.dag as Json | undefined)?.nodes as Json[] | undefined) ?? [];
    return { chainId: String(c.chainId), typeIds: nodes.map((n) => (typeof n.typeId === 'string' ? bare(n.typeId) : '')).filter(Boolean) };
  });
}

/** The typeIds the MyndHyve ad-publish node packs export, read from the packs. */
function myndhyveAdPublishTypeIds(): Set<string> {
  const ids = new Set<string>();
  for (const name of readdirSync(join(REPO, 'packs')).filter((n) => n.startsWith('vendor.myndhyve.ads-publish-'))) {
    for (const node of (readJson(join(REPO, 'packs', name, 'pack.json')).nodes as Json[] | undefined) ?? []) {
      if (typeof node.typeId === 'string') ids.add(node.typeId);
    }
  }
  return ids;
}

function offendersOf(packs: Array<{ file: string; pack: Json }>, forbidden: (typeId: string) => boolean, scope: (file: string, typeIds: string[]) => boolean): string[] {
  const out: string[] = [];
  for (const { file, pack } of packs) {
    for (const c of chainsOf(pack)) {
      if (!scope(file, c.typeIds)) continue;
      for (const t of c.typeIds) if (forbidden(t)) out.push(`${relative(REPO, file)} :: ${c.chainId} :: ${t}`);
    }
  }
  return out;
}

const PACKS = chainPackFiles().map((file) => ({ file, pack: readJson(file) }));
const planted = (typeId: string): { file: string; pack: Json } => ({
  file: join(REPO, 'examples', 'workflow-chain-packs', 'campaign-planted', 'pack.json'),
  pack: { kind: 'workflow-chain', chains: [{ chainId: 'planted', dag: { nodes: [{ id: 'a', typeId: 'feature.campaign-brief.nodes.validate@1.0.0' }, { id: 'b', typeId }] } }] },
});

describe('ADR 0941 P4 — 2. no chain publishes ads outside the adsAdapter chokepoint', () => {
  const forbidden = myndhyveAdPublishTypeIds();
  const any = (): boolean => true;

  it('the scanner sees the corpus and the forbidden set (denominators)', () => {
    expect(PACKS.length).toBeGreaterThan(20);
    expect(forbidden.has('ads.publish.meta')).toBe(true);
  });
  it('negative control: a planted ads.publish node is found', () => {
    expect(offendersOf([planted('ads.publish.meta@1.0.0')], (t) => forbidden.has(t), any)).toHaveLength(1);
  });
  it('no shipped chain pack contains a vendor.myndhyve.ads-publish-* node', () => {
    expect(offendersOf(PACKS, (t) => forbidden.has(t), any)).toEqual([]);
  });
});

describe('ADR 0941 P4 — 3. campaign creative never uses the host brand', () => {
  /** A campaign chain: in a campaign-* pack directory, or using a campaign/creative node. */
  const isCampaignChain = (file: string, typeIds: string[]): boolean =>
    /[/\\](campaign[^/\\]*|marketing)[/\\]pack\.json$/.test(file)
    || typeIds.some((t) => /^feature\.(campaign-[a-z-]+|creative-briefs|creative-video)\.nodes\./.test(t));
  const HOST_IDENTITY = 'feature.brand.nodes.get-app-identity';

  it('a. negative control finds a planted host-identity read; no shipped campaign chain has one', () => {
    expect(offendersOf([planted(`${HOST_IDENTITY}@1.0.0`)], (t) => t === HOST_IDENTITY, isCampaignChain)).toHaveLength(1);
    expect(offendersOf(PACKS, (t) => t === HOST_IDENTITY, isCampaignChain)).toEqual([]);
  });

  /** The campaign/creative feature modules (curated: a new creative feature is added here). */
  const CAMPAIGN_FEATURE_DIRS = (): string[] =>
    readdirSync(join(SRC, 'features')).filter((d) => /^campaign(-|s$)/.test(d) || ['creative-briefs', 'creative-video'].includes(d));
  const HOST_BRAND_IMPORT = /from\s+['"][^'"]*host\/(brandAssets|systemBrand)(\.js)?['"]|import\(\s*['"][^'"]*host\/(brandAssets|systemBrand)(\.js)?['"]/;

  function filesUnder(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) filesUnder(p, out);
      else if (/\.tsx?$/.test(name)) out.push(p);
    }
    return out;
  }

  it('b. no campaign/creative feature module imports host/brandAssets or host/systemBrand', () => {
    const dirs = CAMPAIGN_FEATURE_DIRS();
    expect(dirs).toEqual(expect.arrayContaining(['campaign-orchestration', 'campaign-channels', 'campaign-ops', 'campaigns', 'creative-briefs', 'creative-video']));
    expect(HOST_BRAND_IMPORT.test("import { getAppBrand } from '../../host/systemBrand.js';")).toBe(true); // negative control
    const offenders = dirs.flatMap((d) => filesUnder(join(SRC, 'features', d)))
      .filter((f) => HOST_BRAND_IMPORT.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f));
    expect(offenders).toEqual([]);
  });
});
