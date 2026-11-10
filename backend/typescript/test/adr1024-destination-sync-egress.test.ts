/**
 * ADR 1024 P1 — destination sync: who may change a sync, what may leave, where it may
 * go, and who may approve a warehouse load. Feature-loop row 73 (`CDP2WF-4/-5/-6/-16`).
 *
 * Each describe is one decision, and each is written so removing its mechanism fails it:
 *  D1 a Viewer reads syncs but cannot create, edit, delete, prepare or advance one, over
 *     HTTP or through the chat tools (before: the toggle was the only check);
 *  D2 `[]`, a malformed label and an erased subject never leave on ANY egress path (before:
 *     only the onward path dropped `[]`, and nothing checked erasure); a narrowTo that
 *     empties the label drops the envelope; the onward URL must be the sync's own;
 *  D3 a warehouse approval covers exactly its rows, a newer batch supersedes the old
 *     pending row, the inbox can decide it (before: 404 "Proposing agent no longer
 *     exists"), and the member who asked for the load cannot approve it.
 *
 * Red when (sabotage-witnessed in this PR, each applied and reverted in one step):
 *  - `requireWrite` → `requireRead` on POST/PATCH/DELETE/prepare/advance (routes.ts);
 *  - `toolGate(scope,'workspace:write')` → `'workspace:read'` in `runRunTool`;
 *  - `selectEligible` without the `isNoOnwardUse` / `isMalformedLabel` / `isErasedRecord` arm,
 *    or matching only the exact spelling (no `collectedIdentityForms` fold);
 *  - `buildOnwardEnvelopes` without the D2.3 `isNoOnwardUse(onward)` drop;
 *  - `prepareOnward` without the `destination_mismatch` comparison;
 *  - `warehouseBatchKey` without the rows digest (a changed batch is allowed);
 *  - `moveSlotTo` not superseding, or `supersede` keeping the old batch's map row;
 *  - `'warehouse-load'` mapped back to `'run-proposal'` (the inbox 404 returns);
 *  - the separation-of-duties `some(...)` check removed, or applied to reject too;
 *  - the decider's `workspace:write` check removed, or the reject lane's `outcome` unthreaded.
 * (w86) The race case holds the first load's batch-key read until the second has
 * read it too, so the insert-if-absent loser path really runs; a loser that
 * proceeds as a winner leaves two pending rows and the case goes red. The viewer
 * refusals assert their body, and D1 reads back that no refused write landed.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { HostAdapterSuite } from '../src/host/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createWorkspace, createMember } from '../src/host/accessControlService.js';
import { userIdFor } from '../src/features/users/usersService.js';
import { writeErasureTombstone } from '../src/features/consent/consentService.js';
import {
  buildOnwardEnvelopes,
  buildWarehouseRows,
  createDestinationSync,
  prepareSyncBatch,
} from '../src/features/destination-sync/destinationSyncService.js';
import { buildDestinationSyncSurface } from '../src/features/destination-sync/surface.js';
import { runListTool, runRunTool } from '../src/features/destination-sync/agentTools.js';
import { warehouseLoad, setWarehouseLoadStorage } from '../src/features/destination-sync/warehouseLoadService.js';
import { claimApproval, rejectApproval } from '../src/host/approvalDecision.js';
import { getApproval, listApprovals } from '../src/host/approvalService.js';
import { __resetGovernanceStore } from '../src/host/governanceService.js';
import type { BrokeredEgressDeps } from '../src/host/brokeredEgress.js';

let app: Awaited<ReturnType<typeof createApp>>;
let server: Server;
let BASE = '';
let storage: Storage;
let WS = '';
const OWNER = 'oidc:d1024-owner';
const EDITOR = 'oidc:d1024-editor';
const EDITOR2 = 'oidc:d1024-editor2';
const VIEWER = 'oidc:d1024-viewer';
const PEER = 'https://peer.example/host/openwop-app/trigger-bridge/ingest';

async function on(id: string): Promise<void> {
  const d = getToggleDefault(id);
  if (!d) throw new Error(`no toggle ${id}`);
  await saveConfig({ ...d, status: 'on' }, 'test');
}

async function login(subject: string): Promise<string> {
  const res = await fetch(`${BASE}/host/openwop-app/test/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ subject, tenantId: WS, displayName: subject, sharedWorkspace: true }),
  });
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

async function call(cookie: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${BASE}/host/openwop-app/destination-sync/syncs${path}`, {
    method, headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, body: res.status === 204 ? {} : ((await res.json().catch(() => ({}))) as Record<string, unknown>) };
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  storage = app.locals.storage as Storage;
  setWarehouseLoadStorage(storage);
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; r(); }); });
  for (const id of ['cdp', 'destination-sync']) await on(id);
  const ws = await createWorkspace({ name: 'ADR 1024 destination sync', ownerSubject: OWNER });
  WS = ws.orgId ?? ws.tenantId;
  await createMember({ orgId: WS, tenantId: WS, displayName: 'Editor', subject: userIdFor(WS, EDITOR), roles: ['editor'] });
  await createMember({ orgId: WS, tenantId: WS, displayName: 'Editor 2', subject: userIdFor(WS, EDITOR2), roles: ['editor'] });
  await createMember({ orgId: WS, tenantId: WS, displayName: 'Viewer', subject: userIdFor(WS, VIEWER), roles: ['viewer'] });
});

afterAll(async () => {
  delete process.env.OPENWOP_CDP_PURPOSE_PROPAGATION_ENABLED;
  await new Promise<void>((r) => server.close(() => r()));
});

describe('D1 — a Viewer reads syncs and changes none of them', () => {
  const body = { name: 'Webhook', destinationKind: 'webhook', sourceObject: 'contact', fieldMap: [{ from: 'email', to: 'e' }] };

  it('an editor creates, edits, prepares, advances and deletes; a viewer gets 403 on each write', async () => {
    const editor = await login(EDITOR);
    const viewer = await login(VIEWER);
    const created = await call(editor, 'POST', '', body);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = encodeURIComponent(String(created.body.syncId));

    // The read half stays open to a viewer.
    expect((await call(viewer, 'GET', '')).status).toBe(200);
    expect((await call(viewer, 'GET', `/${id}`)).status).toBe(200);
    expect((await call(viewer, 'POST', `/${id}/dry-run`, { sample: { email: 'a@x.test' } })).status).toBe(200);

    const writes: Array<[string, string, unknown]> = [
      ['POST', '', body],
      ['PATCH', `/${id}`, { name: 'renamed' }],
      ['POST', `/${id}/prepare`, { records: [] }],
      ['POST', `/${id}/advance`, { cursor: '2026-01-01' }],
      ['DELETE', `/${id}`, undefined],
    ];
    for (const [method, path, b] of writes) {
      const r = await call(viewer, method, path, b);
      expect(r.status, `${method} ${path} as a viewer`).toBe(403);
      expect(r.body.error, `${method} ${path} as a viewer`).toBe('forbidden_scope');
    }
    // None of the refused writes landed: the sync is still there, still named as created.
    const after = await call(editor, 'GET', `/${id}`);
    expect(after.status).toBe(200);
    expect(JSON.stringify(after.body)).toContain('"name":"Webhook"');
    expect(JSON.stringify(after.body)).not.toContain('renamed');
    // ...and every one of them still works for the editor.
    expect((await call(editor, 'PATCH', `/${id}`, { name: 'renamed' })).status).toBe(200);
    expect((await call(editor, 'POST', `/${id}/prepare`, { records: [] })).status).toBe(200);
    expect((await call(editor, 'POST', `/${id}/advance`, { cursor: '2026-01-01' })).status).toBe(200);
    expect((await call(editor, 'DELETE', `/${id}`)).status).toBe(204);
  });

  it('the chat tools run the same predicate: a viewer lists but cannot run a sync', async () => {
    const sync = await createDestinationSync({ tenantId: WS, ...body, name: 'Tool sync' });
    const viewerScope = { tenantId: WS, actingUserId: userIdFor(WS, VIEWER) };
    const listed = JSON.parse((await runListTool({}, viewerScope)).content) as { syncs: Array<{ syncId: string }> };
    expect(listed.syncs.some((s) => s.syncId === sync.syncId)).toBe(true);

    const deps = { storage, hostSuite: app.locals.hostSuite as HostAdapterSuite };
    const refused = await runRunTool(deps, { syncId: sync.syncId }, viewerScope);
    expect(refused.isError).toBe(true);
    expect(JSON.parse(refused.content).error).toBe('forbidden_scope');

    // An editor passes the gate and reaches the kind check (a webhook sync has no chat igniter).
    const editorRun = await runRunTool(deps, { syncId: sync.syncId }, { tenantId: WS, actingUserId: userIdFor(WS, EDITOR) });
    expect(JSON.parse(editorRun.content).error).toBe('unsupported_destination_kind');
  });
});

describe('D2 — nothing a label forbids, or an erasure removed, leaves on any path', () => {
  const T = 'tenant-1024-egress';
  const base = { tenantId: T, syncId: 'dsync:1024', syncMode: 'batch' as const, cursorField: 'updatedAt', fieldMap: [{ from: 'email', to: 'EMAIL' }], warehouseKeyField: 'email' };
  const records = [
    { email: 'keep@x.test', permittedPurposes: ['analytics'] },
    { email: 'unlabelled@x.test' }, // RFC 0128 §1: no constraint asserted → ships
    { email: 'none@x.test', permittedPurposes: [] }, // no onward use → dropped
    { email: 'garbled@x.test', permittedPurposes: 'analytics' }, // malformed → dropped
    { email: 'Erased@X.test', permittedPurposes: ['analytics'] }, // tombstoned (any case) → dropped
    { email: 'visitor@x.test', visitorId: 'VK-Erased-7', permittedPurposes: ['analytics'] }, // erased visitor key → dropped
  ];

  beforeAll(async () => {
    await writeErasureTombstone(T, 'erased@x.test');
    // A non-email identity is matched in the CDP's folded form too (the visitor index's rule).
    await writeErasureTombstone(T, 'vk-erased-7');
  });

  it('the warehouse rows, /prepare and the onward envelopes all drop the same four', async () => {
    const wh = await buildWarehouseRows(base, records);
    expect(wh.rows.map((r) => r.json.EMAIL)).toEqual(['keep@x.test', 'unlabelled@x.test']);
    expect(wh.dropped).toBe(4);

    const prep = await prepareSyncBatch(base, records);
    expect(prep.payloads).toEqual([{ EMAIL: 'keep@x.test' }, { EMAIL: 'unlabelled@x.test' }]);
    expect(prep.dropped).toBe(4);

    const onward = await buildOnwardEnvelopes(base, records);
    expect(onward.envelopes.map((e) => e.webhook.body.EMAIL)).toEqual(['keep@x.test', 'unlabelled@x.test']);
    expect(onward.dropped).toBe(4);
  });

  it('a narrowTo that leaves nothing in common drops the envelope instead of POSTing `[]`', async () => {
    const out = await buildOnwardEnvelopes({ ...base, narrowTo: ['advertising'] }, [{ email: 'a@x.test', permittedPurposes: ['analytics'] }]);
    expect(out.envelopes).toEqual([]);
    expect(out.dropped).toBe(1);
  });

  it('prepare-onward refuses a URL that is not the sync\'s own, and accepts its normalised form', async () => {
    process.env.OPENWOP_CDP_PURPOSE_PROPAGATION_ENABLED = 'true';
    try {
      const sync = await createDestinationSync({
        tenantId: T, name: 'Peer', destinationKind: 'openwop-host', sourceObject: 'contact',
        fieldMap: [{ from: 'email', to: 'e' }], connectionId: 'conn:peer', peerIngestUrl: PEER,
      });
      const surface = buildDestinationSyncSurface({ tenantId: T });
      const rec = [{ email: 'a@x.test', permittedPurposes: ['analytics'] }];
      expect((await surface.prepareOnward!({ syncId: sync.syncId, records: rec, peerIngestUrl: 'https://attacker.example/ingest' })).error).toBe('destination_mismatch');
      expect((await surface.prepareOnward!({ syncId: sync.syncId, records: rec })).error).toBe('destination_mismatch');
      const ok = await surface.prepareOnward!({ syncId: sync.syncId, records: rec, peerIngestUrl: `HTTPS://Peer.Example:443${new URL(PEER).pathname}/` });
      expect(ok.error).toBeUndefined();
      expect(ok.count).toBe(1);
    } finally {
      delete process.env.OPENWOP_CDP_PURPOSE_PROPAGATION_ENABLED;
    }
  });

  it('a peer URL carrying credentials or a query string is refused at create', async () => {
    for (const peerIngestUrl of ['https://user:pw@peer.example/ingest', 'https://peer.example/ingest?token=abc']) {
      await expect(createDestinationSync({
        tenantId: T, name: 'Bad peer', destinationKind: 'openwop-host', sourceObject: 'contact',
        fieldMap: [{ from: 'email', to: 'e' }], connectionId: 'conn:peer', peerIngestUrl,
      })).rejects.toMatchObject({ httpStatus: 400, message: '`peerIngestUrl` must not carry credentials or a query string; put the credential in the Connection.' });
    }
  });
});

describe('D3 — a warehouse approval is bound to its rows, decidable in the inbox, and not by its requester', () => {
  const recordsA = [{ id: 'c1', email: 'a@x.test' }, { id: 'c2', email: 'b@x.test' }];
  const recordsB = [{ id: 'c1', email: 'a@x.test' }, { id: 'c3', email: 'c@x.test' }];
  let syncId = '';
  const decideDeps = (): { storage: Storage; hostSuite: HostAdapterSuite } => ({ storage, hostSuite: app.locals.hostSuite as HostAdapterSuite });
  const loadDeps = (actingUserId: string): BrokeredEgressDeps => ({ storage, tenantId: WS, runId: '', actingUserId, orgId: WS });

  beforeAll(async () => {
    await __resetGovernanceStore(); // unset policy = approval-required
    const sync = await createDestinationSync({
      tenantId: WS, name: 'Warehouse', destinationKind: 'warehouse', sourceObject: 'contact',
      fieldMap: [{ from: 'email', to: 'EMAIL' }], syncMode: 'batch', connectionId: 'conn:bq',
      project: 'p', dataset: 'd', table: 't', warehouseKeyField: 'id',
    });
    syncId = sync.syncId;
  });

  it('a different batch at the same cursor needs its own approval, and supersedes the pending one', async () => {
    const editor = userIdFor(WS, EDITOR);
    const a = await warehouseLoad(loadDeps(editor), { syncId, records: recordsA });
    if (a.status !== 'requires_approval') throw new Error(`expected requires_approval, got ${a.status}`);
    const again = await warehouseLoad(loadDeps(editor), { syncId, records: recordsA });
    expect(again.status === 'requires_approval' && again.approvalId).toBe(a.approvalId); // same rows → same row

    const b = await warehouseLoad(loadDeps(editor), { syncId, records: recordsB });
    if (b.status !== 'requires_approval') throw new Error(`expected requires_approval, got ${b.status}`);
    expect(b.approvalId).not.toBe(a.approvalId);
    expect((await getApproval(a.approvalId))?.status).toBe('rejected'); // superseded
    const row = await getApproval(b.approvalId);
    expect(row?.rowsDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.submitters).toEqual([editor]);

    // The superseded batch coming back asks again; it is not refused forever by the row
    // the supersede rejected (architect pass 2, N2), and it supersedes B in turn.
    const aAgain = await warehouseLoad(loadDeps(editor), { syncId, records: recordsA });
    if (aAgain.status !== 'requires_approval') throw new Error(`expected requires_approval, got ${aAgain.status}`);
    expect(aAgain.approvalStatus).toBe('pending');
    expect(aAgain.approvalId).not.toBe(a.approvalId);
    expect((await getApproval(b.approvalId))?.status).toBe('rejected');
  });

  it('two loads of the same rows racing end with one approval, not two (grade-code M1)', async () => {
    const editor = userIdFor(WS, EDITOR);
    const rows = [{ id: 'c20', email: 'race@x.test' }];
    // Force the race: the FIRST load's batch-key read (a miss) is held until the
    // second load has read the same key, so both miss and both mint an approval
    // before either claims the key. Only the insert-if-absent claim can then
    // leave one approval (2 s fallback so a broken hold fails, never hangs).
    const BATCH = 'hostext:cdp:warehouse-load-approval:whbatch:';
    const realGet = storage.kvGet.bind(storage);
    let arrivals = 0;
    let release: () => void = () => {};
    const bothRead = new Promise<void>((r) => { release = r; });
    const hold = vi.spyOn(storage, 'kvGet').mockImplementation(async (key: string) => {
      if (!key.startsWith(BATCH) || arrivals >= 2) return realGet(key);
      arrivals += 1;
      const value = await realGet(key);
      if (arrivals === 1) await Promise.race([bothRead, new Promise<void>((r) => setTimeout(r, 2_000))]);
      else release();
      return value;
    });
    let x: Awaited<ReturnType<typeof warehouseLoad>>;
    let y: Awaited<ReturnType<typeof warehouseLoad>>;
    try {
      [x, y] = await Promise.all([
        warehouseLoad(loadDeps(editor), { syncId, records: rows }),
        warehouseLoad(loadDeps(editor), { syncId, records: rows }),
      ]);
    } finally { hold.mockRestore(); }
    expect(arrivals).toBe(2);
    if (x.status !== 'requires_approval' || y.status !== 'requires_approval') throw new Error('expected requires_approval twice');
    expect(x.approvalId).toBe(y.approvalId);
    const winner = await getApproval(x.approvalId);
    expect(winner?.status).toBe('pending');
    // The loser's own fresh row was minted and then superseded, not left pending.
    const batch = (await listApprovals(WS)).filter((a) => a.spendIdemKey === winner?.spendIdemKey);
    expect(batch.map((a) => a.status).sort()).toEqual(['pending', 'rejected']);
  });

  it('the requester cannot approve it; a viewer cannot decide it; another editor approves it in the inbox', async () => {
    const editor = userIdFor(WS, EDITOR);
    const out = await warehouseLoad(loadDeps(editor), { syncId, records: [{ id: 'c9', email: 'z@x.test' }] });
    if (out.status !== 'requires_approval') throw new Error(`expected requires_approval, got ${out.status}`);

    await expect(claimApproval(decideDeps(), { tenantId: WS, decidedBy: editor }, out.approvalId))
      .rejects.toMatchObject({ httpStatus: 403, details: { reason: 'separation-of-duties' } });
    // The viewer is refused by the write-scope check, not by separation of duties.
    await expect(claimApproval(decideDeps(), { tenantId: WS, decidedBy: userIdFor(WS, VIEWER) }, out.approvalId))
      .rejects.toMatchObject({ httpStatus: 403, code: 'forbidden_scope', message: 'Missing required scope: workspace:write' });
    expect((await getApproval(out.approvalId))?.status).toBe('pending');

    // The inbox decides it (this was 404 "Proposing agent no longer exists" before ADR 1024).
    await claimApproval(decideDeps(), { tenantId: WS, decidedBy: userIdFor(WS, EDITOR2) }, out.approvalId);
    expect((await getApproval(out.approvalId))?.status).toBe('approved');

    // The same rows now pass the gate and reach the insert (no BigQuery connection here).
    const loaded = await warehouseLoad(loadDeps(editor), { syncId, records: [{ id: 'c9', email: 'z@x.test' }] });
    expect(loaded.status).toBe('no_connection');
  });

  it('the requester may withdraw their own load, and a personal-workspace owner may approve their own', async () => {
    const editor = userIdFor(WS, EDITOR);
    const w = await warehouseLoad(loadDeps(editor), { syncId, records: [{ id: 'c10', email: 'w@x.test' }] });
    if (w.status !== 'requires_approval') throw new Error(`expected requires_approval, got ${w.status}`);
    await rejectApproval(decideDeps(), { tenantId: WS, decidedBy: editor }, w.approvalId);
    expect(await getApproval(w.approvalId)).toMatchObject({ status: 'rejected', decidedBy: editor });

    const p = await warehouseLoad(loadDeps(editor), { syncId, records: [{ id: 'c11', email: 'p@x.test' }] });
    if (p.status !== 'requires_approval') throw new Error(`expected requires_approval, got ${p.status}`);
    await claimApproval(decideDeps(), { tenantId: WS, decidedBy: editor, decidedByPersonalOwner: true }, p.approvalId);
    expect(await getApproval(p.approvalId)).toMatchObject({ status: 'approved', decidedBy: editor });
  });
});
