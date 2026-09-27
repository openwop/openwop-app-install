/**
 * AI Workflow Author (ADR 0072) — ROUTE harness. Boots the real app and drives
 * the host-extension routes over HTTP:
 *   - always-on (no toggle): catalog + draft never 404 for a feature-flag reason
 *     (the `workflow-author` toggle was retired — see the `always-on (no toggle)`
 *     describe block below, which asserts draft 400s on bad input rather than 404s)
 *   - the authoring catalog endpoint returns the runnable node menu
 *   - draft validates its input (400 on missing intent) and, on a valid intent,
 *     dispatches the meta-workflow run (201 + runId)
 *   - the node-catalog extraction still serves the builder palette
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b) };
}

async function signup(c: Client): Promise<void> {
  const r = await c.post('/v1/host/openwop-app/test/login', { email: `wa-${Date.now()}-${n++}@acme.test` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
}
const CATALOG = '/v1/host/openwop-app/workflow-author/catalog';
const DRAFT = '/v1/host/openwop-app/workflow-author/draft';

describe('workflow-author — always-on (no toggle)', () => {
  it('catalog + draft are reachable without enabling any feature flag', async () => {
    const c = client();
    await signup(c);
    expect((await c.get(CATALOG)).status).toBe(200);
    // draft validates input (400 on missing intent) rather than 404-ing
    expect((await c.post(DRAFT, {})).status).toBe(400);
  });
});

describe('workflow-author — authoring catalog', () => {
  it('returns the runnable node menu', async () => {
    const c = client();
    await signup(c);
    const r = await c.get(CATALOG);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(Array.isArray(r.body.nodes)).toBe(true);
    expect(Array.isArray(r.body.excluded)).toBe(true);
    // every offered node is runnable (no missing host surfaces left in the menu)
    expect(r.body.nodes.some((nd: { typeId: string }) => nd.typeId === 'core.noop')).toBe(true);
  });
});

describe('workflow-author — draft dispatch', () => {
  it('400s on a missing intent', async () => {
    const c = client();
    await signup(c);
    const r = await c.post(DRAFT, {});
    expect(r.status).toBe(400);
    expect(r.body?.error).toBe('validation_error');
  });

  it('dispatches the meta-workflow run and returns a runId for a valid intent', async () => {
    const c = client();
    await signup(c);
    const r = await c.post(DRAFT, { intent: 'When a new lead arrives, summarize it and notify the owner.' });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(typeof r.body.runId).toBe('string');
    expect(r.body.workflowId).toBe('openwop-app.workflow-author');
  });
});

// ── ADR 0596 §Correction 4 (`WFAU-2`) — the WIRE hop of "made readable". ──────
// The three provenance witnesses in `workflow-author-node-pack.test.ts` all stop
// at `getOwned()`: an adversarial review DELETED the `authoredVia` projection
// line in `routes/workflows.ts` and six suites stayed 96-green. The row reaching
// the ownership store is only half the claim — the other half is that the list
// the dashboard and the `/` picker actually read carries it.
describe('WFAU-2 — provenance survives the wire, not just the ownership row', () => {
  const LIST = '/v1/host/openwop-app/workflows';
  const noopDef = (id: string) => ({
    workflowId: id,
    nodes: [{ nodeId: 'n1', typeId: 'core.noop', outputRole: 'primary' as const }],
  });

  it('an AI-authored workflow arrives on GET /workflows carrying authoredVia; a hand-built one does not', async () => {
    const c = client();
    await signup(c);
    // CONTROL, and the tenant probe in one move: the builder's own REST lane
    // records ownership with NO provenance. If the route stamped `authoredVia`
    // itself rather than projecting the row, this row would carry it too and the
    // assertion below would be meaningless. Creating it over HTTP also tells us
    // the caller's tenant without assuming one — the list route projects
    // `listOwned(tenantOf(req))`, so the authored write must land in the same
    // tenant or the test would pass vacuously on an absent row.
    const created = await c.post(LIST, {
      workflowId: 'plain.route-hand-built',
      nodes: [{ nodeId: 'n1', typeId: 'core.noop', outputRole: 'primary' }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const { allOwnershipByWorkflow } = await import('../src/host/workflowOwnership.js');
    const tenantId = (await allOwnershipByWorkflow()).get('plain.route-hand-built')?.[0];
    expect(typeof tenantId, 'the REST create must have recorded ownership').toBe('string');

    const { persistAuthoredWorkflow } = await import('../src/features/workflow-author/workflowAuthorService.js');
    await persistAuthoredWorkflow(noopDef('authored.route-prov'), { tenantId: tenantId! });

    const list = await c.get(LIST);
    expect(list.status, JSON.stringify(list.body)).toBe(200);
    const rows = list.body.workflows as Array<{ workflowId: string; authoredVia?: string }>;
    const authored = rows.find((w) => w.workflowId === 'authored.route-prov');
    const handBuilt = rows.find((w) => w.workflowId === 'plain.route-hand-built');
    expect(authored, 'the authored workflow must be in the owner scoped list').toBeDefined();
    expect(handBuilt, 'the hand-built workflow must be in the owner scoped list').toBeDefined();
    expect(authored!.authoredVia).toBe('workflow-author');
    expect(handBuilt!.authoredVia).toBeUndefined();
  });
});

describe('node-catalog — extraction still serves the palette', () => {
  it('returns a non-empty node catalog including core.noop', async () => {
    const c = client();
    await signup(c);
    const r = await c.get('/v1/host/openwop-app/node-catalog');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.nodes)).toBe(true);
    expect(r.body.nodes.some((nd: { typeId: string }) => nd.typeId === 'core.noop')).toBe(true);
  });
});
