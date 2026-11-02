/**
 * Outbound notification delivery (messaging/notifyDeliverer.ts), the seam behind
 * `/host/openwop-app/messaging/notify` for email/SMS (added in `744afda22`, "real
 * outbound email/SMS delivery via pluggable webhook"; no ADR).
 *
 *   - synthetic deliverer reports accepted-but-not-delivered (no false positive)
 *   - webhook deliverer POSTs exactly the message and reports delivered on 2xx
 *   - non-2xx / network failure degrade to not-delivered (never throws)
 *
 * The webhook is an OPERATOR-set URL that receives message content + recipient,
 * so the body must be exactly the five message fields and nothing else.
 *
 * Sabotage witnessed (grade-tests w74, TST-DVA-5): synthetic `delivered: true`,
 * `res.ok` ignored, the auth header or the subject dropped, the catch re-thrown,
 * and the method changed — each reds its case.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  syntheticNotifyDeliverer,
  createWebhookNotifyDeliverer,
  type NotifyMessage,
} from '../src/messaging/notifyDeliverer.js';

const MSG: NotifyMessage = { kind: 'email', to: 'a@b.com', text: 'hi', subject: 'S', tenantId: 't1' };

describe('syntheticNotifyDeliverer', () => {
  it('accepts but does not claim delivery', async () => {
    const r = await syntheticNotifyDeliverer(MSG);
    expect(r).toEqual({ delivered: false, detail: 'synthetic email dispatch accepted; no provider configured' });
    expect(r.provider).toBeUndefined();
  });
});

describe('createWebhookNotifyDeliverer', () => {
  it('POSTs the message and reports delivered on 2xx', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
    const deliver = createWebhookNotifyDeliverer('https://hook.example/notify', { fetchImpl, authHeader: 'Bearer k' });
    const r = await deliver(MSG);

    expect(r).toEqual({ delivered: true, detail: 'email delivered via webhook (200)', provider: 'webhook' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://hook.example/notify');
    expect(init?.method).toBe('POST');
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer k');
    expect(headers.get('content-type')).toBe('application/json');
    // Exactly the message — an extra field leaking to the operator's endpoint reds this.
    expect(JSON.parse(String(init?.body))).toEqual({ kind: 'email', to: 'a@b.com', text: 'hi', subject: 'S', tenantId: 't1' });
  });

  it('reports not-delivered on a non-2xx response (no throw)', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('nope', { status: 503 }));
    const r = await createWebhookNotifyDeliverer('https://hook.example/notify', { fetchImpl })(MSG);
    expect(r).toEqual({ delivered: false, detail: 'notify webhook returned 503; message not delivered', provider: 'webhook' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reports not-delivered when the webhook is unreachable (no throw)', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => { throw new Error('ECONNREFUSED'); });
    const r = await createWebhookNotifyDeliverer('https://hook.example/notify', { fetchImpl })(MSG);
    expect(r).toEqual({ delivered: false, detail: 'notify webhook unreachable; message not delivered', provider: 'webhook' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
