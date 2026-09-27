/**
 * CBW-1 (WORKFLOWS-ASSESSMENT) — the host-default `subChainRef → workflowId` rewrite
 * binds a parent's dispatch node to a child id, but registration ORDER is free (a
 * parent can register before its sibling), so the bind cannot be checked eagerly.
 * `validateChainBackedSubChainBinds` is the post-boot sweep: every bind whose parent
 * registered must point at a child ALSO registered same-id, else the parent carries a
 * dangling runtime dispatch (a declared-but-unregistered sibling, or an external ref
 * this host never registered). Exercised through the REAL loader + the exact
 * `buildChainBackedDefinition` path boot registration uses — no synthetic registry.
 *
 * @see docs/adr/0472-retire-builtin-workflows-seam.md (chain-backed same-id lane)
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  loadWorkflowChainPacks,
  defaultWorkflowChainPackRoots,
  _resetChainRegistryForTest,
} from '../src/host/workflowChainPackLoader.js';
import {
  buildChainBackedDefinition,
  registerChainBackedWorkflow,
  validateChainBackedSubChainBinds,
  _resetChainBackedWorkflowsForTest,
} from '../src/host/chainBackedWorkflows.js';

const FACTORY = 'openwop-app.kicktodo.challenge-factory';
const LESSON_BATCH = 'openwop-app.kicktodo.lesson-batch';

beforeEach(() => {
  _resetChainRegistryForTest();
  _resetChainBackedWorkflowsForTest();
  const { errors } = loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() });
  expect(errors).toEqual([]);
});

describe('CBW-1 — chain-backed sub-chain bind validation', () => {
  it('passes clean when the parent AND its bound sibling child are both registered (the boot shape)', () => {
    registerChainBackedWorkflow(FACTORY);
    registerChainBackedWorkflow(LESSON_BATCH);
    expect(validateChainBackedSubChainBinds()).toEqual([]);
  });

  it('registration order does not matter — child before parent is equally clean', () => {
    registerChainBackedWorkflow(LESSON_BATCH);
    registerChainBackedWorkflow(FACTORY);
    expect(validateChainBackedSubChainBinds()).toEqual([]);
  });

  it('reports every dangling bind when the parent registered but the bound child did not', () => {
    registerChainBackedWorkflow(FACTORY);
    const dangling = validateChainBackedSubChainBinds();
    // The factory's 4 build-N fan-out nodes all bind the same sibling child.
    expect(dangling).toHaveLength(4);
    for (const d of dangling) {
      expect(d.parentId).toBe(FACTORY);
      expect(d.childId).toBe(LESSON_BATCH);
      expect(d.nodeId).toMatch(/_build-\d$/);
    }
  });

  it('a chain merely BUILT (probe/test) but never registered contributes no findings', () => {
    buildChainBackedDefinition(FACTORY);
    expect(validateChainBackedSubChainBinds()).toEqual([]);
  });

  it('a workflow with no sub-chains contributes no findings', () => {
    registerChainBackedWorkflow('campaign-studio.campaign-orchestration');
    expect(validateChainBackedSubChainBinds()).toEqual([]);
  });
});
