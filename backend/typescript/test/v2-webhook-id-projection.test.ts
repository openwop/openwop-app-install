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
 * THE SECOND CASE IS THE SAFETY PROPERTY, not a nicety. `protocolMajor` absent
 * MUST read as major 1, so every subscription registered before the column
 * existed keeps the bare id it has always received. Projecting unconditionally
 * would silently rewrite the identifiers live v1 subscribers correlate on —
 * the same defect, aimed at the other set of receivers. If the fail-safe leg
 * ever goes red, the fix has become the bug.
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
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as RunRecord;
  await storage.insertRun(run);
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
    const event = { type: 'run.completed', runId: RUN_ID, eventId: 'e1', sequence: 1 } as unknown as EventRecord;
    await __deliverToSubscribersForTests(storage, event);

    // The whole point: what the SUBSCRIBER sees, not what toWireRunId returns.
    expect(await deliveredRunId('sub-v2')).toBe(`${TENANT}/${RUN_ID}`);
  });

  it('a subscription with NO recorded major keeps the BARE runId (absent ⇒ 1)', async () => {
    await register('sub-legacy');
    const event = { type: 'run.completed', runId: RUN_ID, eventId: 'e2', sequence: 2 } as unknown as EventRecord;
    await __deliverToSubscribersForTests(storage, event);

    // A subscriber that has only ever seen bare ids cannot correlate a
    // projected one. Absent MUST mean 1.
    expect(await deliveredRunId('sub-legacy')).toBe(RUN_ID);
  });

  it('protocolMajor survives the storage round-trip (a field that does not persist is not a field)', async () => {
    await register('sub-roundtrip', 2);
    expect((await storage.getWebhook('sub-roundtrip'))?.protocolMajor).toBe(2);
    await register('sub-roundtrip-v1', 1);
    // 1 is stored as NULL-or-1 and read back as "not 2" — the read rule is what
    // matters, so assert the behaviour rather than the storage representation.
    expect((await storage.getWebhook('sub-roundtrip-v1'))?.protocolMajor).not.toBe(2);
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
    const event = { type: RENAMED_V1, runId: RUN_ID, eventId: 'e-vocab-1', sequence: 5 } as unknown as EventRecord;
    await __deliverToSubscribersForTests(storage, event);
    const got = await deliveredEventType('sub-v2-vocab');
    expect(got.body).toBe(RENAMED_V2);
    expect(got.header).toBe(RENAMED_V2);
  });

  it('a major-1 subscription keeps the v1 spelling in body and header', async () => {
    await register('sub-v1-vocab', 1, [RENAMED_V1]);
    const event = { type: RENAMED_V1, runId: RUN_ID, eventId: 'e-vocab-2', sequence: 6 } as unknown as EventRecord;
    await __deliverToSubscribersForTests(storage, event);
    const got = await deliveredEventType('sub-v1-vocab');
    expect(got.body).toBe(RENAMED_V1);
    expect(got.header).toBe(RENAMED_V1);
  });

  it('a major-2 subscription registered with the v1 spelling (bare through the overlap) still matches and still receives the v2 spelling', async () => {
    await register('sub-v2-v1spelling', 2, [RENAMED_V1]);
    const event = { type: RENAMED_V1, runId: RUN_ID, eventId: 'e-vocab-3', sequence: 7 } as unknown as EventRecord;
    await __deliverToSubscribersForTests(storage, event);
    expect((await deliveredEventType('sub-v2-v1spelling')).body).toBe(RENAMED_V2);
  });

  it('an unmapped host-extension type is delivered to a major-2 subscriber under its only spelling (fan-out is tolerant, never dropped)', async () => {
    await register('sub-v2-hostext', 2, ['openwop-app.crm.contact-triaged']);
    const event = { type: 'openwop-app.crm.contact-triaged', runId: RUN_ID, eventId: 'e-vocab-4', sequence: 8 } as unknown as EventRecord;
    await __deliverToSubscribersForTests(storage, event);
    expect((await deliveredEventType('sub-v2-hostext')).body).toBe('openwop-app.crm.contact-triaged');
  });
});
