/**
 * Angles / hook-bank / targeting routes (ADR 0403 Phases 2-3) — ROUTE harness:
 *   - GET /briefs/:id/angles + DELETE (curation)
 *   - evidence delete blocked 409 while an angle cites it; clean after
 *   - GET /hooks?orgId (uniform 404 for non-members) + POST /hooks/:id/promote
 *     (transition lattice; workspace:write)
 *   - GET/DELETE /briefs/:id/targeting
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { persistVocEvidence } from '../src/features/campaign-brief/vocService.js';
import { persistAngles } from '../src/features/campaign-brief/angleService.js';
import { emitCandidateHooks } from '../src/features/campaign-brief/hookBankService.js';
import { persistTargetingPack } from '../src/features/campaign-brief/targetingService.js';

let BASE: string;
let server: http.Server;
let n = 0;

const TENANT = 'hooks-route-tenant';

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

const uniqEmail = (): string => `hb-${Date.now()}-${n++}@acme.test`;
const CB = '/v1/host/openwop-app/campaign-brief';
const REF = { documentId: 'doc-1', sourceKind: 'kb' as const, locator: 'chunk:0', contentHash: 'a'.repeat(64) };

async function ownerWithBrief(): Promise<{ owner: Client; orgId: string; briefId: string }> {
  const owner = client();
  expect((await owner.post('/v1/host/openwop-app/test/login', { email: uniqEmail(), tenantId: TENANT })).status).toBe(201);
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  const brief = await owner.post(`${CB}/briefs`, { orgId: org.body.orgId, name: 'Q4', productName: 'FlashPick' });
  expect(brief.status, JSON.stringify(brief.body)).toBe(201);
  return { owner, orgId: org.body.orgId, briefId: brief.body.brief.id };
}

describe('angle routes + the evidence-cited 409 guard', () => {
  it('lists angles; evidence delete is 409 while cited, 204 after the angle is pruned', async () => {
    const { owner, orgId, briefId } = await ownerWithBrief();
    const [ev] = await persistVocEvidence(TENANT, orgId, briefId, 'test', [
      { quote: 'costs too much', sourceRef: REF, theme: 'price', sentiment: 'objection' },
    ]);
    const [angle] = await persistAngles(TENANT, orgId, briefId, 'test', [
      { claim: 'Worth it', positioningLens: 'value', proofRefs: [ev.id], hookVariants: [] },
    ]);
    expect((await owner.get(`${CB}/briefs/${briefId}/angles`)).body.angles).toHaveLength(1);

    const blocked = await owner.del(`${CB}/briefs/${briefId}/voc/${ev.id}`);
    expect(blocked.status).toBe(409);
    // The error middleware redacts high-entropy strings (UUIDs) in details —
    // assert the citation count, not the raw id.
    expect(blocked.body.details.citingAngleIds).toHaveLength(1);

    expect((await owner.del(`${CB}/briefs/${briefId}/angles/${angle.id}`)).status).toBe(204);
    expect((await owner.del(`${CB}/briefs/${briefId}/voc/${ev.id}`)).status).toBe(204);
  });

  it('evidence delete is also blocked while a targeting pack cites it', async () => {
    const { owner, orgId, briefId } = await ownerWithBrief();
    const [ev] = await persistVocEvidence(TENANT, orgId, briefId, 'test', [
      { quote: 'slow sync', sourceRef: REF, theme: 'sync', sentiment: 'pain' },
    ]);
    await persistTargetingPack(TENANT, orgId, briefId, 'test', { platform: 'meta', audiences: ['ops'], interests: [], keywords: [], rationale: 'r', evidenceRefs: [ev.id] });
    const blocked = await owner.del(`${CB}/briefs/${briefId}/voc/${ev.id}`);
    expect(blocked.status).toBe(409);
    expect(blocked.body.details.citingPlatforms).toEqual(['meta']);
    expect((await owner.del(`${CB}/briefs/${briefId}/targeting/meta`)).status).toBe(204);
    expect((await owner.del(`${CB}/briefs/${briefId}/voc/${ev.id}`)).status).toBe(204);
  });
});

describe('hook-bank routes', () => {
  it('lists + promotes through the lattice; illegal transition is a 400-class error', async () => {
    const { owner, orgId } = await ownerWithBrief();
    const { emitted } = await emitCandidateHooks(TENANT, orgId, 'angle-1', [{ text: 'Stop recounting bins', format: 'bold-claim' }], 'test');
    const hookId = emitted[0].id;
    expect((await owner.get(`${CB}/hooks?orgId=${orgId}&status=candidate`)).body.hooks).toHaveLength(1);

    const promoted = await owner.post(`${CB}/hooks/${hookId}/promote`, { orgId, status: 'tested', metricRef: 'perf:ad-7' });
    expect(promoted.status).toBe(200);
    expect(promoted.body.hook).toMatchObject({ status: 'tested', metricRef: 'perf:ad-7' });

    expect((await owner.post(`${CB}/hooks/${hookId}/promote`, { orgId, status: 'candidate' })).status).toBe(422);
    expect((await owner.post(`${CB}/hooks/missing/promote`, { orgId, status: 'tested' })).status).toBe(404);
  });

  it('IDOR: a co-tenant stranger gets uniform 404 on list AND promote', async () => {
    const { orgId } = await ownerWithBrief();
    const { emitted } = await emitCandidateHooks(TENANT, orgId, 'angle-1', [{ text: 'Private hook', format: 'question' }], 'test');
    const stranger = client();
    await stranger.post('/v1/host/openwop-app/test/login', { email: uniqEmail(), tenantId: TENANT });
    expect((await stranger.get(`${CB}/hooks?orgId=${orgId}`)).status).toBe(404);
    expect((await stranger.post(`${CB}/hooks/${emitted[0].id}/promote`, { orgId, status: 'tested' })).status).toBe(404);
  });
});

describe('targeting routes', () => {
  it('lists packs; delete of an absent platform is 404', async () => {
    const { owner, orgId, briefId } = await ownerWithBrief();
    const [ev] = await persistVocEvidence(TENANT, orgId, briefId, 'test', [
      { quote: 'q', sourceRef: REF, theme: 't', sentiment: 'desire' },
    ]);
    await persistTargetingPack(TENANT, orgId, briefId, 'test', { platform: 'linkedin', audiences: ['ops'], interests: [], keywords: ['wms'], rationale: 'r', evidenceRefs: [ev.id] });
    const list = await owner.get(`${CB}/briefs/${briefId}/targeting`);
    expect(list.body.packs.map((p: any) => p.platform)).toEqual(['linkedin']);
    expect((await owner.del(`${CB}/briefs/${briefId}/targeting/tiktok`)).status).toBe(404);
    expect((await owner.del(`${CB}/briefs/${briefId}/targeting/not-a-platform`)).status).toBe(404);
  });
});
