/**
 * WF-KB-1 — the ADR 0038 §B auto-ingest workflow is a CHAIN, witnessed through the
 * REAL loader.
 *
 * It used to be an in-tree `registerWorkflow({...})` literal on the feature's boot
 * path with no `recordOwnership` — the exact anti-pattern ADR 0472 retired, shipped
 * past the ratchet because the ratchet only read `LEGACY_PINNED_WORKFLOWS`
 * (see `workflow-pin-site-ratchet.test.ts`, the detector that can now see it).
 *
 * This suite drives `loadWorkflowChainPacks(defaultWorkflowChainPackRoots())` — the
 * same call the boot path makes — rather than a synthetic registry, because a
 * synthetic registry proves the shape of a fixture, not that the pack this repo
 * actually ships is discoverable, valid and expandable.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  loadWorkflowChainPacks,
  defaultWorkflowChainPackRoots,
  getChain,
  _resetChainRegistryForTest,
} from '../src/host/workflowChainPackLoader.js';
import {
  registerChainBackedWorkflow,
  buildChainBackedDefinition,
  getChainBackedWorkflow,
  _resetChainBackedWorkflowsForTest,
} from '../src/host/chainBackedWorkflows.js';
import { AUTO_INGEST_WORKFLOW_ID } from '../src/features/agent-knowledge/feature.js';

const INGEST_NODE = 'feature.agent-knowledge.nodes.ingest';

describe('WF-KB-1 — agent-knowledge auto-ingest is chain-backed, not code-pinned', () => {
  beforeAll(() => {
    _resetChainRegistryForTest();
    _resetChainBackedWorkflowsForTest();
    const { errors } = loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() });
    expect(errors, 'the vendored chain packs (including the new one) must load clean').toEqual([]);
  });

  it('the chain is discoverable through the real loader under the ORIGINAL workflow id', () => {
    // Same-id is load-bearing: `exampleDataSeed` binds a demo trigger subscription
    // to this literal string, and every recorded run replays against it.
    expect(AUTO_INGEST_WORKFLOW_ID).toBe('feature.agent-knowledge.auto-ingest');
    const entry = getChain(AUTO_INGEST_WORKFLOW_ID);
    expect(entry, 'auto-ingest must be reachable as a chain (gallery + `/` picker)').not.toBeNull();
    expect(entry!.packName).toBe('core.openwop.workflows.agent-knowledge');
  });

  it('registers chain-backed and resolves by id with the SAME shape the pinned def had', () => {
    registerChainBackedWorkflow(AUTO_INGEST_WORKFLOW_ID);
    const def = getChainBackedWorkflow(AUTO_INGEST_WORKFLOW_ID);
    expect(def, 'resolve-by-id must work on every instance (trigger ignition)').toBeDefined();
    expect(def!.workflowId).toBe(AUTO_INGEST_WORKFLOW_ID);
    expect(def!.nodes).toHaveLength(1);
    expect(def!.nodes[0]!.typeId).toBe(INGEST_NODE);
    // The retired literal marked its single node `outputRole: 'primary'`; the
    // expander must reproduce that, or the run's primary output moves.
    expect(def!.nodes[0]!.outputRole).toBe('primary');
    expect(def!.edges ?? []).toEqual([]);
  });

  it('expansion is DETERMINISTIC (replay/`:fork` safety — two builds are byte-identical)', () => {
    const a = JSON.stringify(buildChainBackedDefinition(AUTO_INGEST_WORKFLOW_ID));
    const b = JSON.stringify(buildChainBackedDefinition(AUTO_INGEST_WORKFLOW_ID));
    expect(a).toBe(b);
    expect(a).not.toContain('subChainRef');
  });

  it('the feature module no longer imports the raw registry (the pin site is GONE, not moved)', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    // Comments are not code: the module's own docblock QUOTES the retired call to
    // explain the migration, so an un-stripped scan reads the fix as the defect.
    // (Local copy rather than an import — importing a sibling *.test.ts would
    // re-run its suite inside this one.)
    const src = readFileSync(join(__dirname, '..', 'src', 'features', 'agent-knowledge', 'feature.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
    expect(/\bregisterWorkflow\s*\(/.test(src), 'no raw registerWorkflow call may return').toBe(false);
    expect(/registerChainBackedWorkflow\s*\(/.test(src)).toBe(true);
  });
});
