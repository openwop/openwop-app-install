/**
 * CC-CHAIN-4b — tenants seeded before CC-CHAIN-4 lose their copy of the retired
 * tour alias; the alias itself stays registered so old runs replay.
 *
 * CC-CHAIN-4 (#5826) stopped `seedZeroConfigWorkflows` minting
 * `wf.seed.tour.campaign-studio.first-brief`, but the seeder only skips — it
 * never retracts — and ADR 0789's `internal-seed-retract` is already marked done
 * on every install (and only selects RFC 0135 `internal` chains anyway). So every
 * tenant seeded before kept the retired tour in /builder and the `/` picker,
 * beside its replacement.
 *
 * Pins: the post-listen background job `retired-alias-seed-retract` exists,
 * removes a pristine seeded copy's OWNERSHIP, keeps an edited copy, leaves the
 * definition resolvable (replay/fork), and a second run is a no-op that still
 * reports complete.
 *
 * Red when: no `retired-alias-seed-retract` job exists (pre-fix), or it deletes
 * the definition, or it retracts an edited copy, or a re-run fails.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { setDurableStorage } from '../src/host/durable/durableStore.js';
import { BACKGROUND_APP_JOBS, __resetBackgroundAppJobsForTests } from '../src/host/appMigrations.js';
import { loadWorkflowChainPacks, listChains, expandChain } from '../src/host/workflowChainPackLoader.js';
import { seedWorkflowId } from '../src/host/seedWorkflows.js';
import { recordOwnership, getOwned } from '../src/host/workflowOwnership.js';
import { registerWorkflowDurable, getRegisteredWorkflowStrict } from '../src/host/workflowsRegistry.js';
import { recordRevision } from '../src/host/workflowRevisions.js';
import type { Storage } from '../src/storage/storage.js';

const REPO_ROOT = join(__dirname, '..', '..', '..');
const ALIAS = 'tour.campaign-studio.first-brief';
let storage: Storage;

beforeAll(() => {
  loadWorkflowChainPacks({ roots: [join(REPO_ROOT, 'examples', 'workflow-chain-packs')] });
});
beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  setDurableStorage(storage);
  __resetBackgroundAppJobsForTests();
});

/** Plant the seed exactly as the pre-CC-CHAIN-4 seeder minted it. */
async function plantAliasSeed(tenants: string[]): Promise<{ id: string; nodes: number; def: Record<string, unknown> }> {
  const found = listChains().find(({ chain }) => chain.chainId === ALIAS);
  expect(found, `${ALIAS} must still be in the corpus (kept registered for replay)`).toBeTruthy();
  const id = seedWorkflowId(ALIAS);
  const e = expandChain(found!.chain, { deferred: true });
  const name = (typeof e.metadata?.name === 'string' && e.metadata.name.trim()) ? e.metadata.name : found!.chain.label;
  const def = { ...e, workflowId: id, metadata: { ...e.metadata, name } };
  await registerWorkflowDurable(def);
  await recordRevision('host', def);
  for (const t of tenants) await recordOwnership(t, id, { name: 'p', nodeCount: def.nodes.length });
  return { id, nodes: def.nodes.length, def: def as unknown as Record<string, unknown> };
}

describe('CC-CHAIN-4b — retired-alias seed retract', () => {
  it('the job retracts pristine copies, keeps an edited one, and leaves the definition resolvable', async () => {
    const job = BACKGROUND_APP_JOBS.find((j) => j.id === 'retired-alias-seed-retract');
    expect(job, 'no background job retracts retired-alias seeds').toBeDefined();

    const { id, def } = await plantAliasSeed(['org:cc4b-a', 'org:cc4b-b', 'org:cc4b-edited']);
    // An edited copy: this tenant saved its own revision that differs from the seed.
    await recordRevision('org:cc4b-edited', { ...def, metadata: { ...(def.metadata as object), name: 'My edited tour' } } as never);

    expect(await job!.run(storage)).toEqual({ complete: true });
    expect(await getOwned('org:cc4b-a', id), 'pristine copy still owned').toBeNull();
    expect(await getOwned('org:cc4b-b', id)).toBeNull();
    expect(await getOwned('org:cc4b-edited', id), 'an edited copy must be kept').not.toBeNull();
    // Ownership only — old runs stamped with the id still resolve their definition.
    expect(await getRegisteredWorkflowStrict(id)).not.toBeNull();

    // Idempotent: a second run finds nothing more to do and still completes.
    expect(await job!.run(storage)).toEqual({ complete: true });
    expect(await getOwned('org:cc4b-edited', id)).not.toBeNull();
  });
});
