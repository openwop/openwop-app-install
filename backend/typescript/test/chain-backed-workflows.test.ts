/**
 * ADR 0472 Phase 1 — `registerChainBackedWorkflow` (the sanctioned replacement for
 * the deprecated `builtinWorkflows` seam).
 *
 * Proves the friction-reducer end-to-end: a chain pack → a stable-id, resolve-by-id
 * `WorkflowDefinition`, WITHOUT a hand-coded def and WITHOUT the deprecated seam. The
 * chainId-only signature is the guardrail against reopening the anti-pattern.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import {
  loadWorkflowChainPacks,
  defaultWorkflowChainPackRoots,
  _resetChainRegistryForTest,
  listChains,
} from '../src/host/workflowChainPackLoader.js';
import {
  registerChainBackedWorkflow,
  buildChainBackedDefinition,
  getChainBackedWorkflow,
  listChainBackedWorkflows,
  _resetChainBackedWorkflowsForTest,
} from '../src/host/chainBackedWorkflows.js';

// Use a real vendored chain (the migrated plan-generation pack, #2430) as the fixture.
const CHAIN_ID = 'kicktodo.plan-generation';

beforeAll(() => {
  _resetChainRegistryForTest();
  _resetChainBackedWorkflowsForTest();
  const { errors } = loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() });
  expect(errors).toEqual([]);
});

describe('registerChainBackedWorkflow — resolve-by-id from a chain', () => {
  it('expands a chain to a STABLE-id definition (workflowId === chainId → replay-safe)', () => {
    const def = buildChainBackedDefinition(CHAIN_ID);
    expect(def.workflowId).toBe(CHAIN_ID); // deterministic, not a random uuid
    expect(def.nodes.length).toBeGreaterThan(0);
  });

  it('restores launch-contract param names (un-prefixes deferred materialization)', () => {
    const def = buildChainBackedDefinition(CHAIN_ID);
    const names = (def.variables ?? []).map((v) => v.name);
    // The chain declares `candidateId`/`topic`/... as parameters → a run passes them
    // by the bare launch-contract name, not the `<chain>_<id>_candidateId` prefix.
    expect(names).toContain('candidateId');
    expect(names.some((n) => n.includes('_candidateId'))).toBe(false);
    // The produced variable `plan` (RFC 0133 §2) survives verbatim.
    expect(names).toContain('plan');
  });

  it('registers for resolve-by-id under the stable id', () => {
    registerChainBackedWorkflow(CHAIN_ID);
    const resolved = getChainBackedWorkflow(CHAIN_ID);
    expect(resolved).toBeTruthy();
    expect(resolved!.workflowId).toBe(CHAIN_ID);
    expect(listChainBackedWorkflows().some((w) => w.workflowId === CHAIN_ID)).toBe(true);
  });

  it('applies the optional postProcess hook (feature customization seam)', () => {
    _resetChainBackedWorkflowsForTest();
    registerChainBackedWorkflow(CHAIN_ID, {
      postProcess: (def) => {
        def.metadata = { ...(def.metadata ?? {}), kind: 'test-marker' };
      },
    });
    expect(getChainBackedWorkflow(CHAIN_ID)!.metadata).toMatchObject({ kind: 'test-marker' });
  });

  it('is idempotent by id, and soft-fails (logs, no throw) on an unknown chain', () => {
    _resetChainBackedWorkflowsForTest();
    registerChainBackedWorkflow(CHAIN_ID);
    registerChainBackedWorkflow(CHAIN_ID); // repeat — no dup, no throw
    expect(listChainBackedWorkflows().filter((w) => w.workflowId === CHAIN_ID)).toHaveLength(1);
    // Unknown chain: the boot-soft contract swallows + logs, never aborts the loop.
    expect(() => registerChainBackedWorkflow('nope.not.a.chain')).not.toThrow();
    expect(getChainBackedWorkflow('nope.not.a.chain')).toBeUndefined();
  });
});

/**
 * ADR 0491 P4 — the Challenge Factory's ABSENCE from the tenant workflow list is
 * correct (it is chain-backed WITHOUT `hostOwned`, so it resolves by id but is not
 * in the ownership index `/builder` + the `/` picker read). Its reachability comes
 * from the chain GALLERY instead. That is a real, checkable contract: the parent
 * chain must stay gallery-visible and its lesson-batch child must stay hidden.
 *
 * Pinned after the 2026-07-25 incident, when "the workflow isn't in the list" was a
 * reasonable-looking symptom of the wrong diagnosis — the workflow was fine; the
 * run's SURFACING was broken.
 */
describe('ADR 0491 P4 — Challenge Factory chain-gallery discoverability', () => {
  it('the parent chain is gallery-visible; the lesson-batch child is internal (hidden)', () => {
    const chains = listChains();
    const parent = chains.find((c) => c.chain.chainId === 'openwop-app.kicktodo.challenge-factory');
    const child = chains.find((c) => c.chain.chainId === 'openwop-app.kicktodo.lesson-batch');
    expect(parent, 'challenge-factory chain must be loaded').toBeDefined();
    // The gallery filter is `chain.internal !== true` (routes/workflows.ts).
    expect(parent!.chain.internal).not.toBe(true);
    expect(child, 'lesson-batch child chain must be loaded').toBeDefined();
    expect(child!.chain.internal).toBe(true); // a child is never independently instantiable
  });
});
