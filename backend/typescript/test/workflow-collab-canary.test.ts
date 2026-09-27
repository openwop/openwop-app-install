/**
 * ADR 0481 — the workflow-collab resource + the GATE B two-client canary:
 * two real Yjs clients over the REAL transport (HTTP server, WS upgrade,
 * ticket auth, collabServer authorization, collabRoom sync) against the
 * workflow lane. Asserts live two-way convergence, awareness relay, the D2
 * REST lock (409 workflow_room_live), the teardown force-derive writing the
 * head through the full save trio, and the eligibility refusals.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, type RawData } from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { readSyncMessage, writeSyncStep1, writeUpdate } from 'y-protocols/sync';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { attachCollabWebSocket, __resetCollabConns } from '../src/host/collab/collabServer.js';
import { __resetCollabRooms, __stopCollabLeaseHeartbeat, __stopCollabUpdateSweep } from '../src/host/collab/collabRoom.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';

const ORIGIN = 'http://localhost:9989';
let BASE: string; let WSBASE: string; let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_CORS_ORIGINS = ORIGIN;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => {
    const port = (server.address() as AddressInfo).port; BASE = `http://127.0.0.1:${port}`; WSBASE = `ws://127.0.0.1:${port}`; res();
  }); });
  attachCollabWebSocket(server);
  for (const id of ['realtime-collab', 'workflow-collab']) {
    const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { __stopCollabLeaseHeartbeat(); __stopCollabUpdateSweep(); __resetCollabRooms(); __resetCollabConns(); delete process.env.OPENWOP_CORS_ORIGINS; await new Promise<void>((res) => server.close(() => res())); });

let n = 0;
interface Session { cookie: string; tenantId: string }
async function login(): Promise<Session> {
  const tenantId = `org:wfcollab-${Date.now()}-${n++}`;
  const res = await fetch(`${BASE}/v1/host/openwop-app/test/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `wfc-${Date.now()}-${n++}@a.test`, tenantId }) });
  let cookie = '';
  for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
  return { cookie, tenantId };
}

function def(workflowId: string, marker: string): Record<string, unknown> {
  return {
    workflowId,
    nodes: [{ nodeId: 'n1', typeId: 'core.noop', config: { marker } }],
    edges: [],
    metadata: { name: `WF ${marker}`, lifecycle: { transient: true, generatedBy: 'test' } },
  };
}

async function api<T = unknown>(s: Session, method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { cookie: s.cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: (await res.json().catch(() => undefined)) as T };
}

const REMOTE = Symbol('test-remote');
const MSG_AWARENESS = 1;
function toBytes(d: RawData): Uint8Array { return Array.isArray(d) ? Buffer.concat(d) : Buffer.isBuffer(d) ? d : Buffer.from(d as ArrayBuffer); }

/** A minimal Yjs sync client over the WORKFLOW lane, authenticated by TICKET
 *  (the cross-origin prod posture — the stronger canary). */
function client(ticket: string, workflowId: string): { doc: Y.Doc; ws: WebSocket; awarenessFrames: number[] } {
  const doc = new Y.Doc();
  const awarenessFrames: number[] = [];
  const ws = new WebSocket(`${WSBASE}/v1/host/openwop-app/workflow-collab/${workflowId}?ticket=${encodeURIComponent(ticket)}`, { headers: { origin: ORIGIN } });
  ws.on('open', () => { const e = encoding.createEncoder(); encoding.writeVarUint(e, 0); writeSyncStep1(e, doc); ws.send(encoding.toUint8Array(e)); });
  ws.on('message', (data) => {
    const dec = decoding.createDecoder(toBytes(data));
    const kind = decoding.readVarUint(dec);
    if (kind === MSG_AWARENESS) { awarenessFrames.push(1); return; }
    if (kind !== 0) return;
    const e = encoding.createEncoder(); encoding.writeVarUint(e, 0);
    readSyncMessage(dec, e, doc, REMOTE);
    if (encoding.length(e) > 1) ws.send(encoding.toUint8Array(e));
  });
  doc.on('update', (u: Uint8Array, origin: unknown) => {
    if (origin === REMOTE || ws.readyState !== ws.OPEN) return;
    const e = encoding.createEncoder(); encoding.writeVarUint(e, 0); writeUpdate(e, u); ws.send(encoding.toUint8Array(e));
  });
  return { doc, ws, awarenessFrames };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms = 4000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await sleep(25); }
  return pred();
}
const opened = (ws: WebSocket) => new Promise<void>((res, rej) => {
  if (ws.readyState === ws.OPEN) return res();
  ws.on('open', () => res());
  ws.on('unexpected-response', (_req, r) => rej(new Error(`upgrade rejected: ${r.statusCode}`)));
  ws.on('error', (e) => rej(e));
});
const closed = (ws: WebSocket) => new Promise<void>((res) => { if (ws.readyState === ws.CLOSED) return res(); ws.on('close', () => res()); ws.close(); });

describe('workflow collab canary (ADR 0481 / Gate B)', () => {
  it('two clients converge live over the real transport; REST locks; teardown derives the head', async () => {
    const s = await login();
    const wfId = `wfc-live-${Date.now()}`;
    expect((await api(s, 'POST', '/v1/host/openwop-app/workflows', def(wfId, 'v1'))).status).toBe(201);

    const t1 = await api<{ ticket: string }>(s, 'POST', `/v1/host/openwop-app/workflow-collab/${wfId}/ticket`);
    const t2 = await api<{ ticket: string }>(s, 'POST', `/v1/host/openwop-app/workflow-collab/${wfId}/ticket`);
    expect(t1.status).toBe(200);

    const a = client(t1.body.ticket, wfId);
    const b = client(t2.body.ticket, wfId);
    await Promise.all([opened(a.ws), opened(b.ws)]);

    // Live two-way convergence through the REAL room.
    a.doc.getMap('doc').set('name', 'renamed-by-a');
    expect(await waitFor(() => b.doc.getMap('doc').get('name') === 'renamed-by-a')).toBe(true);
    b.doc.getMap('doc').set('defaultInputs', '{"x":1}');
    expect(await waitFor(() => a.doc.getMap('doc').get('defaultInputs') === '{"x":1}')).toBe(true);

    // D2 lock: while the room lives, REST saves/rollback/lifecycle 409.
    const blocked = await api<{ details?: { reason?: string } }>(s, 'POST', '/v1/host/openwop-app/workflows', def(wfId, 'clobber'));
    expect(blocked.status).toBe(409);
    expect(JSON.stringify(blocked.body)).toContain('workflow_room_live');

    // The derive vehicle: a client writes its serialized definition scalar.
    const derived = def(wfId, 'from-collab');
    a.doc.getMap('doc').set('definition', JSON.stringify(derived));
    expect(await waitFor(() => typeof b.doc.getMap('doc').get('definition') === 'string')).toBe(true);

    // Teardown: both leave → evict force-derives → the head is the room's.
    await closed(a.ws);
    await closed(b.ws);
    // Evict's flush + force-derive are async — POLL the head (no fixed sleep).
    const head = await (async () => {
      for (let i = 0; i < 100; i += 1) {
        const r = await api<{ workflows?: Array<{ workflowId: string; name?: string }> }>(s, 'GET', '/v1/host/openwop-app/workflows');
        const got = await fetch(`${BASE}/v1/workflows/${encodeURIComponent(wfId)}`, { headers: { cookie: s.cookie } });
        if (got.status === 200) {
          const j = await got.json() as { metadata?: { name?: string } };
          if (j.metadata?.name === 'WF from-collab') return j;
        }
        void r;
        await sleep(30);
      }
      return null;
    })();
    expect(head).not.toBeNull();

    // After teardown the lock releases — REST saves work again (poll: the
    // lease deletion is part of the async evict).
    const after = await (async () => {
      for (let i = 0; i < 100; i += 1) {
        const r = await api(s, 'POST', '/v1/host/openwop-app/workflows', def(wfId, 'post-session'));
        if (r.status === 201) return r.status;
        await sleep(30);
      }
      return 0;
    })();
    expect(after).toBe(201);
  }, 30_000);

  it('awareness relays between the two clients (presence transport)', async () => {
    const s = await login();
    const wfId = `wfc-aware-${Date.now()}`;
    expect((await api(s, 'POST', '/v1/host/openwop-app/workflows', def(wfId, 'v1'))).status).toBe(201);
    const t1 = await api<{ ticket: string }>(s, 'POST', `/v1/host/openwop-app/workflow-collab/${wfId}/ticket`);
    const t2 = await api<{ ticket: string }>(s, 'POST', `/v1/host/openwop-app/workflow-collab/${wfId}/ticket`);
    const a = client(t1.body.ticket, wfId);
    const b = client(t2.body.ticket, wfId);
    await Promise.all([opened(a.ws), opened(b.ws)]);
    // Hand-encode one awareness frame from A; B must receive an awareness frame.
    const { Awareness, encodeAwarenessUpdate } = await import('y-protocols/awareness');
    const aw = new Awareness(a.doc);
    aw.setLocalState({ user: 'a', selection: ['n1'] });
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, MSG_AWARENESS);
    encoding.writeVarUint8Array(e, encodeAwarenessUpdate(aw, [a.doc.clientID]));
    a.ws.send(encoding.toUint8Array(e));
    expect(await waitFor(() => b.awarenessFrames.length > 0)).toBe(true);
    await closed(a.ws); await closed(b.ws);
  }, 20_000);

  it('DELETE is room-locked (code-review H2) and the seed claim dies with the workflow (H1)', async () => {
    const s = await login();
    const wfId = `wfc-del-${Date.now()}`;
    expect((await api(s, 'POST', '/v1/host/openwop-app/workflows', def(wfId, 'v1'))).status).toBe(201);
    const t = await api<{ ticket: string }>(s, 'POST', `/v1/host/openwop-app/workflow-collab/${wfId}/ticket`);

    // Win the seed claim, join a room.
    const claim1 = await api<{ seed: boolean }>(s, 'POST', `/v1/host/openwop-app/workflow-collab/${wfId}/claim-seed`);
    expect(claim1.body.seed).toBe(true);
    const a = client(t.body.ticket, wfId);
    await opened(a.ws);

    // DELETE under the live room → 409 workflow_room_live (H2).
    const del = await api(s, 'DELETE', `/v1/host/openwop-app/workflows/${wfId}`);
    expect(del.status).toBe(409);
    expect(JSON.stringify(del.body)).toContain('workflow_room_live');

    await closed(a.ws);
    // After leave, delete succeeds (poll the async evict releasing the lease).
    let deleted = 0;
    for (let i = 0; i < 100; i += 1) {
      const r = await api(s, 'DELETE', `/v1/host/openwop-app/workflows/${wfId}`);
      if (r.status === 200) { deleted = r.status; break; }
      await sleep(30);
    }
    expect(deleted).toBe(200);

    // H1 — recreate the SAME id: the seed claim must have died with the
    // workflow, so the fresh room's election is winnable again.
    expect((await api(s, 'POST', '/v1/host/openwop-app/workflows', def(wfId, 'v2'))).status).toBe(201);
    let seedAgain = false;
    for (let i = 0; i < 100; i += 1) {
      const claim2 = await api<{ seed: boolean }>(s, 'POST', `/v1/host/openwop-app/workflow-collab/${wfId}/claim-seed`);
      if (claim2.body?.seed === true) { seedAgain = true; break; }
      await sleep(30);
    }
    expect(seedAgain).toBe(true);
  }, 30_000);

  it('eligibility refusals: cross-tenant, reserved namespace, unknown — uniform 404; toggle off — 404', async () => {
    const s = await login();
    const other = await login();
    const wfId = `wfc-own-${Date.now()}`;
    expect((await api(s, 'POST', '/v1/host/openwop-app/workflows', def(wfId, 'v1'))).status).toBe(201);

    expect((await api(other, 'POST', `/v1/host/openwop-app/workflow-collab/${wfId}/ticket`)).status).toBe(404); // foreign
    expect((await api(s, 'POST', '/v1/host/openwop-app/workflow-collab/tmpl.anything/ticket')).status).toBe(404); // reserved
    expect((await api(s, 'POST', '/v1/host/openwop-app/workflow-collab/never-registered/ticket')).status).toBe(404); // unknown

    const d = getToggleDefault('workflow-collab');
    if (d) await saveConfig({ ...d, status: 'off' }, 'test');
    try {
      expect((await api(s, 'POST', `/v1/host/openwop-app/workflow-collab/${wfId}/ticket`)).status).toBe(404); // resource toggle off
    } finally {
      if (d) await saveConfig({ ...d, status: 'on' }, 'test');
    }
  });
});
