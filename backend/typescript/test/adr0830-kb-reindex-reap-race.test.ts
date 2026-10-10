/**
 * ADR 0830 D6 / `KB2WF-4` — a reindex started between the previous job's `done`
 * commit and its driver reap must KEEP its driver.
 *
 * The driver is shared per collection (one `kbReindexJobId`, one
 * `kbReindexWorkflowId`). `drainReindex` reaps only after `drainReindexCore`
 * returns, i.e. after the old-namespace GC and the awaited `reindex.completed`
 * emit. `assertNoLiveReindex` already lets a new `startReindex` through in that
 * window (the job is terminal), and the new start re-registers the SAME job id +
 * workflow id. Pre-fix, the old job's reap then deleted the successor's scheduler
 * job and archived its workflow — leaving a `running` row stamped
 * `driver:'scheduled'` with no server driver at all (reproduced by the
 * grade-workflows pass that filed `KB2WF-4`).
 *
 * The window is opened deterministically: a host-event delivery hook (awaited by
 * `emitHostEvent`) starts reindex #2 when `host.kb.reindex.completed` fires for
 * reindex #1 — the emit sits inside the window by construction.
 *
 * DOUBLE GUARD (measured, wave-6 /grade-tests): `reapKbReindexDriverIfTerminal`
 * re-reads the job row on BOTH sides of the teardown (skip the reap while a live
 * successor owns the row; re-ensure its driver if one appeared during it). Removing
 * either re-read alone keeps this test green; removing both turns it red
 * (`w6g1-reap-both`). And every assertion about the successor runs AFTER the drain:
 * `emitHostEvent` swallows a throwing delivery hook, so an `expect` inside the hook
 * could never fail this test.
 */
import http from 'node:http';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Express } from 'express';
import { createApp } from '../src/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { StartRunDeps } from '../src/host/runStarter.js';
import { __setHeadlessEmbedderForTest, type HeadlessEmbedder } from '../src/host/headlessAi.js';
import { getJob } from '../src/host/schedulingService.js';
import { getRegisteredWorkflowAsync } from '../src/host/workflowsRegistry.js';
import { lifecycleOf } from '../src/host/workflowLifecycle.js';
import { initHostEventDispatcher, __resetHostEventDispatcher } from '../src/host/hostEventDispatcher.js';
import { getOwned } from '../src/host/workflowOwnership.js';
import {
  createCollection, drainReindex, getReindexJob, ingestDocument,
  kbReindexJobId, kbReindexWorkflowId, startReindex, type ReindexJobView,
} from '../src/features/kb/kbService.js';

let server: http.Server;
let app: Express;
const PRE = { preAuthorized: true } as const;

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', res); });
  // Deterministic fake provider embedder — the openai target signature differs
  // from the local floor, so reindex #1 has work; #2 targets `local`, which
  // differs from #1's (now active) openai signature.
  const embedder: HeadlessEmbedder = {
    provider: 'openai', model: 'text-embedding-3-small',
    embed: async (texts: readonly string[]) => texts.map(() => { const v = new Array<number>(256).fill(0); v[1] = 1; return v; }),
  };
  __setHeadlessEmbedderForTest(async () => embedder);
});
afterAll(async () => {
  __setHeadlessEmbedderForTest(null);
  __resetHostEventDispatcher();
  await new Promise<void>((res) => server.close(() => res()));
});

it('KB2WF-4 — a reindex started inside the done→reap window keeps its scheduler job and an un-archived workflow', async () => {
  const tenantId = `reap-race-${Date.now()}`;
  const orgId = 'org-reap-race';
  const col = await createCollection(tenantId, orgId, 'actor', { name: 'Reap race' });
  await ingestDocument(tenantId, orgId, 'actor', col.collectionId, { title: 'Doc', text: '# Heading\nBody text for the reap race.' });
  await startReindex(tenantId, orgId, col.collectionId, { provider: 'openai' });

  // Open the window: when reindex #1 announces completion — AFTER its `done`
  // commit and BEFORE `drainReindex`'s reap — start reindex #2 on the same collection.
  let successorStarted = false;
  let second: ReindexJobView | undefined;
  initHostEventDispatcher({
    storage: app.locals.storage as Storage,
    hostSuite: app.locals.hostSuite as StartRunDeps['hostSuite'],
    deliverWebhooks: async (e) => {
      // Record only — an `expect` here would be swallowed by `emitHostEvent`.
      if (e.type === 'host.kb.reindex.completed' && !successorStarted) {
        successorStarted = true;
        second = await startReindex(tenantId, orgId, col.collectionId, { provider: 'local' }, PRE);
      }
    },
    startRun: async () => null,
  });

  const first = await drainReindex(tenantId, orgId, col.collectionId, 4096, PRE);
  expect(first?.status, 'reindex #1 must complete').toBe('done');
  expect(successorStarted, 'reindex #2 must have started inside the done→reap window').toBe(true);
  // Non-vacuity: the successor really started with a scheduled driver, so anything
  // missing below was removed by the predecessor's reap.
  expect(second?.status).toBe('running');
  expect(second?.driver).toBe('scheduled');

  const successor = await getReindexJob(tenantId, orgId, col.collectionId, PRE);
  expect(successor?.status, 'the successor job is live').toBe('running');
  expect(successor?.driver).toBe('scheduled');

  const schedulerJob = await getJob(kbReindexJobId(tenantId, orgId, col.collectionId));
  expect(schedulerJob, "the successor's scheduler job must survive the predecessor's reap").toBeTruthy();
  expect(schedulerJob!.enabled).toBe(true);

  const workflowId = kbReindexWorkflowId(tenantId, orgId, col.collectionId);
  const def = await getRegisteredWorkflowAsync(workflowId);
  expect(def, "the successor's workflow must still be registered").toBeTruthy();
  expect(lifecycleOf(def!).archivedAt, "the successor's workflow must NOT be archived").toBeFalsy();
  expect((await getOwned(tenantId, workflowId))?.archivedAt, 'nor its ownership row').toBeFalsy();
}, 30_000);
