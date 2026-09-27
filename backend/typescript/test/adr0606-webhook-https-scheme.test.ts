/**
 * ADR 0606 — registration-time https enforcement for webhook subscriptions.
 *
 * `spec/v1/webhooks.md:41` (Stable, v1.1) says the subscription `url` "MUST be
 * `https://`", and §"SSRF protection" lists "Non-`https://` protocols" among the
 * shapes registration refuses. This host had neither arm.
 *
 * MEASURED on d1771e70c, before the fix, with the dev flag OFF:
 *   `http://example.com/hook`               => ACCEPTED
 *   `https://127.0.0.1/hook`                => REJECTED ssrf_guard   (control)
 *   `http://169.254.169.254/computeMetadata`=> REJECTED ssrf_guard
 * and the accepted row then DELIVERED — one plaintext POST carrying the payload
 * and the `x-openwop-signature` header (see webhook-delivery-queue.test.ts).
 *
 * So the hole was bounded to PUBLIC hosts — the metadata-server case the spec
 * names at :169 was already covered by the denied-host arm. What leaked is
 * confidentiality, not the secret: HMAC authenticates, it does not encrypt, and
 * a captured delivery replays to the receiver inside the ±5min freshness window.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { assertReachableUrl } from '../src/routes/webhooks.js';

/** Reduce a call to a comparable disposition so every case reads the same way. */
function outcome(url: string): string {
  try {
    assertReachableUrl(url);
    return 'ACCEPTED';
  } catch (e) {
    const err = e as { code?: string; details?: { reason?: string } };
    return `REJECTED:${err.code ?? 'error'}:${err.details?.reason ?? '-'}`;
  }
}

describe('ADR 0606 — webhook registration refuses non-https urls', () => {
  afterEach(() => {
    delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;
  });

  it('refuses a plaintext http:// url to a PUBLIC host — the case that was accepted', () => {
    expect(outcome('http://example.com/hook')).toBe('REJECTED:webhook_url_rejected:insecure_scheme');
  });

  // POSITIVE CONTROL. Without it, an arm that refused every url would be
  // indistinguishable from one that refuses only plaintext.
  it('positive control — an https url to a public host is still ACCEPTED', () => {
    expect(outcome('https://example.com/hook')).toBe('ACCEPTED');
  });

  it('the denied-host arm still bites, and still names ssrf_guard rather than the scheme', () => {
    expect(outcome('https://127.0.0.1/hook')).toBe('REJECTED:webhook_url_rejected:ssrf_guard');
  });

  it('a plaintext url to a PRIVATE host reports insecure_scheme, not ssrf_guard', () => {
    // Ordering is deliberate: the scheme arm runs first, so the caller is told
    // the reason that is true of every request they could retry with this url.
    expect(outcome('http://169.254.169.254/computeMetadata/v1/')).toBe(
      'REJECTED:webhook_url_rejected:insecure_scheme',
    );
  });

  it('a non-http(s) scheme is still refused as unsupported_protocol, ahead of everything', () => {
    expect(outcome('file:///etc/passwd')).toBe('REJECTED:webhook_url_rejected:unsupported_protocol');
  });

  it('the unsupported_protocol arm is NOT reopened by the dev flag', () => {
    // The flag is a private-egress escape hatch for local development. It must
    // not turn the registration endpoint into a file: reader.
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    expect(outcome('file:///etc/passwd')).toBe('REJECTED:webhook_url_rejected:unsupported_protocol');
  });

  it('the dev flag reopens plaintext loopback, so the conformance receiver still registers', () => {
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    expect(outcome('http://127.0.0.1:8787/receiver')).toBe('ACCEPTED');
  });

  it('an unparseable url is a validation_error, not a scheme rejection', () => {
    expect(outcome('not-a-url')).toBe('REJECTED:validation_error:-');
  });
});
