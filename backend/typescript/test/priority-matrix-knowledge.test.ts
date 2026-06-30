/**
 * Priority Matrix → KB auto-indexer (ADR 0100 Phase 2) — ROUTE harness. Drives
 * list + idea CRUD over HTTP and reads the managed 'Priority Matrix KB' to verify:
 *   - a workspace/org list is indexed (pm-list doc); its ideas are indexed
 *     (pm-idea docs) on submit, and re-indexed (not duplicated) on score/move
 *   - a PROJECT-scoped list + its ideas are NOT indexed (the RBAC carve-out)
 *   - deleteList evicts the list doc + every idea doc (the only idea-removal path)
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

let BASE: string;
let server: http.Server;
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['priority-matrix', 'kb', 'projects']) await enableToggle(id);
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; patch: (p: string, b?: unknown) => Promise<Res>; put: (p: string, b?: unknown) => Promise<Res>; del: (p: string) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b), put: (p, b) => call('PUT', p, b), del: (p) => call('DELETE', p) };
}

const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;
const enableToggle = async (id: string): Promise<void> => { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); };
const L = '/v1/host/openwop-app/priority-matrix/lists';

async function ownerWithOrg(): Promise<{ owner: Client; orgId: string }> {
  const owner = client();
  const r = await owner.post('/v1/host/openwop-app/test/login', { email: uniqEmail('pmk'), tenantId: `org:pmk-${Date.now()}-${n++}` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  expect(org.status, JSON.stringify(org.body)).toBe(201);
  return { owner, orgId: org.body.orgId };
}

/** Doc ids in the managed Priority Matrix KB for an org (empty if absent). */
async function kbDocIds(owner: Client, orgId: string): Promise<string[]> {
  const colId = `mgd-priority-matrix-${orgId}`;
  const docs = await owner.get(`/v1/host/openwop-app/kb/orgs/${encodeURIComponent(orgId)}/collections/${encodeURIComponent(colId)}/documents`);
  if (docs.status !== 200) return [];
  return (docs.body.documents as Array<{ documentId: string }>).map((d) => d.documentId);
}

describe('ADR 0100 P2 — priority matrix indexes lists + ideas', () => {
  it('indexes a workspace list and its ideas; re-indexes (not duplicates) on score', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const list = (await owner.post(L, { orgId, name: 'Launch priorities' })).body;
    expect(await kbDocIds(owner, orgId)).toEqual([`pm-list:${list.id}`]);

    const base = `${L}/${encodeURIComponent(list.id)}`;
    const idea = (await owner.post(`${base}/ideas`, { title: 'Ship onboarding', description: 'Reduce time-to-value' })).body;
    expect(await kbDocIds(owner, orgId)).toEqual(expect.arrayContaining([`pm-list:${list.id}`, `pm-idea:${idea.id}`]));

    await owner.put(`${base}/ideas/${encodeURIComponent(idea.id)}/scores`, { scores: { 'strategic-alignment': 9, roi: 8, urgency: 7, 'compliance-risk': 5, cost: 3 } });
    const ids = await kbDocIds(owner, orgId);
    expect(ids.filter((d) => d === `pm-idea:${idea.id}`)).toHaveLength(1); // upserted, not duplicated

    const cols = await owner.get(`/v1/host/openwop-app/kb/orgs/${encodeURIComponent(orgId)}/collections`);
    expect((cols.body.collections as Array<any>).find((c) => c.collectionId === `mgd-priority-matrix-${orgId}`)?.managed).toBe('priority-matrix');
  });

  it('does NOT index a PROJECT-scoped list or its ideas — the RBAC carve-out', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const proj = (await owner.post('/v1/host/openwop-app/projects', { orgId, name: 'Secret project' })).body;
    const list = (await owner.post(L, { orgId, name: 'Project priorities', projectId: proj.id })).body;
    const idea = (await owner.post(`${L}/${encodeURIComponent(list.id)}/ideas`, { title: 'Private idea' })).body;

    const ids = await kbDocIds(owner, orgId);
    expect(ids).not.toContain(`pm-list:${list.id}`);
    expect(ids).not.toContain(`pm-idea:${idea.id}`);
  });

  it('idea doc carries the score; a criteria-weight change re-indexes it (single doc, refreshed)', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const list = (await owner.post(L, { orgId, name: 'Scored list' })).body;
    const base = `${L}/${encodeURIComponent(list.id)}`;
    const idea = (await owner.post(`${base}/ideas`, { title: 'Scored idea' })).body;
    await owner.put(`${base}/ideas/${encodeURIComponent(idea.id)}/scores`, { scores: { 'strategic-alignment': 9, roi: 8, urgency: 7, 'compliance-risk': 5, cost: 3 } });

    const colId = `mgd-priority-matrix-${orgId}`;
    const docPath = `/v1/host/openwop-app/kb/orgs/${encodeURIComponent(orgId)}/collections/${encodeURIComponent(colId)}/documents/${encodeURIComponent(`pm-idea:${idea.id}`)}`;
    const doc = (await owner.get(docPath)).body;
    expect(doc.text).toContain('## Scores');
    expect(doc.text).toContain('Strategic alignment: 9/10');

    // Re-weight criteria → recompute + re-index; the idea doc stays single + present.
    const cs = { ...list.criteriaSet, criteria: list.criteriaSet.criteria.map((c: any) => ({ ...c, weight: c.id === 'roi' ? 10 : c.weight })) };
    expect((await owner.patch(base, { criteriaSet: cs })).status).toBe(200);
    expect((await kbDocIds(owner, orgId)).filter((d) => d === `pm-idea:${idea.id}`)).toHaveLength(1);
  });

  it('deleteList evicts the list doc and all idea docs', async () => {
    const { owner, orgId } = await ownerWithOrg();
    const list = (await owner.post(L, { orgId, name: 'Temp list' })).body;
    const idea = (await owner.post(`${L}/${encodeURIComponent(list.id)}/ideas`, { title: 'Temp idea' })).body;
    expect(await kbDocIds(owner, orgId)).toEqual(expect.arrayContaining([`pm-list:${list.id}`, `pm-idea:${idea.id}`]));

    expect((await owner.del(`${L}/${encodeURIComponent(list.id)}`)).status === 204).toBe(true);
    const ids = await kbDocIds(owner, orgId);
    expect(ids).not.toContain(`pm-list:${list.id}`);
    expect(ids).not.toContain(`pm-idea:${idea.id}`);
  });
});
