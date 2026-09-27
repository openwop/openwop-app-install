/**
 * ADR 0335 Phase 1b-ii — cross-instance fan-out (signal-not-payload). Simulates a
 * fan-out notification arriving from ANOTHER instance and asserts it is applied
 * to the local room + relayed to a connected client; and that a notification
 * bearing THIS instance's own origin id is skipped (echo guard). The real
 * transport (storage pub/sub / Postgres LISTEN-NOTIFY) is exercised in-process on
 * memory storage; the two-instance path is simulated via the test hooks.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { WebSocket, type RawData } from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { readSyncMessage, writeSyncStep1 } from 'y-protocols/sync';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { attachCollabWebSocket, __resetCollabConns } from '../src/host/collab/collabServer.js';
import { __resetCollabRooms, __deliverFanout, __putFanoutUpdate, __collabInstanceId, sweepOrphanedCollabUpdates, __stopCollabLeaseHeartbeat, __stopCollabUpdateSweep } from '../src/host/collab/collabRoom.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createCanvasForTenant } from '../src/host/canvasSurface.js';

const ORIGIN = 'http://localhost:9990';
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
  const tenantId = `org:fan-${Date.now()}-${n++}`;
  const res = await fetch(`${BASE}/v1/host/openwop-app/test/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: `fan-${Date.now()}-${n++}@a.test`, tenantId }) });
  let cookie = ''; for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
  const canvas = await createCanvasForTenant(tenantId, { canvasTypeId: 'canvas.document', name: 'D', initialState: { title: 'D', content: { type: 'doc', content: [] } } });
  return { cookie, canvasId: canvas.canvasId };
}

const REMOTE = Symbol('t');
function toBytes(d: RawData): Uint8Array { return Array.isArray(d) ? Buffer.concat(d) : Buffer.isBuffer(d) ? d : Buffer.from(d as ArrayBuffer); }
function client(cookie: string, canvasId: string): { doc: Y.Doc; ws: WebSocket } {
  const doc = new Y.Doc();
  const ws = new WebSocket(`${WSBASE}/v1/host/openwop-app/canvas-collab/${canvasId}`, { headers: { cookie, origin: ORIGIN } });
  ws.on('open', () => { const e = encoding.createEncoder(); encoding.writeVarUint(e, 0); writeSyncStep1(e, doc); ws.send(encoding.toUint8Array(e)); });
  ws.on('message', (data) => { const dec = decoding.createDecoder(toBytes(data)); if (decoding.readVarUint(dec) !== 0) return; const e = encoding.createEncoder(); encoding.writeVarUint(e, 0); readSyncMessage(dec, e, doc, REMOTE); if (encoding.length(e) > 1) ws.send(encoding.toUint8Array(e)); });
  return { doc, ws };
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function waitFor(pred: () => boolean, ms = 4000): Promise<boolean> { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await sleep(25); } return pred(); }
const opened = (ws: WebSocket) => new Promise<void>((res) => (ws.readyState === ws.OPEN ? res() : ws.on('open', () => res())));

/** A Yjs update from a hypothetical peer instance. */
function peerUpdate(text: string): Uint8Array { const d = new Y.Doc(); d.getText('t').insert(0, text); return Y.encodeStateAsUpdate(d); }

describe('collab fan-out (ADR 0335 Phase 1b-ii)', () => {
  it('applies a peer-instance update and relays it to a local client', async () => {
    const { cookie, canvasId } = await loginAndDoc();
    const a = client(cookie, canvasId);
    await opened(a.ws);
    await sleep(100); // initial sync settles
    const updateId = randomUUID();
    await __putFanoutUpdate(updateId, canvasId, peerUpdate('hi from instance 2'));
    await __deliverFanout(JSON.stringify({ canvasId, updateId, originId: 'other-instance' }));
    const ok = await waitFor(() => a.doc.getText('t').toString() === 'hi from instance 2');
    expect(ok).toBe(true);
    a.ws.close();
  });

  it('skips a notification bearing this instance\'s own origin id (echo guard)', async () => {
    const { cookie, canvasId } = await loginAndDoc();
    const a = client(cookie, canvasId);
    await opened(a.ws);
    await sleep(100);
    const updateId = randomUUID();
    await __putFanoutUpdate(updateId, canvasId, peerUpdate('should not apply'));
    await __deliverFanout(JSON.stringify({ canvasId, updateId, originId: __collabInstanceId() }));
    await sleep(300);
    expect(a.doc.getText('t').toString()).toBe(''); // own-origin update ignored
    a.ws.close();
  });
});

describe('orphaned collab:update sweep (ADR 0359 Phase 1)', () => {
  it('prunes rows older than the orphan age and leaves fresh rows', async () => {
    const canvasId = `sweep-${randomUUID()}`;
    await __putFanoutUpdate(randomUUID(), canvasId, peerUpdate('old-1'));
    await __putFanoutUpdate(randomUUID(), canvasId, peerUpdate('old-2'));
    // Two minutes in the future ⇒ both rows exceed 2× FANOUT_PRUNE_MS (60 s).
    expect(await sweepOrphanedCollabUpdates(Date.now() + 120_000)).toBeGreaterThanOrEqual(2);
    await __putFanoutUpdate(randomUUID(), canvasId, peerUpdate('fresh'));
    expect(await sweepOrphanedCollabUpdates(Date.now())).toBe(0); // fresh row survives
  });
});
