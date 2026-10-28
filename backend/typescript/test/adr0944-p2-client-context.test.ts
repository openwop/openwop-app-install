/**
 * ADR 0944 P2 — the per-client context block (D5).
 *
 * Exit criterion: the block is identical across a `replay` fork, even after the
 * client's brand, performance and knowledge designation changed in between,
 * while a NEW run sees the change. Also covers D7 test 6 (a collection of client
 * B cannot enter client A's designation or A's snapshot), the provider's refusal
 * when the run's person lost the client, the budget cut order, and that the
 * content never sits on the run row.
 *
 * Sabotage-witnessed (P2): making the contributor stamp on a `derivedFromRun`
 * fork (dropping its first line) reds "a fork of a run that predates the block"
 * (a fork of a stamped run is held by the merge's never-overwrite rule); reading
 * the snapshot without `compareAndSwap(null, …)` (always rebuilding) reds the same
 * case; dropping `getCollection` from `setClientContextSources` reds test 6;
 * dropping the `client.orgId !== stamp.orgId` check reds "a stamp naming another
 * client is refused".
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import type http from 'node:http';
import { createApp } from '../src/index.js';
import { saveConfig } from '../src/host/featureToggles/service.js';
import { getToggleDefault } from '../src/host/featureToggles/registry.js';
import { createMember, createOrg, createWorkspace, deleteMember } from '../src/host/accessControlService.js';
import { upsertFromPrincipal } from '../src/features/users/usersService.js';
import { hostExtStorage } from '../src/host/hostExtPersistence.js';
import { insertRunWithStartContext } from '../src/host/runInsert.js';
import { collectRunContextBlocks } from '../src/host/runContextProviders.js';
import { CAMPAIGN_OPS_RUN_STAMP } from '../src/features/campaign-ops/surface.js';
import { createClient } from '../src/features/campaign-ops/clientService.js';
import {
  CLIENT_CONTEXT_STAMP_KEY, clientContextForRun, readClientContextStamp, renderClientContextBlock, setClientContextSources,
} from '../src/features/campaign-ops/clientContext.js';
import { runClientCollectionIds } from '../src/host/runClientKnowledge.js';
import { createBrand, updateBrand } from '../src/features/brand/brandService.js';
import { createCollection, deleteCollection } from '../src/features/kb/kbService.js';
import { addProjectMember, createProject, projectSubject, removeProjectMember, setProjectVisibility } from '../src/features/projects/projectsService.js';
import { createDocument } from '../src/features/documents/documentsService.js';
import { acceptDelta, createLedger, proposeDelta } from '../src/features/team-intent-ledger/ledgerStore.js';
import { importCsv } from '../src/features/campaign-connectors/performanceService.js';
import type { RunRecord } from '../src/types.js';

let server: http.Server;
let TENANT: string;
let orgA: string;
let orgB: string;
let person: string;
let brandA: string;
let kbA: string;
let kbB: string;

async function newRun(metadata: Record<string, unknown>, derivedFromRun = false): Promise<string> {
  const runId = `run-p2-${randomBytes(5).toString('hex')}`;
  const now = new Date().toISOString();
  await insertRunWithStartContext(hostExtStorage(), {
    runId, workflowId: 'w', tenantId: TENANT, status: 'running', inputs: null,
    metadata, configurable: {}, createdAt: now, updatedAt: now,
  } as RunRecord, { tenantId: TENANT, ...(derivedFromRun ? { derivedFromRun: true } : {}) });
  return runId;
}

const metadataOf = async (runId: string): Promise<Record<string, unknown>> =>
  ((await hostExtStorage().getRun(runId))?.metadata ?? {}) as Record<string, unknown>;

const blockOf = async (runId: string): Promise<string> =>
  (await collectRunContextBlocks({ tenantId: TENANT, runId })).join('\n\n');

async function decisionIn(project: Awaited<ReturnType<typeof createProject>>, title: string, ownerProject = project): Promise<void> {
  const doc = await createDocument({ tenantId: TENANT, orgId: orgA, title, kind: 'decision-record', ownerSubject: projectSubject(ownerProject.id), createdBy: person, provenance: { producedBy: { kind: 'user', id: person } } });
  const ledger = await createLedger(project, person);
  const delta = await proposeDelta({ ledger, patch: { decisionDocumentIds: [doc.documentId] }, why: 'Record the approved decision', author: { kind: 'user', id: person } });
  await acceptDelta(project, delta.deltaId, person);
}

async function clientReader(): Promise<string> {
  const reader = (await upsertFromPrincipal({ tenantId: TENANT, principalId: `oidc:decision-reader-${randomBytes(4).toString('hex')}`, source: 'oidc' })).userId;
  await createMember({ tenantId: TENANT, orgId: orgA, subject: reader, displayName: 'Client reader', roles: ['viewer'] });
  return reader;
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => res()); });
  for (const id of ['cms', 'campaign-ops', 'brand', 'kb', 'campaign-connectors', 'team-intent-ledger', 'projects', 'documents']) {
    const d = getToggleDefault(id);
    if (d) await saveConfig({ ...d, status: 'on' }, 'test');
  }
  TENANT = (await createWorkspace({ name: 'Northwind Agency', ownerSubject: 'oidc:p2-owner' })).tenantId;
  person = (await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:p2-person', source: 'oidc' })).userId;
  orgA = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client A' })).orgId;
  orgB = (await createOrg({ tenantId: TENANT, createdBy: 'seed', name: 'Client B' })).orgId;
  for (const org of [orgA, orgB]) {
    await createMember({ tenantId: TENANT, orgId: org, subject: person, displayName: 'Person', roles: ['editor'] });
    await createClient({ tenantId: TENANT, orgId: org, name: org === orgA ? 'Client A' : 'Client B', createdBy: 'seed' });
  }
  brandA = (await createBrand(TENANT, orgA, 'seed', { name: 'Acme', voiceProfile: { voice: 'VOICE-ONE: warm and plain' } } as Parameters<typeof createBrand>[3])).id;
  await createBrand(TENANT, orgB, 'seed', { name: 'Beta', voiceProfile: { voice: 'VOICE-BETA: loud' } } as Parameters<typeof createBrand>[3]);
  kbA = (await createCollection(TENANT, orgA, 'seed', { name: 'KB-ALPHA playbook' })).collectionId;
  kbB = (await createCollection(TENANT, orgB, 'seed', { name: 'KB-BETA playbook' })).collectionId;
  await setClientContextSources(TENANT, orgA, [kbA], person);
  await importCsv(TENANT, orgA, ['Platform,Campaign,Day,Cost,Impr.,Clicks,Conversions,Revenue', 'Google,ALPHA-SEARCH,2026-01-01,1000,10000,100,40,4000'].join('\n'));
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

describe('ADR 0944 D5 — the client context block', () => {
  it('is identical across a replay fork after the client changed; a new run sees the change', async () => {
    const runA = await newRun({ [CAMPAIGN_OPS_RUN_STAMP]: { orgId: orgA }, actingUserId: person });
    const stamp = readClientContextStamp(await metadataOf(runA));
    expect(stamp?.orgId).toBe(orgA);
    const first = await blockOf(runA);
    expect(first).toContain('VOICE-ONE');
    expect(first).toContain('KB-ALPHA');
    expect(first).toContain('ALPHA-SEARCH');
    expect(first).not.toContain('VOICE-BETA');
    expect(first).not.toContain('KB-BETA');
    // The content is never on the run row (any run reader would see it).
    expect(JSON.stringify(await metadataOf(runA))).not.toContain('VOICE-ONE');

    // The client changes between the run and its fork.
    await updateBrand(TENANT, brandA, { name: 'Acme', voiceProfile: { voice: 'VOICE-TWO: crisp' } } as Parameters<typeof updateBrand>[2]);
    await importCsv(TENANT, orgA, ['Platform,Campaign,Day,Cost,Impr.,Clicks,Conversions,Revenue', 'Meta,ALPHA-NEW,2026-01-02,500,5000,50,5,600'].join('\n'));

    // `:fork` copies the metadata verbatim and inserts with derivedFromRun.
    const fork = await newRun(await metadataOf(runA), true);
    expect(readClientContextStamp(await metadataOf(fork))).toEqual(stamp);
    expect(await blockOf(fork)).toBe(first);
    expect(await blockOf(runA)).toBe(first); // a second read of the same run

    const fresh = await newRun({ [CAMPAIGN_OPS_RUN_STAMP]: { orgId: orgA }, actingUserId: person });
    const later = await blockOf(fresh);
    expect(later).toContain('VOICE-TWO');
    expect(later).not.toBe(first);
  });

  it('a fork of a run that predates the block gets none (a fork never re-resolves)', async () => {
    // A source run from before P2: client-stamped, no `clientContext`.
    const fork = await newRun({ [CAMPAIGN_OPS_RUN_STAMP]: { orgId: orgA }, actingUserId: person }, true);
    expect((await metadataOf(fork))[CLIENT_CONTEXT_STAMP_KEY]).toBeUndefined();
    expect(await blockOf(fork)).not.toContain('Client context');
  });

  it('a run with no client gets no block and no stamp', async () => {
    const plain = await newRun({ actingUserId: person });
    expect((await metadataOf(plain))[CLIENT_CONTEXT_STAMP_KEY]).toBeUndefined();
    expect(await blockOf(plain)).not.toContain('Client context');
  });

  it('a stamp naming another client than the run, or a person without the client, is refused', async () => {
    const runB = await newRun({ [CAMPAIGN_OPS_RUN_STAMP]: { orgId: orgB }, actingUserId: person });
    const bStamp = readClientContextStamp(await metadataOf(runB));
    // A run of client A carrying B's snapshot reference.
    const forged = await newRun({ [CAMPAIGN_OPS_RUN_STAMP]: { orgId: orgA }, actingUserId: person, [CLIENT_CONTEXT_STAMP_KEY]: bStamp }, true);
    expect(await clientContextForRun(TENANT, forged)).toEqual({ refused: true });
    expect(await blockOf(forged)).not.toContain('VOICE-BETA');

    const outsider = (await upsertFromPrincipal({ tenantId: TENANT, principalId: 'oidc:p2-outsider', source: 'oidc' })).userId;
    const noAccess = await newRun({ [CAMPAIGN_OPS_RUN_STAMP]: { orgId: orgA }, actingUserId: outsider });
    const block = await blockOf(noAccess);
    expect(block).not.toContain('VOICE');
    expect(block).toContain('could not be searched');
    expect(await runClientCollectionIds(TENANT, noAccess)).toEqual([]);
  });

  it('D7 test 6: a collection of client B cannot enter client A’s designation or its snapshot', async () => {
    await expect(setClientContextSources(TENANT, orgA, [kbB], person)).rejects.toMatchObject({ code: 'not_found' });
    const runA = await newRun({ [CAMPAIGN_OPS_RUN_STAMP]: { orgId: orgA }, actingUserId: person });
    expect(await runClientCollectionIds(TENANT, runA)).toEqual([kbA]);
  });

  it('cuts sections to the budget in order, decisions last', () => {
    const big = 'x'.repeat(400);
    const sections = (['brand', 'knowledge', 'performance', 'decisions'] as const).map((kind) => ({ kind, text: `## ${kind}\n${big}` }));
    expect(renderClientContextBlock('H', sections, 100_000).omitted).toEqual([]);
    const cut = renderClientContextBlock('H', sections, 1000);
    expect(cut.omitted).toEqual(['performance', 'knowledge']);
    expect(cut.block).toContain('## decisions');
    expect(cut.block).toContain('## brand');
    expect(cut.block.length).toBeLessThanOrEqual(1000);
    // Nothing fits: every section goes, and the block is never sliced mid-section.
    const none = renderClientContextBlock('H', sections, 50);
    expect(none.omitted).toEqual(['performance', 'knowledge', 'brand', 'decisions']);
    expect(none.block).not.toContain('xxx');
    expect(renderClientContextBlock('H', sections, 500).omitted).toEqual(['performance', 'knowledge', 'brand']);
    expect(renderClientContextBlock('H'.repeat(1000), sections, 10).block).toBe('');
  });

  it('a previously frozen block cannot bypass a source feature disabled afterward', async () => {
    const runId = await newRun({ [CAMPAIGN_OPS_RUN_STAMP]: { orgId: orgA }, actingUserId: person });
    const first = await blockOf(runId);
    expect(first).toContain('VOICE-TWO');
    // Brand and KB are always-on substrate; only real toggleable sources can be disabled.
    for (const id of ['campaign-connectors']) {
      const config = getToggleDefault(id);
      if (!config) throw new Error(`Source toggle missing: ${id}`);
      try {
        await saveConfig({ ...config, status: 'off' }, 'test');
        expect(await clientContextForRun(TENANT, runId)).toEqual({ refused: true });
        expect(await blockOf(runId)).not.toContain('VOICE-TWO');
        expect(await runClientCollectionIds(TENANT, runId)).toEqual([]);
      } finally { await saveConfig({ ...config, status: 'on' }, 'test'); }
      expect(await blockOf(runId)).toBe(first);
    }
  });

  it('revoking the actual run actor after freezing removes access to its block and collections', async () => {
    const user = (await upsertFromPrincipal({ tenantId: TENANT, principalId: `oidc:revoked-${randomBytes(4).toString('hex')}`, source: 'oidc' })).userId;
    const member = await createMember({ tenantId: TENANT, orgId: orgA, subject: user, displayName: 'Revoked person', roles: ['editor'] });
    const runId = await newRun({ [CAMPAIGN_OPS_RUN_STAMP]: { orgId: orgA }, actingUserId: user });
    expect(await blockOf(runId)).toContain('VOICE-TWO');
    await deleteMember(member.memberId);
    expect(await clientContextForRun(TENANT, runId)).toEqual({ refused: true });
    expect(await runClientCollectionIds(TENANT, runId)).toEqual([]);
  });

  it('a deleted collection is not revived by the frozen snapshot', async () => {
    const collection = await createCollection(TENANT, orgA, 'seed', { name: 'Temporary source' });
    try {
      await setClientContextSources(TENANT, orgA, [collection.collectionId], person);
      const runId = await newRun({ [CAMPAIGN_OPS_RUN_STAMP]: { orgId: orgA }, actingUserId: person });
      expect(await runClientCollectionIds(TENANT, runId)).toEqual([collection.collectionId]);
      await deleteCollection(TENANT, orgA, collection.collectionId);
      expect(await clientContextForRun(TENANT, runId)).toEqual({ refused: true });
      expect(await runClientCollectionIds(TENANT, runId)).toEqual([]);
    } finally { await setClientContextSources(TENANT, orgA, [kbA], person); }
  });

  it('a private project source is available to its real reader and disappears from a frozen run after membership is revoked', async () => {
    const reader = (await upsertFromPrincipal({ tenantId: TENANT, principalId: `oidc:private-source-${randomBytes(4).toString('hex')}`, source: 'oidc' })).userId;
    await createMember({ tenantId: TENANT, orgId: orgA, subject: reader, displayName: 'Project reader', roles: ['viewer'] });
    const project = await createProject(TENANT, orgA, { name: 'Private client evidence' }, person);
    await setProjectVisibility(TENANT, project.id, 'private');
    await addProjectMember(TENANT, project.id, `user:${reader}`, 'contributor');
    const source = await createCollection(TENANT, orgA, person, { name: 'PRIVATE-CLIENT-SOURCE' }, { boundSubject: projectSubject(project.id) });
    try {
      await setClientContextSources(TENANT, orgA, [source.collectionId], person);
      const runId = await newRun({ [CAMPAIGN_OPS_RUN_STAMP]: { orgId: orgA }, actingUserId: reader });
      expect(await blockOf(runId)).toContain('PRIVATE-CLIENT-SOURCE');
      expect(await runClientCollectionIds(TENANT, runId)).toEqual([source.collectionId]);
      await removeProjectMember(TENANT, project.id, `user:${reader}`);
      expect(await clientContextForRun(TENANT, runId)).toEqual({ refused: true });
      expect(await blockOf(runId)).not.toContain('PRIVATE-CLIENT-SOURCE');
      expect(await runClientCollectionIds(TENANT, runId)).toEqual([]);
      await expect(setClientContextSources(TENANT, orgA, [source.collectionId], reader)).rejects.toMatchObject({ code: 'not_found' });
    } finally { await setClientContextSources(TENANT, orgA, [kbA], person); }
  });

  it('private project decisions require project membership and disappear from an already frozen run after revocation', async () => {
    const reader = await clientReader();
    const project = await createProject(TENANT, orgA, { name: 'PRIVATE-DECISION-PROJECT' }, person);
    await setProjectVisibility(TENANT, project.id, 'private');
    await decisionIn(project, 'PRIVATE-PROJECT-DECISION');
    const before = await newRun({ [CAMPAIGN_OPS_RUN_STAMP]: { orgId: orgA }, actingUserId: reader });
    expect(await blockOf(before)).not.toContain('PRIVATE-PROJECT-DECISION');
    expect(await blockOf(before)).not.toContain('PRIVATE-DECISION-PROJECT');
    await addProjectMember(TENANT, project.id, `user:${reader}`, 'contributor');
    const allowed = await newRun({ [CAMPAIGN_OPS_RUN_STAMP]: { orgId: orgA }, actingUserId: reader });
    expect(await blockOf(allowed)).toContain('PRIVATE-PROJECT-DECISION');
    await removeProjectMember(TENANT, project.id, `user:${reader}`);
    expect(await clientContextForRun(TENANT, allowed)).toEqual({ refused: true });
    expect(await blockOf(allowed)).not.toContain('PRIVATE-PROJECT-DECISION');
  });

  it('a visible project cannot expose a document owned by a different private project, including after a frozen read', async () => {
    const reader = await clientReader();
    const visible = await createProject(TENANT, orgA, { name: 'Visible ledger' }, person);
    const privateOwner = await createProject(TENANT, orgA, { name: 'Private document owner' }, person);
    await setProjectVisibility(TENANT, privateOwner.id, 'private');
    await decisionIn(visible, 'PRIVATE-DOCUMENT-DECISION', privateOwner);
    const before = await newRun({ [CAMPAIGN_OPS_RUN_STAMP]: { orgId: orgA }, actingUserId: reader });
    expect(await blockOf(before)).not.toContain('PRIVATE-DOCUMENT-DECISION');
    await addProjectMember(TENANT, privateOwner.id, `user:${reader}`, 'contributor');
    const allowed = await newRun({ [CAMPAIGN_OPS_RUN_STAMP]: { orgId: orgA }, actingUserId: reader });
    expect(await blockOf(allowed)).toContain('PRIVATE-DOCUMENT-DECISION');
    await removeProjectMember(TENANT, privateOwner.id, `user:${reader}`);
    expect(await clientContextForRun(TENANT, allowed)).toEqual({ refused: true });
    expect(await blockOf(allowed)).not.toContain('PRIVATE-DOCUMENT-DECISION');
  });

  it('an unconfirmed snapshot CAS never serves an unrecorded local snapshot', async () => {
    const runId = await newRun({ [CAMPAIGN_OPS_RUN_STAMP]: { orgId: orgA }, actingUserId: person });
    const storage = hostExtStorage();
    const cas = storage.kvCompareAndSwap.bind(storage);
    const spy = vi.spyOn(storage, 'kvCompareAndSwap').mockImplementation(async (...args) => {
      if (args[0].startsWith('hostext:campaign-ops:client-context-snapshot:')) return { swapped: false, actual: null };
      return cas(...args);
    });
    try {
      await expect(clientContextForRun(TENANT, runId)).rejects.toMatchObject({ code: 'conflict' });
      expect(await blockOf(runId)).not.toContain('VOICE');
      expect(await runClientCollectionIds(TENANT, runId)).toEqual([]);
    } finally { spy.mockRestore(); }
  });
});
