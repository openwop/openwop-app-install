/**
 * CDP-1c — RFC 0127 (Draft) streaming/CDC trigger sources, host ingest path.
 *
 * Witness-readiness: the ingest path lands a `source:"stream"` and a `source:"change"`
 * event as a run via the UNCHANGED RFC 0083 four-state machine (`ingestExternalEvent`),
 * producing a real delivery for BOTH sources non-vacuously (the reference-host witness the
 * steward's gated scenario needs). Covers: `op` REQUIRED for change; dedup composed from
 * (topic,partition,offset)/(table,changelogId); SR-1 (the message/row body lives ONLY in
 * `run.metadata.triggerData`, never an event payload); and the flag guardrail — with the
 * default-off flag, stream/change are neither ingested nor advertised.
 *
 * Sabotage-witnessed (/grade-tests w38): the `op` check, the (topic,partition,offset) dedup seed
 * (replaced by a body hash), leaking the envelope into the delivery event, the flag gate in
 * `ingestExternalEvent`, the stream `key` mapping, and the accept gate's flag term each turn a
 * case red. (The ADVERT flip itself is asserted over HTTP in cdp-stream-cdc-consumer.test.ts,
 * "honest-off advert flip".)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { createHostAdapterSuite } from '../src/host/index.js';
import { getEventLog, setEventLogBackend } from '../src/executor/eventLog.js';
import { __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { __resetTriggerBridgeStore, listDeliveries, registerSubscription } from '../src/host/triggerBridgeService.js';
import {
  ingestExternalEvent,
  isAcceptedIngestionSource,
  type TriggerEvent,
} from '../src/host/triggerIngestionService.js';

const WF = 'openwop-app.uppercase';

describe('CDP-1c stream/CDC ingest (RFC 0127, flag-gated)', () => {
  const storage = openSqliteStorage(':memory:');
  const hostSuite = createHostAdapterSuite({ storage });
  const deps = { storage, hostSuite };

  beforeAll(() => {
    process.env.OPENWOP_TRIGGER_STREAM_CDC_ENABLED = 'true'; // reference-host witness flag ON
    initHostExtPersistence(storage);
    setEventLogBackend(storage);
  });
  afterAll(async () => {
    delete process.env.OPENWOP_TRIGGER_STREAM_CDC_ENABLED;
    __resetHostExtPersistence();
    await storage.close();
  });
  beforeEach(async () => {
    initHostExtPersistence(storage);
    await __resetTriggerBridgeStore();
  });

  async function reg(source: 'stream' | 'change') {
    const subscriptionId = `tgsub-${source}-${Math.random().toString(16).slice(2)}`;
    await registerSubscription({ subscriptionId, tenantId: 't1', source, workflowId: WF, verificationMode: 'none' });
    return subscriptionId;
  }

  it('a stream event lands a run as source:"stream" with a non-vacuous delivery', async () => {
    const sub = await reg('stream');
    const result = await ingestExternalEvent(deps, sub, {
      source: 'stream', topic: 'orders', partition: 3, offset: '10045', key: 'o1', message: { orderId: 'o1', email: 'a@x.test' },
    });
    expect(result.outcome).toBe('delivered');
    const run = await storage.getRun(result.runId!);
    const te = (run!.metadata as { triggerData: TriggerEvent }).triggerData;
    expect(te.source).toBe('stream');
    expect(te.contentTrust).toBe('untrusted');
    expect(te.stream?.partition).toBe(3);
    expect(te.stream?.offset).toBe('10045');
    expect(te.stream?.key).toBe('o1');
    expect(te.stream?.message).toEqual({ orderId: 'o1', email: 'a@x.test' });
    // real trigger.delivery.attempted (the witness bar)
    const deliveries = await listDeliveries(sub);
    expect(deliveries.some((d) => d.deliveryId === te.deliveryId && d.outcome === 'delivered' && d.runId === result.runId)).toBe(true);
  });

  it('a change event lands a run as source:"change" with the REQUIRED op', async () => {
    const sub = await reg('change');
    const result = await ingestExternalEvent(deps, sub, {
      source: 'change', op: 'update', table: 'contacts', changelogId: 'lsn-88',
      before: { id: 42, stage: 'lead' }, after: { id: 42, stage: 'customer' },
    });
    expect(result.outcome).toBe('delivered');
    const run = await storage.getRun(result.runId!);
    const te = (run!.metadata as { triggerData: TriggerEvent }).triggerData;
    expect(te.source).toBe('change');
    expect(te.change?.op).toBe('update');
    expect(te.change?.before).toEqual({ id: 42, stage: 'lead' });
    expect(te.change?.after).toEqual({ id: 42, stage: 'customer' });
    expect((await listDeliveries(sub)).some((d) => d.outcome === 'delivered')).toBe(true);
  });

  it('a change event with an invalid op is rejected (op REQUIRED)', async () => {
    const sub = await reg('change');
    // @ts-expect-error — an `op` outside the union IS the case under test (tsc proves it invalid).
    const result = await ingestExternalEvent(deps, sub, { source: 'change', op: 'upsert', table: 't', changelogId: '1' });
    // The rejection REASON is deliberately not asserted: today it reads `signature-invalid`, a
    // mislabel for an op failure (grade-code row) — pinning it would certify the bug.
    expect(result.outcome).toBe('rejected');
    expect(result.runId).toBeUndefined();
    expect(await listDeliveries(sub)).toEqual([]); // no delivery, so no run
  });

  it('dedup: the same (topic,partition,offset) redelivery returns the prior run (effectively-once)', async () => {
    const sub = await reg('stream');
    const ev = { source: 'stream' as const, topic: 'orders', partition: 1, offset: '7', message: { a: 1 } };
    const first = await ingestExternalEvent(deps, sub, ev);
    const again = await ingestExternalEvent(deps, sub, { ...ev, message: { a: 2 } }); // same coords, different body
    expect(first.outcome).toBe('delivered');
    expect(again.outcome).toBe('deduped');
    expect(again.runId).toBe(first.runId);
  });

  it('SR-1: the message body never reaches the event log (content-free trigger events)', async () => {
    const sub = await reg('stream');
    const secret = 'SR1-secret-marker-3f9a';
    const result = await ingestExternalEvent(deps, sub, { source: 'stream', topic: 't', partition: 0, offset: '1', message: { note: secret } });
    expect(result.outcome).toBe('delivered');
    const events = await getEventLog().list(result.runId!);
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(secret); // body lives only in run.metadata.triggerData
  });

  it('guardrail: stream/change are accepted ONLY with the flag on', () => {
    // The honest-off ACCEPT gate (`isAcceptedIngestionSource`). Replaces a pin on the
    // EXTERNAL_INGESTION_SOURCES constant whose "never advertised" claim is false of the
    // product: discovery DOES advertise stream/change when the flag is on (w38).
    delete process.env.OPENWOP_TRIGGER_STREAM_CDC_ENABLED;
    try {
      expect(isAcceptedIngestionSource('stream')).toBe(false);
      expect(isAcceptedIngestionSource('change')).toBe(false);
      expect(isAcceptedIngestionSource('webhook')).toBe(true); // the advertised set is unaffected
    } finally {
      process.env.OPENWOP_TRIGGER_STREAM_CDC_ENABLED = 'true';
    }
    expect(isAcceptedIngestionSource('stream')).toBe(true);
    expect(isAcceptedIngestionSource('change')).toBe(true);
  });

  it('guardrail: with the flag OFF, a stream event is skipped (not ingested)', async () => {
    const sub = await reg('stream');
    delete process.env.OPENWOP_TRIGGER_STREAM_CDC_ENABLED;
    let result: Awaited<ReturnType<typeof ingestExternalEvent>>;
    try {
      result = await ingestExternalEvent(deps, sub, { source: 'stream', topic: 't', partition: 0, offset: '99', message: { a: 1 } });
    } finally {
      process.env.OPENWOP_TRIGGER_STREAM_CDC_ENABLED = 'true'; // restore for the suite
    }
    expect(result.outcome).toBe('skipped');
  });
});
