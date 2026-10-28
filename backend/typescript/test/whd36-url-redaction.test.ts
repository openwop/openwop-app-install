/**
 * WHD-36 / WHDATA-2 — findings applied from this session's /grade-code and
 * /grade-data passes.
 *
 * WHD-36: the delivery-failure log emitted the subscriber URL verbatim. A
 * subscriber URL is operator-supplied and routinely carries a credential in the
 * query string, so the log was a plausible route for a customer secret into log
 * storage, where it outlives the subscription.
 *
 * The redaction drops query + fragment WHOLESALE rather than filtering by key
 * name: an allowlist has to be right about every parameter name any subscriber
 * ever chooses, and being wrong once is the whole leak.
 *
 * Two layers, both asserted: the helper (`redactUrlForLog`), and the WIRING — the
 * `webhook delivery failed` line a real failed attempt writes to stdout carries
 * the redacted URL and no secret. The helper cases alone stayed green with the
 * failure log reverted to `url: rec.url` (wave 64 probe 8fw5g2-wh-log-wiring,
 * vacuous), which is exactly the WHD-36 defect.
 */
import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import type { WebhookDeliveryRecord } from '../src/types.js';
import { processDueWebhookDeliveries, redactUrlForLog, WEBHOOK_MAX_ATTEMPTS } from '../src/host/webhookDeliveryWorker.js';

describe('WHD-36 — subscriber URLs are safe to log', () => {
  it('keeps origin + path, which is what makes a failure diagnosable', () => {
    expect(redactUrlForLog('https://hooks.example.com/openwop/ingest'))
      .toBe('https://hooks.example.com/openwop/ingest');
  });

  it('drops the query wholesale — any param may be the credential', () => {
    for (const [raw, why] of [
      ['https://h.example.com/i?token=SECRET', 'the obvious one'],
      ['https://h.example.com/i?tenant=acme&sig=deadbeef', 'a signature beside a benign param'],
      ['https://h.example.com/i?x=1', 'a param nobody would allowlist, redacted anyway'],
    ] as const) {
      const out = redactUrlForLog(raw);
      expect(out, why).toBe('https://h.example.com/i?<redacted>');
      expect(out, `${why}: no secret material survives`).not.toMatch(/SECRET|deadbeef/);
    }
  });

  it('drops userinfo — a credential in the authority never reaches the log', () => {
    const out = redactUrlForLog('https://user:pw-in-url@h.example.com/i');
    expect(out).toBe('https://h.example.com/i');
    expect(out).not.toMatch(/pw-in-url|user/);
  });

  it('drops the fragment too', () => {
    expect(redactUrlForLog('https://h.example.com/i#tok')).toBe('https://h.example.com/i');
  });

  it('degrades to a constant, NEVER to the raw string, when unparseable', () => {
    // The failure mode that matters: a parse error must not fall through to
    // logging the original value, which is exactly what it was doing before.
    const out = redactUrlForLog('not a url ?token=SECRET');
    expect(out).toBe('<unparseable-url>');
    expect(out).not.toMatch(/SECRET/);
  });
});

describe('WHD-36 — the delivery-failure log line itself is redacted (the wiring)', () => {
  const T0 = 1_700_000_000_000;
  const saved = process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;
  afterEach(() => {
    vi.restoreAllMocks();
    if (saved === undefined) delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE; else process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = saved;
  });

  it('a failed attempt logs `webhook delivery failed` with the redacted URL and no secret', async () => {
    // A loopback subscriber that answers 500: a real failed attempt, no network
    // beyond 127.0.0.1.
    const server = http.createServer((_req, res) => { res.writeHead(500); res.end('nope'); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    if (addr === null || typeof addr === 'string') throw new Error(`expected a TCP address, got ${String(addr)}`);
    const { port } = addr;
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    const url = `http://127.0.0.1:${port}/i?token=plain-subscriber-secret`;
    const lines: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { lines.push(String(chunk)); return true; });
    try {
      const storage = await openStorage('memory://');
      await storage.insertWebhook({ subscriptionId: 'sub-36', tenantId: 'default', url, events: ['*'], secret: 'shh', createdAt: new Date(T0).toISOString() });
      const rec: WebhookDeliveryRecord = {
        deliveryId: 'd-36', subscriptionId: 'sub-36', url, secret: 'shh', eventType: 'run.completed',
        payload: JSON.stringify({ type: 'run.completed', runId: 'r1' }), status: 'pending', attempts: 0,
        maxAttempts: WEBHOOK_MAX_ATTEMPTS, nextAttemptAt: T0, claimedBy: null, claimExpiresAt: null,
        lastError: null, createdAt: T0, updatedAt: T0,
      };
      await storage.enqueueWebhookDelivery(rec);
      expect(await processDueWebhookDeliveries(storage, 'w-36', T0)).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    const failed = lines.filter((l) => l.includes('"msg":"webhook delivery failed"'));
    expect(failed, 'the failure line was written (the case cannot pass on "no log at all")').toHaveLength(1);
    expect(JSON.parse(failed[0]!)).toMatchObject({ component: 'webhookDeliveryWorker', url: `http://127.0.0.1:${port}/i?<redacted>` });
    expect(lines.join('')).not.toContain('plain-subscriber-secret');
  });
});
