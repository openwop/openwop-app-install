/**
 * ADR 0768 follow-up P2 — `GET /host/openwop-app/artifacts?runId=` narrows the
 * Library to ONE run's outputs (the chat's "open in the Workbench").
 *
 * The contract under test is "a FILTER, never a wider view": every item must be
 * something the caller could already fetch via `GET /artifacts/:id`, from ONE run
 * only (a run-id prefix must not bleed into a longer id), and the route must not
 * fall back to the tenant-wide Library scan.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { persistRunArtifact } from '../src/host/runArtifactStore.js';

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
  for (const id of ['users', 'documents']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

async function login(tenantId: string): Promise<(p: string) => Promise<{ status: number; body: any }>> {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
  const r = await call('POST', '/host/openwop-app/test/login', { email: `abr-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return (p: string) => call('GET', p);
}

const A = '/host/openwop-app/artifacts';
const out = (text: string) => ({ text });

describe('artifacts ?runId= (ADR 0768 follow-up P2)', () => {
  it('returns ONE run\'s outputs with their node ids, and nothing from a longer run id', async () => {
    const tenantId = `org:abr-${Date.now()}-${n++}`;
    const get = await login(tenantId);
    const now = new Date().toISOString();
    await persistRunArtifact({ tenantId, runId: 'run-7', nodeId: 'draft', role: 'deliverable', output: out('the plan'), now });
    await persistRunArtifact({ tenantId, runId: 'run-7', nodeId: 'review', role: 'deliverable', output: out('the review'), now });
    await persistRunArtifact({ tenantId, runId: 'run-70', nodeId: 'draft', role: 'deliverable', output: out('another run'), now });

    const r = await get(`${A}?runId=run-7`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const items = r.body.artifacts as Array<{ artifactId: string; runNodeId: string }>;
    expect(items.map((a) => a.runNodeId).sort()).toEqual(['draft', 'review']);
    expect(items.every((a) => a.artifactId.startsWith('run-event:run-7:'))).toBe(true);

    // Every item is fetchable through the per-artifact route — the filter is never wider.
    for (const a of items) expect((await get(`${A}/${encodeURIComponent(a.artifactId)}`)).status).toBe(200);
  });

  it('is tenant-isolated: another workspace asking for the same run id gets nothing', async () => {
    const tenantId = `org:abr-${Date.now()}-${n++}`;
    await login(tenantId);
    await persistRunArtifact({ tenantId, runId: 'run-shared-id', nodeId: 'draft', role: 'deliverable', output: out('secret'), now: new Date().toISOString() });
    const other = await login(`org:abr-other-${Date.now()}-${n++}`);
    const r = await other(`${A}?runId=run-shared-id`);
    expect(r.status).toBe(200);
    expect(r.body.artifacts).toEqual([]);
  });

  it('rejects an empty run id', async () => {
    const get = await login(`org:abr-${Date.now()}-${n++}`);
    expect((await get(`${A}?runId=`)).status).toBe(400);
  });
});
