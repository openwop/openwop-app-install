/**
 * RFC 0176 §D.2 — the inbound webhook verifier seam.
 *
 * The assertion that carries weight is the ROUND TRIP: a delivery signed by the
 * same module the delivery worker signs with must verify. That is what makes a
 * passing witness here say something true about this host's SENDER, rather than
 * about a verifier written to agree with a verifier.
 */
import { describe, expect, it } from 'vitest';

import { signWebhookV1, verifyWebhookV1, webhookSignedPayload } from '../src/host/webhookSignature.js';
import { validateReceiveBody } from '../src/routes/webhookReceiveSeam.js';

const SECRET = 'conformance-secret-abc123';
const BODY = JSON.stringify({ runId: 'run-x', event: { type: 'run.completed', sequence: 3 } });
const TS_ = '1757100000';

/** A delivery in the v1.x canonical family ONLY — the shape §D.2 names. */
function xOnlyHeaders(sig: string): Record<string, string> {
  return {
    'X-openwop-webhook-id': 'sub-1',
    'X-openwop-event-type': 'run.completed',
    'X-openwop-timestamp': TS_,
    'X-openwop-signature': `sha256=${sig}`,
    'X-openwop-signature-algorithm': 'v1',
  };
}

describe('webhook receive seam (RFC 0176 §D.2)', () => {
  it('accepts an X-openwop-*-only scheme-v1 delivery signed by the SENDER’s own module', () => {
    const sig = signWebhookV1(SECRET, TS_, BODY);
    expect(verifyWebhookV1(SECRET, xOnlyHeaders(sig), BODY)).toEqual({ accepted: true });
  });

  it('accepts the OpenWOP-* family too — RFC 0165 §C.1 emits both with identical values', () => {
    const sig = signWebhookV1(SECRET, TS_, BODY);
    const res = verifyWebhookV1(SECRET, {
      'OpenWOP-Timestamp': TS_, 'OpenWOP-Signature': `sha256=${sig}`, 'OpenWOP-Signature-Algorithm': 'v1',
    }, BODY);
    expect(res.accepted, 'a receiver demanding one family would refuse half its own host’s traffic').toBe(true);
  });

  it('refuses a TAMPERED body — the negative half of the scenario', () => {
    const sig = signWebhookV1(SECRET, TS_, BODY);
    const res = verifyWebhookV1(SECRET, xOnlyHeaders(sig), `${BODY} `);
    expect(res.accepted).toBe(false);
    expect(res.reason).toMatch(/signature mismatch/);
  });

  it('refuses a tampered TIMESTAMP — the signed bytes cover it', () => {
    const sig = signWebhookV1(SECRET, TS_, BODY);
    const headers = { ...xOnlyHeaders(sig), 'X-openwop-timestamp': '1757100001' };
    expect(verifyWebhookV1(SECRET, headers, BODY).accepted).toBe(false);
  });

  it('refuses a wrong secret, a missing signature, a missing timestamp, and a foreign algorithm', () => {
    const sig = signWebhookV1(SECRET, TS_, BODY);
    expect(verifyWebhookV1('other-secret', xOnlyHeaders(sig), BODY).accepted).toBe(false);
    const { 'X-openwop-signature': _s, ...noSig } = xOnlyHeaders(sig);
    expect(verifyWebhookV1(SECRET, noSig, BODY)).toEqual({ accepted: false, reason: 'missing signature header' });
    const { 'X-openwop-timestamp': _t, ...noTs } = xOnlyHeaders(sig);
    expect(verifyWebhookV1(SECRET, noTs, BODY)).toEqual({ accepted: false, reason: 'missing timestamp header' });
    const foreign = { ...xOnlyHeaders(sig), 'X-openwop-signature-algorithm': 'v2' };
    expect(verifyWebhookV1(SECRET, foreign, BODY).reason).toMatch(/unsupported signature algorithm/);
  });

  it('a SHORT signature is refused, not thrown — timingSafeEqual throws on length mismatch', () => {
    const headers = { ...xOnlyHeaders('abc'), 'X-openwop-signature': 'sha256=abc' };
    expect(() => verifyWebhookV1(SECRET, headers, BODY)).not.toThrow();
    expect(verifyWebhookV1(SECRET, headers, BODY).accepted).toBe(false);
  });

  it('the signed bytes are exactly `{timestamp}.{rawBody}` — webhooks.md §Surfaces', () => {
    expect(webhookSignedPayload(TS_, BODY)).toBe(`${TS_}.${BODY}`);
  });

  it('closed-world validates the request body', () => {
    const good = { secret: SECRET, headers: { a: 'b' }, body: BODY };
    expect('error' in validateReceiveBody(good)).toBe(false);
    for (const [bad, re] of [
      [{ headers: {}, body: '' }, /secret must be/],
      [{ secret: SECRET, headers: {}, body: 1 }, /body must be a string/],
      [{ secret: SECRET, headers: [], body: '' }, /headers must be an object/],
      [{ secret: SECRET, headers: { a: 2 }, body: '' }, /headers\[a\] must be a string/],
    ] as Array<[unknown, RegExp]>) {
      const out = validateReceiveBody(bad);
      expect('error' in out, `expected refusal for ${JSON.stringify(bad)}`).toBe(true);
      if ('error' in out) expect(out.error).toMatch(re);
    }
  });
});
