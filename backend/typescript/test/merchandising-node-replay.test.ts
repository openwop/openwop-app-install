/**
 * ADR 1025 D2 + D3 — the four merchandising WRITE nodes must not re-execute on a replay
 * `:fork`, and their surface methods must ask for `workspace:write`.
 *
 * WHY (MCHWF-2): at 1.0.1 every node in `feature.{promotions,discovery,recommendations}.nodes`
 * was `role:"action"` with no capabilities. `action` is re-executed on a replay fork (only
 * `side-effect` is served from the recording — `executor/sideEffects.ts`), and discovery's
 * two "upsert" nodes always CREATE, so every fork minted a second live collection or
 * merch rule. The pack header said "All role:'action' (recorded → replay-safe)".
 *
 * WHY (MCHWF-3): the surfaces declared no `methodScopes`, so the ADR 0832 floor asked only
 * for membership (`workspace:read`) and a Viewer-acting run could write. The HTTP door
 * and the chat tools ask for `workspace:write`.
 *
 * Legs:
 *   1. manifest partition: the 4 writes are `side-effect` + `side-effectful`, the 4 reads
 *      `action`, and every manifest node is classified exactly once;
 *   2. the GENERATED floor holds the writes AND the fast path serves them; the predicate
 *      `executor.ts` branches on agrees; the reads are not in the floor;
 *   3. BEHAVIOURAL: a run of all four writes through `createApp`, then a replay fork —
 *      still ONE rule, collection, promotion and placement;
 *   4. AUTHORITY: through the real seam (`buildFeatureSurfaces`), a Viewer-acting run is
 *      refused every write; an editor is allowed; a blank `orgId` is refused.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
// `index.js` FIRST (see users-node-replay.test.ts — feature-module import order).
import { createApp } from '../src/index.js';
import { MANIFEST_SIDE_EFFECT_FLOOR, MANIFEST_FAST_PATH_SERVED } from '../src/executor/sideEffectFloor.generated.js';
import { isSideEffectingNode } from '../src/executor/sideEffects.js';
import { registerWorkflow } from '../src/host/workflowsRegistry.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { buildFeatureSurfaces, type FeatureSurface } from '../src/host/featureSurfaces.js';
import type { BundleScope } from '../src/host/inMemorySurfaces.js';
import { listMerchRules, listCollections } from '../src/features/discovery/discoveryService.js';
import { listPromotions } from '../src/features/promotions/promotionsService.js';
import { listPlacements } from '../src/features/recommendations/recommendationsService.js';
import { getSetCookies } from './headerCookies.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../..');

const WRITES = [
  'feature.promotions.nodes.create',
  'feature.discovery.nodes.collection-upsert',
  'feature.discovery.nodes.merch-rule-upsert',
  'feature.recommendations.nodes.placement-upsert',
] as const;
const READS = [
  'feature.promotions.nodes.list-active',
  'feature.promotions.nodes.apply-preview',
  'feature.discovery.nodes.search',
  'feature.recommendations.nodes.resolve',
] as const;
const PACKS = ['feature.promotions.nodes', 'feature.discovery.nodes', 'feature.recommendations.nodes'];

interface ManifestNode { typeId: string; role?: string; capabilities?: string[] }
const nodes: ManifestNode[] = PACKS.flatMap((p) => (JSON.parse(readFileSync(join(REPO, 'packs', p, 'pack.json'), 'utf8')) as { nodes: ManifestNode[] }).nodes);
const byId = new Map(nodes.map((n) => [n.typeId, n]));

describe('ADR 1025 D2 — the merchandising writes are classified on every leg', () => {
  it('manifest partition: 4 side-effect writes, 4 action reads, nothing unclassified', () => {
    const classified: string[] = [...WRITES, ...READS];
    expect(nodes.map((n) => n.typeId).filter((id) => !classified.includes(id)), 'unclassified manifest nodes').toEqual([]);
    expect(classified.filter((id) => !byId.has(id)), 'classified ids missing from the manifests').toEqual([]);
    for (const id of WRITES) {
      expect(byId.get(id)?.role, id).toBe('side-effect');
      expect(byId.get(id)?.capabilities ?? [], id).toContain('side-effectful');
    }
    for (const id of READS) {
      expect(byId.get(id)?.role, id).toBe('action');
      expect(byId.get(id)?.capabilities ?? [], id).not.toContain('side-effectful');
    }
  });

  it('the generated floor holds the writes AND serves them; the executor predicate agrees; reads stay out', () => {
    for (const id of WRITES) {
      expect(MANIFEST_SIDE_EFFECT_FLOOR.has(id), `${id} not in the derived floor`).toBe(true);
      expect(MANIFEST_FAST_PATH_SERVED.has(id), `${id} held but NOT served`).toBe(true);
      expect(isSideEffectingNode(id, null), id).toBe(true);
    }
    for (const id of READS) {
      expect(MANIFEST_SIDE_EFFECT_FLOOR.has(id), `${id} is a read`).toBe(false);
      expect(isSideEffectingNode(id, null), id).toBe(false);
    }
  });
});

describe('ADR 1025 — behaviour through the real app', () => {
  let server: http.Server;
  let BASE = '';
  type Body = Record<string, unknown> & { runId?: string; orgId?: string; status?: string; error?: unknown; user?: { userId: string } };
  const client = () => {
    let cookie = '';
    return async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Body }> => {
      const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]!; }
      const text = await res.text(); // wire JSON
      return { status: res.status, body: (text ? JSON.parse(text) : {}) as Body };
    };
  };
  const settle = async (call: ReturnType<typeof client>, runId: string): Promise<string> => {
    // The executor runs detached: poll the run snapshot until terminal (no hook to await).
    let snap: Body = {};
    await vi.waitFor(async () => {
      snap = (await call('GET', `/runs/${runId}`)).body ?? snap;
      expect(['completed', 'failed', 'cancelled']).toContain(String(snap.status ?? ''));
    }, { timeout: 5000, interval: 25 });
    return snap.status === 'completed' ? 'completed' : `${String(snap.status)}:${JSON.stringify(snap.error)}`;
  };

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
    process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
    delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
    delete process.env.OPENWOP_DEMO_MODE;
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
    for (const id of ['commerce', 'promotions', 'discovery', 'recommendations']) {
      const d = getToggleDefault(id);
      if (d) await saveConfig({ ...d, status: 'on' }, 'test');
    }
  });
  afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

  it('a replay fork of merch-rule-upsert + promotions.create is served the recording: still ONE rule, ONE promotion', async () => {
    const TENANT = `org:mch1025-replay-${Date.now()}`;
    const call = client();
    expect((await call('POST', '/host/openwop-app/test/login', { email: 'mch1025-owner@acme.test', tenantId: TENANT })).status).toBe(201);
    const orgId = String((await call('POST', '/host/openwop-app/orgs', { name: 'Acme' })).body.orgId);

    const workflowId = 'mch1025.replay.writes';
    registerWorkflow({
      workflowId,
      nodes: [
        { nodeId: 'rule', typeId: 'feature.discovery.nodes.merch-rule-upsert', config: { orgId, name: 'Hide clearance', actions: [{ kind: 'hide', predicate: { categories: ['clearance'] } }] } },
        { nodeId: 'promo', typeId: 'feature.promotions.nodes.create', config: { orgId, name: 'Agent sale', type: 'product_discount', reward: { kind: 'percentage', value: 10 }, scope: { all: true } } },
        { nodeId: 'col', typeId: 'feature.discovery.nodes.collection-upsert', config: { orgId, name: 'Agent picks', type: 'manual', productIds: [] } },
        { nodeId: 'place', typeId: 'feature.recommendations.nodes.placement-upsert', config: { orgId, slot: 'home', source: 'trending' } },
      ],
      // promo FIRST: a node's inputs are the run's produced values merged over its config,
      // and the rule node outputs `scope: 'all'`, which would replace the promotion's
      // scope. The promotion's outputs carry no key the rule node reads.
      edges: [
        { edgeId: 'e1', sourceNodeId: 'promo', targetNodeId: 'rule' },
        { edgeId: 'e2', sourceNodeId: 'promo', targetNodeId: 'col' },
        { edgeId: 'e3', sourceNodeId: 'promo', targetNodeId: 'place' },
      ],
    });
    const run = await call('POST', '/runs', { workflowId, inputs: {} });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    expect(await settle(call, String(run.body.runId))).toBe('completed');
    expect((await listMerchRules(TENANT, orgId)).length).toBe(1);
    expect((await listPromotions(TENANT, orgId)).length).toBe(1);
    expect((await listCollections(TENANT, orgId)).length).toBe(1);
    expect((await listPlacements(TENANT, orgId)).length).toBe(1);
    // ADR 1025 D5 — a run-authored merch rule is a PROPOSAL.
    expect((await listMerchRules(TENANT, orgId))[0]!.active).toBe(false);

    const fork = await call('POST', `/runs/${String(run.body.runId)}:fork`, { mode: 'replay' });
    expect(fork.status, JSON.stringify(fork.body)).toBe(201);
    expect(await settle(call, String(fork.body.runId))).toBe('completed');
    expect((await listMerchRules(TENANT, orgId)).length, 'a replay fork re-executed merch-rule-upsert').toBe(1);
    expect((await listPromotions(TENANT, orgId)).length, 'a replay fork re-executed promotions.create').toBe(1);
    expect((await listCollections(TENANT, orgId)).length, 'a replay fork re-executed collection-upsert').toBe(1);
    expect((await listPlacements(TENANT, orgId)).length, 'placement-upsert stays one row').toBe(1);
  });

  it('D3: a Viewer-acting run is refused every merchandising write; an editor writes; a blank orgId is refused', async () => {
    const tenantId = `org:mch1025-scope-${Date.now()}`;
    const owner = client();
    const ownerId = String((await owner('POST', '/host/openwop-app/test/login', { email: 'mch1025-o@acme.test', tenantId })).body.user?.userId);
    const viewer = client();
    const viewerId = String((await viewer('POST', '/host/openwop-app/test/login', { email: 'mch1025-v@acme.test', tenantId })).body.user?.userId);
    const orgId = String((await owner('POST', '/host/openwop-app/orgs', { name: 'Store' })).body.orgId);
    const added = await owner('POST', `/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'V', subject: viewerId, roles: ['viewer'] });
    expect(added.status, JSON.stringify(added.body)).toBe(201);

    const surfaces = (scope: BundleScope): Record<string, FeatureSurface> => buildFeatureSurfaces(scope);
    const asViewer = surfaces({ tenantId, runId: 'r-v', actingUserId: viewerId });
    const writes: Array<[string, string, Record<string, unknown>]> = [
      ['promotions', 'create', { orgId, name: 'V sale', type: 'product_discount', reward: { kind: 'percentage', value: 5 }, scope: { all: true } }],
      ['discovery', 'createCollection', { orgId, name: 'V col', type: 'manual', productIds: [] }],
      ['discovery', 'createMerchRule', { orgId, name: 'V rule', actions: [{ kind: 'hide', predicate: { categories: ['x'] } }] }],
      ['recommendations', 'upsertPlacement', { orgId, slot: 'home', source: 'trending' }],
    ];
    for (const [feature, method, args] of writes) {
      await expect(asViewer[feature]![method]!(args), `${feature}.${method} as a Viewer`).rejects.toBeTruthy();
    }
    // Nothing landed.
    expect(await listPromotions(tenantId, orgId)).toEqual([]);
    expect(await listCollections(tenantId, orgId)).toEqual([]);
    expect(await listMerchRules(tenantId, orgId)).toEqual([]);
    expect(await listPlacements(tenantId, orgId)).toEqual([]);
    // The Viewer still READS (membership is the read floor): positive control on the gate.
    await expect(asViewer.discovery!.search!({ orgId })).resolves.toBeTruthy();

    // The owner (workspace:write) writes through the same seam.
    const asOwner = surfaces({ tenantId, runId: 'r-o', actingUserId: ownerId });
    for (const [feature, method, args] of writes) await expect(asOwner[feature]![method]!(args), `${feature}.${method} as owner`).resolves.toBeTruthy();
    expect((await listMerchRules(tenantId, orgId)).length).toBe(1);

    // A blank orgId skips the org floor, so each write refuses it itself.
    const system = surfaces({ tenantId, runId: 'r-s' });
    for (const [feature, method, args] of writes) {
      await expect(system[feature]![method]!({ ...args, orgId: '' }), `${feature}.${method} with a blank orgId`).rejects.toMatchObject({ code: 'validation_error' });
    }
  });
});
