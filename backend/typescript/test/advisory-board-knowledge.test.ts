/**
 * Board "Shared knowledge" (ADR 0100 Phase 5) — ROUTE harness. Verifies the D2
 * affordance: sharing a managed planning KB with a board binds it to EVERY advisor
 * (and unsharing unbinds), surfaced via GET/POST /advisors/boards/:id/shared-knowledge.
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
  for (const id of ['users', 'kb', 'advisory-board', 'projects']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
interface Client { get: (p: string) => Promise<Res>; post: (p: string, b?: unknown) => Promise<Res>; patch: (p: string, b?: unknown) => Promise<Res> }
function client(): Client {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? undefined : await res.json().catch(() => undefined);
    return { status: res.status, body: out };
  };
  return { get: (p) => call('GET', p), post: (p, b) => call('POST', p, b), patch: (p, b) => call('PATCH', p, b) };
}

const uniqEmail = (who: string): string => `${who}-${Date.now()}-${n++}@acme.test`;
async function makeAdvisor(c: Client, persona: string): Promise<string> {
  const r = await c.post('/v1/host/openwop-app/roster', { persona, agentRef: { agentId: 'core.openwop.agents.brief-writer' } });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.rosterId;
}
async function ownerBoard(): Promise<{ owner: Client; orgId: string; boardId: string; advisors: string[] }> {
  const owner = client();
  const login = await owner.post('/v1/host/openwop-app/test/login', { email: uniqEmail('abk'), tenantId: `org:abk-${Date.now()}-${n++}` });
  expect(login.status, JSON.stringify(login.body)).toBe(201);
  const a = await makeAdvisor(owner, 'Ada Lovelace');
  const b = await makeAdvisor(owner, 'Alan Turing');
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  const board = await owner.post('/v1/host/openwop-app/advisors/boards', { orgId: org.body.orgId, name: 'Founders', advisors: [a, b], personaKind: 'historical' });
  expect(board.status, JSON.stringify(board.body)).toBe(201);
  return { owner, orgId: org.body.orgId, boardId: board.body.boardId, advisors: [a, b] };
}

const SK = (boardId: string): string => `/v1/host/openwop-app/advisors/boards/${encodeURIComponent(boardId)}/shared-knowledge`;
const find = (items: any[], kind: string): any => items.find((i) => i.kind === kind);

describe('ADR 0100 P5 — board shared knowledge', () => {
  it('lists both managed kinds, defaulting to not-shared', async () => {
    const { owner, boardId } = await ownerBoard();
    const r = await owner.get(SK(boardId));
    expect(r.status).toBe(200);
    expect(r.body.items.map((i: any) => i.kind).sort()).toEqual(['priority-matrix', 'project', 'strategy']);
    expect(find(r.body.items, 'strategy').shared).toBe(false);
    // Managed kinds are always shareable (toggle pre-creates); project is NOT
    // shareable with no project KBs (nothing to bind — the UI disables it).
    expect(find(r.body.items, 'strategy').shareable).toBe(true);
    expect(find(r.body.items, 'priority-matrix').shareable).toBe(true);
    expect(find(r.body.items, 'project').shareable).toBe(false);
  });

  it('shares the Strategy KB across all advisors, then unshares', async () => {
    const { owner, boardId } = await ownerBoard();
    const shared = await owner.post(SK(boardId), { kind: 'strategy', shared: true });
    expect(shared.status, JSON.stringify(shared.body)).toBe(200);
    expect(find(shared.body.items, 'strategy').shared).toBe(true);
    expect(find(shared.body.items, 'priority-matrix').shared).toBe(false); // independent

    const unshared = await owner.post(SK(boardId), { kind: 'strategy', shared: false });
    expect(find(unshared.body.items, 'strategy').shared).toBe(false);
  });

  it('shares the org PROJECT KBs across all advisors, then unshares', async () => {
    const { owner, orgId, boardId } = await ownerBoard();
    const proj = (await owner.post('/v1/host/openwop-app/projects', { orgId, name: 'Launch' })).body;
    const col = (await owner.post(`/v1/host/openwop-app/projects/${encodeURIComponent(proj.id)}/knowledge/collections`, { orgId, name: 'Launch notes' })).body;
    expect(col.collectionId, JSON.stringify(col)).toBeTruthy();

    const shared = await owner.post(SK(boardId), { kind: 'project', shared: true });
    expect(shared.status, JSON.stringify(shared.body)).toBe(200);
    const item = find(shared.body.items, 'project');
    expect(item.shared).toBe(true);
    expect(item.shareable).toBe(true); // a project KB exists ⇒ now toggle-able
    expect(item.count).toBeGreaterThanOrEqual(1);

    const unshared = await owner.post(SK(boardId), { kind: 'project', shared: false });
    expect(find(unshared.body.items, 'project').shared).toBe(false);
  });

  it('does NOT share a PRIVATE project KB — the visibility carve-out', async () => {
    const { owner, orgId, boardId } = await ownerBoard();
    const proj = (await owner.post('/v1/host/openwop-app/projects', { orgId, name: 'Secret' })).body;
    expect((await owner.patch(`/v1/host/openwop-app/projects/${encodeURIComponent(proj.id)}/visibility`, { visibility: 'private' })).status).toBe(200);
    await owner.post(`/v1/host/openwop-app/projects/${encodeURIComponent(proj.id)}/knowledge/collections`, { orgId, name: 'Secret notes' });

    const r = await owner.post(SK(boardId), { kind: 'project', shared: true });
    const item = find(r.body.items, 'project');
    expect(item.count).toBe(0); // private project skipped → nothing to share
    expect(item.shared).toBe(false);
  });

  it('rejects an unknown kind (400) and a non-member (404/403)', async () => {
    const { owner, boardId } = await ownerBoard();
    expect((await owner.post(SK(boardId), { kind: 'nonsense', shared: true })).status).toBe(400);
    const stranger = client();
    await stranger.post('/v1/host/openwop-app/test/login', { email: uniqEmail('stranger'), tenantId: `org:other-${Date.now()}-${n++}` });
    expect([403, 404]).toContain((await stranger.post(SK(boardId), { kind: 'strategy', shared: true })).status);
  });
});
