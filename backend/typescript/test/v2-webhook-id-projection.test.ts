/**
 * ADR 0629 / `spec/v2/core/versioning.md` §5 — THE PROJECTED runId REACHES THE
 * OUTBOUND DELIVERY.
 *
 * WHY THIS TEST EXISTS. ADR 0629 projected major-2 runIds in the two JSON
 * *response* senders and stopped there. A webhook delivery is not an Express
 * `res.json` — it is an outbound POST built at enqueue time — so a v2 client was
 * handed `default/<uuid>` by its create and then received `<uuid>` in the
 * delivery. Its correlation filter matched NOTHING: no error, no 4xx, no log
 * line, just a subscriber that never sees its own run. `v2-webhook-durable-
 * delivery` caught it (2 tests, 0 attempts observed) only because the scenario
 * correlates the way a real integrator would.
 *
 * The unit tests that shipped with ADR 0629 all passed, because they test
 * `toWireRunId`, which is correct. The projection function was right and the
 * projection was wrong — the defect was a missing CALL SITE, so only a test that
 * reads the emitted body can see it.
 *
 * §Correction (grade-tests w63): this header used to call a second case "the
 * safety property" — major 1 keeping the bare id. That leg was deleted with
 * major 1 (ADR 0812 P3c-0): after the cut a major-1 subscriber is not delivered
 * to at all (`deliverToSubscribers` returns before enqueue). What remains is
 * the major-2 projection, the v2 event vocabulary, and `protocolMajor`
 * persisting (absent reads as 1, which is what makes that skip fire).
 * Witnessed: the unprojected runId → case 1 red; `wireType = event.type` →
 * the two vocabulary cases red.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { __deliverToSubscribersForTests } from '../src/routes/webhooks.js';
import type { EventRecord, RunRecord } from '../src/types.js';

const TENANT = 'acme';
const RUN_ID = '11111111-2222-4333-8444-555555555555';
let storage: Storage;

async function seedRun(): Promise<void> {
  const run: RunRecord = {
    runId: RUN_ID,
    workflowId: 'wf-noop',
    status: 'completed',
    tenantId: TENANT,
    inputs: {},
    metadata: {},
    configurable: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await storage.insertRun(run);
}

/** An in-process event exactly as the executor appends it (host v1 dialect). */
function ev(type: string, eventId: string, sequence: number): EventRecord {
  return { type, runId: RUN_ID, eventId, sequence, payload: null, timestamp: new Date().toISOString() };
}

async function register(subscriptionId: string, protocolMajor?: 1 | 2, events: string[] = ['run.completed']): Promise<void> {
  await storage.insertWebhook({
    subscriptionId,
    tenantId: TENANT,
    url: `https://example.test/${subscriptionId}`,
    events,
    secret: 's3cret',
    createdAt: new Date().toISOString(),
    ...(protocolMajor ? { protocolMajor } : {}),
  });
}

/** The runId the worker will actually POST, read out of the durable row. */
async function claimed(subscriptionId: string) {
  const rows = await storage.claimDueWebhookDeliveries('test-worker', Date.now(), 60_000, 50);
  const mine = rows.find((r) => r.subscriptionId === subscriptionId);
  expect(mine, `no delivery enqueued for ${subscriptionId}`).toBeDefined();
  return mine!;
}
async function deliveredRunId(subscriptionId: string): Promise<unknown> {
  return (JSON.parse((await claimed(subscriptionId)).payload) as { runId?: unknown }).runId;
}
async function deliveredEventType(subscriptionId: string): Promise<{ header: string; body: unknown }> {
  const row = await claimed(subscriptionId);
  const parsed = JSON.parse(row.payload) as { type?: unknown; event?: { type?: unknown } };
  return { header: row.eventType, body: parsed.event?.type ?? parsed.type };
}

beforeAll(async () => {
  storage = await openStorage('memory://');
  await seedRun();
});

describe('v2 webhook id projection (ADR 0629; versioning.md §5)', () => {
  it('a subscription registered under major 2 receives the TENANT-BOUND runId', async () => {
    await register('sub-v2', 2);
    const event = ev('run.completed', 'e1', 1);
    await __deliverToSubscribersForTests(storage, event);

    // The whole point: what the SUBSCRIBER sees, not what toWireRunId returns.
    expect(await deliveredRunId('sub-v2')).toBe(`${TENANT}/${RUN_ID}`);
  });

  // ADR 0812 P3c-0 — the "absent major ⇒ 1 keeps the BARE runId" leg was deleted with major 1
  // (after the cut a major-1 subscriber is not delivered to at all — v2-webhook-delivery-envelope).
  it('protocolMajor survives the storage round-trip (a field that does not persist is not a field)', async () => {
    await register('sub-roundtrip', 2);
    expect((await storage.getWebhook('sub-roundtrip'))?.protocolMajor).toBe(2);
    await register('sub-roundtrip-v1', 1);
    // 1 is stored as NULL-or-1; the delivery rule reads it as `protocolMajor ?? 1`,
    // so assert THROUGH that rule — exactly 1, which is what skips delivery.
    expect((await storage.getWebhook('sub-roundtrip-v1'))?.protocolMajor ?? 1).toBe(1);
  });
});

describe('v2 webhook event VOCABULARY (ADR 0647 correction, 2026-09-10 — schemas/v2/event-codemap.json)', () => {
  // The executor emits the host's v1 dialect (`agent.toolCalled`); the codemap
  // renames it `agent.tool-called` on the major-2 wire. Before this fix a
  // major-2 subscriber filtering on the v2 spelling NEVER matched, and one that
  // did match (via `*`) received the v1 spelling in the body and the
  // `openwop-event-type` header.
  const RENAMED_V1 = 'agent.toolCalled';
  const RENAMED_V2 = 'agent.tool-called';

  it('a major-2 subscription registered with the v2 spelling matches the v1-spelled in-process event, and receives the v2 spelling', async () => {
    await register('sub-v2-vocab', 2, [RENAMED_V2]);
    const event = ev(RENAMED_V1, 'e-vocab-1', 5);
    await __deliverToSubscribersForTests(storage, event);
    const got = await deliveredEventType('sub-v2-vocab');
    expect(got.body).toBe(RENAMED_V2);
    expect(got.header).toBe(RENAMED_V2);
  });

  // ADR 0812 P3c-0 — the "major-1 subscription keeps the v1 spelling" leg was deleted with major 1.
  it('a major-2 subscription registered with the v1 spelling (bare through the overlap) still matches and still receives the v2 spelling', async () => {
    await register('sub-v2-v1spelling', 2, [RENAMED_V1]);
    const event = ev(RENAMED_V1, 'e-vocab-3', 7);
    await __deliverToSubscribersForTests(storage, event);
    expect((await deliveredEventType('sub-v2-v1spelling')).body).toBe(RENAMED_V2);
  });

  it('an unmapped host-extension type is delivered to a major-2 subscriber under its only spelling (fan-out is tolerant, never dropped)', async () => {
    await register('sub-v2-hostext', 2, ['openwop-app.crm.contact-triaged']);
    const event = ev('openwop-app.crm.contact-triaged', 'e-vocab-4', 8);
    await __deliverToSubscribersForTests(storage, event);
    expect((await deliveredEventType('sub-v2-hostext')).body).toBe('openwop-app.crm.contact-triaged');
  });
});
