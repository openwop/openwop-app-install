/**
 * ADR 0643 D1b + D2 — the reindex completes WITHOUT A BROWSER, and the node that
 * drives it is not a general-purpose verb.
 *
 * ── WHY THE WITNESS IS SHAPED THE WAY IT IS ─────────────────────────────────
 *
 * "The drain finished" is not, on its own, evidence that the SCHEDULER drove it:
 * a test that only checks the end state passes just as happily when the fire was
 * silently skipped and something else did the work. And the two ways this
 * mechanism dies are both SKIPS, not errors:
 *
 *   - `featureId` on the job. `kb` graduated its toggle, `resolveOne` answers
 *     `null` for a feature with no registered default, and `scheduleDaemon`
 *     treats `null` as disabled: `recordJobSkipped(_, 'feature-disabled')`, an
 *     `info` log, forever, invisibly.
 *   - the autonomous-run budget. An over-budget fire is DROPPED, not queued:
 *     `recordJobSkipped(_, 'budget')`.
 *
 * Both would read here as "the run just did not happen yet", i.e. as a flaky
 * timeout. So every scheduled leg asserts POSITIVELY that the fire happened
 * (`lastRunAt` advanced, a run row exists) AND that `lastSkipReason` is absent.
 * The sabotage that proves this is load-bearing: put `featureId: 'kb'` back on
 * the job and the positive leg goes red on `lastSkipReason === 'feature-disabled'`.
 *
 * @see docs/adr/0643-kb-reindex-orchestration-write-surface-lifecycle-events.md (D1b, D2)
 */

import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/index.js';
import { buildHostSurfaceBundle } from '../src/host/inMemorySurfaces.js';
import { tryDurableStorage } from '../src/host/durable/durableStore.js';
import { __setHeadlessEmbedderForTest } from '../src/host/headlessAi.js';
import { processDueSchedules } from '../src/host/scheduleDaemon.js';
import { getJob, listJobs } from '../src/host/schedulingService.js';
import { getRegisteredWorkflowAsync } from '../src/host/workflowsRegistry.js';
import { lifecycleOf } from '../src/host/workflowLifecycle.js';
import { __runTransientDefGcOnce } from '../src/host/runRetentionSweeper.js';
import { getOwned, listOwned } from '../src/host/workflowOwnership.js';
import { getChain } from '../src/host/workflowChainPackLoader.js';
import type { StartRunDeps } from '../src/host/runStarter.js';
import {
  cancelReindex, createCollection, getReindexJob, ingestDocument,
  kbReindexJobId, kbReindexWorkflowId, startReindex,
} from '../src/features/kb/kbService.js';

let server: http.Server;
let n = 0;

/** A deterministic fake provider embedder — no real credentials, and the target
 *  signature differs from the local floor so `startReindex` has work to do. */
function fakeEmbedder(): void {
  __setHeadlessEmbedderForTest(async () => ({
    provider: 'openai', model: 'text-embedding-3-small',
    embed: async (texts: string[]) => texts.map((t) => { const v = new Array(256).fill(0); v[Math.abs(hash(t)) % 256] = 1; return v; }),
  }) as never);
}
function hash(s: string): number { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return h; }

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', res); });
  fakeEmbedder();
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

/** The daemon's deps: the app's own durable storage, and a catalog that resolves
 *  from the SAME registry `ensureKbReindexDriver` wrote to — so the fire runs the
 *  real chain-expanded definition through the real executor and the real pack
 *  node, not a stub. */
const daemonDeps = (): StartRunDeps => ({
  storage: tryDurableStorage()!,
  hostSuite: {
    workflowCatalog: {
      getWorkflow: async (workflowId: string) => {
        const definition = await getRegisteredWorkflowAsync(workflowId);
        return definition ? { workflowId, definition } : null;
      },
    },
    providerPolicyResolver: { resolveForRun: async () => [] },
  },
} as unknown as StartRunDeps);

async function fixture(docs = 3): Promise<{ tenantId: string; orgId: string; collectionId: string }> {
  const tenantId = `kbd-${Date.now()}-${n++}`;
  const orgId = 'org-reindex';
  const col = await createCollection(tenantId, orgId, 'actor', { name: 'Reindexable' });
  for (let i = 0; i < docs; i++) {
    await ingestDocument(tenantId, orgId, 'actor', col.collectionId, { title: `Doc ${i}`, text: `# Section ${i}\nBody of document ${i} with searchable content.` });
  }
  return { tenantId, orgId, collectionId: col.collectionId };
}

describe('D1b — startReindex registers a scheduler-driven driver', () => {
  it('the kb.reindex chain is loaded and instantiates into an OWNED, registered per-collection workflow', async () => {
    const { tenantId, orgId, collectionId } = await fixture();
    expect(getChain('kb.reindex'), 'the kb-reindex workflow-chain pack must be installed').toBeTruthy();

    await startReindex(tenantId, orgId, collectionId, { provider: 'openai' });

    const workflowId = kbReindexWorkflowId(tenantId, orgId, collectionId);
    // Tenant-qualified (review #10): `registerWorkflowDurable` is a GLOBAL
    // id-keyed map and `orgId` is caller-suppliable, so an id without the tenant
    // is squattable across tenants.
    expect(workflowId).toBe(`kb.reindex:${tenantId}:${orgId}:${collectionId}`);
    expect(await getRegisteredWorkflowAsync(workflowId), 'resolvable for run/:fork/replay').toBeTruthy();
    expect(await getOwned(tenantId, workflowId), 'in the tenant ownership index ⇒ visible + editable').not.toBeNull();
  });

  it('the job carries NO featureId and a */10 cadence — the two divergences that decide whether it ever fires', async () => {
    const { tenantId, orgId, collectionId } = await fixture();
    await startReindex(tenantId, orgId, collectionId, { provider: 'openai' });
    const job = await getJob(kbReindexJobId(tenantId, orgId, collectionId));

    expect(job, 'a scheduler job must exist for the collection').toBeTruthy();
    expect(job!.workflowId).toBe(kbReindexWorkflowId(tenantId, orgId, collectionId));
    expect(job!.enabled).toBe(true);
    // THE divergence from `knowledge-sync`. `kb` graduated its toggle, so a
    // `featureId` here would make `resolveOne` answer null and the daemon skip
    // EVERY fire forever. Asserted as an ABSENCE because that is what it is.
    expect(job!.featureId, 'featureId on a graduated feature makes the whole mechanism inert').toBeUndefined();
    // Not per-minute: the autonomous-run budget is 120/h, consumed on denial,
    // and an over-budget fire is dropped — which D1a would then cancel.
    expect(job!.cronExpr).toBe('*/10 * * * *');
    expect(job!.nextFireAt, 'an unparseable cron leaves nextFireAt undefined ⇒ the daemon never sees it').toBeTypeOf('number');
  });
});

describe('D1b — the drain completes with NO browser', () => {
  it('a scheduled fire runs the chain and drains the reindex to `done`, then tears the driver down', async () => {
    const { tenantId, orgId, collectionId } = await fixture(3);
    const started = await startReindex(tenantId, orgId, collectionId, { provider: 'openai' });
    expect(started.status).toBe('running');
    expect(started.embeddedChunks).toBe(0);
    // R3 Should 7 — the row SAYS which driver it has, so the console can too.
    expect(started.driver).toBe('scheduled');
    const jobId = kbReindexJobId(tenantId, orgId, collectionId);
    const workflowId = kbReindexWorkflowId(tenantId, orgId, collectionId);
    // R3 Should 3/4 — TRANSIENT and host-stamped: hidden from the gallery/picker, and
    // collectable by the transient GC rather than deleted under its runs.
    expect(lifecycleOf((await getRegisteredWorkflowAsync(workflowId))!)).toMatchObject({ transient: true, generatedBy: 'kb.reindex' });
    expect((await getOwned(tenantId, workflowId))?.transient).toBe(true);

    // Fire the slot the way the live daemon does — no HTTP, no browser, no SPA loop.
    const due = (await getJob(jobId))!.nextFireAt!;
    const fired = await processDueSchedules(daemonDeps(), due);

    // NOT A SKIP — asserted FIRST, because it is the diagnostic one. The two
    // ways this mechanism dies (`feature-disabled`, `budget`) both look like
    // "the run has not happened yet" from the end state.
    const afterFire = await getJob(jobId);
    expect(afterFire?.lastSkipReason, 'the fire was SKIPPED, not run — a skip reads exactly like a flaky timeout').toBeUndefined();
    // POSITIVE: this instance actually started a run for a due job.
    expect(fired, 'the daemon must have STARTED a run — a 0 here is the silent-skip failure').toBeGreaterThan(0);
    expect(afterFire?.lastRunAt).toBeTruthy();

    // The run executes asynchronously (`setImmediate(executeRun)`), so wait for
    // the job the RUN is driving to reach a terminal state — the reindex job,
    // not the scheduler job.
    let job = await getReindexJob(tenantId, orgId, collectionId, { preAuthorized: true });
    for (let i = 0; i < 120 && job && (job.status === 'running' || job.status === 'paused'); i++) {
      await new Promise((r) => setTimeout(r, 25));
      job = await getReindexJob(tenantId, orgId, collectionId, { preAuthorized: true });
    }
    expect(job?.status, `reindex did not finish (last: ${JSON.stringify(job)})`).toBe('done');
    expect(job!.embeddedChunks).toBe(job!.totalChunks);

    // TEARDOWN (R3 Should 3 — CORRECTED): the scheduler job goes; the definition and
    // its ownership row are ARCHIVED, not deleted, because the run this fire just
    // recorded replays against the definition by id (ADR 0369/0440 — the same rule
    // `routes/workflows.ts` enforces with `workflow_referenced`). Archived + transient
    // is invisible to the gallery/picker and is what the retention sweeper's transient
    // GC collects once the run is pruned. `kb-node-replay.test.ts` forks that run.
    expect(await getJob(jobId)).toBeFalsy();
    const def = await getRegisteredWorkflowAsync(workflowId);
    expect(def, 'a definition with a recorded run must STILL resolve').not.toBeNull();
    expect(lifecycleOf(def!).archivedAt, 'archived, never deleted under its run').toBeTruthy();
    const owned = await getOwned(tenantId, workflowId);
    expect(owned?.archivedAt).toBeTruthy();
    expect(owned?.transient).toBe(true);
  }, 30_000);

  it('after N reindexes that never RAN, the reap ARCHIVES each driver and the transient GC tick leaves ZERO `kb.reindex:` rows', async () => {
    const { tenantId, orgId, collectionId } = await fixture(2);
    const workflowId = kbReindexWorkflowId(tenantId, orgId, collectionId);
    for (let i = 0; i < 3; i++) {
      // Each cycle: start (registers a driver) then cancel (terminal ⇒ reap). R4 Should
      // 4: the reap ALWAYS archives — deleting a "never-fired" driver in the reap raced
      // a dispatch past definition resolution but before its run row landed. The ONE
      // deleter is the retention sweeper's transient GC, which runs with run rows settled.
      await startReindex(tenantId, orgId, collectionId, { provider: 'openai' });
      expect(await getOwned(tenantId, workflowId)).not.toBeNull();
      await cancelReindex(tenantId, orgId, collectionId, { preAuthorized: true });
      const archived = await getOwned(tenantId, workflowId);
      expect(archived?.archivedAt, 'the reap archives, never deletes').toBeTruthy();
      expect(archived?.transient).toBe(true);
    }
    const gc = await __runTransientDefGcOnce(tryDurableStorage()!);
    expect(gc.gcDeleted, 'the GC tick is what reclaims the archived driver').toBeGreaterThanOrEqual(1);
    const owned = await listOwned(tenantId);
    expect(owned.filter((o) => o.workflowId.startsWith('kb.reindex:')), JSON.stringify(owned.map((o) => o.workflowId))).toEqual([]);
    expect(await getRegisteredWorkflowAsync(kbReindexWorkflowId(tenantId, orgId, collectionId))).toBeNull();
    expect((await listJobs(tenantId)).filter((j) => j.jobId.startsWith('kbreindex:'))).toEqual([]);
  });

  it('a BUDGET-paused job is left enabled and resumes on the next tick — it is not cancelled', async () => {
    process.env.OPENWOP_EMBED_BUDGET_TOKENS_PER_DAY = '1'; // impossibly low ⇒ the first batch pauses
    try {
      const { tenantId, orgId, collectionId } = await fixture(2);
      await startReindex(tenantId, orgId, collectionId, { provider: 'openai' });
      const scope = { tenantId, runId: `r-${n++}`, workflowId: kbReindexWorkflowId(tenantId, orgId, collectionId) };
      const out = await buildHostSurfaceBundle(scope).features.kb!.reindexDrain!({ orgId, collectionId });
      expect(out.status).toBe('paused');
      expect(out.done).toBe(false);
      // The driver SURVIVES a pause — that is the whole point: it is what removes
      // the ordinary path into D1a's lease expiry.
      expect(await getJob(kbReindexJobId(tenantId, orgId, collectionId))).toBeTruthy();

      delete process.env.OPENWOP_EMBED_BUDGET_TOKENS_PER_DAY; // budget rolls over
      // R3 Should 8 — the RESUME is a real scheduler tick, not a second direct call
      // to the surface: fire the job's next slot the way the daemon does and wait
      // for the reindex row (the thing the run drives) to reach `done`.
      const jobId = kbReindexJobId(tenantId, orgId, collectionId);
      const due = (await getJob(jobId))!.nextFireAt!;
      expect(await processDueSchedules(daemonDeps(), due), 'the daemon must have STARTED the resume run').toBeGreaterThan(0);
      expect((await getJob(jobId))?.lastSkipReason, 'a paused job must not be skipped on its next tick').toBeUndefined();
      let job = await getReindexJob(tenantId, orgId, collectionId, { preAuthorized: true });
      for (let i = 0; i < 120 && job && (job.status === 'running' || job.status === 'paused'); i++) {
        await new Promise((r) => setTimeout(r, 25));
        job = await getReindexJob(tenantId, orgId, collectionId, { preAuthorized: true });
      }
      expect(job?.status, `the scheduled resume did not finish (last: ${JSON.stringify(job)})`).toBe('done');
      // ...and NOW it is torn down.
      expect(await getJob(jobId)).toBeFalsy();
    } finally {
      delete process.env.OPENWOP_EMBED_BUDGET_TOKENS_PER_DAY;
    }
  });
});

describe('D2 — reindexDrain is STRUCTURALLY scoped, not a general-purpose verb', () => {
  it('an ARBITRARY tenant chain declaring the node is REFUSED with a typed error, at the node boundary', async () => {
    const { tenantId, orgId, collectionId } = await fixture(2);
    await startReindex(tenantId, orgId, collectionId, { provider: 'openai' });

    // A workflow the tenant authored itself. Same tenant, same org, live job —
    // everything except the host-minted workflow id.
    const attacker = buildHostSurfaceBundle({ tenantId, runId: 'r-evil', workflowId: 'my-innocent-chain' }).features.kb!;
    await expect(attacker.reindexDrain!({ orgId, collectionId }))
      .rejects.toMatchObject({ code: 'validation_error', httpStatus: 403 });
    // The refusal is not an existence oracle: it names neither the expected id
    // nor whether the collection is reindexing.
    await attacker.reindexDrain!({ orgId, collectionId }).catch((err: Error) => {
      expect(err.message).not.toContain(collectionId);
      expect(err.message).not.toContain('kb.reindex:');
    });
    // ...and nothing was drained.
    expect((await getReindexJob(tenantId, orgId, collectionId, { preAuthorized: true }))!.embeddedChunks).toBe(0);
    await expect(attacker.reindexStatus!({ orgId, collectionId })).rejects.toMatchObject({ httpStatus: 403 });
  });

  it('R3 Should 4 — a HUMAN-started run of the driver workflow is refused: the right id is not enough, a schedule fire has no acting user', async () => {
    const { tenantId, orgId, collectionId } = await fixture(2);
    await startReindex(tenantId, orgId, collectionId, { provider: 'openai' });
    // Every fact the old gate checked is satisfied — same tenant, live job, the
    // host-minted workflow id — plus the ONE fact a human-started run always
    // carries and a schedule fire never does.
    const human = buildHostSurfaceBundle({ tenantId, runId: 'r-human', workflowId: kbReindexWorkflowId(tenantId, orgId, collectionId), actingUserId: 'user:any-member' }).features.kb!;
    await expect(human.reindexDrain!({ orgId, collectionId })).rejects.toMatchObject({ code: 'validation_error', httpStatus: 403 });
    await expect(human.reindexStatus!({ orgId, collectionId })).rejects.toMatchObject({ httpStatus: 403 });
    expect((await getReindexJob(tenantId, orgId, collectionId, { preAuthorized: true }))!.embeddedChunks, 'nothing drained').toBe(0);
    // Positive control: the same scope WITHOUT an acting user is the scheduler's, and drains.
    const fire = buildHostSurfaceBundle({ tenantId, runId: 'r-fire', workflowId: kbReindexWorkflowId(tenantId, orgId, collectionId) }).features.kb!;
    expect((await fire.reindexDrain!({ orgId, collectionId })).done).toBe(true);
  });

  it('a run with NO workflowId (a surface-direct caller) is refused', async () => {
    const { tenantId, orgId, collectionId } = await fixture(2);
    await startReindex(tenantId, orgId, collectionId, { provider: 'openai' });
    const direct = buildHostSurfaceBundle({ tenantId }).features.kb!;
    await expect(direct.reindexDrain!({ orgId, collectionId })).rejects.toMatchObject({ httpStatus: 403 });
  });

  it('the RIGHT workflow with NO live job is refused too — both facts are required', async () => {
    const { tenantId, orgId, collectionId } = await fixture(2);
    // No startReindex ⇒ no job. Only the admin-gated REST door creates one.
    const kb = buildHostSurfaceBundle({ tenantId, workflowId: kbReindexWorkflowId(tenantId, orgId, collectionId) }).features.kb!;
    await expect(kb.reindexDrain!({ orgId, collectionId })).rejects.toMatchObject({ code: 'conflict', httpStatus: 409 });
  });

  it('a CROSS-TENANT id cannot be squatted — the workflow id carries the tenant', async () => {
    const a = await fixture(2);
    await startReindex(a.tenantId, a.orgId, a.collectionId, { provider: 'openai' });
    // Tenant B guesses A's org+collection and mints what a tenant-less id would be.
    const bogus = `kb.reindex:${a.orgId}:${a.collectionId}`;
    const b = buildHostSurfaceBundle({ tenantId: 'other-tenant', workflowId: bogus }).features.kb!;
    await expect(b.reindexDrain!({ orgId: a.orgId, collectionId: a.collectionId })).rejects.toMatchObject({ httpStatus: 403 });
  });

  it('the surface exposes EXACTLY the two new verbs — ingest is deliberately NOT on it', async () => {
    const kb = buildHostSurfaceBundle({ tenantId: 'shape-probe' }).features.kb!;
    expect(Object.keys(kb).sort()).toEqual(['listCollections', 'rag', 'reindexDrain', 'reindexStatus', 'retrieve', 'search']);
    // The media path is replay-unsafe by design (`kbService` declares it sound
    // only because every caller is a non-recorded service op), so no ingest verb.
    expect(kb).not.toHaveProperty('ingest');
    expect(kb).not.toHaveProperty('ingestDocument');
  });
});
