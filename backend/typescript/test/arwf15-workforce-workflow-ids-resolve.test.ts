/**
 * ARWF-15 — every workflow id a workforce names must resolve.
 *
 * `seed-data/workforces.json` named 15 `openwop-app.agents.*` ids in its
 * `workflowCatalog`. ADR 0775 P2d deleted those definitions, so the ids
 * resolved nowhere, and three things inherited the dead ids:
 *  - the demo seed stamped every synthetic run with one (1,090 per tenant), so
 *    no seeded run could be re-run;
 *  - the Migration wizard's target picker offered ONLY those ids;
 *  - the migration PATCH saved whatever id it was sent.
 *
 * The fix: a catalog names only workflows that resolve, the one real-AI
 * gallery chain that fits (`service-desk.sla-escalation`, seeded as the shared
 * `wf.seed.*`) or nothing. The synthetic history is stamped with a DECLARED
 * historical id (`historyWorkflowId`) that resolves nowhere by design, so a
 * fork of a fake run is a typed not-found, never a replay onto a real graph.
 * The `tmpl.*` Work-Twin chains are mock-AI and were deliberately NOT used.
 *
 * The ADR 0764 D6 / ADR 0775 ratchet (`catalog-source-a-literal-ratchet`)
 * pins what catalog source A RESOLVES. It cannot see an id that a seed file
 * REFERENCES and nothing resolves, which is this class. These cases are the
 * guard for it.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { createHostAdapterSuite } from '../src/host/index.js';
import { resolveTenantWorkflow } from '../src/host/resolveLaunchDefinition.js';
import { seedWorkforceEntities, seedWorkforceHistory } from '../src/host/workforceService.js';
import { seedZeroConfigWorkflows } from '../src/host/seedWorkflows.js';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import workforceSeed from '../src/host/seed-data/workforces.json';

const T = 'tenant-arwf15';
const WF = 'workforce.support.escalation-triage';

let server: http.Server;
let BASE: string;
const storage = openSqliteStorage(':memory:');
let catalog: ReturnType<typeof createHostAdapterSuite>['workflowCatalog'];

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  catalog = createHostAdapterSuite({ storage }).workflowCatalog;
  await seedWorkforceEntities();
  // The shared `wf.seed.*` definitions exist once any tenant has been seeded
  // (in prod: always). A catalog entry that is not one is caught regardless.
  await seedZeroConfigWorkflows('tenant-arwf15-seeder');
  await new Promise<void>((res) => {
    server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); });
  });
});
afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  await storage.close();
});

type SeedWorkforce = { workforceId: string; workflowCatalog: string[]; historyWorkflowId?: string; historyRunCount?: number };
const seeds = workforceSeed as SeedWorkforce[];

describe('workforces.json workflowCatalog', () => {
  it('every catalog id resolves for a tenant', async () => {
    const ids = seeds.flatMap((w) => w.workflowCatalog.map((id) => `${w.workforceId} → ${id}`));
    expect(ids.length).toBeGreaterThan(0); // non-vacuity: at least one workforce names a real workflow
    const dead: string[] = [];
    for (const w of seeds) {
      for (const id of w.workflowCatalog) if (!(await resolveTenantWorkflow(catalog, T, id))) dead.push(`${w.workforceId} → ${id}`);
    }
    expect(dead).toEqual([]);
  });

  it('never names a mock-AI Work-Twin template (tmpl.*)', () => {
    expect(seeds.flatMap((w) => w.workflowCatalog).filter((id) => id.startsWith('tmpl.'))).toEqual([]);
  });
});

describe('the demo seed', () => {
  it('every instrumented workforce declares a historical id that is not a catalog entry and resolves nowhere', async () => {
    const instrumented = seeds.filter((w) => (w.historyRunCount ?? 0) > 0);
    expect(instrumented.length).toBe(5);
    for (const w of instrumented) {
      expect(w.historyWorkflowId, w.workforceId).toBeTruthy();
      expect(w.workflowCatalog).not.toContain(w.historyWorkflowId);
      // If this ever resolves, a synthetic run would fork onto a real graph:
      // re-decide the id rather than relaxing this line.
      expect(await resolveTenantWorkflow(catalog, T, w.historyWorkflowId!), w.historyWorkflowId).toBeNull();
    }
  });

  it('stamps every synthetic run with exactly the declared historical ids', async () => {
    const res = await seedWorkforceHistory(storage, T, { runCount: 6, nowMs: Date.parse('2026-10-19T00:00:00Z') });
    expect(res.runs).toBeGreaterThan(0);
    const runs = await storage.listRuns({ tenantId: T, limit: 5000 });
    expect(new Set(runs.map((r) => r.workflowId))).toEqual(new Set(seeds.filter((w) => (w.historyRunCount ?? 0) > 0).map((w) => w.historyWorkflowId)));
  });
});

describe('HTTP: the migration target picker + save', () => {
  async function call<B = Record<string, unknown>>(path: string, init: RequestInit = {}): Promise<{ status: number; body: B }> {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', authorization: 'Bearer dev-token', ...(init.headers ?? {}) },
    });
    return { status: res.status, body: (await res.json()) as B };
  }
  const wfPath = `/host/openwop-app/workforces/${encodeURIComponent(WF)}`;

  it('offers only workflows that resolve, the workforce catalog included', async () => {
    const r = await call<{ targets: Array<{ workflowId: string; name: string; source: string }> }>(`${wfPath}/migration/targets`);
    expect(r.status).toBe(200);
    const fromCatalog = r.body.targets.filter((t) => t.source === 'workforce').map((t) => t.workflowId);
    expect(fromCatalog).toEqual(seeds.find((w) => w.workforceId === WF)!.workflowCatalog);
    expect(fromCatalog).toEqual(['wf.seed.service-desk-sla-escalation']);
    for (const t of r.body.targets) expect(await resolveTenantWorkflow(catalog, 'default', t.workflowId), t.workflowId).not.toBeNull();
  });

  it('404s the targets of an unknown workforce', async () => {
    expect((await call('/host/openwop-app/workforces/workforce.nope/migration/targets')).status).toBe(404);
  });

  it('refuses a target that does not resolve with a typed 400, and saves nothing', async () => {
    const before = await call<{ target: unknown }>(`${wfPath}/migration`);
    const r = await call<{ error?: string; details?: { reason?: string; field?: string; workflowId?: string } }>(`${wfPath}/migration`, {
      method: 'PATCH',
      body: JSON.stringify({ target: { workflowId: 'openwop-app.agents.invoice-post', targetOutcome: 'x' }, stageStatus: { target: 'done' } }),
    });
    expect(r.status).toBe(400);
    expect(r.body.details).toMatchObject({ reason: 'target_workflow_unresolved', field: 'target.workflowId', workflowId: 'openwop-app.agents.invoice-post' });
    const after = await call<{ target: unknown; stageStatus: Record<string, string> }>(`${wfPath}/migration`);
    expect(after.body.target).toEqual(before.body.target);
    expect(after.body.stageStatus.target).toBe('pending');
  });

  it('refuses an empty target id', async () => {
    const r = await call<{ details?: { reason?: string } }>(`${wfPath}/migration`, {
      method: 'PATCH', body: JSON.stringify({ target: { workflowId: '', targetOutcome: 'x' } }),
    });
    expect(r.status).toBe(400);
    expect(r.body.details?.reason).toBe('target_workflow_unresolved');
  });

  it('accepts a target from the offered list', async () => {
    const targets = (await call<{ targets: Array<{ workflowId: string }> }>(`${wfPath}/migration/targets`)).body.targets;
    const pick = targets[0]!.workflowId;
    const r = await call<{ target: { workflowId: string } }>(`${wfPath}/migration`, {
      method: 'PATCH', body: JSON.stringify({ target: { workflowId: pick, targetOutcome: 'clear in a day' } }),
    });
    expect(r.status).toBe(200);
    expect(r.body.target.workflowId).toBe(pick);
  });

  it('a fork of a synthetic history run is a typed not-found, never a replay onto a real graph', async () => {
    const H = { 'content-type': 'application/json', authorization: 'Bearer dev-token', 'OpenWOP-Version': '2' };
    const seeded = await fetch(`${BASE}/host/openwop-app/example-data/run`, { method: 'POST', headers: H, body: JSON.stringify({ steps: ['workforces'] }) });
    expect(seeded.status).toBe(200);
    const list = (await (await fetch(`${BASE}/runs?limit=50`, { headers: H })).json()) as { runs: Array<{ runId: string; workflowId: string }> };
    const run = list.runs.find((r) => seeds.some((w) => w.historyWorkflowId === r.workflowId));
    expect(run).toBeTruthy();
    expect((await fetch(`${BASE}/runs/${encodeURIComponent(run!.runId)}`, { headers: H })).status).toBe(200);
    const fork = await fetch(`${BASE}/runs/${encodeURIComponent(run!.runId)}:fork`, { method: 'POST', headers: H, body: JSON.stringify({ fromSeq: 2, mode: 'replay' }) });
    expect(fork.status).toBe(404);
    // The route's `workflow_not_found` reaches the v2 wire as `not_found`.
    expect(await fork.json()).toMatchObject({ error: 'not_found', details: { workflowId: run!.workflowId } });
  });

  it('still clears a target with null', async () => {
    const r = await call<{ target: unknown }>(`${wfPath}/migration`, { method: 'PATCH', body: JSON.stringify({ target: null }) });
    expect(r.status).toBe(200);
    expect(r.body.target).toBeNull();
  });
});
