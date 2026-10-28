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
 * CORRECTED (8f W4, 2026-10-24): "always-envelope reddens the v1 leg" described
 * a branch that can no longer run. `preferredVersion()` is the constant '2.0'
 * (`middleware/protocolVersion.ts:63`), so the bare-event leg was dead code and
 * was deleted. After the cut (ADR 0812 decision 2) a major-1 subscriber gets
 * NOTHING — no bare event, no silent v2 upgrade — and that is what the second
 * case now asserts, beside a v2 subscriber that DOES receive the same event.
 *
 * Witnessed: wd-no-envelope, wd-tenant-as-workspace, wd-v1-enqueued,
 * wd-unprojected.
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
/** `schemas/v2/webhook-delivery.schema.json` — the closed v2 envelope. */
interface DeliveryEnvelope { runId: string; workspaceId?: string; event: { runId: string; type: string } }
async function body(id: string): Promise<DeliveryEnvelope> {
  const rows = await storage.claimDueWebhookDeliveries('w', Date.now(), 60_000, 50);
  const mine = rows.find((r) => r.subscriptionId === id); expect(mine, `no delivery for ${id}`).toBeDefined();
  return JSON.parse(mine!.payload) as DeliveryEnvelope;
}
const event = (eventId: string, sequence: number): EventRecord => ({
  eventId, runId: RUN_ID, sequence, type: 'run.completed', payload: {}, timestamp: new Date().toISOString(),
});
beforeAll(async () => {
  storage = await openStorage('memory://');
  const now = new Date().toISOString();
  const run: RunRecord = { runId: RUN_ID, workflowId: 'wf', status: 'completed', tenantId: TENANT, inputs: {}, metadata: {}, configurable: {}, createdAt: now, updatedAt: now };
  await storage.insertRun(run);
});

describe('v2 webhook delivery envelope (webhook-delivery.schema.json)', () => {
  it('a major-2 subscriber receives { runId, workspaceId, event } with tenant-bound ids', async () => {
    await register('v2', 2);
    await __deliverToSubscribersForTests(storage, event('e1', 1));
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

  // ADR 0812 P3c-0 — the v1 fail-safe leg (bare event to a major-1 subscriber)
  // holds only while 1.x is served. After the cut ADR 0812 decision 2 applies:
  // the v1 contract is NOT emitted and the body is NOT silently upgraded to v2 —
  // the delivery is simply not enqueued.
  it('a major-1 (or unstamped) subscriber gets NOTHING after the cut — no bare event, no silent v2 upgrade', async () => {
    await register('v1');
    await register('v2-control', 2);
    await __deliverToSubscribersForTests(storage, event('e2', 2));
    const rows = await storage.claimDueWebhookDeliveries('w', Date.now(), 60_000, 50);
    // Positive control: the SAME fan-out did enqueue for a major-2 subscriber, so
    // the empty v1 list below is not a claim query that found nothing at all.
    expect(rows.filter((r) => r.subscriptionId === 'v2-control')).toHaveLength(1);
    expect(rows.filter((r) => r.subscriptionId === 'v1'), 'no v1 delivery after the cut, and no silent v2 upgrade').toEqual([]);
  });
});
