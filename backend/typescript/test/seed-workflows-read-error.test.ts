/**
 * SEEDRM-1 — a FAILED registry read must not license an overwrite.
 *
 * `getRegisteredWorkflowAsync` returns `null` when the durable `kvGet` throws, so
 * the seeder's register-if-missing read could not tell "never seeded" from
 * "storage hiccuped" and re-registered over the global `wfreg:` row every tenant
 * runs — the same rewrite `seed-workflows-cold-boot.test.ts` pins for a cold
 * cache, reached through a transient read error instead. The seeder now uses
 * `getRegisteredWorkflowStrict`, which throws into its per-chain skip.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { setDurableStorage } from '../src/host/durable/durableStore.js';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import {
  registerWorkflowDurable, getRegisteredWorkflowAsync, getRegisteredWorkflowStrict, __resetWorkflowRegistryForTests,
} from '../src/host/workflowsRegistry.js';
import { loadWorkflowChainPacks, _resetChainRegistryForTest } from '../src/host/workflowChainPackLoader.js';
import { seedZeroConfigWorkflows } from '../src/host/seedWorkflows.js';

const ID = 'wf.seed.starters-webhook-notify';
let storage: Storage;

beforeAll(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  setDurableStorage(storage);
  _resetChainRegistryForTest();
  loadWorkflowChainPacks({ roots: [join(import.meta.dirname, '../../../examples/workflow-chain-packs')] });
});

/** Make `kvGet` throw for the registry row of `id` while `fn` runs. */
async function withFailingRead<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const real = storage.kvGet.bind(storage);
  storage.kvGet = async (k: string) => {
    if (k.endsWith(id)) throw new Error('simulated transient storage error');
    return real(k);
  };
  try { return await fn(); } finally { storage.kvGet = real; }
}

describe('SEEDRM-1 — a registry read error never overwrites a seeded definition', () => {
  it('the seeder skips the chain instead of re-registering over a tenant edit', async () => {
    await seedZeroConfigWorkflows('tenant-seedrm-a');
    const seeded = await getRegisteredWorkflowAsync(ID);
    expect(seeded, `expected ${ID} to be seeded — chain renamed?`).not.toBeNull();
    await registerWorkflowDurable({ ...seeded!, metadata: { ...seeded!.metadata, name: 'Edited by a tenant' } });

    __resetWorkflowRegistryForTests(); // cold instance, so the read really reaches storage
    await withFailingRead(ID, () => seedZeroConfigWorkflows('tenant-seedrm-b'));

    __resetWorkflowRegistryForTests();
    const after = await getRegisteredWorkflowAsync(ID);
    expect(after?.metadata?.name, 'a failed read was taken as "absent" and the shared row overwritten')
      .toBe('Edited by a tenant');
  });

  it('the strict reader throws on a read error and still returns null for a genuinely absent row', async () => {
    __resetWorkflowRegistryForTests();
    await expect(withFailingRead(ID, () => getRegisteredWorkflowStrict(ID))).rejects.toThrow(/simulated/);
    expect(await getRegisteredWorkflowStrict('wf.seed.never-registered')).toBeNull();
  });
});
