/**
 * ADR 0847 — entities: project-namespace access on every lane (D1), the namespace goes
 * with its project (D2), and delivery follows the schema (D3).
 *
 * The first three describes are the row-29 RED probe (`ENT2WF-1/-2/-3`), measured
 * failing on origin/main `c4d4dfa20` before any fix. The rest cover every lane the
 * `/architect` pass named (A1–A6).
 *
 * TST-BWC-3 (grade-tests w62): every D3 case builds its OWN type (`freshType`) — the
 * describe used to be a sequence over one type, so any reorder failed it. The sub-org
 * editor case now writes to a type that EXISTS in org B (created through the service), so
 * its 404 is the namespace gate, not a missing type. Red when: the namespace read gate,
 * the unscoped-list filter, the act-as intersection, or the key-issuer check is skipped;
 * an empty `?projectId=` is taken as a namespace; a run skips its tenant-scope check or a
 * system run reaches a project; the schema-live projection keeps removed or mis-kinded
 * values; a foreign term matches; the project purge skips the namespace; or public
 * delivery serves a type whose project is gone.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getSetCookies } from './headerCookies.js';
import { createApp } from '../src/index.js';
import { createOrg, createWorkspace, createMember } from '../src/host/accessControlService.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { DurableCollection } from '../src/host/hostExtPersistence.js';
import { builtinAgentTool } from '../src/host/agentToolProvider.js';
import { countSubjectDependents, listSubjectDependentKeys } from '../src/host/subjectDependents.js';
import { addProjectMember, createProject, deleteProject, setProjectVisibility } from '../src/features/projects/projectsService.js';
import { buildEntitiesSurface } from '../src/features/entities/surface.js';
import { ENTITIES_DESCRIBE_TYPE_TOOL_ID, ENTITIES_QUERY_TOOL_ID } from '../src/features/entities/agentTools.js';
import { createEntityType, listEntities, liveView, type EntityRecord, type EntityTypeRecord } from '../src/features/entities/entitiesService.js';
import { readPublicEntities } from '../src/features/entities/publicRead.js';

const BASE = '/host/openwop-app/entities';
const PUB = '/host/openwop-app/public-entities';
let server: http.Server;
let ORIGIN = '';
let WS = '';
let n = 0;

/** The response fields these legs read (each optional: a refusal carries only `code`). */
type Body = {
  error?: string; // the error envelope's code (middleware/errorEnvelope.ts)
  user?: { userId: string };
  types?: Array<{ name: string }>;
  taxonomies?: Array<{ name: string }>;
  viewer?: { canWrite: boolean; canManageTypes: boolean };
  projectId?: string;
  typeId?: string;
  token?: string;
  termId?: string;
  total?: number;
  termIds?: string[];
  values?: Record<string, unknown>;
  entities?: Array<{ values: Record<string, unknown> }>;
};
type Res = { status: number; body: Body | string | undefined };
/** The JSON body of a response (every leg below reads a JSON route, except the NDJSON export). */
const json = (r: Res): Body => (typeof r.body === 'object' ? r.body : {});
interface Client { userId: string; call: (m: string, p: string, b?: unknown, h?: Record<string, string>) => Promise<Res> }

async function loginTo(tenantId: string, who: string): Promise<Client> {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<Res> => {
    const res = await fetch(`${ORIGIN}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...(headers ?? {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const ck of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]!; }
    const text = res.status === 204 ? '' : await res.text();
    let parsed: Body | string | undefined = text;
    try { parsed = text ? (JSON.parse(text) as Body) : undefined; } catch { /* NDJSON export — keep the text */ }
    return { status: res.status, body: parsed };
  };
  const r = await call('POST', '/host/openwop-app/test/login', { email: `${who}-${Date.now()}-${n++}@acme.test`, tenantId });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { userId: json(r).user!.userId, call };
}

const bearer = async (token: string, method: string, path: string, body?: unknown): Promise<Res> => {
  const res = await fetch(`${ORIGIN}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json().catch(() => undefined)) as Body | undefined };
};

/** The surface's verbs return `unknown`; these tests read a known subset of the shape. */
type SurfaceResult = { types: Array<{ name: string }>; entities: unknown[]; total: number; entity: { entityId: string; values: unknown } | null; type: unknown };
const surface = (scope: Parameters<typeof buildEntitiesSurface>[0]) => {
  const raw = buildEntitiesSurface(scope);
  const verb = (name: string) => async (a: Record<string, unknown>): Promise<SurfaceResult> => (await raw[name]!(a)) as SurfaceResult;
  return { listTypes: verb('listTypes'), query: verb('query'), get: verb('get'), getType: verb('getType'), create: verb('create') };
};

const TITLE = [{ key: 'title', label: 'Title', type: 'string' }];
const names = (r: Res, key: 'types' | 'taxonomies' = 'types'): string[] => (json(r)[key] ?? []).map((x) => x.name);

let admin: Client;
let viewer: Client;
let insider: Client; // a viewer who IS a member of the private project
let P = ''; // a private project in the root org
let T = ''; // a type in P's namespace

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_DEMO_MODE;
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { ORIGIN = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  const ws = await createWorkspace({ name: 'adr0847', ownerSubject: 'oidc:adr0847-founder' });
  WS = ws.orgId ?? ws.tenantId;
  const d = getToggleDefault('entities'); if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  admin = await loginTo(WS, 'admin');
  await createMember({ orgId: WS, tenantId: WS, displayName: 'Admin', subject: admin.userId, roles: ['admin'] });
  viewer = await loginTo(WS, 'viewer');
  await createMember({ orgId: WS, tenantId: WS, displayName: 'Viewer', subject: viewer.userId, roles: ['viewer'] });
  insider = await loginTo(WS, 'insider');
  await createMember({ orgId: WS, tenantId: WS, displayName: 'Insider', subject: insider.userId, roles: ['viewer'] });

  P = (await createProject(WS, WS, { name: 'Secret launch' }, admin.userId)).id;
  await setProjectVisibility(WS, P, 'private');
  await addProjectMember(WS, P, `user:${insider.userId}`, 'member');
  T = `sec_${n++}`;
  const made = await admin.call('POST', `${BASE}/types`, { name: T, projectId: P, fields: TITLE });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const row = await admin.call('POST', `${BASE}/types/${T}/entities?projectId=${P}`, { values: { title: 'codename' }, entityId: 'e1' });
  expect(row.status, JSON.stringify(row.body)).toBe(201);
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('D1 / ENT2WF-1 — a private project namespace, session lane', () => {
  it('a non-member viewer does not see the private type in the unscoped list, and reads 404', async () => {
    expect(names(await viewer.call('GET', `${BASE}/types`)), 'unscoped list leaks the private type').not.toContain(T);
    expect((await viewer.call('GET', `${BASE}/types/${T}/entities?projectId=${P}`)).status).toBe(404);
    expect((await viewer.call('GET', `${BASE}/types/${T}/entities/e1?projectId=${P}`)).status).toBe(404);
    expect((await viewer.call('POST', `${BASE}/types/${T}/query?projectId=${P}`, {})).status).toBe(404);
    expect((await viewer.call('GET', `${BASE}/types/${T}/export?projectId=${P}`)).status).toBe(404);
    expect((await viewer.call('GET', `${BASE}/types/${T}?projectId=${P}`)).status).toBe(404);
  });

  it('the exit: a project MEMBER viewer reads, and the admin (org write) reads and writes', async () => {
    expect(names(await insider.call('GET', `${BASE}/types`))).toContain(T);
    expect((await insider.call('GET', `${BASE}/types/${T}/entities?projectId=${P}`)).status).toBe(200);
    expect((await admin.call('PATCH', `${BASE}/types/${T}/entities/e1?projectId=${P}`, { values: { title: 'renamed' } })).status).toBe(200);
  });

  it('taxonomy and relationship routes carry the namespace in query/body (review A5)', async () => {
    const tax = `tx_${n++}`;
    expect((await admin.call('POST', `${BASE}/taxonomies`, { name: tax, projectId: P })).status).toBe(201);
    expect((await viewer.call('GET', `${BASE}/taxonomies/${tax}/terms?projectId=${P}`)).status).toBe(404);
    expect((await insider.call('GET', `${BASE}/taxonomies/${tax}/terms?projectId=${P}`)).status).toBe(200);
    expect(names(await viewer.call('GET', `${BASE}/taxonomies`), 'taxonomies')).not.toContain(tax);
    expect(names(await insider.call('GET', `${BASE}/taxonomies`), 'taxonomies')).toContain(tax);
  });

  it('a workspace-root editor cannot write a SUB-ORG project namespace they have no write in', async () => {
    const orgB = (await createOrg({ tenantId: WS, createdBy: 'oidc:adr0847-founder', name: `B_${n++}` })).orgId;
    const pb = (await createProject(WS, orgB, { name: 'Org B project' }, 'oidc:adr0847-founder')).id;
    const editor = await loginTo(WS, 'editor');
    await createMember({ orgId: WS, tenantId: WS, displayName: 'Editor', subject: editor.userId, roles: ['editor'] });
    const t = `b_${n++}`;
    // Before ADR 0847 this was 201: any tenant-level writer reached any namespace.
    const made = await admin.call('POST', `${BASE}/types`, { name: t, projectId: pb, fields: TITLE });
    expect(made.status, 'the root ADMIN holds no write in org B either').toBe(404);
    // The type EXISTS in org B's namespace (made through the service, no gate), so the
    // editor's refusal below can only be the namespace gate, not "no such type".
    const tb = `bx_${n++}`;
    await createEntityType({ tenantId: WS, projectId: pb, name: tb, displayName: 'B', fields: TITLE, createdBy: 'oidc:adr0847-founder' });
    const r = await editor.call('POST', `${BASE}/types/${tb}/entities?projectId=${pb}`, { values: { title: 'x' } });
    expect(r.status, JSON.stringify(r.body)).toBe(404);
    expect(json(r).error).toBe('not_found');
    expect((await listEntities({ tenantId: WS, projectId: pb, typeName: tb })).entities).toHaveLength(0);
  });

  it('the gate and the service read the SAME namespace (grade-code ENT3CD-1)', async () => {
    const orgB = (await createOrg({ tenantId: WS, createdBy: 'oidc:adr0847-founder', name: `B2_${n++}` })).orgId;
    const pb = (await createProject(WS, orgB, { name: 'Org B project 2' }, 'oidc:adr0847-founder')).id;
    // An empty `?projectId=` used to make the gate see the root while the service took
    // the body's project — authoring into a project the caller cannot write.
    const t1 = `smug_${n++}`;
    const r1 = await admin.call('POST', `${BASE}/types?projectId=`, { name: t1, projectId: pb, fields: TITLE });
    expect(r1.status, JSON.stringify(r1.body)).toBe(404);
    for (const [path, body] of [
      [`${BASE}/taxonomies?projectId=`, { name: `stx_${n++}`, projectId: pb }],
      [`${BASE}/relationships?projectId=`, { fromTypeName: 'a', toTypeName: 'b', projectId: pb }],
    ] as const) {
      expect((await admin.call('POST', path, body)).status, path).toBe(404);
    }
    // A query namespace and a different body namespace: the gated one is the one used.
    const t2 = `split_${n++}`;
    const r2 = await admin.call('POST', `${BASE}/types?projectId=${P}`, { name: t2, projectId: pb, fields: TITLE });
    expect(r2.status).toBe(201);
    expect(json(r2).projectId).toBe(P);
  });

  it('act-as is the intersection (review A3): an admin acting as the non-member viewer is refused', async () => {
    const viewerMember = await createMember({ orgId: WS, tenantId: WS, displayName: 'Viewer2', subject: `oidc:act-${n++}`, roles: ['viewer'] });
    const r = await admin.call('GET', `${BASE}/types/${T}/entities?projectId=${P}`, undefined, { 'x-openwop-act-as': viewerMember.memberId });
    expect(r.status, JSON.stringify(r.body)).toBe(404);
  });
});

describe('ENT3UX-2 — the types read tells the page what this viewer may do', () => {
  it('a viewer may do nothing; an admin may write and manage types', async () => {
    expect(json(await viewer.call('GET', `${BASE}/types`)).viewer).toEqual({ canWrite: false, canManageTypes: false });
    expect(json(await admin.call('GET', `${BASE}/types`)).viewer).toEqual({ canWrite: true, canManageTypes: true });
  });
});

describe('D1 — the API-key lane answers to the key ISSUER', () => {
  it('a key minted by a non-member viewer cannot read the private namespace; the admin\'s can', async () => {
    expect((await admin.call('PATCH', `${BASE}/types/${T}?projectId=${P}`, { status: 'published' })).status).toBe(200);
    const mint = async (c: Client): Promise<string> => {
      const r = await c.call('POST', '/host/openwop-app/developer-keys', { name: `k-${n++}`, scopes: [`entities:${P}/${T}:read`] });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      return json(r).token!;
    };
    const viewerKey = await mint(viewer);
    const adminKey = await mint(admin);
    expect((await bearer(viewerKey, 'GET', `${BASE}/types/${T}/entities?projectId=${P}`)).status).toBe(404);
    expect((await bearer(adminKey, 'GET', `${BASE}/types/${T}/entities?projectId=${P}`)).status).toBe(200);
  });
});

describe('D1 — the workflow surface: a run is limited to its starter', () => {
  it('a run started by the non-member viewer reads nothing in the namespace', async () => {
    const s = surface({ tenantId: WS, actingUserId: viewer.userId, runId: 'r-viewer' });
    expect((await s.listTypes!({})).types.map((t) => t.name)).not.toContain(T);
    expect(await s.query!({ typeName: T, projectId: P })).toEqual({ entities: [], total: 0 });
    expect(await s.get!({ typeName: T, projectId: P, entityId: 'e1' })).toEqual({ entity: null });
    expect(await s.getType!({ typeName: T, projectId: P })).toEqual({ type: null });
  });

  it('a person-started run without workspace:write cannot write, even in the root', async () => {
    const root = `root_${n++}`;
    expect((await admin.call('POST', `${BASE}/types`, { name: root, fields: TITLE })).status).toBe(201);
    const s = surface({ tenantId: WS, actingUserId: insider.userId, runId: 'r-insider' });
    await expect(s.create!({ typeName: root, values: { title: 'x' } })).rejects.toThrow(/not found/i);
    // The member still READS the seeded row (by id: another case adds rows to T, so a count is order-dependent).
    expect((await s.get!({ typeName: T, projectId: P, entityId: 'e1' })).entity?.entityId, 'the member still READS').toBe('e1');
  });

  it('an actorless system run is tenant-trusted in the root and refused in a project namespace', async () => {
    const s = surface({ tenantId: WS, runId: 'r-system' });
    expect((await s.query!({ typeName: T, projectId: P })).total).toBe(0);
    const root = `sys_${n++}`;
    expect((await admin.call('POST', `${BASE}/types`, { name: root, fields: TITLE })).status).toBe(201);
    expect(((await s.create!({ typeName: root, values: { title: 'x' }, entityId: 'sys1' })).entity as { entityId: string }).entityId).toBe('sys1');
    await expect(s.create!({ typeName: T, projectId: P, values: { title: 'x' } })).rejects.toThrow(/not found/i);
  });

  it('the admin\'s run reads and writes the namespace (the exit)', async () => {
    const s = surface({ tenantId: WS, actingUserId: admin.userId, runId: 'r-admin' });
    expect((await s.get!({ typeName: T, projectId: P, entityId: 'e1' })).entity?.entityId).toBe('e1');
    expect(((await s.create!({ typeName: T, projectId: P, values: { title: 'y' }, entityId: 'adm1' })).entity as { entityId: string }).entityId).toBe('adm1');
  });
});

describe('D1 / ENT2WF-4 — the chat tools share the rule', () => {
  type ToolOut = { types: Array<{ name: string }>; type: unknown; entities: unknown[]; total: number };
  const run = async (id: string, input: Record<string, unknown>, actingUserId: string): Promise<ToolOut> =>
    JSON.parse((await builtinAgentTool(id)!.run(input, { tenantId: WS, actingUserId })).content) as ToolOut;

  it('the non-member sees neither the type nor its rows; the member sees both', async () => {
    expect((await run(ENTITIES_DESCRIBE_TYPE_TOOL_ID, {}, viewer.userId)).types.map((t) => t.name)).not.toContain(T);
    expect((await run(ENTITIES_DESCRIBE_TYPE_TOOL_ID, { typeName: T, projectId: P }, viewer.userId)).type).toBeNull();
    expect((await run(ENTITIES_QUERY_TOOL_ID, { typeName: T, projectId: P }, viewer.userId)).entities).toEqual([]);
    expect((await run(ENTITIES_DESCRIBE_TYPE_TOOL_ID, {}, insider.userId)).types.map((t) => t.name)).toContain(T);
    expect((await run(ENTITIES_QUERY_TOOL_ID, { typeName: T, projectId: P }, insider.userId)).total).toBeGreaterThan(0);
  });

  it('an acting user with no membership in the workspace reads nothing, even in the root', async () => {
    const root = `tool_${n++}`;
    expect((await admin.call('POST', `${BASE}/types`, { name: root, fields: TITLE })).status).toBe(201);
    expect((await run(ENTITIES_DESCRIBE_TYPE_TOOL_ID, {}, 'oidc:stranger')).types).toEqual([]);
    expect((await run(ENTITIES_QUERY_TOOL_ID, { typeName: root }, 'oidc:stranger')).entities).toEqual([]);
  });
});

describe('D1 / review A2 — terms stay in their namespace', () => {
  it('a root entity cannot carry a project term, and a foreign termId matches nothing', async () => {
    const tax = `ptx_${n++}`;
    expect((await admin.call('POST', `${BASE}/taxonomies`, { name: tax, projectId: P })).status).toBe(201);
    const term = await admin.call('POST', `${BASE}/taxonomies/${tax}/terms`, { slug: 'roadmap', projectId: P });
    expect(term.status, JSON.stringify(term.body)).toBe(201);
    const termId = json(term).termId!;
    const root = `rt_${n++}`;
    expect((await admin.call('POST', `${BASE}/types`, { name: root, fields: TITLE })).status).toBe(201);
    const r = await admin.call('POST', `${BASE}/types/${root}/entities`, { values: { title: 'x' }, termIds: [termId] });
    expect(r.status, 'a cross-namespace term must be refused like an unknown one').toBe(400);
    // A pre-ADR-0847 row that already carries the project term (written raw — the API
    // now refuses it). Filtering the ROOT type by that term must match nothing, or the
    // query becomes a lookup into the private taxonomy.
    const ok = await admin.call('POST', `${BASE}/types/${root}/entities`, { values: { title: 'legacy' }, entityId: 'LT' });
    expect(ok.status).toBe(201);
    const records = new DurableCollection<EntityRecord>('entity:record', (e) => e.recordKey, undefined, (e) => e.tenantId);
    const termIdx = new DurableCollection<{ key: string; tenantId: string; recordKey: string }>('entity:term-idx', (x) => x.key);
    const key = `${(await records.listForTenantIndexed(WS)).find((x) => x.entityId === 'LT')!.typeId}|LT`;
    await records.put({ ...(await records.get(key))!, termIds: [termId] });
    await termIdx.put({ key: `${termId}|${key}`, tenantId: WS, recordKey: key });
    const q = await admin.call('POST', `${BASE}/types/${root}/query`, { termId });
    expect(json(q).total).toBe(0);
    // ...and the legacy membership itself is never served (grade-code ENT3CD-2).
    const lt = await admin.call('GET', `${BASE}/types/${root}/entities/LT`);
    expect(lt.status).toBe(200);
    expect(json(lt).termIds).toBeUndefined();
  });
});

describe('D2 / ENT2WF-2 — the namespace goes with its project', () => {
  it('entities is a registered project dependent, counted in the delete preview, and purged', async () => {
    expect(listSubjectDependentKeys('project')).toContain('entities');
    const p = (await createProject(WS, WS, { name: 'Short-lived' }, admin.userId)).id;
    const t = `gone_${n++}`;
    expect((await admin.call('POST', `${BASE}/types`, { name: t, projectId: p, fields: TITLE })).status).toBe(201);
    expect((await admin.call('POST', `${BASE}/types/${t}/entities?projectId=${p}`, { values: { title: 'x' } })).status).toBe(201);
    const tax = `gtx_${n++}`;
    expect((await admin.call('POST', `${BASE}/taxonomies`, { name: tax, projectId: p })).status).toBe(201);
    const pTermId = json(await admin.call('POST', `${BASE}/taxonomies/${tax}/terms`, { slug: 'a', projectId: p })).termId!;
    // A pre-ADR-0847 row in the ROOT that carries this project's term (written raw:
    // the API now refuses it) — the purge must strip it, not strand it.
    const root = `legacy_${n++}`;
    const rootType = await admin.call('POST', `${BASE}/types`, { name: root, fields: TITLE });
    const legacy = await admin.call('POST', `${BASE}/types/${root}/entities`, { values: { title: 'old' }, entityId: 'L1' });
    expect(legacy.status).toBe(201);
    const records = new DurableCollection<EntityRecord>('entity:record', (e) => e.recordKey, undefined, (e) => e.tenantId);
    const termIdx = new DurableCollection<{ key: string; tenantId: string; recordKey: string }>('entity:term-idx', (r) => r.key);
    const rootTypeId = json(rootType).typeId!;
    const key = `${rootTypeId}|L1`;
    const raw = (await records.get(key))!;
    await records.put({ ...raw, termIds: [pTermId] });
    await termIdx.put({ key: `${pTermId}|${key}`, tenantId: WS, recordKey: key });

    expect((await countSubjectDependents(WS, { kind: 'project', id: p })).entities, 'type + row + taxonomy + term').toBe(4);
    await deleteProject(WS, p);
    expect(names(await admin.call('GET', `${BASE}/types`)), 'type outlived its project').not.toContain(t);
    expect((await records.get(key))!.termIds, 'the legacy membership was stripped').toBeUndefined();
    expect(await termIdx.get(`${pTermId}|${key}`)).toBeNull();
  });

  it('public delivery refuses a namespace whose project no longer exists (review A6)', async () => {
    const types = new DurableCollection<EntityTypeRecord>('entity:type', (t) => t.typeId, undefined, (t) => t.tenantId);
    const now = new Date().toISOString();
    await types.put({
      typeId: `${WS}:ghost-project:orph`, tenantId: WS, projectId: 'ghost-project', name: 'orph', displayName: 'Orphan',
      fields: [{ key: 'title', label: 'Title', type: 'string', required: false }], status: 'published', publicRead: true,
      createdBy: 'x', createdAt: now, updatedAt: now,
    });
    await expect(readPublicEntities({ tenantId: WS, projectId: 'ghost-project', typeName: 'orph' })).rejects.toThrow(/not found/i);
  });
});

describe('D3 / ENT2WF-3 — delivery follows the schema', () => {
  /** A type of its own per case: a row written under three fields, then `internal_notes`
   *  removed and `rank` re-kinded to number, then published + public. */
  async function freshType(): Promise<string> {
    const t = `pub_${n++}`;
    expect((await admin.call('POST', `${BASE}/types`, { name: t, fields: [
      { key: 'title', label: 'Title', type: 'string' },
      { key: 'internal_notes', label: 'Internal notes', type: 'string' },
      { key: 'rank', label: 'Rank', type: 'string' },
    ] })).status).toBe(201);
    expect((await admin.call('POST', `${BASE}/types/${t}/entities`, { values: { title: 'Hello', internal_notes: 'margin is 4%', rank: 'high' }, entityId: 's1' })).status).toBe(201);
    const patched = await admin.call('PATCH', `${BASE}/types/${t}`, { fields: [
      { key: 'title', label: 'Title', type: 'string' },
      { key: 'rank', label: 'Rank', type: 'number' },
    ] });
    expect(patched.status, JSON.stringify(patched.body)).toBe(200);
    expect((await admin.call('PATCH', `${BASE}/types/${t}`, { status: 'published' })).status).toBe(200);
    expect((await admin.call('PATCH', `${BASE}/types/${t}`, { publicRead: true })).status).toBe(200);
    return t;
  }

  it('the anonymous wire withholds a removed field and a value of the old kind', async () => {
    const t = await freshType();
    const res = await fetch(`${ORIGIN}${PUB}/${encodeURIComponent(WS)}/types/${t}/entities`);
    const body = await res.json() as { entities: Array<{ values: Record<string, unknown> }> };
    expect(res.status).toBe(200);
    expect(body.entities[0]?.values).toEqual({ title: 'Hello' });
    const one = await (await fetch(`${ORIGIN}${PUB}/${encodeURIComponent(WS)}/types/${t}/entities/s1`)).json() as { values: Record<string, unknown> };
    expect(one.values).toEqual({ title: 'Hello' });
  });

  it('every authed read exit withholds them too: get, list, query, export', async () => {
    const t = await freshType();
    expect(json(await admin.call('GET', `${BASE}/types/${t}/entities/s1`)).values).toEqual({ title: 'Hello' });
    expect(json(await admin.call('GET', `${BASE}/types/${t}/entities`)).entities?.[0]?.values).toEqual({ title: 'Hello' });
    expect(json(await admin.call('POST', `${BASE}/types/${t}/query`, {})).entities?.[0]?.values).toEqual({ title: 'Hello' });
    const exp = await admin.call('GET', `${BASE}/types/${t}/export`);
    expect(exp.status).toBe(200);
    // One row parses as plain JSON; several stay NDJSON text.
    const first = (typeof exp.body === 'string' ? JSON.parse(exp.body.trim().split('\n')[0] ?? '{}') : exp.body) as Body;
    expect(first.values).toEqual({ title: 'Hello' });
  });

  it('write RETURNS withhold them too (review A1): PATCH, and an idempotent re-create', async () => {
    const t = await freshType();
    expect(json(await admin.call('PATCH', `${BASE}/types/${t}/entities/s1`, { values: { title: 'Hi' } })).values).toEqual({ title: 'Hi' });
    const again = await admin.call('POST', `${BASE}/types/${t}/entities`, { values: { title: 'ignored' }, entityId: 's1' });
    expect(json(again).values).toEqual({ title: 'Hi' });
  });

  it('the run and chat lanes inherit it', async () => {
    const t = await freshType();
    const s = surface({ tenantId: WS, actingUserId: admin.userId, runId: 'r-d3' });
    expect((await s.get!({ typeName: t, entityId: 's1' })).entity?.values).toEqual({ title: 'Hello' });
    const tool = JSON.parse((await builtinAgentTool(ENTITIES_QUERY_TOOL_ID)!.run({ typeName: t }, { tenantId: WS, actingUserId: admin.userId })).content) as { entities: Array<{ values: unknown }> };
    expect(tool.entities[0]?.values).toEqual({ title: 'Hello' });
  });

  it('storage is untouched: re-adding the field brings the value back', async () => {
    const t = await freshType();
    expect((await admin.call('PATCH', `${BASE}/types/${t}`, { fields: [
      { key: 'title', label: 'Title', type: 'string' },
      { key: 'rank', label: 'Rank', type: 'string' },
      { key: 'internal_notes', label: 'Internal notes', type: 'string' },
    ] })).status).toBe(200);
    expect(json(await admin.call('GET', `${BASE}/types/${t}/entities/s1`)).values).toEqual({ title: 'Hello', internal_notes: 'margin is 4%', rank: 'high' });
  });

  it('liveView: overlays keep only current localizable string fields; system types pass through', () => {
    const now = new Date().toISOString();
    const type: EntityTypeRecord = {
      typeId: 'x', tenantId: 't', projectId: '', name: 'n', displayName: 'N', status: 'published', createdBy: 'a', createdAt: now, updatedAt: now,
      fields: [{ key: 'title', label: 'T', type: 'string', required: false, localizable: true }, { key: 'body', label: 'B', type: 'string', required: false }],
    };
    const rec: EntityRecord = {
      recordKey: 'x|1', entityId: '1', tenantId: 't', projectId: '', typeId: 'x', createdBy: 'a', createdAt: now, updatedBy: 'a', updatedAt: now,
      values: { title: 'Hi', body: 'B', gone: 'G' },
      localizations: { es: { title: 'Hola', body: 'no-longer-localizable' }, fr: { body: 'x' } },
    };
    expect(liveView(type, rec).values).toEqual({ title: 'Hi', body: 'B' });
    expect(liveView(type, rec).localizations).toEqual({ es: { title: 'Hola' } });
    expect(liveView({ ...type, system: true }, rec)).toBe(rec);
  });
});
