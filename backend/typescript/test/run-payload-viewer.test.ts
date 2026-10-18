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
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { toWireRunId } from '../src/host/v2Ids.js';
import { VENDOR_ROOT } from '../src/middleware/protocolVersion.js';

let server: http.Server;
let BASE = '';
let n = 0;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
  for (const id of ['users']) { const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test'); }
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

interface Res<T = any> { status: number; body: T }
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, { method, headers: { 'content-type': 'application/json', ...headers, ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const text = res.status === 204 ? '' : await res.text();
    let out: unknown;
    try { out = text ? JSON.parse(text) : undefined; } catch { out = text; }
    return { status: res.status, body: out };
  };
  return {
    get: (p: string, h?: Record<string, string>) => call('GET', p, undefined, h),
    post: (p: string, b?: unknown) => call('POST', p, b),
  };
}
type Client = ReturnType<typeof client>;
async function signup(c: Client): Promise<{ userId: string }> {
  const r = await c.post('/host/openwop-app/test/login', { email: `payload-${Date.now()}-${n++}@acme.test` });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body.user;
}
async function startRun(c: Client, marker: string): Promise<string> {
  const r = await c.post('/runs', { workflowId: 'conformance-noop', inputs: { marker } });
  expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
  return r.body.runId as string;
}
const raw = (id: string): string => id.slice(id.lastIndexOf('/') + 1);
const V2 = { 'OpenWOP-Version': '2' };
const PAYLOAD = ['inputs', 'variables', 'channels', 'configurable'];

async function sharedWorkspace(): Promise<{ owner: Client; join: (role: string) => Promise<Client>; ws: string }> {
  const owner = client();
  await signup(owner);
  const ws = (await owner.post('/host/openwop-app/workspaces', { name: `PayloadWS-${n++}` })).body.workspaceId as string;
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

function rowFor(body: { runs: Array<Record<string, unknown>> }, runId: string): Record<string, unknown> {
  const row = body.runs.find((r) => raw(r.runId as string) === raw(runId));
  expect(row, `run ${runId} missing from the list`).toBeDefined();
  return row!;
}

describe('#4543 — run payload is the run owner\'s and the admins\'', () => {
  it('a Viewer lists and opens another member\'s run without its payload, on both contracts', async () => {
    const { owner, join } = await sharedWorkspace();
    const viewer = await join('viewer');
    const runId = await startRun(owner, 'owner-secret-prompt');

    for (const h of [undefined, V2]) {
      const list = await viewer.get('/runs?limit=100', h);
      expect(list.status, JSON.stringify(list.body)).toBe(200);
      const row = rowFor(list.body, runId);
      expect(row.status).toBeDefined();
      for (const k of PAYLOAD) expect(row, `list leaks ${k}`).not.toHaveProperty(k);
      expect(JSON.stringify(list.body)).not.toContain('owner-secret-prompt');

      const snap = await viewer.get(`/runs/${encodeURIComponent(runId)}`, h);
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
      const ownerSnap = await owner.get(`/runs/${encodeURIComponent(ownerRun)}`, h);
      expect(ownerSnap.body.inputs, JSON.stringify(ownerSnap.body)).toEqual({ marker: 'owner-input' });

      const adminList = await admin.get('/runs?limit=100', h);
      expect(rowFor(adminList.body, ownerRun).inputs).toEqual({ marker: 'owner-input' });
      expect(rowFor(adminList.body, editorRun).inputs).toEqual({ marker: 'editor-input' });

      const editorList = await editor.get('/runs?limit=100', h);
      expect(rowFor(editorList.body, editorRun).inputs).toEqual({ marker: 'editor-input' });
      expect(rowFor(editorList.body, ownerRun)).not.toHaveProperty('inputs');
      const editorOnOwner = await editor.get(`/runs/${encodeURIComponent(ownerRun)}`, h);
      expect(editorOnOwner.status).toBe(200);
      expect(editorOnOwner.body).not.toHaveProperty('inputs');
    }
  });

  it('in the caller\'s own personal workspace every payload is theirs', async () => {
    const c = client();
    await signup(c);
    const runId = await startRun(c, 'mine');
    const snap = await c.get(`/runs/${encodeURIComponent(runId)}`, V2);
    expect(snap.body.inputs).toEqual({ marker: 'mine' });
    const list = await c.get('/runs?limit=100', V2);
    expect(rowFor(list.body, runId).inputs).toEqual({ marker: 'mine' });
  });
});

/** Wait for `runId` to reach a terminal status, read as `c`. */
async function settle(c: Client, runId: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const r = await c.get(`/runs/${encodeURIComponent(runId)}`);
    if (['completed', 'failed', 'cancelled'].includes(r.body?.status)) return;
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
    const own = await owner.get(poll(runId));
    expect(own.status, JSON.stringify(own.body)).toBe(200);
    expect(JSON.stringify(own.body)).toContain('owner-secret-prompt');

    const seen = await viewer.get(poll(runId));
    expect(seen.status, JSON.stringify(seen.body)).toBe(200);
    expect(seen.body.events.length).toBe(own.body.events.length);
    expect(seen.body.events.map((e: { type: string }) => e.type)).toEqual(own.body.events.map((e: { type: string }) => e.type));
    for (const e of seen.body.events) for (const k of Object.keys(e.payload)) expect(KEPT, `poll keeps payload.${k} on ${e.type}`).toContain(k);
    expect(JSON.stringify(seen.body)).not.toContain('owner-secret-prompt');

    const asJson = await viewer.get(events(runId), JSON_EVENTS);
    expect(asJson.status).toBe(200);
    expect(asJson.body.events.length).toBeGreaterThan(0);
    expect(JSON.stringify(asJson.body)).not.toContain('owner-secret-prompt');

    for (const q of ['', '?streamMode=debug', '?streamMode=values', '?streamMode=messages']) {
      const sse = await viewer.get(events(runId, q), SSE);
      expect(sse.status, q).toBe(200);
      expect(String(sse.body), `stream ${q}`).not.toContain('owner-secret-prompt');
    }
    const ownSse = await owner.get(events(runId, '?streamMode=debug'), SSE);
    expect(String(ownSse.body)).toContain('owner-secret-prompt');
  });

  it('the stream token carries the minting caller\'s grant across origins, and a redacted grant cannot be upgraded', async () => {
    const { owner, join, ws } = await sharedWorkspace();
    const viewer = await join('viewer');
    const runId = await startRun(owner, 'owner-secret-prompt');
    await settle(owner, runId);

    const viewerTok = (await viewer.get(mint(runId))).body.streamToken as string;
    const ownerTok = (await owner.get(mint(runId))).body.streamToken as string;
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

    expect((await viewer.get(bundle(ownerRun))).status).toBe(403);
    expect((await editor.get(bundle(ownerRun))).status).toBe(403);
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
    const run = await owner.post('/runs', { workflowId: wf, inputs: { marker: 'owner-prefill' } });
    expect(run.status, JSON.stringify(run.body)).toBeLessThan(300);
    await settle(owner, run.body.runId);

    const prefill = (c: Client) => c.post(`/host/openwop-app/workflows/${wf}/pins/from-run`, { runId: raw(run.body.runId) });
    const refused = await prefill(editor);
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    expect(JSON.stringify(refused.body)).not.toContain('owner-prefill');
    const allowed = await prefill(owner);
    expect(allowed.status, JSON.stringify(allowed.body)).toBe(200);
    expect(allowed.body.pinned).toEqual(['a']);
  });
});
