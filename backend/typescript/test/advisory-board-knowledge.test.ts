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
import { getAgentProfile } from '../src/host/agentProfileService.js';
import { createAgentToolProvider } from '../src/host/agentToolProvider.js';
import { composeChatContext } from '../src/host/chatContext.js';
import { bindCollection } from '../src/features/agent-knowledge/service.js';
import { PREAUTHORIZED_CALLER } from '../src/host/subjectAccess.js';
import { __clearAgentIdentityCache } from '../src/host/agentIdentity.js';

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
async function ownerBoard(): Promise<{ owner: Client; tenantId: string; orgId: string; boardId: string; advisors: string[] }> {
  const owner = client();
  const tenantId = `org:abk-${Date.now()}-${n++}`;
  const login = await owner.post('/v1/host/openwop-app/test/login', { email: uniqEmail('abk'), tenantId });
  expect(login.status, JSON.stringify(login.body)).toBe(201);
  const a = await makeAdvisor(owner, 'Ada Lovelace');
  const b = await makeAdvisor(owner, 'Alan Turing');
  const org = await owner.post('/v1/host/openwop-app/orgs', { name: 'Acme' });
  const board = await owner.post('/v1/host/openwop-app/advisors/boards', { orgId: org.body.orgId, name: 'Founders', advisors: [a, b], personaKind: 'historical' });
  expect(board.status, JSON.stringify(board.body)).toBe(201);
  return { owner, tenantId, orgId: org.body.orgId, boardId: board.body.boardId, advisors: [a, b] };
}

const SK = (boardId: string): string => `/v1/host/openwop-app/advisors/boards/${encodeURIComponent(boardId)}/shared-knowledge`;
const find = (items: any[], kind: string): any => items.find((i) => i.kind === kind);

describe('ADR 0100 P5 — board shared knowledge', () => {
  it('lists both managed kinds, defaulting to not-shared', async () => {
    const { owner, boardId } = await ownerBoard();
    const r = await owner.get(SK(boardId));
    expect(r.status).toBe(200);
    expect(r.body.items.map((i: any) => i.kind).sort()).toEqual(['priority-matrix', 'project', 'strategy', 'team-portfolio']);
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

describe('ADR 0277 P2 — knowledge-composition reconciliation', () => {
  const BOARD = (id: string): string => `/v1/host/openwop-app/advisors/boards/${encodeURIComponent(id)}`;
  const bound = async (tenantId: string, advisorId: string): Promise<string[]> =>
    (await getAgentProfile(tenantId, advisorId))?.knowledge?.collectionIds ?? [];

  it('cohort change reconciles bindings: adds are bound, removes are unbound, the toggle stays ON (stored intent)', async () => {
    const { owner, tenantId, boardId, advisors: [a, b] } = await ownerBoard();
    expect(find((await owner.post(SK(boardId), { kind: 'strategy', shared: true })).body.items, 'strategy').shared).toBe(true);
    const before = await bound(tenantId, a!);
    expect(before.length).toBeGreaterThan(0); // the managed strategy collection

    // Swap the cohort: keep a, drop b, add c. Previously: c got NOTHING (and the
    // toggle silently read OFF), b kept the org strategy KB forever (grant leak).
    const c = await makeAdvisor(owner, 'Grace Hopper');
    __clearAgentIdentityCache();
    const patched = await owner.patch(BOARD(boardId), { advisors: [a, c] });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);

    expect(find((await owner.get(SK(boardId))).body.items, 'strategy').shared).toBe(true); // no silent OFF
    expect(await bound(tenantId, c)).toEqual(expect.arrayContaining(before)); // added advisor bound
    expect(await bound(tenantId, b!)).toEqual([]); // removed advisor unbound (leak closed)
  });

  it('cross-board protection: a removed advisor keeps bindings another board still grants', async () => {
    const { owner, tenantId, orgId, boardId, advisors: [a, b] } = await ownerBoard();
    await owner.post(SK(boardId), { kind: 'strategy', shared: true });
    // A second board in the same org also shares strategy with b.
    const board2 = await owner.post('/v1/host/openwop-app/advisors/boards', { orgId, name: 'Council', advisors: [b], personaKind: 'historical' });
    await owner.post(SK(board2.body.boardId), { kind: 'strategy', shared: true });
    const withGrant = await bound(tenantId, b!);
    expect(withGrant.length).toBeGreaterThan(0);

    // Removing b from board ONE must not strip what board TWO still grants.
    expect((await owner.patch(BOARD(boardId), { advisors: [a] })).status).toBe(200);
    expect(await bound(tenantId, b!)).toEqual(withGrant);
  });

  it('cross-board protection also honors a LEGACY board (bindings, no stored intent)', async () => {
    const { owner, tenantId, orgId, boardId, advisors: [a, b] } = await ownerBoard();
    await owner.post(SK(boardId), { kind: 'strategy', shared: true });
    const withGrant = await bound(tenantId, b!);
    expect(withGrant.length).toBeGreaterThan(0);
    // A pre-0277 board: cohort [b], bindings present, but NO stored sharedKbKinds
    // (created via the plain create route; its bindings came from the share above,
    // which for board2's purposes is indistinguishable from a legacy manual share).
    const board2 = await owner.post('/v1/host/openwop-app/advisors/boards', { orgId, name: 'Legacy circle', advisors: [b], personaKind: 'historical' });
    expect(board2.status).toBe(201);

    // Removing b from board ONE: board TWO's DERIVED sharedness must protect b.
    expect((await owner.patch(BOARD(boardId), { advisors: [a] })).status).toBe(200);
    expect(await bound(tenantId, b!)).toEqual(withGrant);
  });

  it('knowledge.search honors the agent binding (bound ⇒ scoped; agent-less ⇒ tenant-wide)', async () => {
    const { owner, tenantId, orgId, boardId, advisors: [a] } = await ownerBoard();
    // Bind the advisor to the strategy KB (the Shared-knowledge grant)…
    await owner.post(SK(boardId), { kind: 'strategy', shared: true });
    // …and put a distinctive doc in a DIFFERENT org collection the advisor is NOT bound to.
    const col = (await owner.post(`/v1/host/openwop-app/kb/orgs/${encodeURIComponent(orgId)}/collections`, { name: 'Ops runbook' })).body;
    const doc = await owner.post(`/v1/host/openwop-app/kb/orgs/${encodeURIComponent(orgId)}/collections/${col.collectionId}/documents`, { title: 'Codeword', text: 'The operations codeword is ZEBRAWORD, used for the incident bridge.' });
    expect(doc.status, JSON.stringify(doc.body)).toBe(201);

    const query = { name: 'openwop:knowledge.search', input: { query: 'ZEBRAWORD incident codeword' } };
    // Bound agent: retrieval is SCOPED to its collections → the unbound doc is invisible.
    const scoped = await createAgentToolProvider({ tenantId, agentProfileId: a! }).executeTool(query);
    expect(scoped.content).not.toContain('ZEBRAWORD');
    // Agent-less scope (workflow nodes): tenant-wide, unchanged → the doc is found.
    const tenantWide = await createAgentToolProvider({ tenantId }).executeTool(query);
    expect(tenantWide.content).toContain('ZEBRAWORD');
  });

  it('composeChatContext composes the bound-KB block for the interactive turn (the GAP-B pin)', async () => {
    const { owner, tenantId, orgId, advisors: [a] } = await ownerBoard();
    // A persona agent the registry can resolve, wrapped by roster advisor `a`
    // …simpler: bind an org KB with distinctive content straight to `a` and
    // compose with `a`'s id — the persona comes from a user-authored agent.
    const created = await owner.post('/v1/host/openwop-app/agents', {
      persona: 'Beacon Analyst', label: 'Beacon', modelClass: 'chat',
      systemPrompt: 'PERSONA-BEACON: you analyze operational readiness.',
    });
    expect([200, 201, 409]).toContain(created.status);
    const agentId = created.body?.agentId ?? created.body?.agent?.agentId;
    expect(typeof agentId, JSON.stringify(created.body)).toBe('string');
    const roster = await owner.post('/v1/host/openwop-app/roster', { persona: 'Beacon Analyst Member', agentRef: { agentId } });
    const rosterId = roster.body.rosterId as string;
    __clearAgentIdentityCache();

    const col = (await owner.post(`/v1/host/openwop-app/kb/orgs/${encodeURIComponent(orgId)}/collections`, { name: 'Signals' })).body;
    await owner.post(`/v1/host/openwop-app/kb/orgs/${encodeURIComponent(orgId)}/collections/${col.collectionId}/documents`, { title: 'Signal', text: 'The readiness signal threshold is GRIFFINWORD at level nine.' });
    await bindCollection(tenantId, rosterId, col.collectionId, PREAUTHORIZED_CALLER); // ADR 0643 R3 Blocker 2 — the bind door takes the binder's principal; a plain org collection (no boundSubject) needs none, so the test seeds with the explicit bypass

    // BOTH id forms compose the bound KB into the interactive scaffold now.
    for (const id of [rosterId, agentId]) {
      const ctx = await composeChatContext(tenantId, { agentId: id, seedText: 'GRIFFINWORD readiness threshold' });
      expect(ctx.systemPrompt, `id form: ${id}`).toContain('PERSONA-BEACON');
      expect(ctx.systemPrompt, `id form: ${id}`).toContain('GRIFFINWORD');
    }
    // Advisor `a` (no binding beyond the board share) is unaffected noise-wise.
    expect(a).toBeTruthy();
  });
});
