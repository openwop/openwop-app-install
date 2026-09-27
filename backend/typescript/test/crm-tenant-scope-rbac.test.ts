/**
 * ADR 0627 D3 (`CRM-6`) — tenant-scope RBAC on the CRM tenant lane.
 *
 * Before this ADR `routes.ts` never called `requireTenantScope`: its mutators
 * gated on `requireEnabled` (toggle + entitlement) alone, and the default
 * membership role is `viewer` (read-only scopes). So a read-only member of a
 * shared `ws:` workspace could create/patch/delete contacts, merge them
 * directly (bypassing the steward approval lane), spawn triage runs, and edit
 * field defs / segments / suppressions. The segment chat tools' `tenantGate`
 * was a second copy of the toggle check with no scope check at all.
 *
 * TABLE-DRIVEN over the 16 mutators + the segment tools, three principals in
 * ONE real `ws:` workspace built through the production path (sign in, create
 * workspace, switch, invite by email, accept — the `crm-shared-workspace-
 * tenant-source.test.ts` shape, so `personalTenant` is genuinely distinct from
 * the active tenant and the implicit-owner short-circuit cannot make a gate
 * vacuous):
 *   - a `viewer` member → 403 `forbidden_scope` on every mutator;
 *   - an `editor` member → the route's real 2xx (each row is set up so the
 *     editor's call SUCCEEDS — a 404 or 400 would be a vacuous "not 403");
 *   - the personal-tenant owner (a `user:` tenant, no membership row) → 2xx
 *     via the implicit-owner short-circuit (USERS-19 shape);
 *   - the anon lead-capture tool stays on the PUBLIC gate (unchanged);
 *   - `GET /runs/:runId` stays readable by a viewer (`runs:read`) and stays
 *     readable with the toggle OFF (ADR 0001 §3.4 replay-safety — the ADR 0627
 *     D3 correction note retracts "gains requireEnabled");
 *   - the segment tools' `tenantGate` reads the REQUEST-stamped
 *     `run.metadata.personalTenant` (review S2): an anon session persists a
 *     segment in its OWN `anon:` sandbox through the tool and is
 *     `forbidden_scope` on a `ws:` workspace; a client-supplied
 *     `metadata.personalTenant` is stripped at run creation.
 *
 * The mutator table is checked against a SCAN of `crm/routes.ts`'s
 * `app.(post|patch|put|delete)` registrations (minus `convert`, which rides
 * `authorizeOrgScope`), so a new ungated mutator is red here, not just uncounted.
 *
 * Sabotage (run during the ADR 0627 build): removing the `requireTenantScope`
 * insertion on ONE route turns exactly that row's viewer assertion red; dropping
 * the `personalTenant` pass-through in `tenantGate` turns the anon-sandbox tool
 * row red while the HTTP row beside it stays green.
 */
import http from 'node:http';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createAgentToolProvider } from '../src/host/agentToolProvider.js';
import { CRM_LEAD_CAPTURE_TOOL_ID, CRM_PERSIST_SEGMENT_TOOL_ID } from '../src/features/crm/agentTools.js';

let BASE = '';
let server: http.Server;
let storage: Storage;
let n = 0;
let workflowId = 'openwop-app.uppercase';

interface Res<T = Record<string, any>> { status: number; body: T }

function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res<any>> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const h = res.headers as Headers & { getSetCookie?: () => string[] };
    const single = res.headers.get('set-cookie');
    const setCookies: string[] = typeof h.getSetCookie === 'function' ? h.getSetCookie() : single ? [single] : [];
    for (const sc of setCookies) { const m = /(__session=[^;]+)/.exec(sc); if (m) cookie = m[1]!; }
    return { status: res.status, body: res.status === 204 ? undefined : await res.json().catch(() => undefined) };
  };
  return {
    get: (p: string) => call('GET', p),
    post: (p: string, b?: unknown) => call('POST', p, b),
    patch: (p: string, b?: unknown) => call('PATCH', p, b),
    del: (p: string) => call('DELETE', p),
  };
}
type Client = ReturnType<typeof client>;

/** Production sign-in — no `tenantId` override, so the caller lands in their
 *  own `user:` personal tenant exactly as OIDC would leave them. */
async function signIn(c: Client, email: string): Promise<{ userId: string; tenantId: string }> {
  const r = await c.post('/v1/host/openwop-app/test/login', { email });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { userId: r.body.user.userId as string, tenantId: r.body.user.tenantId as string };
}

async function sharedWorkspace(c: Client): Promise<string> {
  const ws = await c.post('/v1/host/openwop-app/workspaces', { name: `CRM RBAC WS ${n++}` });
  expect(ws.status, JSON.stringify(ws.body)).toBe(201);
  expect(ws.body.workspaceId, 'must be a real shared workspace').toMatch(/^ws:/);
  const sw = await c.post(`/v1/host/openwop-app/workspaces/${encodeURIComponent(ws.body.workspaceId)}/switch`);
  expect(sw.status, JSON.stringify(sw.body)).toBe(200);
  return ws.body.workspaceId as string;
}

async function joinAsMember(owner: Client, ws: string, joiner: Client, email: string, role: 'viewer' | 'editor'): Promise<{ userId: string }> {
  const invite = await owner.post(`/v1/host/openwop-app/orgs/${encodeURIComponent(ws)}/invites`, { email, role });
  expect(invite.status, JSON.stringify(invite.body)).toBe(201);
  const me = await signIn(joiner, email);
  const accepted = await joiner.post('/v1/host/openwop-app/orgs/invitations/accept', { token: invite.body.token });
  expect(accepted.status, JSON.stringify(accepted.body)).toBe(201);
  const sw = await joiner.post(`/v1/host/openwop-app/workspaces/${encodeURIComponent(ws)}/switch`);
  expect(sw.status, JSON.stringify(sw.body)).toBe(200);
  return me;
}

const CRM = '/v1/host/openwop-app/crm';
const contactsOf = async (c: Client, name: string): Promise<string> => {
  const r = await c.post(`${CRM}/contacts`, { name });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.contactId as string;
};

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  // The de-facto-owner bypass in `resolveEffectiveAccess` hands OWNER scopes to any
  // subject with no member row — it would make every viewer refusal pass vacuously.
  delete process.env.OPENWOP_DEMO_MODE;
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users', 'orgs', 'crm']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
  const wellKnown = (await (await fetch(`${BASE}/.well-known/openwop`)).json()) as { fixtures?: string[] };
  workflowId = wellKnown.fixtures?.[0] ?? workflowId;
});

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => res()));
  delete process.env.OPENWOP_TEST_AUTH_ENABLED;
});

/** The tool scope AS THE CONVERSATION TOOL LOOP BUILDS IT — from the run row
 *  `POST /v1/runs` stamped for this session (`metadata.actingUserId` +
 *  `metadata.personalTenant`, both host-authoritative), never hand-typed. */
async function scopeFromRun(c: Client, extraMetadata?: Record<string, unknown>): Promise<{ tenantId: string; runId: string; actingUserId?: string; personalTenant?: string }> {
  const r = await c.post('/v1/runs', { workflowId, inputs: {}, ...(extraMetadata ? { metadata: extraMetadata } : {}) });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const run = await storage.getRun(r.body.runId as string);
  expect(run).toBeTruthy();
  const m = (run!.metadata ?? {}) as { actingUserId?: unknown; personalTenant?: unknown };
  return {
    tenantId: run!.tenantId,
    runId: run!.runId,
    ...(typeof m.actingUserId === 'string' ? { actingUserId: m.actingUserId } : {}),
    ...(typeof m.personalTenant === 'string' ? { personalTenant: m.personalTenant } : {}),
  };
}

interface Row {
  name: string;
  /** Owner-side setup returning what the calls need (fresh per row so the
   *  editor's successful mutation never starves a later row). */
  setup?: () => Promise<Record<string, string>>;
  call: (c: Client, s: Record<string, string>) => Promise<Res<any>>;
  /** The editor's REAL success status — never "anything but 403". */
  editor: number;
}

describe('ADR 0627 D3 — the 16 tenant-lane mutators require workspace:write', () => {
  let owner: Client, viewer: Client, editor: Client;
  let ws: string;
  let viewerId = '', editorId = '';

  beforeAll(async () => {
    owner = client(); viewer = client(); editor = client();
    await signIn(owner, `crm-rbac-owner-${n++}@acme.test`);
    ws = await sharedWorkspace(owner);
    viewerId = (await joinAsMember(owner, ws, viewer, `crm-rbac-viewer-${n++}@acme.test`, 'viewer')).userId;
    editorId = (await joinAsMember(owner, ws, editor, `crm-rbac-editor-${n++}@acme.test`, 'editor')).userId;
    // Sanity: both members READ the shared rolodex (the gate is on WRITES only).
    expect((await viewer.get(`${CRM}/contacts`)).status).toBe(200);
    expect((await editor.get(`${CRM}/contacts`)).status).toBe(200);
  });

  const rows: Row[] = [
    { name: 'POST /suppressions', call: (c) => c.post(`${CRM}/suppressions`, { email: `sup-${n++}@acme.test` }), editor: 201 },
    {
      name: 'DELETE /suppressions/:email',
      setup: async () => { const email = `sup-del-${n++}@acme.test`; expect((await owner.post(`${CRM}/suppressions`, { email })).status).toBe(201); return { email }; },
      call: (c, s) => c.del(`${CRM}/suppressions/${encodeURIComponent(s.email!)}`),
      editor: 200,
    },
    { name: 'POST /contacts', call: (c) => c.post(`${CRM}/contacts`, { name: `Lead ${n++}` }), editor: 201 },
    {
      name: 'PATCH /contacts/:id',
      setup: async () => ({ id: await contactsOf(owner, 'Patch Target') }),
      call: (c, s) => c.patch(`${CRM}/contacts/${s.id}`, { name: 'Renamed' }),
      editor: 200,
    },
    {
      name: 'DELETE /contacts/:id',
      setup: async () => ({ id: await contactsOf(owner, 'Delete Target') }),
      call: (c, s) => c.del(`${CRM}/contacts/${s.id}`),
      editor: 204,
    },
    {
      name: 'POST /contacts/:id/identifiers',
      setup: async () => ({ id: await contactsOf(owner, 'Ident Target') }),
      call: (c, s) => c.post(`${CRM}/contacts/${s.id}/identifiers`, { type: 'phone', value: `+1206555${String(1000 + n++).slice(-4)}` }),
      editor: 201,
    },
    {
      name: 'DELETE /contacts/:id/identifiers',
      setup: async () => {
        const id = await contactsOf(owner, 'Ident Remove Target');
        expect((await owner.post(`${CRM}/contacts/${id}/identifiers`, { type: 'loyalty', value: 'LOY-1' })).status).toBe(201);
        return { id };
      },
      call: (c, s) => c.del(`${CRM}/contacts/${s.id}/identifiers?type=loyalty&value=LOY-1`),
      editor: 200,
    },
    {
      name: 'POST /contacts/:id/merge-proposal',
      setup: async () => ({ survivor: await contactsOf(owner, 'Proposal Survivor'), source: await contactsOf(owner, 'Proposal Source') }),
      call: (c, s) => c.post(`${CRM}/contacts/${s.survivor}/merge-proposal`, { sourceContactId: s.source }),
      editor: 201,
    },
    {
      name: 'POST /merge-events/:id/unmerge',
      setup: async () => {
        const survivor = await contactsOf(owner, 'Unmerge Survivor');
        const source = await contactsOf(owner, 'Unmerge Source');
        expect((await owner.post(`${CRM}/contacts/${survivor}/merge`, { sourceContactId: source })).status).toBe(200);
        const events = await owner.get(`${CRM}/merge-events`);
        const ev = (events.body.events as Array<{ mergeEventId: string; sourceId: string }>).find((e) => e.sourceId === source);
        expect(ev, 'the merge must have recorded an event').toBeTruthy();
        return { id: ev!.mergeEventId };
      },
      call: (c, s) => c.post(`${CRM}/merge-events/${encodeURIComponent(s.id!)}/unmerge`),
      editor: 200,
    },
    {
      name: 'POST /contacts/:id/merge (direct — bypasses the approval lane)',
      setup: async () => ({ survivor: await contactsOf(owner, 'Merge Survivor'), source: await contactsOf(owner, 'Merge Source') }),
      call: (c, s) => c.post(`${CRM}/contacts/${s.survivor}/merge`, { sourceContactId: s.source }),
      editor: 200,
    },
    {
      name: 'POST /contacts/:id/triage (spawns a run)',
      setup: async () => ({ id: await contactsOf(owner, 'Triage Target') }),
      call: (c, s) => c.post(`${CRM}/contacts/${s.id}/triage`, { workflowId }),
      editor: 202,
    },
    { name: 'POST /fields', call: (c) => c.post(`${CRM}/fields`, { key: `k${n++}`, label: 'K', type: 'string' }), editor: 201 },
    {
      name: 'DELETE /fields/:defId',
      setup: async () => { const r = await owner.post(`${CRM}/fields`, { key: `kdel${n++}`, label: 'K', type: 'string' }); expect(r.status).toBe(201); return { id: r.body.defId }; },
      call: (c, s) => c.del(`${CRM}/fields/${s.id}`),
      editor: 204,
    },
    { name: 'POST /segments', call: (c) => c.post(`${CRM}/segments`, { name: `Seg ${n++}`, filters: [] }), editor: 201 },
    {
      name: 'PATCH /segments/:segmentId',
      setup: async () => { const r = await owner.post(`${CRM}/segments`, { name: 'Seg Patch', filters: [] }); expect(r.status).toBe(201); return { id: r.body.segmentId }; },
      call: (c, s) => c.patch(`${CRM}/segments/${s.id}`, { name: 'Seg Patched' }),
      editor: 200,
    },
    {
      name: 'DELETE /segments/:segmentId',
      setup: async () => { const r = await owner.post(`${CRM}/segments`, { name: 'Seg Del', filters: [] }); expect(r.status).toBe(201); return { id: r.body.segmentId }; },
      call: (c, s) => c.del(`${CRM}/segments/${s.id}`),
      editor: 204,
    },
  ];

  it('the table covers all 16 ADR 0627 D3 mutators — and EVERY mutator `crm/routes.ts` registers (scan), so a new ungated route is red', () => {
    expect(rows).toHaveLength(16);
    const src = readFileSync(fileURLToPath(new URL('../src/features/crm/routes.ts', import.meta.url)), 'utf8');
    const registered = [...src.matchAll(/app\.(post|patch|put|delete)\(\s*'\/v1\/host\/openwop-app\/crm(\/[^']*)'/g)]
      .map((m) => `${m[1]!.toUpperCase()} ${m[2]}`)
      // `convert` rides `authorizeOrgScope` (already gated before ADR 0627 D3).
      .filter((r) => !r.endsWith('/convert'))
      .sort();
    const tabled = rows.map((r) => r.name.replace(/\s*\(.*\)$/, '')).sort();
    expect(registered, 'a mutator registered in crm/routes.ts has no viewer-403/editor-2xx row here').toEqual(tabled);
    expect(registered).toHaveLength(rows.length);
  });

  for (const row of rows) {
    it(`${row.name}: viewer → 403 forbidden_scope, editor → ${row.editor}`, async () => {
      const s = row.setup ? await row.setup() : {};
      const v = await row.call(viewer, s);
      expect(v.status, `viewer must be refused: ${JSON.stringify(v.body)}`).toBe(403);
      expect(v.body?.error, 'the refusal is the typed scope error').toBe('forbidden_scope');
      const e = await row.call(editor, s);
      expect(e.status, `editor must succeed: ${JSON.stringify(e.body)}`).toBe(row.editor);
    });
  }

  it('GET /runs/:runId — a viewer can still READ a triage run (runs:read), and it stays readable with the toggle OFF (ADR 0001 §3.4)', async () => {
    const id = await contactsOf(owner, 'Run Read Target');
    const started = await editor.post(`${CRM}/contacts/${id}/triage`, { workflowId });
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    const read = await viewer.get(`${CRM}/runs/${encodeURIComponent(started.body.runId)}`);
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.runId).toBe(started.body.runId);
    // DELIBERATELY NOT toggle-gated: a historical run's provenance is readable
    // regardless of the feature's CURRENT state (the replay/fork decoupling —
    // `feature-replay-fork.test.ts` is the full witness). The ADR 0627 D3
    // correction note retracts the "gains requireEnabled" sentence; the build
    // that did it turned that witness red.
    const d = getToggleDefault('crm');
    if (d) await saveConfig({ ...d, status: 'off' }, 'test');
    try {
      expect((await viewer.get(`${CRM}/contacts`)).status, 'the live surface IS gone').toBe(404);
      const off = await viewer.get(`${CRM}/runs/${encodeURIComponent(started.body.runId)}`);
      expect(off.status, `provenance must stay readable with the toggle off: ${JSON.stringify(off.body)}`).toBe(200);
      expect(off.body.runId).toBe(started.body.runId);
    } finally {
      if (d) await saveConfig({ ...d, status: 'on' }, 'test');
    }
  });

  it('segment chat tools: the viewer is forbidden_scope, the editor persists (tenantGate = the routes predicate)', async () => {
    const asViewer = createAgentToolProvider({ tenantId: ws, actingUserId: viewerId, runId: 'r-viewer' });
    const refused = await asViewer.executeTool({ name: CRM_PERSIST_SEGMENT_TOOL_ID, input: { name: 'Viewer seg', filters: [] } });
    expect(JSON.parse(refused.content).error).toBe('forbidden_scope');

    const asEditor = createAgentToolProvider({ tenantId: ws, actingUserId: editorId, runId: 'r-editor' });
    const saved = await asEditor.executeTool({ name: CRM_PERSIST_SEGMENT_TOOL_ID, input: { name: 'Editor seg', filters: [] } });
    expect(saved.isError, saved.content).toBeFalsy();
    expect((JSON.parse(saved.content) as { segment?: { segmentId?: string } }).segment?.segmentId).toMatch(/^seg:/);
  });

  it('a member\'s run stamps their `personalTenant` (a `user:` tenant ≠ the active `ws:`) — the tool lane still judges them by membership, and a client cannot forge the stamp', async () => {
    // A viewer forging `metadata.personalTenant: ws` would, if it survived,
    // satisfy the implicit-owner short-circuit for the shared workspace.
    const forged = await scopeFromRun(viewer, { personalTenant: ws, actingUserId: editorId });
    expect(forged.tenantId).toBe(ws);
    expect(forged.actingUserId, 'host-authoritative — the client value is overridden').toBe(viewerId);
    expect(forged.personalTenant, 'host-authoritative — the reserved key is stripped, then stamped from req.personalTenant').toMatch(/^user:/);
    expect(forged.personalTenant).not.toBe(ws);
    const refused = await createAgentToolProvider(forged).executeTool({ name: CRM_PERSIST_SEGMENT_TOOL_ID, input: { name: 'Forged seg', filters: [] } });
    expect(JSON.parse(refused.content).error, 'a personal tenant that is not the active tenant grants nothing').toBe('forbidden_scope');
  });

  it(':fork re-stamps `personalTenant` to the FORKING caller (review S4) — B\'s fork of A\'s run carries B\'s own sandbox, never A\'s', async () => {
    const src = await scopeFromRun(viewer);
    expect(src.personalTenant).toMatch(/^user:/);
    const fork = await editor.post(`/v1/runs/${encodeURIComponent(src.runId)}:fork`, { fromSeq: 0, mode: 'replay' });
    expect([200, 201, 202], JSON.stringify(fork.body)).toContain(fork.status);
    const forked = await storage.getRun(fork.body.runId as string);
    const m = (forked!.metadata ?? {}) as { actingUserId?: unknown; personalTenant?: unknown };
    expect(m.actingUserId, 'the forker is the acting user').toBe(editorId);
    expect(m.personalTenant, 'the forker\'s OWN personal tenant').toMatch(/^user:/);
    expect(m.personalTenant).not.toBe(src.personalTenant);
    // The one lane NOT covered here: a forker with NO personal tenant (an API-key
    // bearer) must CLEAR the stamp — `routes/runs.ts` deletes it when
    // `personalTenantOf(req)` is empty; no cookie-jar client in this file can
    // mint such a principal (stated, not proven).
  });

  it('the anon lead-capture tool stays on the PUBLIC gate (no acting user, no scope check)', async () => {
    const anon = createAgentToolProvider({ tenantId: ws });
    const out = await anon.executeTool({ name: CRM_LEAD_CAPTURE_TOOL_ID, input: { email: `visitor-${n++}@example.test`, name: 'Visitor' } });
    expect(out.isError, out.content).toBeFalsy();
    expect((JSON.parse(out.content) as { success?: boolean }).success).toBe(true);
  });
});

describe('ADR 0627 D3 — the personal-tenant owner keeps writing (implicit owner, no membership row)', () => {
  it('POST /contacts + POST /segments + the persist-segment tool succeed in a `user:` tenant', async () => {
    const solo = client();
    const me = await signIn(solo, `crm-rbac-solo-${n++}@acme.test`);
    expect(me.tenantId).toMatch(/^user:/);
    expect((await solo.post(`${CRM}/contacts`, { name: 'Solo Lead' })).status).toBe(201);
    expect((await solo.post(`${CRM}/segments`, { name: 'Solo seg', filters: [] })).status).toBe(201);
    const scope = await scopeFromRun(solo);
    expect(scope).toMatchObject({ tenantId: me.tenantId, actingUserId: me.userId, personalTenant: me.tenantId });
    const saved = await createAgentToolProvider(scope).executeTool({ name: CRM_PERSIST_SEGMENT_TOOL_ID, input: { name: 'Solo tool seg', filters: [] } });
    expect(saved.isError, saved.content).toBeFalsy();
  });

  it('an ANON session (principal `session:<sid>`, no user row) persists a segment in its OWN `anon:` sandbox — HTTP lane AND tool lane (review S2)', async () => {
    // A credential-less request mints the anon cookie session (ADR 0015).
    const anon = client();
    const viaHttp = await anon.post(`${CRM}/segments`, { name: 'Anon seg (http)', filters: [] });
    expect(viaHttp.status, `the HTTP lane grants the implicit owner: ${JSON.stringify(viaHttp.body)}`).toBe(201);
    const anonTenant = viaHttp.body.tenantId as string;
    expect(anonTenant).toMatch(/^anon:/);

    const scope = await scopeFromRun(anon);
    expect(scope.tenantId).toBe(anonTenant);
    expect(scope.actingUserId, 'an anon principal — no user row to derive anything from').toMatch(/^session:/);
    expect(scope.personalTenant, 'the request\'s personal tenant, stamped host-authoritatively').toBe(anonTenant);

    const viaTool = await createAgentToolProvider(scope).executeTool({ name: CRM_PERSIST_SEGMENT_TOOL_ID, input: { name: 'Anon seg (tool)', filters: [] } });
    expect(viaTool.isError, `the tool lane must agree with the HTTP lane: ${viaTool.content}`).toBeFalsy();
    expect((JSON.parse(viaTool.content) as { segment?: { segmentId?: string } }).segment?.segmentId).toMatch(/^seg:/);

    // The field is load-bearing: the SAME principal without the stamp is what
    // the first cut re-derived (a user row that does not exist) — refused.
    const { personalTenant: _dropped, ...unstamped } = scope;
    const rederived = await createAgentToolProvider(unstamped).executeTool({ name: CRM_PERSIST_SEGMENT_TOOL_ID, input: { name: 'Anon seg (no stamp)', filters: [] } });
    expect(JSON.parse(rederived.content).error).toBe('forbidden_scope');
  });

  it('an ANON session CANNOT write a `ws:` workspace through the tool (its personal tenant is not the active one)', async () => {
    const owner = client();
    await signIn(owner, `crm-rbac-ws-owner-${n++}@acme.test`);
    const ws = await sharedWorkspace(owner);
    const anonScope = await scopeFromRun(client());
    expect(anonScope.personalTenant).toMatch(/^anon:/);
    const attempt = await createAgentToolProvider({ ...anonScope, tenantId: ws, runId: 'r-anon-on-ws' }).executeTool({ name: CRM_PERSIST_SEGMENT_TOOL_ID, input: { name: 'Anon on ws', filters: [] } });
    expect(JSON.parse(attempt.content).error).toBe('forbidden_scope');
  });
});
