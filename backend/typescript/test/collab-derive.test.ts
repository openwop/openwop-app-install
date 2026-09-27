/**
 * ADR 0359 Phase 6 / D6 — durable-authority parity. Pins:
 *  - the state↔Y mirror round-trip (element shapes incl. nested trees);
 *  - the XmlFragment → ProseMirror JSON converter (marks, attrs, empty ⇒ null);
 *  - room-close derives host.canvas (capturedBy 'collab' version provenance);
 *  - an EXTERNAL write to a live element room APPLIES into the room (the
 *    connected client converges on the new state);
 *  - an external write to a live `canvas.document` room is a typed 409
 *    `canvas_room_live`;
 *  - an external write with NO live room INVALIDATES the CRDT store (snapshot
 *    pruned + seed re-claimable — host.canvas is the authority again).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket, type RawData } from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { readSyncMessage, writeSyncStep1 } from 'y-protocols/sync';
import { getSetCookies } from './headerCookies.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { attachCollabWebSocket, __resetCollabConns, claimCollabSeed, __resetCollabSeedClaims } from '../src/host/collab/collabServer.js';
import { __resetCollabRooms, hasCollabSnapshot, hasLiveRoomGlobal, __deliverExtWrite, __putCollabLease, __clearCollabLeases, sweepOrphanedCollabUpdates, __stopCollabLeaseHeartbeat, __stopCollabUpdateSweep } from '../src/host/collab/collabRoom.js';
import { deleteCanvasForTenant } from '../src/host/canvasSurface.js';
import { replaceRootFromState, defaultDeriveState, type CollabShape } from '../src/host/collab/collabStateMirror.js';
import { pmDocFromYFragment, deriveDocumentState } from '../src/features/document-editor/pmFromY.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createCanvasForTenant, getCanvasForTenant, updateCanvasForTenant, listCanvasVersions } from '../src/host/canvasSurface.js';

const ORIGIN = 'http://localhost:9981';
let BASE: string; let WSBASE: string; let server: http.Server;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  process.env.OPENWOP_CORS_ORIGINS = ORIGIN;
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => {
    const port = (server.address() as AddressInfo).port;
    BASE = `http://127.0.0.1:${port}`; WSBASE = `ws://127.0.0.1:${port}`;
    res();
  }); });
  attachCollabWebSocket(server);
  for (const id of ['realtime-collab', 'drawings', 'document-editor']) {
    const d = getToggleDefault(id); if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
});
afterAll(async () => { __stopCollabLeaseHeartbeat(); __stopCollabUpdateSweep(); __resetCollabRooms(); __resetCollabConns(); delete process.env.OPENWOP_CORS_ORIGINS; await new Promise<void>((res) => server.close(() => res())); });

let n = 0;
async function login(): Promise<{ cookie: string; tenantId: string }> {
  const tenantId = `org:derive-${Date.now()}-${n++}`;
  const res = await fetch(`${BASE}/v1/host/openwop-app/test/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: `derive-${Date.now()}-${n++}@acme.test`, tenantId }),
  });
  expect(res.status).toBe(201);
  let cookie = ''; for (const ck of getSetCookies(res.headers) as string[]) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
  return { cookie, tenantId };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => Promise<boolean>, ms = 6000): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return; await sleep(100); }
  throw new Error('condition not reached');
}

function toBytes(d: RawData): Uint8Array { return Array.isArray(d) ? Buffer.concat(d) : Buffer.isBuffer(d) ? d : Buffer.from(d as ArrayBuffer); }
const RELAY = Symbol('t');
/** A minimal Yjs sync client mirroring the server protocol. */
function client(cookie: string, canvasId: string): { doc: Y.Doc; ws: WebSocket; opened: Promise<void> } {
  const doc = new Y.Doc();
  const ws = new WebSocket(`${WSBASE}/v1/host/openwop-app/canvas-collab/${canvasId}`, { headers: { cookie, origin: ORIGIN } });
  const opened = new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
  ws.on('open', () => { const e = encoding.createEncoder(); encoding.writeVarUint(e, 0); writeSyncStep1(e, doc); ws.send(encoding.toUint8Array(e)); });
  ws.on('message', (data) => { const dec = decoding.createDecoder(toBytes(data)); if (decoding.readVarUint(dec) !== 0) return; const e = encoding.createEncoder(); encoding.writeVarUint(e, 0); readSyncMessage(dec, e, doc, RELAY); if (encoding.length(e) > 1) ws.send(encoding.toUint8Array(e)); });
  doc.on('update', (u: Uint8Array, origin: unknown) => {
    if (origin === RELAY) return;
    const e = encoding.createEncoder(); encoding.writeVarUint(e, 0);
    encoding.writeVarUint(e, 2); // messageYjsUpdate
    encoding.writeVarUint8Array(e, u);
    if (ws.readyState === ws.OPEN) ws.send(encoding.toUint8Array(e));
  });
  return { doc, ws, opened };
}


describe('collabStateMirror (unit)', () => {
  it('round-trips element + nested-tree states', () => {
    const ydoc = new Y.Doc();
    const state = { title: 'T', slides: [{ id: 's1', name: 'One', blocks: [{ type: 'text', props: { v: 1 }, children: [{ type: 'leaf' }] }] }], theme: { accent: 'x' } };
    const shape: CollabShape = { collections: [{ key: 'slides', nested: { field: 'blocks', childrenKey: 'children' } }] };
    ydoc.transact(() => replaceRootFromState(ydoc.getMap<unknown>('doc'), shape, state));
    expect(defaultDeriveState(ydoc)).toEqual(state);
    // A second replace fully supersedes (no residue keys).
    ydoc.transact(() => replaceRootFromState(ydoc.getMap<unknown>('doc'), shape, { title: 'U', slides: [] }));
    expect(defaultDeriveState(ydoc)).toEqual({ title: 'U', slides: [] });
  });
});

describe('pmFromY (unit)', () => {
  it('converts elements, attrs, and marked text runs; empty fragment ⇒ null', () => {
    const ydoc = new Y.Doc();
    const frag = ydoc.getXmlFragment('doc');
    expect(pmDocFromYFragment(frag)).toBeNull();
    ydoc.transact(() => {
      const p = new Y.XmlElement('paragraph');
      const t = new Y.XmlText();
      t.insert(0, 'plain ');
      t.insert(6, 'bold', { bold: {} });
      t.insert(10, 'link', { link: { href: 'https://x.test' } });
      p.insert(0, [t]);
      const h = new Y.XmlElement('heading');
      h.setAttribute('level', '2');
      frag.insert(0, [p, h]);
    });
    expect(pmDocFromYFragment(frag)).toEqual({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [
          { type: 'text', text: 'plain ' },
          { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
          { type: 'text', text: 'link', marks: [{ type: 'link', attrs: { href: 'https://x.test' } }] },
        ] },
        { type: 'heading', attrs: { level: '2' } },
      ],
    });
    // deriveDocumentState preserves the current title.
    const derived = deriveDocumentState(ydoc, { title: 'Kept', content: { old: true } });
    expect(derived?.title).toBe('Kept');
    expect((derived?.content as { type?: string })?.type).toBe('doc');
  });
});

describe('derive + external writes (route-level)', () => {
  it('room close derives host.canvas with capturedBy \'collab\' provenance', async () => {
    const { cookie, tenantId } = await login();
    const canvas = await createCanvasForTenant(tenantId, { canvasTypeId: 'canvas.drawing', name: 'D', initialState: { title: 'D', shapes: [] } });
    const c = client(cookie, canvas.canvasId);
    await c.opened;
    // Win the seed election (as the chassis would) and seed the room.
    expect(await claimCollabSeed(tenantId, canvas.canvasId, 'u1')).toBe(true);
    c.doc.transact(() => {
      const root = c.doc.getMap<unknown>('doc');
      root.set('title', 'Live edited');
      const shapes = new Y.Array();
      const rect = new Y.Map<unknown>();
      rect.set('kind', 'rect'); rect.set('x', 10); rect.set('y', 10); rect.set('width', 100); rect.set('height', 50);
      shapes.insert(0, [rect]);
      root.set('shapes', shapes);
    });
    await sleep(300); // let the update reach the server room
    c.ws.close();
    await until(async () => (await getCanvasForTenant(tenantId, canvas.canvasId))?.state.title === 'Live edited');
    const versions = await listCanvasVersions(tenantId, canvas.canvasId);
    expect(versions.some((v) => v.capturedBy === 'collab')).toBe(true);
  });

  it('an external write to a LIVE element room applies into the room (client converges)', async () => {
    const { cookie, tenantId } = await login();
    const canvas = await createCanvasForTenant(tenantId, { canvasTypeId: 'canvas.drawing', name: 'D', initialState: { title: 'D', shapes: [] } });
    const c = client(cookie, canvas.canvasId);
    await c.opened;
    await sleep(200);
    const res = await updateCanvasForTenant(tenantId, canvas.canvasId, { title: 'AI applied', shapes: [{ kind: 'rect', x: 1, y: 2, w: 3, h: 4 }] });
    expect(res?.newVersion).toBeGreaterThan(1);
    await until(async () => c.doc.getMap<unknown>('doc').get('title') === 'AI applied');
    const shapes = c.doc.getMap<unknown>('doc').get('shapes');
    expect(shapes instanceof Y.Array && (shapes as Y.Array<unknown>).length === 1).toBe(true);
    c.ws.close();
    // Consume the eviction derive so the suite tears down cleanly.
    await until(async () => (await getCanvasForTenant(tenantId, canvas.canvasId)) !== null);
  });

  it('an external write to a LIVE canvas.document room is a typed 409 canvas_room_live', async () => {
    const { cookie, tenantId } = await login();
    const canvas = await createCanvasForTenant(tenantId, { canvasTypeId: 'canvas.document', name: 'Doc', initialState: { title: 'Doc', content: { type: 'doc', content: [] } } });
    const c = client(cookie, canvas.canvasId);
    await c.opened;
    await sleep(200);
    await expect(updateCanvasForTenant(tenantId, canvas.canvasId, { title: 'clobber', content: { type: 'doc', content: [] } }))
      .rejects.toMatchObject({ code: 'canvas_room_live', httpStatus: 409 });
    c.ws.close();
    await sleep(200);
  });

  it('an external write with NO live room invalidates the CRDT store (snapshot pruned, seed re-claimable)', async () => {
    await __resetCollabSeedClaims();
    const { cookie, tenantId } = await login();
    const canvas = await createCanvasForTenant(tenantId, { canvasTypeId: 'canvas.document', name: 'Doc', initialState: { title: 'Doc', content: { type: 'doc', content: [] } } });
    const c = client(cookie, canvas.canvasId);
    await c.opened;
    expect(await claimCollabSeed(tenantId, canvas.canvasId, 'u1')).toBe(true);
    c.doc.transact(() => { c.doc.getXmlFragment('doc').insert(0, [new Y.XmlElement('paragraph')]); });
    await sleep(300);
    c.ws.close();
    await until(() => hasCollabSnapshot(canvas.canvasId)); // final flush persisted
    // Grade pass B1 — liveness is now GLOBAL (lease store); evict releases it.
    await until(async () => !(await hasLiveRoomGlobal(canvas.canvasId)));
    const res = await updateCanvasForTenant(tenantId, canvas.canvasId, { title: 'External', content: { type: 'doc', content: [{ type: 'paragraph' }] } });
    expect(res).not.toBeNull();
    await until(async () => !(await hasCollabSnapshot(canvas.canvasId)));
    expect(await claimCollabSeed(tenantId, canvas.canvasId, 'u2')).toBe(true); // re-claimable ⇒ fresh re-seed
  });
});

describe('grade-pass remediations (ADR 0359 B1/B2/I4/I5)', () => {
  it('B1: a foreign-instance lease vetoes an external document write (409) with NO local room', async () => {
    await __clearCollabLeases();
    const { tenantId } = await login();
    const canvas = await createCanvasForTenant(tenantId, { canvasTypeId: 'canvas.document', name: 'Doc', initialState: { title: 'Doc', content: { type: 'doc', content: [] } } });
    await __putCollabLease(canvas.canvasId, 'other-instance', 60_000);
    await expect(updateCanvasForTenant(tenantId, canvas.canvasId, { title: 'x', content: { type: 'doc', content: [] } }))
      .rejects.toMatchObject({ code: 'canvas_room_live' });
    await __clearCollabLeases();
    // Expired lease ⇒ no veto; the write proceeds (and invalidates nothing — no snapshot).
    await __putCollabLease(canvas.canvasId, 'other-instance', -1);
    expect(await updateCanvasForTenant(tenantId, canvas.canvasId, { title: 'y', content: { type: 'doc', content: [] } })).not.toBeNull();
    await __clearCollabLeases();
  });

  it('B1: an extwrite notification applies host.canvas into a LOCAL room (peer-instance path)', async () => {
    const { cookie, tenantId } = await login();
    const canvas = await createCanvasForTenant(tenantId, { canvasTypeId: 'canvas.drawing', name: 'D', initialState: { title: 'D', shapes: [] } });
    const c = client(cookie, canvas.canvasId);
    await c.opened;
    await sleep(200);
    // The write lands durably first (as it would via another instance's hook)…
    await updateCanvasForTenant(tenantId, canvas.canvasId, { title: 'From B', shapes: [] });
    // …then the peer signal arrives with a FOREIGN origin id.
    await __deliverExtWrite(JSON.stringify({ canvasId: canvas.canvasId, originId: 'other-instance' }));
    await until(async () => c.doc.getMap<unknown>('doc').get('title') === 'From B');
    c.ws.close();
    await sleep(300);
  });

  it('B2: deleteCanvasForTenant itself fires the cascade (Documents-browser delete path)', async () => {
    await __resetCollabSeedClaims();
    const { tenantId } = await login();
    const canvas = await createCanvasForTenant(tenantId, { canvasTypeId: 'canvas.document', name: 'Doc', initialState: { title: 'Doc', content: { type: 'doc', content: [] } } });
    expect(await claimCollabSeed(tenantId, canvas.canvasId, 'u1')).toBe(true);
    // The Documents-browser route calls deleteCanvasForTenant WITHOUT firing the
    // lifecycle seam — the seam now lives inside the delete owner.
    expect(await deleteCanvasForTenant(tenantId, canvas.canvasId)).toBe(true);
    expect(await claimCollabSeed(tenantId, canvas.canvasId, 'u2')).toBe(true); // pruned ⇒ re-claimable
  });

  it('I5: consecutive collab auto-derive versions collapse (only the latest survives)', async () => {
    const { tenantId } = await login();
    const canvas = await createCanvasForTenant(tenantId, { canvasTypeId: 'canvas.drawing', name: 'D', initialState: { title: 'D', shapes: [] } });
    // Two consecutive derive-style writes with collab provenance…
    const r1 = await updateCanvasForTenant(tenantId, canvas.canvasId, { title: 'v1', shapes: [] }, { merge: 'replace', snapshot: { capturedBy: 'collab', force: true }, source: 'collab' });
    const { pruneConsecutiveCollabVersions } = await import('../src/host/canvasSurface.js');
    const r2 = await updateCanvasForTenant(tenantId, canvas.canvasId, { title: 'v2', shapes: [] }, { merge: 'replace', snapshot: { capturedBy: 'collab', force: true }, source: 'collab' });
    if (r2) await pruneConsecutiveCollabVersions(tenantId, canvas.canvasId, r2.newVersion);
    const versions = await listCanvasVersions(tenantId, canvas.canvasId);
    const collabVersions = versions.filter((v) => v.capturedBy === 'collab');
    expect(collabVersions.length).toBe(1);
    expect(collabVersions[0]?.version).toBe(r2?.newVersion);
    expect(r1).not.toBeNull();
  });

  it('I4: the eviction compaction round-trips the document (gc\'d snapshot still materializes)', async () => {
    await __resetCollabSeedClaims();
    const { cookie, tenantId } = await login();
    const canvas = await createCanvasForTenant(tenantId, { canvasTypeId: 'canvas.drawing', name: 'D', initialState: { title: 'D', shapes: [] } });
    const c = client(cookie, canvas.canvasId);
    await c.opened;
    expect(await claimCollabSeed(tenantId, canvas.canvasId, 'u1')).toBe(true);
    c.doc.transact(() => {
      const root = c.doc.getMap<unknown>('doc');
      root.set('title', 'Churn');
      const shapes = new Y.Array();
      const rect = new Y.Map<unknown>();
      rect.set('kind', 'rect'); rect.set('x', 1); rect.set('y', 1); rect.set('width', 10); rect.set('height', 10);
      shapes.insert(0, [rect]);
      root.set('shapes', shapes);
    });
    // Churn: repeated set/delete builds tombstones the compaction should drop.
    for (let i = 0; i < 20; i++) c.doc.transact(() => c.doc.getMap<unknown>('doc').set('title', `Churn ${i}`));
    await sleep(300);
    c.ws.close(); // evict ⇒ compacted persist + forced derive
    await until(async () => (await getCanvasForTenant(tenantId, canvas.canvasId))?.state.title === 'Churn 19');
    // Reopen: the compacted snapshot restores into a fresh room and syncs back.
    const c2 = client(cookie, canvas.canvasId);
    await c2.opened;
    await until(async () => c2.doc.getMap<unknown>('doc').get('title') === 'Churn 19');
    c2.ws.close();
    await sleep(200);
  });
});

describe('grade-pass code findings (CODE-1/3/7)', () => {
  it('CODE-1: two CONCURRENT first-opens share one room — edits converge (init-race regression)', async () => {
    const { cookie, tenantId } = await login();
    const canvas = await createCanvasForTenant(tenantId, { canvasTypeId: 'canvas.drawing', name: 'D', initialState: { title: 'D', shapes: [] } });
    // No await between the two connects — both joins race loadRoom's async init.
    const cA = client(cookie, canvas.canvasId);
    const cB = client(cookie, canvas.canvasId);
    await Promise.all([cA.opened, cB.opened]);
    await sleep(250);
    cA.doc.transact(() => { cA.doc.getMap<unknown>('doc').set('title', 'from-A'); });
    await until(async () => cB.doc.getMap<unknown>('doc').get('title') === 'from-A');
    cA.ws.close(); cB.ws.close();
    await sleep(300);
  });

  it('CODE-3: the heartbeat publishes anti-entropy full state when a PEER instance holds a lease', async () => {
    await __clearCollabLeases();
    const { cookie, tenantId } = await login();
    const canvas = await createCanvasForTenant(tenantId, { canvasTypeId: 'canvas.drawing', name: 'D', initialState: { title: 'D', shapes: [] } });
    const c = client(cookie, canvas.canvasId);
    await c.opened;
    await sleep(200);
    // Drain any rows already in flight so the assertion isolates the heartbeat.
    await sweepOrphanedCollabUpdates(Date.now() + 600_000);
    const { __runCollabHeartbeatOnce } = await import('../src/host/collab/collabRoom.js');
    // No peers ⇒ no anti-entropy row.
    await __runCollabHeartbeatOnce();
    expect(await sweepOrphanedCollabUpdates(Date.now() + 600_000)).toBe(0);
    // A live peer lease on another instance ⇒ the heartbeat ships full state.
    await __putCollabLease(canvas.canvasId, 'other-instance', 60_000);
    await __runCollabHeartbeatOnce();
    expect(await sweepOrphanedCollabUpdates(Date.now() + 600_000)).toBeGreaterThanOrEqual(1);
    await __clearCollabLeases();
    c.ws.close();
    await sleep(200);
  });

  it('CODE-7: the _debug surface is superadmin-only (403 for a normal member)', async () => {
    const { cookie } = await login();
    const res = await fetch(`${BASE}/v1/host/openwop-app/canvas-collab/_debug`, { headers: { cookie } });
    expect(res.status).toBe(403);
  });
});

describe('residuals pass (COLLAB-5 convergent snapshots)', () => {
  it('a CAS-raced snapshot save MERGES the winner and re-persists the superset (no LWW clobber)', async () => {
    await __resetCollabSeedClaims();
    const { cookie, tenantId } = await login();
    const canvas = await createCanvasForTenant(tenantId, { canvasTypeId: 'canvas.drawing', name: 'D', initialState: { title: 'D', shapes: [] } });
    const c = client(cookie, canvas.canvasId);
    await c.opened;
    expect(await claimCollabSeed(tenantId, canvas.canvasId, 'u1')).toBe(true);
    c.doc.transact(() => {
      const root = c.doc.getMap<unknown>('doc');
      root.set('title', 'ours');
      root.set('shapes', new Y.Array());
    });
    await sleep(300); // room applied + first debounced persist may run
    // Simulate ANOTHER INSTANCE persisting a divergent superset directly under us:
    // a doc that shares history (from the room's current state) plus its own field.
    const { hasCollabSnapshot: _h, __putCollabSnapshotRaw } = await import('../src/host/collab/collabRoom.js');
    void _h;
    const foreign = new Y.Doc();
    // Fabricate a state the room does NOT have: an independent doc with one field.
    foreign.getMap<unknown>('doc').set('foreignField', 'from-other-instance');
    await __putCollabSnapshotRaw(canvas.canvasId, Buffer.from(Y.encodeStateAsUpdate(foreign)).toString('base64'), tenantId);
    // Our next local edit triggers a persist whose CAS now MISSES → merge + re-persist.
    c.doc.transact(() => { c.doc.getMap<unknown>('doc').set('title', 'ours-2'); });
    // Converged: the client eventually receives the foreign field (merge relayed
    // to local sockets), and the DURABLE snapshot holds BOTH writers' content.
    await until(async () => c.doc.getMap<unknown>('doc').get('foreignField') === 'from-other-instance', 8000);
    await until(async () => {
      const { __getCollabSnapshotRaw } = await import('../src/host/collab/collabRoom.js');
      const raw = await __getCollabSnapshotRaw(canvas.canvasId);
      if (!raw) return false;
      const probe = new Y.Doc();
      Y.applyUpdate(probe, Buffer.from(raw, 'base64'));
      const m = probe.getMap<unknown>('doc');
      const ok = m.get('foreignField') === 'from-other-instance' && m.get('title') === 'ours-2';
      probe.destroy();
      return ok;
    }, 8000);
    c.ws.close();
    await sleep(300);
  });

  it('a validator-loaded snapshot row CASes cleanly (raw-JSON field-order pin)', async () => {
    const { __putCollabSnapshotRaw, __getCollabSnapshotRow, __casCollabSnapshotForTest } = await import('../src/host/collab/collabRoom.js');
    const canvasId = `cas-pin-${Date.now()}`;
    await __putCollabSnapshotRaw(canvasId, Buffer.from('x').toString('base64'), 'org:pin');
    const loaded = await __getCollabSnapshotRow(canvasId);
    expect(loaded).not.toBeNull();
    // The validator-reconstructed object must be byte-identical to the stored
    // raw — a field-order drift here would fail EVERY convergent swap.
    expect(await __casCollabSnapshotForTest(loaded, { ...loaded!, updatedAt: new Date().toISOString() })).toBe(true);
  });
});

describe('grade-pass 3 (data F1/F3)', () => {
  it('F1: an invalidation racing a LIVE shaped room does not resurrect stale state — the external write is re-applied, lease + claim restored', async () => {
    await __resetCollabSeedClaims();
    const { __deleteCollabSnapshotRow, __clearCollabLeases: clearL } = await import('../src/host/collab/collabRoom.js');
    await clearL();
    const { cookie, tenantId } = await login();
    const canvas = await createCanvasForTenant(tenantId, { canvasTypeId: 'canvas.drawing', name: 'D', initialState: { title: 'D', shapes: [] } });
    const c = client(cookie, canvas.canvasId);
    await c.opened;
    expect(await claimCollabSeed(tenantId, canvas.canvasId, 'u1')).toBe(true);
    c.doc.transact(() => {
      const root = c.doc.getMap<unknown>('doc');
      root.set('title', 'stale-crdt');
      root.set('shapes', new Y.Array());
    });
    await until(() => hasCollabSnapshot(canvas.canvasId)); // first persist landed
    // Simulate the invalidation (external write while our lease looked stale):
    // host.canvas got the external content; snapshot + claim were pruned.
    await updateCanvasForTenant(tenantId, canvas.canvasId, { title: 'external-authority', shapes: [] }, { merge: 'replace', source: 'collab' }); // source bypass = raw store write, no hooks
    await __deleteCollabSnapshotRow(canvas.canvasId);
    await __resetCollabSeedClaims();
    await clearL();
    // Our next edit → persist CAS-misses on the vanished row → the guard runs.
    c.doc.transact(() => { c.doc.getMap<unknown>('doc').set('shapes', new Y.Array()); });
    // The room re-applies host.canvas (the external write wins), restores the
    // lease, restores the claim, and only then re-inserts.
    await until(async () => c.doc.getMap<unknown>('doc').get('title') === 'external-authority', 8000);
    await until(() => hasCollabSnapshot(canvas.canvasId), 8000);
    expect(await hasLiveRoomGlobal(canvas.canvasId)).toBe(true);           // lease restored
    expect(await claimCollabSeed(tenantId, canvas.canvasId, 'u2')).toBe(false); // claim restored — no double-seed
    c.ws.close();
    await sleep(300);
  });

  it('F3: a tenantId-ABSENT snapshot row CASes cleanly too (legacy-shape field-order pin)', async () => {
    const { __putCollabSnapshotRaw, __getCollabSnapshotRow, __casCollabSnapshotForTest } = await import('../src/host/collab/collabRoom.js');
    const canvasId = `cas-pin-untagged-${Date.now()}`;
    // The pre-B3 legacy shape: no tenant field at all.
    await __putCollabSnapshotRaw(canvasId, Buffer.from('x').toString('base64'));
    const loaded = await __getCollabSnapshotRow(canvasId);
    expect(loaded).not.toBeNull();
    expect(loaded?.tenantId).toBeUndefined();
    expect(await __casCollabSnapshotForTest(loaded, { ...loaded!, updatedAt: new Date().toISOString() })).toBe(true);
  });
});

describe('grade-pass 3b (code findings 1/2/5)', () => {
  it('converged CAS miss SKIPS the merge/reschedule (adopts the winner, stays clean)', async () => {
    await __resetCollabSeedClaims();
    const { __persistRoomForTest, __getCollabSnapshotRow, __putCollabSnapshotRaw } = await import('../src/host/collab/collabRoom.js');
    const { cookie, tenantId } = await login();
    const canvas = await createCanvasForTenant(tenantId, { canvasTypeId: 'canvas.drawing', name: 'D', initialState: { title: 'D', shapes: [] } });
    const c = client(cookie, canvas.canvasId);
    await c.opened;
    expect(await claimCollabSeed(tenantId, canvas.canvasId, 'u1')).toBe(true);
    c.doc.transact(() => {
      const root = c.doc.getMap<unknown>('doc');
      root.set('title', 'converged');
      root.set('shapes', new Y.Array());
    });
    await until(() => hasCollabSnapshot(canvas.canvasId)); // baseline persisted
    const mine = await __getCollabSnapshotRow(canvas.canvasId);
    expect(mine).not.toBeNull();
    // A peer instance re-writes the SAME state (fan-out already converged us) —
    // only updatedAt differs, so our baseline CAS will miss.
    await __putCollabSnapshotRaw(canvas.canvasId, mine!.state, tenantId);
    const theirs = await __getCollabSnapshotRow(canvas.canvasId);
    expect(theirs?.updatedAt).not.toBe(mine!.updatedAt);
    // The next persist pass must ADOPT theirs without writing (converged skip):
    await __persistRoomForTest(canvas.canvasId);
    const after = await __getCollabSnapshotRow(canvas.canvasId);
    expect(after?.updatedAt).toBe(theirs?.updatedAt); // we did NOT re-write
    c.ws.close();
    await sleep(300);
  });
});

describe('RTCC-2 / RTCC-3 — collab snapshot trust boundary (the derive gate is the durable choke)', () => {
  // The collab CRDT lane is schema-agnostic BY DESIGN: persist() stores the raw
  // Y.Doc update and buildRoom() re-seeds it faithfully (required for
  // Y.applyUpdate convergence + cross-instance CAS-merge). So a room joiner can
  // inject invalid/unknown-field state that persists to the snapshot + relays to
  // peers. The bounded-radius claim rests ENTIRELY on the derive→host.canvas gate
  // skipping invalid state; this pins that boundary (previously untested — RTCC-3).
  it('invalid CRDT state persists to the snapshot but the derive gate BLOCKS it from host.canvas', async () => {
    const { cookie, tenantId } = await login();
    const canvas = await createCanvasForTenant(tenantId, {
      canvasTypeId: 'canvas.drawing', name: 'D', initialState: { title: 'valid-original', shapes: [] },
    });
    const c = client(cookie, canvas.canvasId);
    await c.opened;
    expect(await claimCollabSeed(tenantId, canvas.canvasId, 'u1')).toBe(true);
    // Inject INVALID CRDT content: a shape with an unknown kind, which the
    // closed-world drawings validator (the SAME one the REST PATCH runs) rejects.
    c.doc.transact(() => {
      const root = c.doc.getMap<unknown>('doc');
      root.set('title', 'invalid-injected');
      const shapes = new Y.Array();
      const bad = new Y.Map<unknown>();
      bad.set('kind', 'hologram');
      shapes.insert(0, [bad]);
      root.set('shapes', shapes);
    });
    await sleep(300);
    c.ws.close(); // eviction: persist(snapshot) + derive(host.canvas)
    await until(() => hasCollabSnapshot(canvas.canvasId));

    // (1) SNAPSHOT lane is schema-agnostic — it faithfully carries the invalid state.
    const { __getCollabSnapshotRow } = await import('../src/host/collab/collabRoom.js');
    const row = await __getCollabSnapshotRow(canvas.canvasId);
    const snapDoc = new Y.Doc();
    Y.applyUpdate(snapDoc, Buffer.from(row!.state, 'base64'));
    expect((defaultDeriveState(snapDoc) as { title?: string }).title).toBe('invalid-injected');

    // (2) DURABLE CHOKE holds — the derive gate skipped the invalid state, so
    // host.canvas keeps its last VALID value; the invalid title never lands.
    await sleep(600); // let the eviction derive run (and skip)
    const durable = await getCanvasForTenant(tenantId, canvas.canvasId);
    expect(durable?.state.title).toBe('valid-original');
  });
});
