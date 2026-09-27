/**
 * ADR 0703 D5 — the pin-site drain hid host workflows from `isBuiltinWorkflowId` too,
 * so the AI workflow AUTHOR could overwrite them.
 *
 * D4 fixed the HTTP route guard (`isWriteProtected`). Sweeping every reader of the raw
 * registry afterwards found a SECOND predicate with the same defect — and it guards the
 * door a MODEL uses (`workflowAuthorService.ts:257` → 409 `builtin_workflow`). The
 * lane's own comment warns about exactly that asymmetry: "curation was enforced on the
 * doors a HUMAN uses and skipped on the doors a MODEL uses."
 *
 * BORN RED: before the fix `isBuiltinWorkflowId` consulted only the raw registry, so a
 * chain-backed host workflow answered `false` and the author's 409 never fired.
 *
 * This file ALSO discharges an import-cycle risk: `workflowOwnership` now imports
 * `chainBackedWorkflows`, which imports `recordOwnership` back. Both uses are
 * in-function, so the live bindings should be populated — asserted here rather than
 * assumed, because the failure mode of a bad cycle is `undefined` at call time.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { loadWorkflowChainPacks, defaultWorkflowChainPackRoots, _resetChainRegistryForTest } from '../src/host/workflowChainPackLoader.js';
import { registerChainBackedWorkflow, getChainBackedWorkflow } from '../src/host/chainBackedWorkflows.js';
import { isBuiltinWorkflowId } from '../src/host/workflowOwnership.js';

const DRAINED = ['openwop-app.scheduled-chat.turn', 'openwop-app.channel.turn'] as const;

beforeAll(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  _resetChainRegistryForTest();
  loadWorkflowChainPacks({ roots: defaultWorkflowChainPackRoots() });
  for (const id of DRAINED) registerChainBackedWorkflow(id);
});

describe('ADR 0703 D5 — chain-backed host workflows are BUILT-INS to the author guard', () => {
  it('leg 1: the cycle does not bite — the imported binding is callable', () => {
    // If `workflowOwnership` ⇄ `chainBackedWorkflows` mis-resolved, this is where it
    // shows up: an undefined binding, not a wrong answer.
    expect(typeof getChainBackedWorkflow).toBe('function');
    for (const id of DRAINED) expect(getChainBackedWorkflow(id), `${id} is registered chain-backed`).toBeTruthy();
  });

  it('leg 2: every DRAINED host workflow is recognised as a built-in', async () => {
    for (const id of DRAINED) {
      expect(await isBuiltinWorkflowId(id), `${id} must be a built-in — the author 409s on this`).toBe(true);
    }
  });

  it('leg 3: an unregistered id is NOT a built-in (the predicate still discriminates)', async () => {
    expect(await isBuiltinWorkflowId('openwop-app.definitely-not-registered'), 'a free id stays authorable').toBe(false);
  });

  it('leg 4 (structural): the predicate consults BOTH registries', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'host', 'workflowOwnership.ts'), 'utf8')
      .split('\n').filter((l) => { const t = l.trim(); return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*'); }).join('\n');
    expect(src, 'the raw-registry-only form would reopen the hole').toMatch(/getChainBackedWorkflow\(workflowId\)/);
  });
});
