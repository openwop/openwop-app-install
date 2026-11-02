/** ADR 0951 D3/P2.4 — the replay HTTP lanes through the real app. Upload: the
 * server decodes the closed geometry format and stores only its re-encoded
 * result; every refusal that is not a malformed request is the same
 * `{recorded:false}`. Playback: `host:analytics:replay` on the exact org, then
 * the audited store read. The replay choice is not yet offered on the public
 * consent lane, so the grant is recorded through the consent service for the
 * subject a real public-consent token names. */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createMember, getOrg } from '../src/host/accessControlService.js';
import { mergeConsentCategories } from '../src/features/consent/consentService.js';
import { resolveConsentTokenSubject } from '../src/features/consent/visitorConsent.js';
import { REPLAY_BLOB_ROOT, replayChunkPrefix } from '../src/features/analytics/replayStore.js';
import { buildHostSurfaceBundle } from '../src/host/inMemorySurfaces.js';

let BASE: string;
let server: http.Server;
const ENV = { OPENWOP_REPLAY_ALLOW_MEMORY_BLOB: 'true', OPENWOP_REPLAY_SAMPLE_PERCENT: '100' } as const;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  Object.assign(process.env, ENV);
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['analytics', 'analytics.session-replay', 'consent']) await toggle(id, 'on');
});
afterAll(async () => {
  for (const k of Object.keys(ENV)) delete process.env[k];
  await new Promise<void>((res) => server.close(() => res()));
});

async function toggle(id: string, status: 'on' | 'off'): Promise<void> {
  const d = getToggleDefault(id);
  if (!d) throw new Error(`no toggle default for ${id}`);
  await saveConfig({ ...d, status }, 'test');
}
interface Res<T = unknown> { status: number; body: T }
function client(ua = 'Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Safari/605.1.15') {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'user-agent': ua, ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const h = res.headers as { getSetCookie?: () => string[] };
    for (const c of (typeof h.getSetCookie === 'function' ? h.getSetCookie() : [])) { const m = /(__session=[^;]+)/.exec(c); if (m) cookie = m[1]; }
    return { status: res.status, body: (res.status === 204 ? undefined : await res.json().catch(() => undefined)) as T };
  };
  return { get: <T = unknown>(p: string) => call<T>('GET', p), post: <T = unknown>(p: string, b?: unknown) => call<T>('POST', p, b), put: <T = unknown>(p: string, b?: unknown) => call<T>('PUT', p, b) };
}
let n = 0;
async function site(): Promise<{ owner: ReturnType<typeof client>; orgId: string; tenantId: string }> {
  const owner = client();
  const tenantId = `ws:replay-routes-${n++}-${Date.now()}`;
  expect((await owner.post('/host/openwop-app/test/login', { email: `replay-${n}-${Date.now()}@acme.test`, tenantId })).status).toBe(201);
  const org = await owner.post<{ orgId: string }>('/host/openwop-app/orgs', { name: 'Client A' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  // The owner attests the client is not health/finance (David's exclusion), or nothing records.
  const attested = await owner.put(`/host/openwop-app/analytics/orgs/${org.body.orgId}/replay/eligibility`, { notHealthOrFinance: true });
  expect(attested).toEqual({ status: 200, body: { orgEligible: true } });
  return { owner, orgId: org.body.orgId, tenantId: (await getOrg(org.body.orgId))!.tenantId };
}
/** A real public-consent token, and a recorded explicit replay grant for its subject. */
async function consentedVisitor(orgId: string, tenantId: string, granted = true): Promise<string> {
  const minted = await client().post<{ subjectToken: string }>(`/host/openwop-app/public-consent/${orgId}`, { categories: { analytics: true } });
  expect(minted.status, JSON.stringify(minted.body)).toBe(201);
  const subjectKey = resolveConsentTokenSubject(tenantId, minted.body.subjectToken)!;
  await mergeConsentCategories({ tenantId, subjectKey, categories: { 'analytics.replay': granted }, source: `public:${orgId}` });
  return minted.body.subjectToken;
}
const geometry = () => ({ version: 1, events: [
  { type: 'frame', at: 0, viewport: { width: 800, height: 600 }, nodes: [
    { id: 1, parent: null, kind: 'box', x: 0, y: 0, width: 800, height: 1200 },
    { id: 2, parent: 1, kind: 'masked', x: 16, y: 32, width: 64, height: 16 },
  ] },
  { type: 'pointer', at: 10, action: 'move', x: 24, y: 40 },
] });
// The same chunk, with legal JSON whitespace the server must not keep.
const upload = (value: unknown) => gzipSync(Buffer.from(JSON.stringify(value, null, 2))).toString('base64');
const chunkUrl = (orgId: string, sessionId: string) => `/host/openwop-app/public-analytics/${orgId}/replay/${sessionId}/chunk`;

describe('ADR 0951 — replay upload lane', () => {
  it('stores only the re-encoded validated chunk, and an admin of the org can play it back', async () => {
    const { owner, orgId, tenantId } = await site();
    const consentToken = await consentedVisitor(orgId, tenantId);
    const sessionId = randomUUID();
    const sent = await client().post(chunkUrl(orgId, sessionId), { index: 0, content: upload(geometry()), consentToken });
    expect(sent).toEqual({ status: 202, body: { recorded: true } });
    const stored = await buildHostSurfaceBundle({ tenantId: REPLAY_BLOB_ROOT }).storage.blob.get({ key: `${replayChunkPrefix(tenantId, orgId, sessionId)}0` }) as { contentBase64: string };
    expect(gunzipSync(Buffer.from(stored.contentBase64, 'base64')).toString()).toBe(JSON.stringify(geometry()));
    const list = await owner.get<{ sessions: Array<Record<string, unknown>> }>(`/host/openwop-app/analytics/orgs/${orgId}/replay/sessions`);
    expect(list.status).toBe(200);
    expect(list.body.sessions).toEqual([expect.objectContaining({ sessionId, chunkCount: 1 })]);
    expect(Object.keys(list.body.sessions[0]!)).not.toContain('subjectKey');
    const played = await owner.get<{ events: unknown }>(`/host/openwop-app/analytics/orgs/${orgId}/replay/sessions/${sessionId}/chunks/0`);
    expect(played).toEqual({ status: 200, body: { chunkIndex: 0, ...geometry() } });
  });

  it('refuses content outside the closed format as a malformed request, storing nothing', async () => {
    const { orgId, tenantId } = await site();
    const consentToken = await consentedVisitor(orgId, tenantId);
    const sessionId = randomUUID();
    const poisoned = geometry();
    (poisoned.events[0] as { nodes: Array<Record<string, unknown>> }).nodes[1]!.text = 'PRIVATE';
    // Without a consent token the server does no decompression work at all.
    expect(await client().post(chunkUrl(orgId, randomUUID()), { index: 0, content: upload(poisoned) })).toEqual({ status: 202, body: { recorded: false } });
    const sent = await client().post<{ message?: string }>(chunkUrl(orgId, sessionId), { index: 0, content: upload(poisoned), consentToken });
    expect(sent.status).toBe(400);
    expect(JSON.stringify(sent.body)).not.toContain('PRIVATE');
    const stored = await buildHostSurfaceBundle({ tenantId: REPLAY_BLOB_ROOT }).storage.blob.list({ prefix: replayChunkPrefix(tenantId, orgId, sessionId) }) as { entries: unknown[] };
    expect(stored.entries).toEqual([]);
  });

  it('no token, no grant, a bot, and replay off are all the same {recorded:false}', async () => {
    const { orgId, tenantId } = await site();
    const granted = await consentedVisitor(orgId, tenantId);
    const refused = await consentedVisitor(orgId, tenantId, false);
    const content = upload(geometry());
    const outcomes = [
      await client().post(chunkUrl(orgId, randomUUID()), { index: 0, content }),
      await client().post(chunkUrl(orgId, randomUUID()), { index: 0, content, consentToken: refused }),
      await client('Googlebot/2.1 (+http://www.google.com/bot.html)').post(chunkUrl(orgId, randomUUID()), { index: 0, content, consentToken: granted }),
    ];
    await toggle('analytics.session-replay', 'off');
    outcomes.push(await client().post(chunkUrl(orgId, randomUUID()), { index: 0, content, consentToken: granted }));
    await toggle('analytics.session-replay', 'on');
    for (const o of outcomes) expect(o).toEqual({ status: 202, body: { recorded: false } });
  });

  // ADR 0951 P2 review #8: `sessionKey` is a PII field stored in the index row,
  // and it had no length or shape bound.
  it('an oversized or blank sessionKey is a malformed request, and nothing is stored', async () => {
    const { orgId, tenantId } = await site();
    const consentToken = await consentedVisitor(orgId, tenantId);
    for (const sessionKey of ['k'.repeat(257), '   ', 42]) {
      const sessionId = randomUUID();
      const sent = await client().post<{ details?: { field?: string } }>(chunkUrl(orgId, sessionId), { index: 0, content: upload(geometry()), consentToken, sessionKey });
      expect(sent.status).toBe(400);
      expect(sent.body.details?.field).toBe('sessionKey');
      const stored = await buildHostSurfaceBundle({ tenantId: REPLAY_BLOB_ROOT }).storage.blob.list({ prefix: replayChunkPrefix(tenantId, orgId, sessionId) }) as { entries: unknown[] };
      expect(stored.entries).toEqual([]);
    }
    const ok = await client().post(chunkUrl(orgId, randomUUID()), { index: 0, content: upload(geometry()), consentToken, sessionKey: 'vk-1' });
    expect(ok).toEqual({ status: 202, body: { recorded: true } });
  });

  // ADR 0951 P2 review #9: unconfigured storage answered 503 instead of the
  // uniform refusal, and the org fences ran only after the gunzip and parse.
  it('unconfigured storage and an unattested org are the uniform refusal, before any decoding', async () => {
    const { orgId, tenantId } = await site();
    const consentToken = await consentedVisitor(orgId, tenantId);
    const poisoned = geometry();
    (poisoned.events[0] as { nodes: Array<Record<string, unknown>> }).nodes[1]!.text = 'PRIVATE';
    delete process.env.OPENWOP_REPLAY_ALLOW_MEMORY_BLOB;
    try {
      expect(await client().post(chunkUrl(orgId, randomUUID()), { index: 0, content: upload(geometry()), consentToken })).toEqual({ status: 202, body: { recorded: false } });
    } finally { process.env.OPENWOP_REPLAY_ALLOW_MEMORY_BLOB = 'true'; }
    const other = await site();
    const otherToken = await consentedVisitor(other.orgId, other.tenantId);
    expect((await other.owner.put(`/host/openwop-app/analytics/orgs/${other.orgId}/replay/eligibility`, { notHealthOrFinance: false })).status).toBe(200);
    // A malformed chunk to an unattested org is refused without being decoded (a decode would 400).
    expect(await client().post(chunkUrl(other.orgId, randomUUID()), { index: 0, content: upload(poisoned), consentToken: otherToken })).toEqual({ status: 202, body: { recorded: false } });
  });

  it('playback is refused to a signed-out caller and to a signed-in non-member', async () => {
    const { orgId, tenantId } = await site();
    const consentToken = await consentedVisitor(orgId, tenantId);
    const sessionId = randomUUID();
    await client().post(chunkUrl(orgId, sessionId), { index: 0, content: upload(geometry()), consentToken });
    expect((await client().get(`/host/openwop-app/analytics/orgs/${orgId}/replay/sessions/${sessionId}/chunks/0`)).status).toBe(401);
    const stranger = client();
    await stranger.post('/host/openwop-app/test/login', { email: `stranger-${Date.now()}@other.test`, tenantId: `user:stranger-${Date.now()}` });
    const denied = await stranger.get(`/host/openwop-app/analytics/orgs/${orgId}/replay/sessions/${sessionId}/chunks/0`);
    expect([403, 404]).toContain(denied.status);
    expect((await stranger.get(`/host/openwop-app/analytics/orgs/${orgId}/replay/sessions`)).status).not.toBe(200);
    // A signed-in EDITOR of this very org: a member, but not an owner/admin.
    const editor = client();
    const login = await editor.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `editor-${Date.now()}@acme.test`, tenantId });
    expect(login.status).toBe(201);
    await createMember({ tenantId, orgId, subject: login.body.user.userId, displayName: 'Editor', roles: ['editor'] });
    expect((await editor.get(`/host/openwop-app/analytics/orgs/${orgId}/replay/sessions`)).status).toBe(403);
    expect((await editor.get(`/host/openwop-app/analytics/orgs/${orgId}/replay/sessions/${sessionId}/chunks/0`)).status).toBe(403);
    expect((await editor.put(`/host/openwop-app/analytics/orgs/${orgId}/replay/eligibility`, { notHealthOrFinance: false })).status).toBe(403);
  });

  it('the posture offers recording only for an attested org; withdrawing stops recording at once', async () => {
    const { owner, orgId, tenantId } = await site();
    const posture = async () => (await client().get<{ choices?: string[] }>(`/host/openwop-app/public-consent/${orgId}/posture`)).body.choices ?? [];
    expect(await posture()).toContain('analytics.replay');
    const consentToken = await consentedVisitor(orgId, tenantId);
    const sessionId = randomUUID();
    expect((await client().post(chunkUrl(orgId, sessionId), { index: 0, content: upload(geometry()), consentToken })).body).toEqual({ recorded: true });
    expect((await owner.put(`/host/openwop-app/analytics/orgs/${orgId}/replay/eligibility`, { notHealthOrFinance: false })).status).toBe(200);
    expect(await posture()).not.toContain('analytics.replay');
    expect((await client().post(chunkUrl(orgId, sessionId), { index: 1, content: upload(geometry()), consentToken })).body).toEqual({ recorded: false });
    expect((await owner.get<{ sessions: unknown[] }>(`/host/openwop-app/analytics/orgs/${orgId}/replay/sessions`)).body.sessions).toEqual([]);
    const settings = await owner.get<{ replay: { orgEligible: boolean; available: boolean } }>(`/host/openwop-app/analytics/orgs/${orgId}/behavior/settings`);
    expect(settings.body.replay).toMatchObject({ orgEligible: false, available: false });
    expect((await owner.put(`/host/openwop-app/analytics/orgs/${orgId}/replay/eligibility`, { notHealthOrFinance: 'yes' })).status).toBe(400);
  });
});
