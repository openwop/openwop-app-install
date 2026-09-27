/**
 * ADR 0498 DATA-1 — migration 15, `retarget-seeded-notification-push`.
 *
 * Already-seeded definitions still carry the retired
 * `core.openwop.integration.notification-push`, whose required `deviceToken` no
 * chain author can supply. The packs are retargeted, but `seedWorkflows` is
 * "seeded once, never rewritten", so existing tenants keep the broken node.
 *
 * WHAT MATTERS HERE IS THAT THE EDIT IS SURGICAL. The first design re-expanded the
 * chain and replaced the whole definition; two reviews killed it, because these
 * `wf.seed.*` rows are tenant-owned and builder-editable, so a wholesale rebuild
 * REVERTS user edits and drops the metadata `definitionMetadata.ts` depends on
 * (`requiresAgentId` — "erasing it silently stops enforcement" — `retention`,
 * `lifecycle`, the walkthrough binding). It also forced a per-run guard, because
 * re-expansion re-rolls every node id.
 *
 * So the assertions below are about what the migration must NOT disturb. A test
 * that only checked "the typeId changed" would pass against the design that
 * destroys tenant data.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Storage } from '../src/storage/storage.js';

const RETIRED = 'core.openwop.integration.notification-push';
const NOTIFY = 'feature.notifications.nodes.notify';
const CHAIN_ID = 'test.notify-migration';
const EXPANSION_ID = 'abc123def456';
/** Persisted node ids are `${chainId_underscored}_${expansionId}_${packNodeId}`. */
const PREFIX = `${CHAIN_ID.replace(/\./g, '_')}_${EXPANSION_ID}_`;
// Derived, never hand-written: `seedWorkflowId` slugifies (`.` → `-`), and a
// literal that drifts from it would make every chain look `absent`.
let WORKFLOW_ID = '';

/** The definition as a tenant actually holds it: customized, with real metadata. */
const seededDefinition = () => ({
  workflowId: WORKFLOW_ID,
  nodes: [
    { nodeId: `${PREFIX}draft`, typeId: 'core.ai.chatCompletion', config: { provider: 'anthropic' } },
    { nodeId: `${PREFIX}notify`, typeId: RETIRED, config: {}, inputs: {} },
    { nodeId: `${PREFIX}userAdded`, typeId: 'core.flow.noop', config: { note: 'a tenant edit' } },
  ],
  edges: [{ from: `${PREFIX}draft`, to: `${PREFIX}notify` }],
  metadata: {
    name: 'A tenant-renamed workflow',
    chainId: CHAIN_ID,
    expansionId: EXPANSION_ID,
    requiresAgentId: 'agent-42',
    retention: { ttlDays: 30 },
    lifecycle: 'active',
  },
});

const registered = new Map<string, ReturnType<typeof seededDefinition>>();
const registerWorkflowDurable = vi.fn(async (def: ReturnType<typeof seededDefinition>) => {
  registered.set(def.workflowId, def);
});
/** When set, the durable re-read returns this instead — the concurrent-save racer. */
let concurrentEdit: ReturnType<typeof seededDefinition> | null | undefined;
/** When set, the fresh expansion's notify node carries these inputs instead. */
let refBearingReplacement: Record<string, unknown> | null = null;
let recordRevisionResult: string | null = 'rev-1';

vi.mock('../src/host/workflowChainPackLoader.js', () => ({
  listChains: () => [{
    chain: {
      chainId: CHAIN_ID, label: 'Notify Migration', internal: false,
      parameters: { required: [] }, dag: { nodes: [], edges: [] },
    },
  }],
  loadWorkflowChainPacks: () => ({ installed: [], errors: [] }),
  defaultWorkflowChainPackRoots: () => [],
  // The fresh expansion the migration reads the replacement OUT of. Its own
  // node ids carry a DIFFERENT expansionId — the whole point of the pack bump.
  expandChain: () => ({
    nodes: [{ nodeId: `${CHAIN_ID.replace(/\./g, '_')}_zzz999_notify`, typeId: NOTIFY, config: { audience: 'tenant' }, inputs: refBearingReplacement ?? { title: 'Notify Migration' } }],
    edges: [],
    metadata: { chainId: CHAIN_ID, expansionId: 'zzz999' },
  }),
}));
let reads = 0;
vi.mock('../src/host/workflowsRegistry.js', () => ({
  registerWorkflowDurable: (d: unknown) => registerWorkflowDurable(d as never),
  // The migration reads TWICE: once to decide, once to rebase immediately before
  // the write. `concurrentEdit` simulates a builder save landing in between.
  getRegisteredWorkflowAsync: async (id: string) => {
    reads += 1;
    if (reads === 2 && concurrentEdit !== undefined) return concurrentEdit;
    return registered.get(id) ?? null;
  },
}));
vi.mock('../src/host/workflowRevisions.js', () => ({
  recordRevision: async () => recordRevisionResult,
  HOST_REVISION_TENANT: 'host',
}));

const storage = {} as unknown as Storage;

async function runMigration() {
  const { retargetSeededNotifyNodes } = await import('../src/host/seedWorkflows.js');
  return retargetSeededNotifyNodes(storage);
}
const notifyNode = () => registered.get(WORKFLOW_ID)!.nodes.find((n) => n.nodeId === `${PREFIX}notify`)!;

beforeEach(async () => {
  const { seedWorkflowId } = await import('../src/host/seedWorkflows.js');
  WORKFLOW_ID = seedWorkflowId(CHAIN_ID);
  registered.clear();
  registerWorkflowDurable.mockClear();
  reads = 0;
  concurrentEdit = undefined;
  refBearingReplacement = null;
  recordRevisionResult = 'rev-1';
  registered.set(WORKFLOW_ID, seededDefinition());
});

describe('the edit is surgical — everything it must not disturb', () => {
  it('retargets the node, taking config and inputs from the PACK', async () => {
    const res = await runMigration();
    expect(res.rewritten).toBe(1);
    expect(notifyNode().typeId).toBe(NOTIFY);
    expect(notifyNode().config).toEqual({ audience: 'tenant' });
    expect(notifyNode().inputs).toEqual({ title: 'Notify Migration' });
  });

  it('PRESERVES the node id — this is what makes it replay-safe without a run guard', async () => {
    // `hydrateSnapshot` overlays checkpoints BY NODE ID. Re-rolling ids is the
    // #2671 hazard; keeping them is why no `listRuns` guard is needed.
    await runMigration();
    expect(notifyNode().nodeId).toBe(`${PREFIX}notify`);
  });

  it('PRESERVES the tenant\'s other nodes, including ones they added', async () => {
    await runMigration();
    const def = registered.get(WORKFLOW_ID)!;
    expect(def.nodes.map((n) => n.nodeId)).toEqual([`${PREFIX}draft`, `${PREFIX}notify`, `${PREFIX}userAdded`]);
    expect(def.nodes.find((n) => n.nodeId === `${PREFIX}userAdded`)?.config).toEqual({ note: 'a tenant edit' });
    expect(def.nodes.find((n) => n.nodeId === `${PREFIX}draft`)?.config).toEqual({ provider: 'anthropic' });
  });

  it('PRESERVES edges', async () => {
    await runMigration();
    expect(registered.get(WORKFLOW_ID)!.edges).toEqual([{ from: `${PREFIX}draft`, to: `${PREFIX}notify` }]);
  });

  it('PRESERVES every metadata key — the data-loss the first design caused', async () => {
    await runMigration();
    expect(registered.get(WORKFLOW_ID)!.metadata).toEqual(seededDefinition().metadata);
  });
});

describe('it refuses rather than guessing', () => {
  it('SKIPS when no expanded node matches the persisted node\'s pack id', async () => {
    // A renamed node, or a definition from a pack whose node ids moved. Skip and
    // count — synthesizing an audience/title would be inventing authored intent
    // for a definition whose provenance just failed to establish.
    const def = seededDefinition();
    def.nodes[1]!.nodeId = `${PREFIX}renamedByUser`;
    registered.set(WORKFLOW_ID, def);
    const res = await runMigration();
    expect(res.skippedUnmatchedNode).toBe(1);
    expect(res.rewritten).toBe(0);
    expect(registerWorkflowDurable).not.toHaveBeenCalled();
  });

  it('SKIPS when the persisted metadata cannot reconstruct the prefix', async () => {
    const def = seededDefinition();
    delete (def.metadata as Record<string, unknown>).expansionId;
    registered.set(WORKFLOW_ID, def);
    const res = await runMigration();
    expect(res.skippedUnmatchedNode).toBe(1);
    expect(registerWorkflowDurable).not.toHaveBeenCalled();
  });

  it('SKIPS a replacement carrying a `{{token}}`', async () => {
    refBearingReplacement = { title: '{{params.subject}}' };
    const res = await runMigration();
    expect(res.skippedRefBearingReplacement).toBe(1);
    expect(registerWorkflowDurable).not.toHaveBeenCalled();
  });

  it('SKIPS a replacement carrying a STRUCTURED variable ref', async () => {
    // The shape a brace-only check missed: deferred expansion emits these, and
    // their variable prefix is `expansionId`-derived, so copying one onto a
    // definition with the OLD prefix dangles silently.
    refBearingReplacement = { title: { type: 'variable', variableName: 'test_zzz999_subject' } };
    const res = await runMigration();
    expect(res.skippedRefBearingReplacement).toBe(1);
    expect(registerWorkflowDurable).not.toHaveBeenCalled();
  });

  it('SKIPS a replacement carrying a minted PromptTemplate id', async () => {
    refBearingReplacement = { title: 'chainmint-zzz999-notify-system' };
    const res = await runMigration();
    expect(res.skippedRefBearingReplacement).toBe(1);
    expect(registerWorkflowDurable).not.toHaveBeenCalled();
  });

  it('SKIPS when the row changed under it — a concurrent builder save wins', async () => {
    // NOT a collab-room guard: `workflowCollabResource.ts:45` refuses `^wf\.seed\.`
    // outright, so no room can EVER exist for these ids and a `workflowRoomLive`
    // check was unreachable outside its own mock — a guard that tested only itself.
    // The real racer is the builder's REST autosave, which `routes/workflows.ts:185`
    // deliberately permits for a tenant's own seeded copy.
    const saved = seededDefinition();
    saved.nodes[1]!.typeId = NOTIFY;   // the tenant already fixed it themselves
    concurrentEdit = saved;
    const res = await runMigration();
    expect(res.skippedConcurrentEdit).toBe(1);
    expect(registerWorkflowDurable).not.toHaveBeenCalled();
  });

  it('SKIPS when the row was DELETED under it', async () => {
    concurrentEdit = null;
    const res = await runMigration();
    expect(res.skippedConcurrentEdit).toBe(1);
    expect(registerWorkflowDurable).not.toHaveBeenCalled();
  });

  it('reports `absent` rather than minting a definition never seeded here', async () => {
    registered.clear();
    const res = await runMigration();
    expect(res.absent).toBe(1);
    expect(registerWorkflowDurable).not.toHaveBeenCalled();
  });
});

describe('it cannot report a failure as a success', () => {
  it('counts a revision that failed to record', async () => {
    // `recordRevision` never rejects — it returns null. The previous
    // `.catch(() => undefined)` was dead code that discarded the only signal.
    recordRevisionResult = null;
    const res = await runMigration();
    expect(res.rewritten).toBe(1);
    expect(res.revisionRecordFailed).toBe(1);
  });

  it('every examined chain lands in exactly one outcome bucket', async () => {
    const res = await runMigration();
    const { examined, rewritten, skippedUnmatchedNode, skippedRefBearingReplacement,
      skippedConcurrentEdit, absent, alreadyClean, failed } = res;
    expect(
      rewritten + skippedUnmatchedNode + skippedRefBearingReplacement + skippedConcurrentEdit
        + absent + alreadyClean + failed,
      'a chain vanished from the accounting — some path returns without incrementing a counter',
    ).toBe(examined);
    // `revisionRecordFailed` is a MODIFIER on `rewritten`, not a bucket — assert
    // that explicitly so a future reader does not add it to the sum above.
    expect(res.revisionRecordFailed).toBe(0);
  });
});

describe('idempotency — migrations must tolerate a concurrent second execution', () => {
  it('a second pass is a no-op: the retired typeId is gone, so nothing matches', async () => {
    const first = await runMigration();
    expect(first.rewritten).toBe(1);
    const second = await runMigration();
    expect(second.rewritten).toBe(0);
    expect(second.alreadyClean).toBe(1);
    expect(registerWorkflowDurable).toHaveBeenCalledTimes(1);
  });
});
