/**
 * ADR 0703 D5 — the pin-site drain hid host workflows from `isBuiltinWorkflowId` too,
 * so the AI workflow AUTHOR could overwrite them.
 *
 * D4 fixed the HTTP route guard (`isWriteProtected`). Sweeping every reader of the raw
 * registry afterwards found a SECOND predicate with the same defect — and it guards the
 * door a MODEL uses (`persistAuthoredWorkflow` → 409 `builtin_workflow`). The lane's own
 * comment warns about exactly that asymmetry: "curation was enforced on the doors a HUMAN
 * uses and skipped on the doors a MODEL uses."
 *
 * BORN RED: before the fix `isBuiltinWorkflowId` consulted only the raw registry, so a
 * chain-backed host workflow answered `false` and the author's 409 never fired.
 *
 * Import cycle: `workflowOwnership` imports `chainBackedWorkflows`, which imports
 * `recordOwnership` back. Both uses are in-function; if the cycle mis-resolved, the
 * binding is `undefined` at call time and the predicate leg below THROWS — so leg 1 is
 * the witness for the cycle too (cited by `workflowOwnership.ts`).
 *
 * SABOTAGE (wave 18, probe-witnessed): dropping `&& !getChainBackedWorkflow(workflowId)`
 * from `isBuiltinWorkflowId` turns leg 1 AND the author-door leg red; `if (false) return
 * false;` turns leg 2 red.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { ensureNodesRegistered } from '../src/bootstrap/nodes.js';
import { loadWorkflowChainPacks, defaultWorkflowChainPackRoots, _resetChainRegistryForTest } from '../src/host/workflowChainPackLoader.js';
import { registerChainBackedWorkflow, getChainBackedWorkflow } from '../src/host/chainBackedWorkflows.js';
import { isBuiltinWorkflowId } from '../src/host/workflowOwnership.js';
import { persistAuthoredWorkflow } from '../src/features/workflow-author/workflowAuthorService.js';

const DRAINED = ['openwop-app.scheduled-chat.turn', 'openwop-app.channel.turn', 'openwop-app.kicktodo.convene-turn'] as const;

beforeAll(async () => {
  ensureNodesRegistered();
  initHostExtPersistence(await openStorage('memory://'));
  _resetChainRegistryForTest();
  loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() });
  for (const id of DRAINED) registerChainBackedWorkflow(id);
});

describe('ADR 0703 D5 — chain-backed host workflows are BUILT-INS to the author guard', () => {
  it('leg 1: every DRAINED host workflow is recognised as a built-in', async () => {
    for (const id of DRAINED) {
      // Precondition: the fixture is real (a chain that failed to register would make
      // this leg prove nothing about the chain-backed registry).
      expect(getChainBackedWorkflow(id), `${id} is registered chain-backed`).toBeTruthy();
      expect(await isBuiltinWorkflowId(id), `${id} must be a built-in — the author 409s on this`).toBe(true);
    }
  });

  it('leg 2: an unregistered id is NOT a built-in (the predicate still discriminates)', async () => {
    expect(await isBuiltinWorkflowId('openwop-app.definitely-not-registered'), 'a free id stays authorable').toBe(false);
  });

  it('leg 3 (the door): the AI author is refused an overwrite of a chain-backed built-in, as builtin_workflow', async () => {
    const id = DRAINED[0];
    const before = getChainBackedWorkflow(id);
    // `reason` is load-bearing: `openwop-app.*` is ALSO a shared namespace, so without
    // the built-in check this write would still 409 — as `shared_workflow`.
    await expect(
      persistAuthoredWorkflow({ workflowId: id, nodes: [{ nodeId: 'n1', typeId: 'core.noop' }] }, { tenantId: 'ws-wfa-builtin-guard' }),
    ).rejects.toMatchObject({ code: 'conflict', details: { reason: 'builtin_workflow' } });
    expect(getChainBackedWorkflow(id), 'the built-in definition is untouched').toBe(before);
  });
});
