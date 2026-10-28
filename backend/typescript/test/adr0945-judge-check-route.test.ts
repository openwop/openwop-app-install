/**
 * ADR 0945 P2 — `POST …/creative-briefs/orgs/:orgId/fidelity/judge-check`
 * through the real app. It spends the workspace's BYOK key, so:
 *  - a viewer is refused (403) before anything resolves;
 *  - a partial spec is refused (400): all of provider/model/credentialRef or none;
 *  - a named spec goes to `resolveHeadlessAiForSpec` scoped to THIS tenant;
 *    none falls back to what the fidelity check itself would use;
 *  - no vision provider is an honest 422, never an empty pass;
 *  - the report names the provider, model and route that judged.
 * Breaks if the gate drops to members, a spec reaches another tenant's scope,
 * or a check with no judge reports success.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DescribedHeadlessDispatch, HeadlessModality } from '../src/host/headlessAi.js';

let ladder: DescribedHeadlessDispatch | null = null;
const specCalls: Array<{ tenantId: string; input: unknown; modality: HeadlessModality }> = [];
vi.mock('../src/host/headlessAi.js', async (orig) => ({
  ...(await orig<typeof import('../src/host/headlessAi.js')>()),
  resolveHeadlessAiDescribed: async () => ladder,
  resolveHeadlessAiForSpec: async (scope: { tenantId: string }, input: { provider: string; model: string }, modality: HeadlessModality) => {
    specCalls.push({ tenantId: scope.tenantId, input, modality });
    return { ...faithful(), provider: input.provider, model: input.model, route: 'byok-chosen' as const };
  },
}));
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { FIDELITY_ATTRIBUTES, LIVE_JUDGE_EVAL_CASES } from '../src/host/creativeFidelity/index.js';
import { getSetCookies } from './headerCookies.js';

const reply = (answers: Record<string, string>): string => JSON.stringify({ results: FIDELITY_ATTRIBUTES.map((attribute) => ({ attribute, answer: answers[attribute] ?? 'match', evidence: 'seen' })) });
function faithful(): DescribedHeadlessDispatch {
  let n = 0;
  return { provider: 'google', model: 'ladder-model', route: 'byok-default', dispatch: async () => reply(LIVE_JUDGE_EVAL_CASES[n++].ciJudge) };
}

let server: http.Server;
let BASE = '';
type Jar = { v: string };
const owner: Jar = { v: '' };
const call = async (jar: Jar, method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
  const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(jar.v ? { cookie: jar.v } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  for (const c of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(c); if (m) jar.v = m[1]; }
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
};
const TENANT = `org:g945jc-${Date.now()}`;
let orgId = '';
const P = (): string => `/host/openwop-app/creative-briefs/orgs/${encodeURIComponent(orgId)}/fidelity/judge-check`;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const d = getToggleDefault('creative-briefs');
  if (!d) throw new Error('no creative-briefs toggle');
  await saveConfig({ ...d, status: 'on' }, 'test');
  expect((await call(owner, 'POST', '/host/openwop-app/test/login', { email: 'g945jc@acme.test', tenantId: TENANT })).status).toBe(201);
  orgId = (await call(owner, 'POST', '/host/openwop-app/orgs', { name: 'Acme' })).body.orgId as string;
}, 60_000);
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('judge check route', () => {
  it('a viewer is refused before anything resolves', async () => {
    const viewer: Jar = { v: '' };
    const login = await call(viewer, 'POST', '/host/openwop-app/test/login', { email: `g945jc-viewer-${Date.now()}@acme.test`, tenantId: TENANT });
    const viewerId = (login.body as { user: { userId: string } }).user.userId;
    expect((await call(owner, 'POST', `/host/openwop-app/orgs/${encodeURIComponent(orgId)}/members`, { displayName: 'V', subject: viewerId, roles: ['viewer'] })).status).toBe(201);
    specCalls.length = 0;
    expect((await call(viewer, 'POST', P(), { provider: 'anthropic', model: 'm', credentialRef: 'k' })).status).toBe(403);
    expect(specCalls).toEqual([]);
  }, 60_000);

  it('a partial spec is refused', async () => {
    const r = await call(owner, 'POST', P(), { provider: 'anthropic', model: 'm' });
    expect(r.status).toBe(400);
  });

  it('with no vision provider it is an honest 422', async () => {
    ladder = null;
    const r = await call(owner, 'POST', P(), {});
    expect(r.status).toBe(422);
  });

  it('a named spec is resolved in this tenant, and the report names who judged', async () => {
    specCalls.length = 0;
    const r = await call(owner, 'POST', P(), { provider: 'anthropic', model: 'claude-vision-x', credentialRef: 'my-key' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(specCalls).toEqual([{ tenantId: TENANT, input: { provider: 'anthropic', model: 'claude-vision-x', credentialRef: 'my-key' }, modality: 'image' }]);
    expect(r.body).toMatchObject({ provider: 'anthropic', model: 'claude-vision-x', route: 'byok-chosen', calls: 4, completed: true, passed: true, rulesetVersion: 'fid-a-1' });
    expect((r.body.cases as unknown[]).length).toBe(4);
  });

  it('with no spec it tests what the fidelity check would use', async () => {
    ladder = faithful();
    specCalls.length = 0;
    const r = await call(owner, 'POST', P(), {});
    expect(r.status).toBe(200);
    expect(specCalls).toEqual([]);
    expect(r.body).toMatchObject({ provider: 'google', model: 'ladder-model', route: 'byok-default', passed: true });
  });
});
