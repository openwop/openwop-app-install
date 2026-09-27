/**
 * ADR 0482 grade-fix H1 — a hard-capped workflow must not suppress every
 * OTHER workflow bound to the same host event. ADR 0482 §5 changed
 * startWorkflowRun's budget-exhausted signal from a null return to a typed
 * 429 THROW; in the dispatcher's shared fan-out loop that throw would break
 * the batch and land in the outer catch, silently dropping the sibling
 * bindings. This pins the per-binding isolation fix.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { StartRunDeps } from '../src/host/runStarter.js';
import { OpenwopError } from '../src/types.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  createHostEventBinding,
  emitHostEvent,
  initHostEventDispatcher,
  __clearHostEventBindings,
  __resetHostEventDispatcher,
} from '../src/host/hostEventDispatcher.js';

const hostSuite: StartRunDeps['hostSuite'] = {
  workflowCatalog: { getWorkflow: async (id) => ({ workflowId: id, definition: { workflowId: id, nodes: [] } }) },
  providerPolicyResolver: { resolveForRun: async () => [] },
};

let storage: Storage;
let fired: string[];

beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  await __clearHostEventBindings();
  fired = [];
  initHostEventDispatcher({
    storage,
    hostSuite,
    deliverWebhooks: async () => {},
    // The capped workflow throws the 429 startWorkflowRun now throws; every
    // other binding must still fire.
    startRun: async (_deps, input) => {
      if (input.workflowId === 'wf:capped') {
        throw new OpenwopError('rate_limited', 'daily budget exhausted', 429, { workflowId: 'wf:capped', reason: 'workflow_budget_exhausted' });
      }
      fired.push(input.workflowId);
      return `run:${input.workflowId}`;
    },
  });
});

afterEach(() => {
  __resetHostEventDispatcher();
  __resetHostExtPersistence();
});

describe('host-event budget isolation (ADR 0482 grade-fix H1)', () => {
  it('a budget-capped binding never suppresses its siblings on the same event', async () => {
    const tenantId = 'tenant-h1';
    const eventType = 'host.crm.contact.created';
    // Capped one FIRST so the pre-fix batch-abort would drop the two after it.
    await createHostEventBinding({ tenantId, eventType, workflowId: 'wf:capped', createdBy: 'test' });
    await createHostEventBinding({ tenantId, eventType, workflowId: 'wf:sibling-a', createdBy: 'test' });
    await createHostEventBinding({ tenantId, eventType, workflowId: 'wf:sibling-b', createdBy: 'test' });

    await emitHostEvent({ type: eventType, tenantId, payload: { entityType: 'contact', entityId: 'crm:1' } });

    // Both siblings fired despite the capped one's 429 throw.
    expect(fired).toContain('wf:sibling-a');
    expect(fired).toContain('wf:sibling-b');
    expect(fired).not.toContain('wf:capped');
  });
});
