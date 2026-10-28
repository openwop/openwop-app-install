/**
 * Issue #4543 (DSHCD-9) — the run list and the run snapshot withhold a run's
 * payload (inputs, variables, channels, configurable) from a workspace member
 * who neither started the run nor administers the workspace. A Viewer holds
 * `runs:read`, so before this a fired scheduled chat's prompt reached every
 * member of the workspace.
 *
 * Driven over HTTP in a shared workspace, both contracts (headerless v1 and
 * `OpenWOP-Version: 2`): the owner stamp the real run-create path writes is
 * what ownership is decided against.
 *
 * Breaks it (round-1 probes, witnessed): the list / snapshot projection
 * (8fw2g2-rpv-list, rpv-snap), the admin grant (rpv-admin), the poll
 * redaction (rpv-poll), the SSE redaction (rpv-sse), the token grant
 * (rpv-token), the debug-bundle and pin-prefill refusals (rpv-bundle,
 * rpv-prefill — each now asserted by its exact 403 message).
 *
 * The personal-workspace leg is a STACK of grants in `runPayloadReader`
 * (`host/runPayloadAccess.ts`): own personal workspace, then "membership does
 * not define presence", then the tenant-admin grant, then run ownership. Round
 * 1 read the caller's OWN run, which ownership alone satisfies, so removing the
 * personal check was VACUOUS (8fw2g2-rpv-personal). The case now also reads a
 * HOST-FIRED run (owner stamp removed) in that workspace — ownership cannot
 * grant it — and the probe removes the three tenant-level grants together
 * (8fw2g2-rpv-personal-stack-r2). Each of the three alone is still masked by
 * the other two (the personal workspace's owner is its admin): a recorded
 * double guard, not a gap.
 *
 * `settle` is a 50 ms run-status poll: an honest ceiling (no settle hook).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { toWireRunId } from '../src/host/v2Ids.js';
import { VENDOR_ROOT } from '../src/middleware/protocolVersion.js';
import { runOwner } from '../src/host/runOwner.js';

let server: http.Server;
let BASE = '';
let n = 0;
let storage: Storage;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage;
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = unknown> { status: number; body: T }
/** Narrow views of the response bodies this file reads. */
interface RunRow { runId: string; status?: string; inputs?: unknown; [k: string]: unknown }
interface RunList { runs: RunRow[] }
interface RunEvent { type: string; payload: Record<string, unknown> }
interface EventList { events: RunEvent[] }
interface ErrorBody { error: string; message: string }
function client() {
  let cookie = '';
  const call = async <T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res<T>> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...headers, ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const text = res.status === 204 ? '' : await res.text();
    let out: unknown;
    try { out = text ? JSON.parse(text) : undefined; } catch { out = text; }
    // The ONE place a body is given its expected type; every call site names it.
    return { status: res.status, body: out as T };
  };
  return {
    get: <T = unknown>(p: string, h?: Record<string, string>) => call<T>('GET', p, undefined, h),
    post: <T = unknown>(p: string, b?: unknown) => call<T>('POST', p, b),
  };
}
type Client = ReturnType<typeof client>;
async function signup(c: Client): Promise<{ userId: string }> {
  const r = await c.post<{ user: { userId: string } }>('/host/openwop-app/test/login', { email: `payload-${Date.now()}-${n++}@acme.test` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}
async function startRun(c: Client, marker: string): Promise<string> {
  const r = await c.post<{ runId: string }>('/runs', { workflowId: 'conformance-noop', inputs: { marker } });
  expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
  return r.body.runId;
}
const raw = (id: string): string => id.slice(id.lastIndexOf('/') + 1);
const V2 = { 'OpenWOP-Version': '2' };
const PAYLOAD = ['inputs', 'variables', 'channels', 'configurable'];

async function sharedWorkspace(): Promise<{ owner: Client; join: (role: string) => Promise<Client>; ws: string }> {
  const owner = client();
  await signup(owner);
  const ws = (await owner.post<{ workspaceId: string }>('/host/openwop-app/workspaces', { name: `PayloadWS-${n++}` })).body.workspaceId;
  expect((await owner.post(`/host/openwop-app/workspaces/${encodeURIComponent(ws)}/switch`)).status).toBe(200);
  const join = async (role: string): Promise<Client> => {
    const c = client();
    const u = await signup(c);
    const add = await owner.post(`/host/openwop-app/orgs/${encodeURIComponent(ws)}/members`, { displayName: role, subject: u.userId, roles: [role] });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    expect((await c.post(`/host/openwop-app/workspaces/${encodeURIComponent(ws)}/switch`)).status).toBe(200);
    return c;
  };
  return { owner, join, ws };
}

function rowFor(body: RunList, runId: string): RunRow {
  const row = body.runs.find((r) => raw(r.runId) === raw(runId));
  expect(row, `run ${runId} missing from the list`).toBeDefined();
  return row!;
}

describe('#4543 — run payload is the run owner\'s and the admins\'', () => {
  it('a Viewer lists and opens another member\'s run without its payload, on both contracts', async () => {
    const { owner, join } = await sharedWorkspace();
    const viewer = await join('viewer');
    const runId = await startRun(owner, 'owner-secret-prompt');

    for (const h of [undefined, V2]) {
      const list = await viewer.get<RunList>('/runs?limit=100', h);
      expect(list.status, JSON.stringify(list.body)).toBe(200);
      const row = rowFor(list.body, runId);
      expect(row.status).toBeDefined();
      for (const k of PAYLOAD) expect(row, `list leaks ${k}`).not.toHaveProperty(k);
      expect(JSON.stringify(list.body)).not.toContain('owner-secret-prompt');

      const snap = await viewer.get<RunRow>(`/runs/${encodeURIComponent(runId)}`, h);
      expect(snap.status, JSON.stringify(snap.body)).toBe(200);
      expect(snap.body.status).toBeDefined();
      for (const k of PAYLOAD) expect(snap.body, `snapshot leaks ${k}`).not.toHaveProperty(k);
      expect(JSON.stringify(snap.body)).not.toContain('owner-secret-prompt');
    }
  });

  it('the run owner and an Admin read the payload; an Editor reads only their own', async () => {
    const { owner, join } = await sharedWorkspace();
    const admin = await join('admin');
    const editor = await join('editor');
    const ownerRun = await startRun(owner, 'owner-input');
    const editorRun = await startRun(editor, 'editor-input');

    for (const h of [undefined, V2]) {
      const ownerSnap = await owner.get<RunRow>(`/runs/${encodeURIComponent(ownerRun)}`, h);
      expect(ownerSnap.body.inputs, JSON.stringify(ownerSnap.body)).toEqual({ marker: 'owner-input' });

      const adminList = await admin.get<RunList>('/runs?limit=100', h);
      expect(rowFor(adminList.body, ownerRun).inputs).toEqual({ marker: 'owner-input' });
      expect(rowFor(adminList.body, editorRun).inputs).toEqual({ marker: 'editor-input' });

      const editorList = await editor.get<RunList>('/runs?limit=100', h);
      expect(rowFor(editorList.body, editorRun).inputs).toEqual({ marker: 'editor-input' });
      expect(rowFor(editorList.body, ownerRun)).not.toHaveProperty('inputs');
      const editorOnOwner = await editor.get<RunRow>(`/runs/${encodeURIComponent(ownerRun)}`, h);
      expect(editorOnOwner.status).toBe(200);
      expect(editorOnOwner.body).not.toHaveProperty('inputs');
    }
  });

  it('in the caller\'s own personal workspace every payload is theirs', async () => {
    const c = client();
    await signup(c);
    const runId = await startRun(c, 'mine');
    const snap = await c.get<RunRow>(`/runs/${encodeURIComponent(runId)}`, V2);
    expect(snap.body.inputs).toEqual({ marker: 'mine' });
    const list = await c.get<RunList>('/runs?limit=100', V2);
    expect(rowFor(list.body, runId).inputs).toEqual({ marker: 'mine' });

    // EVERY payload, not only the caller's own: a HOST-FIRED run (no owner stamp)
    // in the same personal workspace. Run ownership cannot grant this one, so the
    // read below is decided by the workspace-level grants (header).
    const hostFired = await startRun(c, 'host-fired');
    const row = await storage.getRun(raw(hostFired));
    expect(row?.metadata.owner, 'precondition: the real create path stamps an owner').toBeDefined();
    // `runOwner` also falls back to `actingUserId` (and an anonymous principal),
    // so every ownership source goes, and the precondition reads it through
    // the same function the payload rule uses (round 2 left `actingUserId` and
    // the probe passed on ownership: 8fw2g2-rpv-personal-stack-r2).
    const { owner: _o, actingUserId: _a, anonPrincipal: _p, principalKind: _k, ...unowned } = row!.metadata;
    await storage.updateRun(raw(hostFired), { metadata: unowned });
    const after = await storage.getRun(raw(hostFired));
    expect(runOwner({ tenantId: after!.tenantId, metadata: after!.metadata }), 'no ownership source is left').toBeUndefined();
    const unownedSnap = await c.get<RunRow>(`/runs/${encodeURIComponent(hostFired)}`, V2);
    expect(unownedSnap.status).toBe(200);
    expect(unownedSnap.body.inputs).toEqual({ marker: 'host-fired' });
  });
});

/** Wait for `runId` to reach a terminal status, read as `c`. */
async function settle(c: Client, runId: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const r = await c.get<RunRow | undefined>(`/runs/${encodeURIComponent(runId)}`);
    if (['completed', 'failed', 'cancelled'].includes(r.body?.status ?? '')) return;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error(`run ${runId} did not settle`);
}
const SSE = { accept: 'text/event-stream' };
const JSON_EVENTS = { accept: 'application/json' };
const KEPT = new Set(['workflowId', 'nodeId', 'nodeType', 'status', 'attempt', 'durationMs', 'error']);
const poll = (runId: string): string => `/runs/${encodeURIComponent(runId)}/events/poll?limit=1000`;
const events = (runId: string, q = ''): string => `/runs/${encodeURIComponent(runId)}/events${q}`;
const bundle = (runId: string): string => `/runs/${encodeURIComponent(runId)}/debug-bundle`;
const mint = (runId: string): string => `${VENDOR_ROOT}/runs/${encodeURIComponent(raw(runId))}/events/token`;
/** The cookie-less cross-origin SSE the SPA opens with a stream token. */
async function crossOriginStream(ws: string, runId: string, token: string): Promise<{ status: number; text: string }> {
  const r = await fetch(`${BASE}/runs/${encodeURIComponent(toWireRunId(raw(runId), ws))}/events?streamToken=${encodeURIComponent(token)}`, { headers: { ...SSE, ...V2 } });
  return { status: r.status, text: await r.text() };
}

describe('#4543 — the run event log is the run owner\'s and the admins\'', () => {
  it('a Viewer watches another member\'s run without its payload: poll, the JSON events, and every stream mode', async () => {
    const { owner, join } = await sharedWorkspace();
    const viewer = await join('viewer');
    const runId = await startRun(owner, 'owner-secret-prompt');
    await settle(owner, runId);

    // Positive control: the log DOES carry the marker, so its absence below is
    // the redaction and not an empty log.
    const own = await owner.get<EventList>(poll(runId));
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(JSON.stringify(own.body)).toContain('owner-secret-prompt');

    const seen = await viewer.get<EventList>(poll(runId));
    expect(seen.status, JSON.stringify(seen.body)).toBe(200);
    expect(seen.body.events.length).toBe(own.body.events.length);
    expect(seen.body.events.map((e) => e.type)).toEqual(own.body.events.map((e) => e.type));
    for (const e of seen.body.events) for (const k of Object.keys(e.payload)) expect(KEPT, `poll keeps payload.${k} on ${e.type}`).toContain(k);
    expect(JSON.stringify(seen.body)).not.toContain('owner-secret-prompt');

    const asJson = await viewer.get<EventList>(events(runId), JSON_EVENTS);
    expect(asJson.status).toBe(200);
    expect(asJson.body.events.length).toBeGreaterThan(0);
    expect(JSON.stringify(asJson.body)).not.toContain('owner-secret-prompt');

    for (const q of ['', '?streamMode=debug', '?streamMode=values', '?streamMode=messages']) {
      const sse = await viewer.get<string>(events(runId, q), SSE);
      expect(sse.status, q).toBe(200);
      expect(String(sse.body), `stream ${q}`).not.toContain('owner-secret-prompt');
    }
    const ownSse = await owner.get<string>(events(runId, '?streamMode=debug'), SSE);
    expect(String(ownSse.body)).toContain('owner-secret-prompt');
  });

  it('the stream token carries the minting caller\'s grant across origins, and a redacted grant cannot be upgraded', async () => {
    const { owner, join, ws } = await sharedWorkspace();
    const viewer = await join('viewer');
    const runId = await startRun(owner, 'owner-secret-prompt');
    await settle(owner, runId);

    const viewerTok = (await viewer.get<{ streamToken: string }>(mint(runId))).body.streamToken;
    const ownerTok = (await owner.get<{ streamToken: string }>(mint(runId))).body.streamToken;
    expect(viewerTok.startsWith('v1r.')).toBe(true);
    expect(ownerTok.startsWith('v1.')).toBe(true);

    const redacted = await crossOriginStream(ws, runId, viewerTok);
    expect(redacted.status).toBe(200);
    expect(redacted.text).toContain('event:');
    expect(redacted.text).not.toContain('owner-secret-prompt');

    const full = await crossOriginStream(ws, runId, ownerTok);
    expect(full.status).toBe(200);
    expect(full.text).toContain('owner-secret-prompt');

    // Relabelling a redacted token as a full one breaks its signature.
    expect((await crossOriginStream(ws, runId, viewerTok.replace(/^v1r\./, 'v1.'))).status).toBe(401);
  });

  it('the debug bundle is refused to a member who may not read the payload', async () => {
    const { owner, join } = await sharedWorkspace();
    const viewer = await join('viewer');
    const admin = await join('admin');
    const editor = await join('editor');
    const ownerRun = await startRun(owner, 'owner-bundle');
    const editorRun = await startRun(editor, 'editor-bundle');
    await settle(owner, ownerRun);
    await settle(owner, editorRun);

    const BUNDLE_403 = 'Only the run owner or a workspace admin can export its debug bundle.';
    for (const refusedBy of [viewer, editor]) {
      const r = await refusedBy.get<ErrorBody>(bundle(ownerRun));
      expect(r.status).toBe(403);
      expect(r.body.message).toBe(BUNDLE_403);
      expect(JSON.stringify(r.body)).not.toContain('owner-bundle');
    }
    const byOwner = await owner.get(bundle(ownerRun));
    expect(byOwner.status).toBe(200);
    expect(JSON.stringify(byOwner.body)).toContain('owner-bundle');
    expect(JSON.stringify((await admin.get(bundle(ownerRun))).body)).toContain('owner-bundle');
    expect(JSON.stringify((await editor.get(bundle(editorRun))).body)).toContain('editor-bundle');

    // An Editor polls their own run in full and another member's without payload.
    expect(JSON.stringify((await editor.get(poll(editorRun))).body)).toContain('editor-bundle');
    expect(JSON.stringify((await editor.get(poll(ownerRun))).body)).not.toContain('owner-bundle');
  });

  it('the pin prefill copies node outputs only from a run the caller may read the payload of', async () => {
    const { owner, join } = await sharedWorkspace();
    const editor = await join('editor');
    const wf = `payload-prefill-${n++}`;
    const made = await owner.post('/host/openwop-app/workflows', {
      workflowId: wf,
      nodes: [{ nodeId: 'a', typeId: 'core.noop' }],
      edges: [],
      metadata: { name: wf, lifecycle: { transient: true, generatedBy: 'test' } },
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const run = await owner.post<{ runId: string }>('/runs', { workflowId: wf, inputs: { marker: 'owner-prefill' } });
    expect(run.status, JSON.stringify(run.body)).toBeLessThan(300);
    await settle(owner, run.body.runId);

    const prefill = <T>(c: Client) => c.post<T>(`/host/openwop-app/workflows/${wf}/pins/from-run`, { runId: raw(run.body.runId) });
    const refused = await prefill<ErrorBody>(editor);
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(refused.body.message).toBe('Only the run owner or a workspace admin can prefill pins from this run.');
    expect(JSON.stringify(refused.body)).not.toContain('owner-prefill');
    const allowed = await prefill<{ pinned: string[] }>(owner);
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
    expect(allowed.body.pinned).toEqual(['a']);
  });
});
