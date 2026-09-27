/**
 * ADR 0335 Phase 1b-i — collaboration CRDT SYNC + snapshot persistence. Boots the
 * app + collab WS, then drives two real Yjs clients over the socket: an edit in
 * one converges to the other; and after a debounced save + room eviction, a fresh
 * client restores the persisted state. Single-instance (fan-out = 1b-ii).
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
import { createCanvasForTenant } from '../src/host/canvasSurface.js';

const ORIGIN = 'http://localhost:9988';
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
  const c = getToggleDefault('realtime-collab'); if (c) await saveConfig({ ...c, status: 'on' }, 'test');
  const de = getToggleDefault('document-editor'); if (de) await saveConfig({ ...de, status: 'on' }, 'test');
});
afterAll(async () => { __stopCollabLeaseHeartbeat(); __stopCollabUpdateSweep(); __resetCollabRooms(); __resetCollabConns(); delete process.env.OPENWOP_CORS_ORIGINS; await new Promise<void>((res) => server.close(() => res())); });

let n = 0;
async function loginAndDoc(): Promise<{ cookie: string; canvasId: string }> {
  const tenantId = `org:sync-${Date.now()}-${n++}`;
  const res = await fetch(`${BASE}/v1/host/openwop-app/test/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `sync-${Date.now()}-${n++}@a.test`, tenantId }) });
  let cookie = '';
  for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
  const canvas = await createCanvasForTenant(tenantId, { canvasTypeId: 'canvas.document', name: 'D', initialState: { title: 'D', content: { type: 'doc', content: [] } } });
  return { cookie, canvasId: canvas.canvasId };
}

const REMOTE = Symbol('test-remote');
function toBytes(d: RawData): Uint8Array { return Array.isArray(d) ? Buffer.concat(d) : Buffer.isBuffer(d) ? d : Buffer.from(d as ArrayBuffer); }

/** A minimal Yjs sync client mirroring the server protocol. */
function client(cookie: string, canvasId: string): { doc: Y.Doc; ws: WebSocket } {
  const doc = new Y.Doc();
  const ws = new WebSocket(`${WSBASE}/v1/host/openwop-app/canvas-collab/${canvasId}`, { headers: { cookie, origin: ORIGIN } });
  ws.on('open', () => { const e = encoding.createEncoder(); encoding.writeVarUint(e, 0); writeSyncStep1(e, doc); ws.send(encoding.toUint8Array(e)); });
  ws.on('message', (data) => {
    const dec = decoding.createDecoder(toBytes(data));
    if (decoding.readVarUint(dec) !== 0) return; // only sync in this test
    const e = encoding.createEncoder(); encoding.writeVarUint(e, 0);
    readSyncMessage(dec, e, doc, REMOTE);
    if (encoding.length(e) > 1) ws.send(encoding.toUint8Array(e));
  });
  doc.on('update', (u: Uint8Array, origin: unknown) => {
    if (origin === REMOTE || ws.readyState !== ws.OPEN) return;
    const e = encoding.createEncoder(); encoding.writeVarUint(e, 0); writeUpdate(e, u); ws.send(encoding.toUint8Array(e));
  });
  return { doc, ws };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms = 4000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await sleep(25); }
  return pred();
}
const opened = (ws: WebSocket) => new Promise<void>((res) => (ws.readyState === ws.OPEN ? res() : ws.on('open', () => res())));

describe('collab CRDT sync (ADR 0335 Phase 1b-i)', () => {
  it('converges an edit from one client to another', async () => {
    const { cookie, canvasId } = await loginAndDoc();
    const a = client(cookie, canvasId); const b = client(cookie, canvasId);
    await Promise.all([opened(a.ws), opened(b.ws)]);
    a.doc.getText('t').insert(0, 'hello collab');
    const ok = await waitFor(() => b.doc.getText('t').toString() === 'hello collab');
    expect(ok).toBe(true);
    a.ws.close(); b.ws.close();
  });

  it('persists the snapshot and restores it into a fresh room', async () => {
    const { cookie, canvasId } = await loginAndDoc();
    const a = client(cookie, canvasId);
    await opened(a.ws);
    a.doc.getText('t').insert(0, 'durable text');
    await sleep(2300);        // let the 2s debounced save fire
    a.ws.close();
    await sleep(200);
    __resetCollabRooms();     // drop the in-memory room; the snapshot remains
    const c = client(cookie, canvasId);
    await opened(c.ws);
    const ok = await waitFor(() => c.doc.getText('t').toString() === 'durable text');
    expect(ok).toBe(true);
    c.ws.close();
  }, 12000);
});
