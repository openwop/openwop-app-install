/**
 * ADR 0789 §Correction — an EMPTY chain corpus never marks the retract job done.
 *
 * A missing pack mount leaves `listChains()` empty even after the retract's own
 * load call. Marking the job done then would disable the retract FOREVER on that
 * install. It must stay pending (and log an error) so the next boot retries.
 * Separate file: the loader mock is file-scoped.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/host/workflowChainPackLoader.js', async (orig) => ({
  ...(await orig<typeof import('../src/host/workflowChainPackLoader.js')>()),
  listChains: () => [],
  loadWorkflowChainPacks: () => [],
}));

const { openStorage } = await import('../src/storage/index.js');
const { initHostExtPersistence } = await import('../src/host/hostExtPersistence.js');
const { setDurableStorage } = await import('../src/host/durable/durableStore.js');
const { startBackgroundAppJobs, BACKGROUND_APP_JOBS, __resetBackgroundAppJobsForTests } = await import('../src/host/appMigrations.js');

describe('ADR 0789 — the retract job with an empty corpus', () => {
  it('is NOT marked done (a failed pack load must not disable the retract forever)', async () => {
    const storage = await openStorage('memory://');
    initHostExtPersistence(storage);
    setDurableStorage(storage);
    __resetBackgroundAppJobsForTests();
    await startBackgroundAppJobs(storage, BACKGROUND_APP_JOBS);
    expect(await storage.getAppMeta('app_bg_job:internal-seed-retract')).toBeNull();
  });
});
