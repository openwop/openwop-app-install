/**
 * VOC evidence routes (ADR 0403 Phase 1) — ROUTE harness:
 *   - GET /briefs/:id/voc lists evidence (sentiment/theme query filters)
 *   - DELETE /briefs/:id/voc/:evidenceId curates (workspace:write), 404 on a miss
 *   - IDOR: a stranger gets a uniform 404 on both
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { persistVocEvidence } from '../src/features/campaign-brief/vocService.js';

let BASE: string;
let server: http.Server;
let n = 0;

const TENANT = 'voc-route-tenant';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const d = getToggleDefault('campaign-brief'); if (d) await saveConfig({ ...d, status: 'on' }, 'test');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; del: (p: string) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), del: (p) => call('DELETE', p) };
}

const uniqEmail = (): string => `voc-${Date.now()}-${n++}@acme.test`;
const B = '/v1/host/openwop-app/campaign-brief/briefs';
const REF = { documentId: 'doc-1', sourceKind: 'kb' as const, locator: 'chunk:0', contentHash: 'a'.repeat(64) };

async function ownerWithBrief(): Promise<{ owner: Client; orgId: string; briefId: string }> {
  const owner = client();
  expect((await owner.post('/v1/host/openwop-app/test/login', { email: uniqEmail(), tenantId: TENANT })).status).toBe(201);
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  const brief = await owner.post(B, { orgId: org.body.orgId, name: 'Q4', productName: 'FlashPick' });
  expect(brief.status, JSON.stringify(brief.body)).toBe(201);
  return { owner, orgId: org.body.orgId, briefId: brief.body.brief.id };
}

describe('campaign-brief VOC routes', () => {
  it('lists evidence with sentiment + theme filters (an unknown sentiment is ignored)', async () => {
    const { owner, orgId, briefId } = await ownerWithBrief();
    await persistVocEvidence(TENANT, orgId, briefId, 'test', [
      { quote: 'I waste two hours every morning', sourceRef: REF, theme: 'time waste', sentiment: 'pain' },
      { quote: 'wish it synced overnight', sourceRef: REF, theme: 'automation', sentiment: 'desire' },
    ]);
    expect((await owner.get(`${B}/${briefId}/voc`)).body.evidence).toHaveLength(2);
    const pains = await owner.get(`${B}/${briefId}/voc?sentiment=pain`);
    expect(pains.body.evidence.map((e: any) => e.theme)).toEqual(['time waste']);
    expect((await owner.get(`${B}/${briefId}/voc?theme=auto`)).body.evidence).toHaveLength(1);
    expect((await owner.get(`${B}/${briefId}/voc?sentiment=bogus`)).body.evidence).toHaveLength(2);
  });

  it('deletes one evidence item; a second delete is a 404', async () => {
    const { owner, orgId, briefId } = await ownerWithBrief();
    const [row] = await persistVocEvidence(TENANT, orgId, briefId, 'test', [
      { quote: 'costs too much for what it does', sourceRef: REF, theme: 'price', sentiment: 'objection' },
    ]);
    expect((await owner.del(`${B}/${briefId}/voc/${row.id}`)).status).toBe(204);
    expect((await owner.get(`${B}/${briefId}/voc`)).body.evidence).toHaveLength(0);
    expect((await owner.del(`${B}/${briefId}/voc/${row.id}`)).status).toBe(404);
  });

  it('IDOR: a co-tenant stranger without org read gets a uniform 404 on list AND delete', async () => {
    const { orgId, briefId } = await ownerWithBrief();
    const [row] = await persistVocEvidence(TENANT, orgId, briefId, 'test', [
      { quote: 'private customer words', sourceRef: REF, theme: 'secret', sentiment: 'pain' },
    ]);
    const stranger = client();
    await stranger.post('/v1/host/openwop-app/test/login', { email: uniqEmail(), tenantId: TENANT });
    expect((await stranger.get(`${B}/${briefId}/voc`)).status).toBe(404);
    expect((await stranger.del(`${B}/${briefId}/voc/${row.id}`)).status).toBe(404);
  });
});
