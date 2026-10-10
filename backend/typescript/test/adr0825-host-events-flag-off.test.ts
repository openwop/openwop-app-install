/**
 * ADR 0825 P1 — with `OPENWOP_HOST_EVENTS_V2` OFF (the default), host-event
 * webhook delivery is BYTE-IDENTICAL to the pre-RFC-0236 host.
 *
 * The golden bodies below were not written by hand: they were captured by
 * running this file against the pre-change `routes/webhooks.ts` (the
 * `origin/chore/corpus-2.45.21` tip, 23c6e8d8f), with time and the event id
 * pinned, and then asserted unchanged against the flagged code. A flag that
 * leaked into the off path (the `{ hostEvent }` body, the two-segment type, a
 * dropped `*` match) reddens a golden.
 *
 * It deliberately pins the NON-conformant major-2 body (`runId: "hostext:…"`):
 * that is what live receivers get today, and the flag exists so they keep
 * getting it until an operator turns RFC 0236 on.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { Storage } from '../src/storage/storage.js';
import { initHostExtPersistence, __resetHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { deliverHostExtEvent } from '../src/routes/webhooks.js';

const TENANT = 'org:flag-off';
let storage: Storage;
const savedFlag = process.env.OPENWOP_HOST_EVENTS_V2;

beforeAll(async () => {
  delete process.env.OPENWOP_HOST_EVENTS_V2;
  storage = await openStorage('memory://');
  initHostExtPersistence(storage);
  const base = { tenantId: TENANT, secret: 's', createdAt: '2026-10-05T00:00:00.000Z' };
  await storage.insertWebhook({ ...base, subscriptionId: 'off-v2-name', url: 'https://example.test/a', events: ['host.crm.contact.created'], protocolMajor: 2 });
  await storage.insertWebhook({ ...base, subscriptionId: 'off-v2-star', url: 'https://example.test/b', events: ['*'], protocolMajor: 2 });
  await storage.insertWebhook({ ...base, subscriptionId: 'off-v1-name', url: 'https://example.test/c', events: ['host.crm.contact.created'], protocolMajor: 1 });
  await storage.insertWebhook({ ...base, subscriptionId: 'off-v2-twoseg', url: 'https://example.test/d', events: ['openwop-app.crm-contact-created'], protocolMajor: 2 });
});
afterAll(() => {
  if (savedFlag === undefined) delete process.env.OPENWOP_HOST_EVENTS_V2; else process.env.OPENWOP_HOST_EVENTS_V2 = savedFlag;
  __resetHostExtPersistence();
});

const GOLDEN_V2 = '{"runId":"hostext:openwop-app.crm.contact-created","event":{"eventId":"hev:00000000-0000-4000-8000-000000000001","runId":"hostext:openwop-app.crm.contact-created","sequence":0,"type":"openwop-app.crm.contact-created","payload":{"contactId":"c-1"},"timestamp":"2026-10-05T12:00:00.000Z","schemaVersion":1}}';

describe('ADR 0825 — flag OFF: host-event webhooks are unchanged', () => {
  it('emits the pre-flag bodies, types and subscriber set, byte for byte', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-05T12:00:00.000Z'));
    try {
      await deliverHostExtEvent({ type: 'host.crm.contact.created', tenantId: TENANT, payload: { contactId: 'c-1' }, eventId: 'hev:00000000-0000-4000-8000-000000000001' });
    } finally {
      vi.useRealTimers();
    }
    const rows = await storage.claimDueWebhookDeliveries('w', Date.now() + 1, 60_000, 50);
    const bySub = new Map(rows.map((r) => [r.subscriptionId, r]));
    // Positive controls: the two major-2 subscriptions that matched before still match.
    // The major-1 one matched too, but ADR 0812 decision 2 enqueues nothing for it
    // now that major 1 is gone (its pre-flag golden went with it in P3c).
    expect([...bySub.keys()].sort()).toEqual(['off-v2-name', 'off-v2-star']);
    // The two-segment RFC 0236 name is NOT a pre-flag spelling, so it matched nothing before and nothing now.
    expect(bySub.has('off-v2-twoseg')).toBe(false);
    expect(bySub.get('off-v2-name')!.payload).toBe(GOLDEN_V2);
    expect(bySub.get('off-v2-star')!.payload).toBe(GOLDEN_V2);
    expect(bySub.get('off-v2-name')!.eventType).toBe('openwop-app.crm.contact-created');
  });
});
