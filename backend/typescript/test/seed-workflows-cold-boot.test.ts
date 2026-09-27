/**
 * ADR 0498 §Open / grade-data RI-1 — a COLD INSTANCE MUST NOT REWRITE AN
 * ALREADY-SEEDED DEFINITION.
 *
 * `wfreg:<workflowId>` has no tenant component, so the seeded definition is one
 * global row every tenant's ownership points at. The seeder's register-if-missing
 * check used `getRegisteredWorkflow` — a process-local Map with no boot
 * hydration — so on a fresh Cloud Run instance it always missed, re-expanded the
 * chain, and overwrote that row.
 *
 * That was harmless only while expansion output never changed. ADR 0498 added
 * chain parameters, which changed `expansionId` and therefore EVERY node id for
 * 77 of 169 chains. A run recorded before such a rewrite then replays against a
 * definition whose node ids no longer match, so it misses BOTH
 * `sourceOutcomes` (`replay_source_missing`) and the invocation-log cache key
 * (`providerKey` is per-node) — and a "deterministic replay" live-dispatches the
 * model. That is precisely the non-determinism the Layer-2 cache exists to stop.
 *
 * The regression is invisible in-process: the sync Map is warm after the first
 * seed, so only a genuinely cold cache reproduces it. These tests clear the
 * cache deliberately rather than hoping.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { setDurableStorage } from '../src/host/durable/durableStore.js';
import { openStorage } from '../src/storage/index.js';
import {
  registerWorkflowDurable, getRegisteredWorkflow, getRegisteredWorkflowAsync, __resetWorkflowRegistryForTests,
} from '../src/host/workflowsRegistry.js';
import { loadWorkflowChainPacks, listChains, _resetChainRegistryForTest } from '../src/host/workflowChainPackLoader.js';
import { seedZeroConfigWorkflows } from '../src/host/seedWorkflows.js';

const TENANT = 'tenant-seed-cold';

beforeAll(async () => {
  const storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  // The workflow REGISTRY reads a different seam than host-ext persistence —
  // without this its durable read returns null, the async lookup always misses,
  // and the harness would silently measure the un-fixed path.
  setDurableStorage(storage);
  _resetChainRegistryForTest();
  loadWorkflowChainPacks({ roots: [join(import.meta.dirname, '../../../examples/workflow-chain-packs')] });
});

describe('seeded definitions survive a cold instance', () => {
  it('a second seed on a COLD cache does not rewrite the durable definition', async () => {
    await seedZeroConfigWorkflows(TENANT);

    // Find one seeded definition and remember exactly what shipped.
    const seededId = 'wf.seed.starters-webhook-notify';
    const first = await getRegisteredWorkflowAsync(seededId);
    expect(first, `expected ${seededId} to be seeded — chain renamed?`).not.toBeNull();
    const beforeNodeIds = first!.nodes.map((n) => n.nodeId);
    expect(beforeNodeIds.length).toBeGreaterThan(0); // non-vacuous

    // Simulate the ACTUAL hazard, not just a cold boot: a deploy that changed
    // the pack. Re-expanding an UNCHANGED chain yields identical node ids, so a
    // cold re-seed alone proves nothing — the sabotage probe confirmed this test
    // stayed green against the defect until the chain also changed. ADR 0498
    // changed `expansionId` (and therefore every node id) for 77 of 169 chains
    // by adding params, which is exactly this shape.
    const loaded = listChains().find((c) => c.chain.chainId === 'starters.webhook-notify')!.chain;
    const params = (loaded.parameters ?? {}) as { properties?: Record<string, unknown> };
    params.properties = { ...(params.properties ?? {}), addedByADeploy: { type: 'string', default: 'x' } };

    // Fresh Cloud Run instance: durable storage intact, cache empty.
    __resetWorkflowRegistryForTests();
    expect(getRegisteredWorkflow(seededId), 'cache must actually be cold').toBeUndefined();

    await seedZeroConfigWorkflows(TENANT);

    const after = await getRegisteredWorkflowAsync(seededId);
    expect(after).not.toBeNull();
    // THE assertion: node ids are the replay join key. If the seeder re-expanded,
    // these change and every prior run of this workflow loses its outcomes.
    expect(after!.nodes.map((n) => n.nodeId)).toEqual(beforeNodeIds);
  });

  it('a definition edited after seeding is NOT reverted by a cold re-seed', async () => {
    await seedZeroConfigWorkflows(TENANT);
    const id = 'wf.seed.starters-webhook-notify';
    const seeded = await getRegisteredWorkflowAsync(id);
    expect(seeded).not.toBeNull();

    // A tenant edits it in the builder (the shared-row case the ADR flags).
    const edited = { ...seeded!, metadata: { ...seeded!.metadata, name: 'Renamed by a tenant' } };
    // AWAIT the durable write — otherwise the cold-boot simulation below races
    // the fire-and-forget persist and the test measures the race, not the fix.
    await registerWorkflowDurable(edited);

    __resetWorkflowRegistryForTests();
    await seedZeroConfigWorkflows(TENANT);

    const after = await getRegisteredWorkflowAsync(id);
    expect(after?.metadata?.name, 'a cold re-seed silently reverted a tenant edit').toBe('Renamed by a tenant');
  });

  it('seeding still WORKS from cold when nothing is stored yet', async () => {
    // The guard must not turn into "never seed".
    __resetWorkflowRegistryForTests();
    const res = await seedZeroConfigWorkflows('tenant-seed-cold-fresh');
    expect(res.seeded).toBeGreaterThan(0);
  });
});

describe('seeded runs can resolve the definition they executed', () => {
  it('seeding records a revision (else replay silently resolves HEAD)', async () => {
    const { latestRevision } = await import('../src/host/workflowRevisions.js');
    __resetWorkflowRegistryForTests();
    await seedZeroConfigWorkflows('tenant-seed-rev');
    const head = await latestRevision('wf.seed.starters-webhook-notify');
    expect(head, 'no revision row ⇒ resolveRunDefinition falls through to HEAD').not.toBeNull();
  });
});
