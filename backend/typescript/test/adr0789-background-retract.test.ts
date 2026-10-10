/**
 * ADR 0789 §Correction — the internal-seed ownership retract must NEVER gate boot.
 *
 * It shipped as APP_MIGRATIONS v22, which `recordAppVersion` awaits inside
 * `createApp` — before `listen`. In production (~1,000 ownership rows, a full
 * scheduler-job scan per row) it outlasted Cloud Run's 4-minute startup probe, the
 * revision never became Ready, and the deploy was rolled back partially applied.
 *
 * Pinned here:
 *  1. boot (the real `runAppMigrations` over the real `APP_MIGRATIONS`) no longer
 *     retracts anything;
 *  2. the post-listen runner returns without waiting on a job, marks a job done
 *     only when it reports complete, and skips a done job on the next boot;
 *  3. the retract's cost does not scale with a scan per row (the 0.4 rows/s cause);
 *  4. it is idempotent over a PARTIALLY applied state (what prod was left in);
 *  5. the listen callback is where the runner starts, and `createApp` never starts it.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { setDurableStorage } from '../src/host/durable/durableStore.js';
import type { Storage } from '../src/storage/storage.js';
import {
  APP_MIGRATIONS, APP_MIGRATION_KEY, runAppMigrations,
  startBackgroundAppJobs, __resetBackgroundAppJobsForTests, BACKGROUND_APP_JOBS, type BackgroundAppJob,
} from '../src/host/appMigrations.js';
import { loadWorkflowChainPacks, listChains, expandChain } from '../src/host/workflowChainPackLoader.js';
import { seedWorkflowId, retractInternalSeedOwnership } from '../src/host/seedWorkflows.js';
import { recordOwnership, getOwned, allOwnershipByWorkflow } from '../src/host/workflowOwnership.js';
import { registerWorkflowDurable } from '../src/host/workflowsRegistry.js';
import { recordRevision } from '../src/host/workflowRevisions.js';
import { registerJob } from '../src/host/schedulingService.js';
import { DurableCollection } from '../src/host/hostExtPersistence.js';

const REPO_ROOT = join(__dirname, '..', '..', '..');
let storage: Storage;
let internalId = '';

async function plantInternalSeed(tenants: string[]): Promise<void> {
  const found = listChains().find(({ chain }) => chain.internal === true
    && !(((chain.parameters as { required?: unknown[] }).required ?? []).length > 0))!;
  internalId = seedWorkflowId(found.chain.chainId);
  const e = expandChain(found.chain, { deferred: true });
  const name = (typeof e.metadata?.name === 'string' && e.metadata.name.trim()) ? e.metadata.name : found.chain.label;
  const def = { ...e, workflowId: internalId, metadata: { ...e.metadata, name } };
  await registerWorkflowDurable(def);
  await recordRevision('host', def);
  for (const t of tenants) await recordOwnership(t, internalId, { name: 'p', nodeCount: def.nodes.length });
}

beforeAll(() => {
  loadWorkflowChainPacks({ roots: [join(REPO_ROOT, 'examples', 'workflow-chain-packs')] });
});
beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  setDurableStorage(storage);
  __resetBackgroundAppJobsForTests();
});

describe('ADR 0789 §Correction — the retract never gates boot', () => {
  it('1. boot migrations (real APP_MIGRATIONS from v21) retract NOTHING', async () => {
    await plantInternalSeed(['org:boot-a', 'org:boot-b']);
    await storage.setAppMeta(APP_MIGRATION_KEY, '21');
    await runAppMigrations(storage, APP_MIGRATIONS);
    expect(await getOwned('org:boot-a', internalId), 'v22 still retracts inside boot').not.toBeNull();
    expect(await getOwned('org:boot-b', internalId)).not.toBeNull();
  });

  it('2a. the post-listen runner returns BEFORE a slow job finishes', async () => {
    let release!: () => void;
    let finished = false;
    const slow: BackgroundAppJob = {
      id: 'test-slow',
      run: () => new Promise((resolve) => { release = () => { finished = true; resolve({ complete: true }); }; }),
    };
    const handle = startBackgroundAppJobs(storage, [slow]);
    // The caller got control back while the job is still pending.
    expect(finished).toBe(false);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(finished).toBe(false);
    release();
    await handle;
    expect(finished).toBe(true);
    expect(await storage.getAppMeta('app_bg_job:test-slow')).toBe('done');
  });

  it('2b. an incomplete run is NOT marked done (the next boot resumes it); a done job is skipped', async () => {
    const runs: string[] = [];
    const flaky: BackgroundAppJob = { id: 'test-flaky', run: async () => { runs.push('x'); return { complete: runs.length > 1 }; } };
    await startBackgroundAppJobs(storage, [flaky]);
    expect(await storage.getAppMeta('app_bg_job:test-flaky')).toBeNull();
    __resetBackgroundAppJobsForTests(); // next boot
    await startBackgroundAppJobs(storage, [flaky]);
    expect(await storage.getAppMeta('app_bg_job:test-flaky')).toBe('done');
    __resetBackgroundAppJobsForTests();
    await startBackgroundAppJobs(storage, [flaky]);
    expect(runs).toHaveLength(2);
  });

  it('2c. a throwing job never escapes the runner (it is logged and retried next boot)', async () => {
    const boom: BackgroundAppJob = { id: 'test-boom', run: async () => { throw new Error('boom'); } };
    await expect(startBackgroundAppJobs(storage, [boom])).resolves.toBeUndefined();
    expect(await storage.getAppMeta('app_bg_job:test-boom')).toBeNull();
  });

  it('2e. a HUNG job cannot wedge the runner: it times out (not done) and the next job still runs', async () => {
    const hung: BackgroundAppJob = { id: 'test-hung', run: () => new Promise(() => { /* never settles */ }) };
    let afterRan = false;
    const after: BackgroundAppJob = { id: 'test-after', run: async () => { afterRan = true; return { complete: true }; } };
    await startBackgroundAppJobs(storage, [hung, after], { jobDeadlineMs: 20 });
    expect(await storage.getAppMeta('app_bg_job:test-hung')).toBeNull();
    expect(afterRan).toBe(true);
    expect(await storage.getAppMeta('app_bg_job:test-after')).toBe('done');
  });

  it('2f. a settled run clears the in-flight latch, so a later call runs again', async () => {
    let n = 0;
    const counter: BackgroundAppJob = { id: 'test-counter', run: async () => { n += 1; return { complete: false }; } };
    await startBackgroundAppJobs(storage, [counter]);
    await startBackgroundAppJobs(storage, [counter]);
    expect(n).toBe(2);
  });

  it('2d. the REAL job runs the retract and marks itself done', async () => {
    await plantInternalSeed(['org:job-a']);
    await startBackgroundAppJobs(storage, BACKGROUND_APP_JOBS);
    expect(await getOwned('org:job-a', internalId)).toBeNull();
    expect(await storage.getAppMeta('app_bg_job:internal-seed-retract')).toBe('done');
  });

  it('3. the retract does a CONSTANT number of collection scans, not one per ownership row', async () => {
    const tenants = Array.from({ length: 120 }, (_, i) => `org:scan-${i}`);
    await plantInternalSeed(tenants);
    for (let i = 0; i < 40; i += 1) {
      await registerJob({ jobId: `job-scan-${i}`, tenantId: `org:other-${i}`, cronExpr: '0 * * * *', workflowId: 'wf-unrelated', timezone: 'UTC' });
    }
    const listSpy = vi.spyOn(DurableCollection.prototype, 'list');
    const r = await retractInternalSeedOwnership({ yieldEvery: 10 });
    const scans = listSpy.mock.calls.length;
    listSpy.mockRestore();
    expect(r.retracted).toBe(120);
    expect(scans, `${scans} full collection scans for 120 rows — a per-row scan is back`).toBeLessThan(10);
  });

  it('4. idempotent over a PARTIALLY applied state, and a second pass does nothing', async () => {
    const tenants = ['org:p-1', 'org:p-2', 'org:p-3', 'org:p-4'];
    await plantInternalSeed(tenants);
    // Simulate the killed deploy: half already retracted.
    const { removeOwnership } = await import('../src/host/workflowOwnership.js');
    await removeOwnership('org:p-1', internalId);
    await removeOwnership('org:p-2', internalId);
    const first = await retractInternalSeedOwnership();
    expect(first.retracted).toBe(2);
    expect(first.failed).toBe(0);
    const second = await retractInternalSeedOwnership();
    expect(second.retracted).toBe(0);
    expect((await allOwnershipByWorkflow()).get(internalId) ?? []).toEqual([]);
  });

  it('5. the runner is started from the listen callback in main(), never from createApp', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'index.ts'), 'utf8');
    const createAppBody = src.slice(src.indexOf('export async function createApp('), src.indexOf('async function main('));
    expect(createAppBody).not.toContain('startBackgroundAppJobs(');
    const listenAt = src.indexOf('app.listen(config.port');
    const startAt = src.indexOf('startBackgroundAppJobs(storage)');
    expect(listenAt).toBeGreaterThan(0);
    expect(startAt, 'the background runner must start AFTER listen').toBeGreaterThan(listenAt);
  });
});
