/**
 * webhooks.md §Delivery / `schemas/v2/webhook-delivery.schema.json` (rc.30) —
 * A MAJOR-2 SUBSCRIBER RECEIVES THE ENVELOPE, NOT THE BARE EVENT.
 *
 *   { runId, workspaceId, event }   required, additionalProperties: false,
 *                                   runId tenant-bound, event verbatim
 *
 * This host POSTed the bare event. A v2 subscriber therefore received a document
 * with no `runId`, no `workspaceId`, and the event at the top level — rejected by
 * its own schema, not merely carrying an unprojected id. Under major 1 the bare
 * event IS the contract and must stay exactly as it was (the fail-safe leg).
 *
 * Both directions are asserted and each has its own sabotage: never-envelope
 * reddens the v2 leg; always-envelope reddens the v1 leg.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { __deliverToSubscribersForTests } from '../src/routes/webhooks.js';
import type { EventRecord, RunRecord } from '../src/types.js';

const TENANT = 'acme';
const RUN_ID = '22222222-3333-4444-8555-666666666666';
let storage: Storage;

async function register(id: string, protocolMajor?: 1 | 2): Promise<void> {
  await storage.insertWebhook({ subscriptionId: id, tenantId: TENANT, url: `https://example.test/${id}`, events: ['run.completed'], secret: 's', createdAt: new Date().toISOString(), ...(protocolMajor ? { protocolMajor } : {}) });
}
async function body(id: string): Promise<any> {
  const rows = await storage.claimDueWebhookDeliveries('w', Date.now(), 60_000, 50);
  const mine = rows.find((r) => r.subscriptionId === id); expect(mine, `no delivery for ${id}`).toBeDefined();
  return JSON.parse(mine!.payload);
}
beforeAll(async () => {
  storage = await openStorage('memory://');
  await storage.insertRun({ runId: RUN_ID, workflowId: 'wf', status: 'completed', tenantId: TENANT, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as RunRecord);
});

describe('v2 webhook delivery envelope (webhook-delivery.schema.json)', () => {
  it('a major-2 subscriber receives { runId, workspaceId, event } with tenant-bound ids', async () => {
    await register('v2', 2);
    const ev = { type: 'run.completed', runId: RUN_ID, eventId: 'e1', sequence: 1 } as unknown as EventRecord;
    await __deliverToSubscribersForTests(storage, ev);
    const b = await body('v2');
    // rc.34: `workspaceId` is present EXACTLY when owner.workspace is. This run has
    // no sub-tenant workspace, so the envelope MUST NOT carry one -- and MUST NOT
    // substitute the tenant (the first cut of this did, against an rc.30 schema
    // that required the field; the schema was wrong and was fixed).
    expect(Object.keys(b).sort(), 'closed envelope, no workspaceId for a workspace-less run').toEqual(['event', 'runId']);
    expect(b.runId).toBe(`${TENANT}/${RUN_ID}`);
    expect('workspaceId' in b, 'never the tenant id in the workspace field').toBe(false);
    expect(b.event.runId, 'nested event projected too').toBe(`${TENANT}/${RUN_ID}`);
    expect(b.event.type).toBe('run.completed');
  });

  // No "present" leg on purpose: `runOwnerV2(run)` returns { tenant, subject } and never
  // sets `workspace` (the sole writer is the persisted-echo projection), so no run on this
  // host can carry a workspace today and the branch that emits `workspaceId` has no
  // reachable input. When a workspace-bearing run exists, add the leg then -- and it must
  // assert `workspaceId === owner.workspace`, never the tenant.

  it('a major-1 (or unstamped) subscriber still receives the BARE event (the fail-safe)', async () => {
    await register('v1');
    const ev = { type: 'run.completed', runId: RUN_ID, eventId: 'e2', sequence: 2 } as unknown as EventRecord;
    await __deliverToSubscribersForTests(storage, ev);
    const b = await body('v1');
    expect(b.event, 'no envelope under major 1').toBeUndefined();
    expect(b.type).toBe('run.completed');
    expect(b.runId).toBe(RUN_ID);
  });
});
