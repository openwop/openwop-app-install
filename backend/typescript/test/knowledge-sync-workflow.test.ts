/**
 * WF-KB-3 / KSWF-1 — the knowledge-sync recurring pass is a registered, owned,
 * replayable `knowledge-sync.run` workflow fired by the ONE host scheduler (the
 * gmailSync twin), NOT the retired bespoke `knowledgeSyncDaemon`. What breaks each case:
 *   - createSyncSource registers a per-source workflow (registered + owned) and an
 *     ENABLED scheduler job — red if registration, ownership or `enabled` is dropped;
 *   - the `knowledge-sync` surface's `runOnce` is the WF-KB-4 SPEND GATE: a DISABLED
 *     tenant, a THROWING toggle resolver (fail-closed), and every spelling of the global
 *     kill switch are typed skips with ZERO egress — red if any half of
 *     `syncEnabledFor` is removed or the catch stops failing closed;
 *   - a source in BACKOFF (`nextAttemptAt` in the future) is a typed skip with zero
 *     egress, and runs once the backoff lapses — red if the surface's backoff check goes;
 *   - an enabled, active source runs a real pass through `syncNow` (untrusted ingest);
 *   - the boot backfill is idempotent over already-migrated sources.
 * In-flight / lease suppression is `syncNow`'s 409, witnessed in
 * `knowledge-sync-runner.test.ts` (crash-recovery case).
 *
 * CORRECTED 2026-10-11 (grade-tests w23): this header used to say backoff was "covered
 * by knowledge-sync-runner + knowledge-sync-daemon's isSyncDue/claimSyncRun cases".
 * It was not: `isSyncDue` has had no product caller since WF-KB-3, and the surface's own
 * backoff skip (`surface.ts`) had no test (probe w23g1-wf-backoff-skip, vacuous). The
 * fail-closed resolver witness, cited by `WORKFLOWS-ASSESSMENT.md` as
 * `knowledge-sync-daemon.test.ts:133-144`, was lost when the daemon was deleted (its
 * `toggleFault` mock outlived it, unflipped); both are now witnessed here.
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

/** Flipped by the fail-closed case to make the toggle resolver throw. */
const toggleFault = vi.hoisted(() => ({ on: false }));
vi.mock('../src/host/featureToggles/service.js', async () => {
  const actual = await vi.importActual<typeof import('../src/host/featureToggles/service.js')>(
    '../src/host/featureToggles/service.js',
  );
  return {
    ...actual,
    resolveOne: (...args: Parameters<typeof actual.resolveOne>) =>
      toggleFault.on ? Promise.reject(new Error('toggle store unavailable')) : actual.resolveOne(...args),
  };
});
vi.mock('../src/features/connections/connectionsService.js', () => ({ getConnection: vi.fn() }));
vi.mock('../src/host/knowledgeSourceFetch.js', () => ({ listFolder: vi.fn(), fetchKnowledgeSource: vi.fn(), fetchKnowledgeSourceBytes: vi.fn() }));
vi.mock('../src/features/kb/kbService.js', () => ({ ingestDocument: vi.fn(), deleteDocument: vi.fn(), getCollection: vi.fn(async () => ({ collectionId: 'col' })) })); // `getCollection` (ADR 0643 R4 Should 3): the runner resolves the target collection as the connection owner BEFORE listing/fetching — a readable stub here, so these tests keep exercising the per-file lanes

import { getConnection, type Connection } from '../src/features/connections/connectionsService.js';
import { listFolder, fetchKnowledgeSource, type SyncFolderListing } from '../src/host/knowledgeSourceFetch.js';
import { ingestDocument, deleteDocument, type KnowledgeDocument } from '../src/features/kb/kbService.js';
import { buildKnowledgeSyncSurface } from '../src/features/knowledge-sync/surface.js';
import {
  createSyncSource, setSyncStatus, syncDocumentId,
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

/** A one-file COMPLETE listing (a Google Doc → the text export path). */
const ONE_FILE: SyncFolderListing = {
  files: [{ fileId: 'a', name: 'a.doc', mimeType: 'application/vnd.google-apps.document', revision: 'r1' }],
  complete: true,
};
const INGESTED: Omit<KnowledgeDocument, 'text'> = {
  documentId: 'd', collectionId: 'col', tenantId: 't', orgId: 'org1', title: 'Doc',
  source: { kind: 'text' }, contentTrust: 'untrusted', chunkCount: 1, createdBy: 'user:owner', createdAt: NOW,
};

async function enable(tenantId: string): Promise<void> {
  const cfg = knowledgeSyncFeature.toggleDefault!;
  await saveConfig({ ...cfg, status: 'on' }, tenantId);
}

const newSource = (t: string, cadence: 'hourly' | 'daily' = 'hourly') =>
  createSyncSource(t, 'org1', { connectionId: 'c1', provider: 'google', externalFolderId: 'F', collectionId: 'col', cadence }, NOW);

beforeAll(async () => {
  const storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() });
  registerToggleDefault(knowledgeSyncFeature.toggleDefault!);
});
beforeEach(() => {
  toggleFault.on = false;
  mConn.mockReset(); mList.mockReset(); mFetch.mockReset(); mIngest.mockReset(); mDelete.mockReset();
  mDelete.mockResolvedValue(undefined);
  // Return a connection whose tenant MATCHES whatever tenant asked (each test uses
  // its own tenant), so the runner's tenant-scoped connection check passes.
  mConn.mockImplementation(async (tenantId: string): Promise<Connection> => ({
    connectionId: 'c1', tenantId, userId: 'user:owner', provider: 'google', kind: 'oauth2',
    displayName: 'D', status: 'active', scopes: [], connectedAt: NOW, updatedAt: NOW,
  }));
  mFetch.mockResolvedValue({ title: 'Doc', text: 'hello world', sourceUrl: 'https://drive.example/a' });
  mIngest.mockResolvedValue(INGESTED);
  mList.mockResolvedValue(ONE_FILE);
});

describe('createSyncSource registers an owned workflow + scheduler job (WF-KB-3)', () => {
  it('the source carries a jobId, and its workflow is registered + owned + scheduled', async () => {
    const t = 'wf-reg';
    await enable(t);
    const source = await newSource(t);
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
    // Enabling an unrelated tenant is load-bearing: a tenant-BLIND toggle read would
    // then see "on" and run this tenant's pass.
    await enable('wf-other');
    // createSyncSource needs the workflow/job; enable briefly to create, then disable.
    await enable(t);
    const source = await newSource(t);
    await saveConfig({ ...knowledgeSyncFeature.toggleDefault!, status: 'off' }, t); // now DISABLED

    const result = await buildKnowledgeSyncSurface({ tenantId: t }).runOnce({ sourceId: source.id });
    expect(result).toEqual({ status: 'skipped', reason: 'feature-disabled' });
    // The WF-KB-4 guarantee: a disabled tenant's fired job does NO third-party egress.
    expect(mIngest).not.toHaveBeenCalled();
    expect(mList).not.toHaveBeenCalled();
  });

  it('a toggle resolver that THROWS fails CLOSED — a typed skip with ZERO egress', async () => {
    const t = 'wf-faulted';
    await enable(t);
    const source = await newSource(t);
    toggleFault.on = true; // the toggle store is unavailable
    try {
      const result = await buildKnowledgeSyncSurface({ tenantId: t }).runOnce({ sourceId: source.id });
      expect(result).toEqual({ status: 'skipped', reason: 'feature-disabled' });
      expect(mList).not.toHaveBeenCalled();
      expect(mIngest).not.toHaveBeenCalled();
    } finally {
      toggleFault.on = false;
    }
  });

  it('the global kill-switch (OPENWOP_KNOWLEDGE_SYNC_DAEMON_ENABLED) stops all egress', async () => {
    const t = 'wf-killswitch';
    await enable(t);
    const source = await newSource(t);
    const prev = process.env.OPENWOP_KNOWLEDGE_SYNC_DAEMON_ENABLED;
    try {
      // Every spelling an operator may type mid-incident (`knowledgeSyncGate.ts` FALSY_ENV).
      for (const stop of ['false', '0', ' OFF ', 'no', 'disabled']) {
        process.env.OPENWOP_KNOWLEDGE_SYNC_DAEMON_ENABLED = stop;
        const result = await buildKnowledgeSyncSurface({ tenantId: t }).runOnce({ sourceId: source.id });
        expect(result, `kill switch value ${JSON.stringify(stop)}`).toEqual({ status: 'skipped', reason: 'feature-disabled' });
      }
      // Even for an ENABLED tenant, the global switch = zero third-party egress.
      expect(mIngest).not.toHaveBeenCalled();
      expect(mList).not.toHaveBeenCalled();
      // …and a non-stop value leaves the (enabled) tenant running.
      process.env.OPENWOP_KNOWLEDGE_SYNC_DAEMON_ENABLED = 'true';
      const ran = await buildKnowledgeSyncSurface({ tenantId: t }).runOnce({ sourceId: source.id });
      expect(ran.status).toBe('success');
    } finally {
      if (prev === undefined) delete process.env.OPENWOP_KNOWLEDGE_SYNC_DAEMON_ENABLED;
      else process.env.OPENWOP_KNOWLEDGE_SYNC_DAEMON_ENABLED = prev;
    }
  });

  it('a source in BACKOFF is a typed skip with ZERO egress, and runs once the backoff lapses', async () => {
    const t = 'wf-backoff';
    await enable(t);
    const source = await newSource(t);
    const next = new Date(Date.parse(NOW) + 60 * 60 * 1000).toISOString();
    await setSyncStatus(t, source.id, 'active', NOW, { retry: { consecutiveFailures: 1, nextAttemptAt: next } });
    const surface = buildKnowledgeSyncSurface({ tenantId: t });

    // one second before the retry time: skipped, nothing fetched
    const early = await surface.runOnce({ sourceId: source.id, actingAt: new Date(Date.parse(next) - 1000).toISOString() });
    expect(early).toEqual({ status: 'skipped', reason: 'backoff' });
    expect(mList).not.toHaveBeenCalled();
    expect(mIngest).not.toHaveBeenCalled();

    // after it: the pass runs
    const late = await surface.runOnce({ sourceId: source.id, actingAt: new Date(Date.parse(next) + 1000).toISOString() });
    expect(late.status).toBe('success');
    expect(mList).toHaveBeenCalledTimes(1);
  });

  it('an ENABLED, active source runs a pass (egress happens)', async () => {
    const t = 'wf-run';
    await enable(t);
    const source = await newSource(t);
    const result = await buildKnowledgeSyncSurface({ tenantId: t }).runOnce({ sourceId: source.id });
    expect(result).toEqual({ status: 'success', ingested: 1, pruned: 0, unchanged: 0, failed: 0 });
    // The pass reached the KB write — this is the egress a disabled tenant must NOT do —
    // with the stable id and the untrusted fence.
    expect(mIngest).toHaveBeenCalledTimes(1);
    expect(mIngest.mock.calls[0]![5]).toEqual({ documentId: syncDocumentId(source.id, 'a'), contentTrust: 'untrusted', silent: true });
  });
});

describe('boot backfill (WF-KB-3)', () => {
  it('is idempotent — a source that already has a jobId is not re-registered', async () => {
    const t = 'wf-backfill';
    await enable(t);
    const source = await newSource(t, 'daily');
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
