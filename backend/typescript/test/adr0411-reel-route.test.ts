/**
 * ADR 0411 P3b — the "Generate reel" launch route (the async lane). Video is
 * slow, so POST …/briefs/:id/reel launches the pinned reel workflow as a RUN
 * (202 + status URL) rather than blocking; the run executes the P3a generate-reel
 * node in the background and the reel render lands in the brief's renders list.
 * The mock video seam (provider:'mock' + OPENWOP_TEST_SEAM_ENABLED) drives it
 * end-to-end without a live provider.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

let BASE = '';
let server: http.Server;
const CB = (orgId: string, s = ''): string => `/v1/host/openwop-app/creative-briefs/orgs/${encodeURIComponent(orgId)}${s}`;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['creative-briefs', 'media', 'brand']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res { status: number; body: Record<string, unknown> }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : {} };
  };
  return { post: (p: string, b?: unknown) => call('POST', p, b), get: (p: string) => call('GET', p), call };
}

let seq = 0;
async function ownerWithOrg(): Promise<{ c: ReturnType<typeof client>; orgId: string }> {
  const c = client();
  seq += 1;
  const login = await c.post('/v1/host/openwop-app/test/login', { email: `reel-${seq}@t.test`, tenantId: `org:reel-${seq}` });
  expect([200, 201]).toContain(login.status);
  const org = await c.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status).toBe(201);
  return { c, orgId: org.body.orgId as string };
}

async function makeBrief(c: ReturnType<typeof client>, orgId: string): Promise<string> {
  const r = await c.post(CB(orgId, '/briefs'), { title: 'Reel Brief', assetType: 'video', sceneDescription: 'a fox running through fresh snow at dawn' });
  expect(r.status).toBe(201);
  return r.body.briefId as string;
}

describe('ADR 0411 P3b — Generate reel launch route', () => {
  it('launches a run (202 + runId + statusUrl); a missing brief 404s', async () => {
    const { c, orgId } = await ownerWithOrg();
    const briefId = await makeBrief(c, orgId);
    const launch = await c.post(CB(orgId, `/briefs/${briefId}/reel`), { aspectRatio: '9:16', provider: 'mock' });
    expect(launch.status).toBe(202);
    expect(typeof launch.body.runId).toBe('string');
    expect(String(launch.body.statusUrl)).toContain('/v1/runs/');

    const missing = await c.post(CB(orgId, `/briefs/cbrief:does-not-exist/reel`), { provider: 'mock' });
    expect(missing.status).toBe(404);
  });

  it('the launched run generates a reel render end-to-end (mock video seam)', async () => {
    const { c, orgId } = await ownerWithOrg();
    const briefId = await makeBrief(c, orgId);
    const launch = await c.post(CB(orgId, `/briefs/${briefId}/reel`), { aspectRatio: '9:16', durationSeconds: 6, provider: 'mock' });
    expect(launch.status).toBe(202);
    const runId = String(launch.body.runId);

    let status = 'pending';
    for (let i = 0; i < 50 && status !== 'completed' && status !== 'failed'; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      status = String((await c.get(`/v1/runs/${runId}`)).body.status ?? 'pending');
    }
    expect(status, `run ${runId} did not complete`).toBe('completed');

    const renders = await c.get(CB(orgId, `/briefs/${briefId}/renders`));
    expect(renders.status).toBe(200);
    const list = (renders.body.renders ?? renders.body) as Array<{ reel?: { prompt: string }; mediaAssetId: string }>;
    const reel = list.find((r) => r.reel);
    expect(reel, 'a reel render should exist').toBeTruthy();
    expect(reel!.reel!.prompt).toContain('fox running');
    expect(reel!.mediaAssetId).toMatch(/^masset:/);
  }, 20_000);
});
