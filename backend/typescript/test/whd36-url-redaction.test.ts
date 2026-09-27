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
 */
import { describe, expect, it } from 'vitest';
import { redactUrlForLog } from '../src/host/webhookDeliveryWorker.js';

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
