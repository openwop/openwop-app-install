/**
 * ADR 0913 (Book AI P1 + P2 + P20) — a feature erases the workflows and runs it
 * created for one subject, and deletes its own document kind on a person's
 * erasure.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { registerWorkflowDurable, getRegisteredWorkflowAsync } from '../src/host/workflowsRegistry.js';
import { recordOwnership, getOwned, listOwnedBySubject } from '../src/host/workflowOwnership.js';
import { deleteTenantWorkflow, eraseWorkflowSubject } from '../src/host/tenantWorkflowDelete.js';
import { setRetentionHold, clearRetentionHold } from '../src/host/retentionHold.js';
import { createOrg } from '../src/host/accessControlService.js';
import { createUser } from '../src/features/users/usersService.js';
import { createDocument, getDocument, addVersion, listVersions } from '../src/features/documents/documentsService.js';
import { eraseDocumentSubject, registerDocumentKindErasure, resetDocumentKindErasureForTests, ERASED_SUBJECT } from '../src/features/documents/erasure.js';

let server: http.Server;
let PORT = 0;
let storage: Storage;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = '';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  server = await new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  PORT = (server.address() as AddressInfo).port;
  storage = await openStorage('memory://');
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

let seq = 0;
async function ownedWorkflow(tenantId: string, subject?: string): Promise<string> {
  const workflowId = `wf.copy.adr0913.${(++seq).toString(16).padStart(16, '0')}`;
  await registerWorkflowDurable({ workflowId, nodes: [{ nodeId: 'a', typeId: 'core.noop' }], edges: [], metadata: { name: workflowId } } as never);
  await recordOwnership(tenantId, workflowId, { name: workflowId, nodeCount: 1, ...(subject ? { subject } : {}) });
  return workflowId;
}
async function run(tenantId: string, workflowId: string, runId: string, extra: Record<string, unknown> = {}): Promise<void> {
  const now = new Date().toISOString();
  await storage.insertRun({ runId, workflowId, tenantId, status: 'completed', inputs: null, metadata: {}, configurable: {}, createdAt: now, updatedAt: now, ...extra } as never);
}

describe('ADR 0913 P1 — deleteTenantWorkflow is the route recipe', () => {
  const T = 'org:adr0913-p1';

  it('deletes an owned, unreferenced workflow and its ownership', async () => {
    const id = await ownedWorkflow(T);
    expect(await deleteTenantWorkflow(storage, T, id)).toEqual({ deleted: true, removed: true });
    expect(await getOwned(T, id)).toBeNull();
    expect(await getRegisteredWorkflowAsync(id)).toBeNull();
  });

  it('refuses a workflow a run still references, and a foreign one', async () => {
    const id = await ownedWorkflow(T);
    await run(T, id, `r-p1-${seq}`);
    expect(await deleteTenantWorkflow(storage, T, id)).toEqual({ deleted: false, reason: 'workflow_referenced' });
    expect(await deleteTenantWorkflow(storage, 'org:someone-else', id)).toEqual({ deleted: false, reason: 'not_owned' });
    expect(await getOwned(T, id)).not.toBeNull();
  });
});

describe('ADR 0913 P1+P2 — eraseWorkflowSubject', () => {
  const T = 'org:adr0913-p2';
  const SUBJECT = 'bookai:org1:book-42';

  afterEach(async () => { await clearRetentionHold(T); });

  it('deletes exactly the labelled workflows, their runs and their child runs, and nothing else', async () => {
    const a = await ownedWorkflow(T, SUBJECT);
    const b = await ownedWorkflow(T, SUBJECT);
    const other = await ownedWorkflow(T, 'bookai:org1:book-7');
    const unlabelled = await ownedWorkflow(T);
    await run(T, a, 'r-a1'); await run(T, a, 'r-a2', { status: 'running' });
    await run(T, 'wf.shared.child', 'r-a1-child', { parentRunId: 'r-a1' });
    await run(T, b, 'r-b1');
    await run(T, other, 'r-other');
    await run(T, unlabelled, 'r-unlabelled');

    const res = await eraseWorkflowSubject(storage, T, SUBJECT, { reason: 'book deleted' });
    expect(res.complete).toBe(true);
    expect(res.workflowsDeleted.sort()).toEqual([a, b].sort());
    expect(res.runsDeleted).toBe(4);
    for (const id of ['r-a1', 'r-a2', 'r-a1-child', 'r-b1']) expect(await storage.getRun(id), id).toBeNull();
    expect(await storage.getRun('r-other')).not.toBeNull();
    expect(await storage.getRun('r-unlabelled')).not.toBeNull();
    expect(await listOwnedBySubject(T, SUBJECT)).toEqual([]);
    expect(await getOwned(T, other)).not.toBeNull();
  });

  it('does nothing under a tenant legal hold, and says so per workflow', async () => {
    const a = await ownedWorkflow(T, 'bookai:org1:held');
    await run(T, a, 'r-held');
    await setRetentionHold(T, 'litigation');
    const res = await eraseWorkflowSubject(storage, T, 'bookai:org1:held', { reason: 'book deleted' });
    expect(res).toEqual({ complete: false, workflowsDeleted: [], runsDeleted: 0, refused: [{ workflowId: a, reason: 'legal_hold' }] });
    expect(await storage.getRun('r-held')).not.toBeNull();
    expect(await getOwned(T, a)).not.toBeNull();
  });

  it('is scoped to the tenant: another tenant with the same label is untouched', async () => {
    const mine = await ownedWorkflow(T, 'bookai:org1:shared-label');
    const theirs = await ownedWorkflow('org:adr0913-other', 'bookai:org1:shared-label');
    await eraseWorkflowSubject(storage, T, 'bookai:org1:shared-label', { reason: 'x' });
    expect(await getOwned(T, mine)).toBeNull();
    expect(await getOwned('org:adr0913-other', theirs)).not.toBeNull();
  });
});

describe('ADR 0913 — from-chain stamps the subject (route)', () => {
  const url = (p: string) => `http://127.0.0.1:${PORT}/host/openwop-app${p}`;
  const cookie = async () => (await fetch(url('/workflows'))).headers.get('set-cookie')!.split(';')[0]!;
  const fromChain = (c: string, body: Record<string, unknown>) => fetch(url('/workflows/from-chain'), {
    method: 'POST', headers: { 'content-type': 'application/json', cookie: c }, body: JSON.stringify({ chainId: 'market-intel.digest', params: { topic: 'x' }, ...body }),
  });

  it('accepts a well-formed subject and refuses a malformed one', async () => {
    const c = await cookie();
    expect((await fromChain(c, { subject: 'bookai:org1:book-9' })).status).toBe(201);
    for (const bad of ['Bookai:x', 'bookai', 'bookai:', 'bookai:has space', 42]) {
      expect((await fromChain(c, { subject: bad })).status, String(bad)).toBe(400);
    }
  });
});

describe('ADR 0913 P20 — a registered document kind is deleted on its owner\'s erasure', () => {
  const T = 'org:adr0913-p20';
  let ORG = '';
  let ME = '';
  beforeAll(async () => {
    ME = (await createUser({ tenantId: T, principalId: 'password:p20@t.test', displayName: 'P20' })).userId;
    ORG = (await createOrg({ tenantId: T, createdBy: ME, name: 'P20' })).orgId;
  });
  afterEach(async () => { resetDocumentKindErasureForTests(); await clearRetentionHold(T); });
  const doc = (kind: string) => createDocument({ tenantId: T, orgId: ORG, title: `${kind}-${++seq}`, kind, format: 'markdown', provenance: { producedBy: { kind: 'user', id: ME } }, createdBy: ME });

  it('deletes the registered kind and still anonymizes every other kind', async () => {
    registerDocumentKindErasure('bookai-story-plan', 'delete');
    const plan = await doc('bookai-story-plan');
    const note = await doc('note');
    await eraseDocumentSubject(T, ME);
    expect(await getDocument(T, ORG, plan.documentId)).toBeNull();
    expect((await getDocument(T, ORG, note.documentId))?.createdBy).toBe(ERASED_SUBJECT);
  });

  it('without registration the kind is anonymized, as before', async () => {
    const plan = await doc('bookai-story-plan');
    await eraseDocumentSubject(T, ME);
    expect((await getDocument(T, ORG, plan.documentId))?.createdBy).toBe(ERASED_SUBJECT);
  });

  it('under a legal hold the registered kind is anonymized, never deleted', async () => {
    registerDocumentKindErasure('bookai-story-plan', 'delete');
    const plan = await doc('bookai-story-plan');
    await setRetentionHold(T, 'litigation');
    await eraseDocumentSubject(T, ME);
    const after = await getDocument(T, ORG, plan.documentId);
    expect(after).not.toBeNull();
    expect(after?.createdBy).toBe(ERASED_SUBJECT);
  });
});

describe('ADR 0913 D5 (P11) — a checked FIRST save', () => {
  const T = 'org:adr0913-p11';
  let ORG = '';
  let ME = '';
  beforeAll(async () => {
    ME = (await createUser({ tenantId: T, principalId: 'password:p11@t.test', displayName: 'P11' })).userId;
    ORG = (await createOrg({ tenantId: T, createdBy: ME, name: 'P11' })).orgId;
  });
  const by = { kind: 'user' as const, id: '' };

  it('baseVersionId: null lands version 1, and a second first-save is refused stale_base', async () => {
    const d = await createDocument({ tenantId: T, orgId: ORG, title: `p11-${++seq}`, kind: 'bookai-story-plan', format: 'markdown', provenance: { producedBy: { kind: 'user', id: ME } }, createdBy: ME });
    const v1 = await addVersion(T, ORG, d.documentId, { content: 'tab A', producedBy: { ...by, id: ME }, baseVersionId: null });
    expect(v1.version).toBe(1);
    await expect(addVersion(T, ORG, d.documentId, { content: 'tab B', producedBy: { ...by, id: ME }, baseVersionId: null }))
      .rejects.toMatchObject({ details: { reason: 'stale_base' } });
    expect((await listVersions(T, ORG, d.documentId)).map((v) => v.content)).toEqual(['tab A']);
  });

  it('two concurrent first saves: exactly one lands', async () => {
    const d = await createDocument({ tenantId: T, orgId: ORG, title: `p11-${++seq}`, kind: 'note', format: 'markdown', provenance: { producedBy: { kind: 'user', id: ME } }, createdBy: ME });
    const results = await Promise.allSettled([
      addVersion(T, ORG, d.documentId, { content: 'A', producedBy: { ...by, id: ME }, baseVersionId: null }),
      addVersion(T, ORG, d.documentId, { content: 'B', producedBy: { ...by, id: ME }, baseVersionId: null }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await listVersions(T, ORG, d.documentId)).toHaveLength(1);
  });

  it('an unchecked first save still behaves as before (control)', async () => {
    const d = await createDocument({ tenantId: T, orgId: ORG, title: `p11-${++seq}`, kind: 'note', format: 'markdown', provenance: { producedBy: { kind: 'user', id: ME } }, createdBy: ME });
    await addVersion(T, ORG, d.documentId, { content: 'one', producedBy: { ...by, id: ME } });
    await addVersion(T, ORG, d.documentId, { content: 'two', producedBy: { ...by, id: ME } });
    expect(await listVersions(T, ORG, d.documentId)).toHaveLength(2);
  });
});
