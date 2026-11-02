/**
 * ADR 0482 grade-fix H1 — a hard-capped workflow must not suppress every
 * OTHER workflow bound to the same host event. ADR 0482 §5 changed
 * startWorkflowRun's budget-exhausted signal from a null return to a typed
 * 429 THROW; in the dispatcher's shared fan-out loop that throw would break
 * the batch and land in the outer catch, silently dropping the sibling
 * bindings. This pins the per-binding isolation fix.
 *
 * The dispatcher lists bindings in index-key order, and a binding id is
 * `hevb:<randomUUID>`, so creation order says nothing about fan-out order. The ids are
 * pinned (node:crypto `randomUUID` is mocked to hand out queued ids) so the capped
 * binding always lists FIRST through the same reader the dispatcher uses; only then
 * would a batch abort drop both siblings. Without that, the regression was invisible
 * whenever the capped binding happened to sort last.
 *
 * Tracker TST-DFC-3. Red when (w71g1): a binding's dispatch error escapes the
 * per-binding catch and aborts the fan-out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Uuid = `${string}-${string}-${string}-${string}-${string}`;
/** Ids handed out by the mocked `randomUUID`, in order; empty ⇒ the real one. */
const { queuedUuids } = vi.hoisted(() => { const q: Uuid[] = []; return { queuedUuids: q }; });
vi.mock('node:crypto', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:crypto')>();
  return { ...real, randomUUID: (): Uuid => queuedUuids.shift() ?? real.randomUUID() };
});
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import type { StartRunDeps } from '../src/host/runStarter.js';
import { OpenwopError } from '../src/types.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import {
  createHostEventBinding,
  listHostEventBindings,
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
let attempted: string[];

beforeEach(async () => {
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  await __clearHostEventBindings();
  fired = [];
  attempted = [];
  initHostEventDispatcher({
    storage,
    hostSuite,
    deliverWebhooks: async () => {},
    // The capped workflow throws the 429 startWorkflowRun now throws; every
    // other binding must still fire.
    startRun: async (_deps, input) => {
      attempted.push(input.workflowId);
      if (input.workflowId === 'wf:capped') {
        throw new OpenwopError('rate_limited', 'daily budget exhausted', 429, { workflowId: 'wf:capped', reason: 'workflow_budget_exhausted' });
      }
      fired.push(input.workflowId);
      return `run:${input.workflowId}`;
    },
  });
});

afterEach(() => {
  queuedUuids.length = 0;
  __resetHostEventDispatcher();
  __resetHostExtPersistence();
});

describe('host-event budget isolation (ADR 0482 grade-fix H1)', () => {
  it('a budget-capped binding never suppresses its siblings on the same event', async () => {
    const tenantId = 'tenant-h1';
    const eventType = 'host.crm.contact.created';
    // Created capped-LAST but with the lowest id, so it is dispatched FIRST and a batch
    // abort would drop BOTH siblings.
    queuedUuids.push(
      'bbbbbbbb-0000-4000-8000-000000000001',
      'cccccccc-0000-4000-8000-000000000002',
      'aaaaaaaa-0000-4000-8000-000000000003',
    );
    await createHostEventBinding({ tenantId, eventType, workflowId: 'wf:sibling-a', createdBy: 'test' });
    await createHostEventBinding({ tenantId, eventType, workflowId: 'wf:sibling-b', createdBy: 'test' });
    const capped = await createHostEventBinding({ tenantId, eventType, workflowId: 'wf:capped', createdBy: 'test' });
    expect(capped.bindingId).toBe('hevb:aaaaaaaa-0000-4000-8000-000000000003');
    expect((await listHostEventBindings(tenantId)).map((b) => b.workflowId)).toEqual(['wf:capped', 'wf:sibling-a', 'wf:sibling-b']);

    await emitHostEvent({ type: eventType, tenantId, payload: { entityType: 'contact', entityId: 'crm:1' } });

    expect(attempted[0]).toBe('wf:capped'); // it really was dispatched first

    // Both siblings fired despite the capped one's 429 throw.
    expect(fired).toContain('wf:sibling-a');
    expect(fired).toContain('wf:sibling-b');
    expect(fired).not.toContain('wf:capped');
  });
});
