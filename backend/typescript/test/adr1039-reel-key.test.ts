/**
 * ADR 1039 D2 (CB82WF-2) — "Generate reel" needs a video key BEFORE a run exists.
 * Before: the page sent `{aspectRatio:'9:16'}` with no `credentialRef`; the route
 * created and charged a run that `callVideoGenerator` could only fail, and every
 * witness used `provider:'mock'`, so the suite never sent the page's body.
 *
 * Red when the route stops refusing the page's old body before admission, accepts
 * a ref name the workspace does not hold, or stops picking a held Replicate key by
 * the dispatch's own ladder, or stops registering the pick on the run (grade-code
 * B1: a ref passed only as an input never reaches the run's secret set, so a
 * keyed workspace's reel died `byok_required_but_unresolved`). The keyed launch
 * runs end to end against a stubbed provider call.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { setSecret } from '../src/byok/secretResolver.js';
import { resolveReelCredential } from '../src/features/creative-briefs/routes.js';
import { toWireRunId } from '../src/host/v2Ids.js';

// The provider call is replaced, never made: a launch with a real ref would
// otherwise reach Replicate. The stub records the key it was handed, which is
// the proof that the picked ref reached the run's secret set.
const dispatched: Array<{ apiKey: string }> = [];
vi.mock('../src/providers/dispatchVideo.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  dispatchVideoReplicate: async (args: { apiKey: string }) => {
    dispatched.push({ apiKey: args.apiKey });
    return { base64: 'AAAAGGZ0eXBpc29t', mimeType: 'video/mp4', sizeBytes: 12 };
  },
}));

let BASE = '';
let server: http.Server;
const CB = (orgId: string, s = ''): string => `/host/openwop-app/creative-briefs/orgs/${encodeURIComponent(orgId)}${s}`;

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
  return { post: (p: string, b?: unknown) => call('POST', p, b), get: (p: string) => call('GET', p) };
}

let seq = 0;
async function ownerWithBrief(): Promise<{ c: ReturnType<typeof client>; orgId: string; briefId: string; tenantId: string }> {
  const c = client();
  seq += 1;
  const tenantId = `org:reelkey-${seq}-${Date.now()}`;
  const login = await c.post('/host/openwop-app/test/login', { email: `reelkey-${seq}-${Date.now()}@t.test`, tenantId });
  expect([200, 201]).toContain(login.status);
  const org = await c.post('/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status).toBe(201);
  const orgId = org.body.orgId as string;
  const b = await c.post(CB(orgId, '/briefs'), { title: 'Reel Brief', assetType: 'video', sceneDescription: 'a fox in snow' });
  expect(b.status).toBe(201);
  return { c, orgId, briefId: b.body.briefId as string, tenantId };
}

describe('ADR 1039 D2 — a reel needs a video key before a run exists', () => {
  it('the page\'s old body (no key) is refused with credential_required and creates no run', async () => {
    const { c, orgId, briefId } = await ownerWithBrief();
    const r = await c.post(CB(orgId, `/briefs/${briefId}/reel`), { aspectRatio: '9:16' });
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(r.body.error).toBe('credential_required');
    expect(r.body.runId).toBeUndefined();
  });

  it('a ref name the workspace does not hold is refused the same way', async () => {
    const { c, orgId, briefId } = await ownerWithBrief();
    const r = await c.post(CB(orgId, `/briefs/${briefId}/reel`), { aspectRatio: '9:16', provider: 'replicate', credentialRef: 'replicate:no-such-key' });
    expect(r.status, JSON.stringify(r.body)).toBe(422);
    expect(r.body.error).toBe('credential_required');
  });

  it('picks a held Replicate key by the dispatch ladder; refuses a managed or other-vendor ref', async () => {
    const tenantId = `org:reelkey-ladder-${Date.now()}`;
    await expect(resolveReelCredential(tenantId, 'replicate', undefined)).rejects.toMatchObject({ code: 'credential_required' });
    await setSecret('replicate:prod', 'r8_key', { tenantId });
    await setSecret('openai', 'sk_key', { tenantId });
    expect(await resolveReelCredential(tenantId, 'replicate', undefined)).toBe('replicate:prod');
    expect(await resolveReelCredential(tenantId, 'replicate', 'replicate:prod')).toBe('replicate:prod');
    await expect(resolveReelCredential(tenantId, 'replicate', 'openai')).rejects.toMatchObject({ code: 'credential_required' });
    await expect(resolveReelCredential(tenantId, 'replicate', 'managed:replicate')).rejects.toMatchObject({ code: 'credential_required' });
    await expect(resolveReelCredential(tenantId, 'openai', undefined)).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('a workspace that holds a Replicate key launches, and the run hands that key to the provider call', async () => {
    const { c, orgId, briefId, tenantId } = await ownerWithBrief();
    await setSecret('replicate', 'r8_held_key', { tenantId });
    const launch = await c.post(CB(orgId, `/briefs/${briefId}/reel`), { aspectRatio: '9:16' });
    expect(launch.status, JSON.stringify(launch.body)).toBe(202);
    const boundRunId = toWireRunId(String(launch.body.runId), tenantId);
    let run: Record<string, unknown> = {};
    for (let i = 0; i < 80 && run.status !== 'completed' && run.status !== 'failed'; i += 1) {
      await new Promise((r) => setTimeout(r, 100));
      run = (await c.get(`/runs/${encodeURIComponent(boundRunId)}`)).body;
    }
    expect(run.status, JSON.stringify(run.error)).toBe('completed');
    expect(dispatched.some((d) => d.apiKey === 'r8_held_key')).toBe(true);
    const renders = await c.get(CB(orgId, `/briefs/${briefId}/renders`));
    expect((renders.body.renders as Array<{ reel?: unknown }>).filter((r) => r.reel)).toHaveLength(1);
  });

  it('an unsupported aspect ratio is refused before a run exists', async () => {
    const { c, orgId, briefId, tenantId } = await ownerWithBrief();
    await setSecret('replicate', 'r8_held_key', { tenantId });
    const r = await c.post(CB(orgId, `/briefs/${briefId}/reel`), { aspectRatio: '4:5' });
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(r.body.runId).toBeUndefined();
  });
});
