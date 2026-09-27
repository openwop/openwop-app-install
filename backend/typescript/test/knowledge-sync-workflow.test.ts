/**
 * WF-KB-3 / KSWF-1 — the knowledge-sync recurring pass is now a registered, owned,
 * replayable `knowledge-sync.run` workflow fired by the ONE host scheduler (the
 * gmailSync twin), NOT the retired bespoke `knowledgeSyncDaemon`. This covers the
 * shape the migration produces:
 *   - createSyncSource registers a per-source workflow (owned) + scheduler job;
 *   - the `knowledge-sync` surface's `runOnce` runs a pass through `syncNow`;
 *   - a DISABLED tenant's fired job is a typed skip with ZERO egress (WF-KB-4);
 *   - the boot backfill is idempotent over already-migrated sources.
 * (Backoff / in-flight / lease suppression are covered by knowledge-sync-runner +
 * knowledge-sync-daemon's isSyncDue/claimSyncRun cases.)
 *
 * Born red against the pre-migration code: there was no surface, no jobId, no
 * registered workflow — the sync ran inline in the deleted daemon.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { loadWorkflowChainPacks, defaultWorkflowChainPackRoots } from '../src/host/workflowChainPackLoader.js';
import { registerToggleDefault } from '../src/host/featureToggles/registry.js';
import { saveConfig } from '../src/host/featureToggles/service.js';

vi.mock('../src/features/connections/connectionsService.js', () => ({ getConnection: vi.fn() }));
vi.mock('../src/host/knowledgeSourceFetch.js', () => ({ listFolder: vi.fn(), fetchKnowledgeSource: vi.fn(), fetchKnowledgeSourceBytes: vi.fn() }));
vi.mock('../src/features/kb/kbService.js', () => ({ ingestDocument: vi.fn(), deleteDocument: vi.fn(), getCollection: vi.fn(async () => ({ collectionId: 'col' })) })); // `getCollection` (ADR 0643 R4 Should 3): the runner resolves the target collection as the connection owner BEFORE listing/fetching — a readable stub here, so these tests keep exercising the per-file lanes

import { getConnection } from '../src/features/connections/connectionsService.js';
import { listFolder, fetchKnowledgeSource } from '../src/host/knowledgeSourceFetch.js';
import { ingestDocument, deleteDocument } from '../src/features/kb/kbService.js';
import { buildKnowledgeSyncSurface } from '../src/features/knowledge-sync/surface.js';
import {
  createSyncSource,
  knowledgeSyncWorkflowId, knowledgeSyncJobId, backfillKnowledgeSyncJobs,
} from '../src/features/knowledge-sync/knowledgeSyncService.js';
import { knowledgeSyncFeature } from '../src/features/knowledge-sync/feature.js';
import { getRegisteredWorkflowAsync } from '../src/host/workflowsRegistry.js';
import { getOwned } from '../src/host/workflowOwnership.js';
import { getJob } from '../src/host/schedulingService.js';

const mConn = vi.mocked(getConnection);
const mList = vi.mocked(listFolder);
const mFetch = vi.mocked(fetchKnowledgeSource);
const mIngest = vi.mocked(ingestDocument);
const mDelete = vi.mocked(deleteDocument);
const NOW = '2026-06-22T00:00:00.000Z';

async function enable(tenantId: string): Promise<void> {
  const cfg = knowledgeSyncFeature.toggleDefault!;
  await saveConfig({ ...cfg, status: 'on' }, tenantId);
}

beforeAll(async () => {
  const storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() });
  registerToggleDefault(knowledgeSyncFeature.toggleDefault!);
});
beforeEach(() => {
  mConn.mockReset(); mList.mockReset(); mFetch.mockReset(); mIngest.mockReset(); mDelete.mockReset();
  mDelete.mockResolvedValue(undefined as never);
  // Return a connection whose tenant MATCHES whatever tenant asked (each test uses
  // its own tenant), so the runner's tenant-scoped connection check passes.
  mConn.mockImplementation((tenantId: string) => Promise.resolve({ connectionId: 'c1', tenantId, userId: 'user:owner', provider: 'google', kind: 'oauth2', displayName: 'D', status: 'active', scopes: [], connectedAt: NOW }) as never);
  mFetch.mockResolvedValue({ title: 'Doc', text: 'hello world' } as never);
  mIngest.mockResolvedValue({} as never);
});

describe('createSyncSource registers an owned workflow + scheduler job (WF-KB-3)', () => {
  it('the source carries a jobId, and its workflow is registered + owned + scheduled', async () => {
    const t = 'wf-reg';
    await enable(t);
    const source = await createSyncSource(t, 'org1', { connectionId: 'c1', provider: 'google', externalFolderId: 'F', collectionId: 'col', cadence: 'hourly' }, NOW);
    // Born red pre-migration: SyncSource had no jobId.
    expect(source.jobId).toBe(knowledgeSyncJobId(source.id));
    const workflowId = knowledgeSyncWorkflowId(source.id);
    // Registered (resolves for run/:fork/replay) AND owned (lists in the builder gallery).
    expect(await getRegisteredWorkflowAsync(workflowId)).toBeTruthy();
    expect(await getOwned(t, workflowId)).not.toBeNull();
    // A scheduler job fires it on cadence — the ONE host scheduler, not a daemon.
    const job = await getJob(knowledgeSyncJobId(source.id));
    expect(job, 'a scheduler job must exist for the source').toBeTruthy();
    expect(job?.workflowId).toBe(workflowId);
    expect(job?.enabled).toBe(true);
  });
});

describe('the knowledge-sync surface runOnce (WF-KB-4 spend gate)', () => {
  it('a DISABLED tenant is a typed skip with ZERO egress', async () => {
    const t = 'wf-disabled';
    // NOTE: the toggle is NOT enabled for this tenant → syncEnabledFor is false.
    await enable('wf-other'); // enable an unrelated tenant to prove isolation
    // createSyncSource needs the workflow/job; enable briefly to create, then disable.
    await enable(t);
    const source = await createSyncSource(t, 'org1', { connectionId: 'c1', provider: 'google', externalFolderId: 'F', collectionId: 'col', cadence: 'hourly' }, NOW);
    await saveConfig({ ...knowledgeSyncFeature.toggleDefault!, status: 'off' }, t); // now DISABLED
    mList.mockResolvedValue({ files: [{ fileId: 'a', name: 'a.doc', mimeType: 'application/vnd.google-apps.document', revision: 'r1' }], complete: true } as never);

    const result = await buildKnowledgeSyncSurface({ tenantId: t }).runOnce({ sourceId: source.id }) as { status: string; reason?: string };
    expect(result.status).toBe('skipped');
    expect(result.reason).toBe('feature-disabled');
    // The WF-KB-4 guarantee: a disabled tenant's fired job does NO third-party egress.
    expect(mIngest).not.toHaveBeenCalled();
    expect(mList).not.toHaveBeenCalled();
  });

  it('the global kill-switch (OPENWOP_KNOWLEDGE_SYNC_DAEMON_ENABLED) stops all egress', async () => {
    const t = 'wf-killswitch';
    await enable(t);
    const source = await createSyncSource(t, 'org1', { connectionId: 'c1', provider: 'google', externalFolderId: 'F', collectionId: 'col', cadence: 'hourly' }, NOW);
    mList.mockResolvedValue({ files: [{ fileId: 'a', name: 'a.doc', mimeType: 'application/vnd.google-apps.document', revision: 'r1' }], complete: true } as never);
    const prev = process.env.OPENWOP_KNOWLEDGE_SYNC_DAEMON_ENABLED;
    process.env.OPENWOP_KNOWLEDGE_SYNC_DAEMON_ENABLED = 'false'; // the incident-response STOP
    try {
      const result = await buildKnowledgeSyncSurface({ tenantId: t }).runOnce({ sourceId: source.id }) as { status: string; reason?: string };
      expect(result.status).toBe('skipped');
      expect(result.reason).toBe('feature-disabled');
      // Even for an ENABLED tenant, the global switch = zero third-party egress.
      expect(mIngest).not.toHaveBeenCalled();
      expect(mList).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.OPENWOP_KNOWLEDGE_SYNC_DAEMON_ENABLED;
      else process.env.OPENWOP_KNOWLEDGE_SYNC_DAEMON_ENABLED = prev;
    }
  });

  it('an ENABLED, active source runs a pass (egress happens)', async () => {
    const t = 'wf-run';
    await enable(t);
    const source = await createSyncSource(t, 'org1', { connectionId: 'c1', provider: 'google', externalFolderId: 'F', collectionId: 'col', cadence: 'hourly' }, NOW);
    mList.mockResolvedValue({ files: [{ fileId: 'a', name: 'a.doc', mimeType: 'application/vnd.google-apps.document', revision: 'r1' }], complete: true } as never);
    const result = await buildKnowledgeSyncSurface({ tenantId: t }).runOnce({ sourceId: source.id }) as { status: string };
    expect(result.status).toBe('success');
    // The pass reached the KB write — this is the egress a disabled tenant must NOT do.
    expect(mIngest).toHaveBeenCalled();
  });
});

describe('boot backfill (WF-KB-3)', () => {
  it('is idempotent — a source that already has a jobId is not re-registered', async () => {
    const t = 'wf-backfill';
    await enable(t);
    const source = await createSyncSource(t, 'org1', { connectionId: 'c1', provider: 'google', externalFolderId: 'F', collectionId: 'col', cadence: 'daily' }, NOW);
    expect(source.jobId).toBeTruthy();
    // Every source created post-migration already carries a jobId (createSyncSource
    // registers the same workflow+job the backfill would), so the boot backfill —
    // which targets rows WITHOUT a jobId — has nothing to do and re-registers none.
    // The jobless-source registration path itself is the same `registerKnowledgeSyncJob`
    // proven by the registration test above.
    const n = await backfillKnowledgeSyncJobs();
    expect(n).toBe(0);
  });
});
