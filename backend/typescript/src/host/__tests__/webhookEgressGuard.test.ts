/**
 * SSRF egress guard (2026-07 vuln-scan Phase 5). isDeniedWebhookHost is the shared
 * deny-predicate for every host outbound fetch; guardedEgressFetch is the shared
 * SSRF-guarded fetch new call sites (a2aSurface, oauthFlow) adopt. This asserts the
 * deny-list ranges (incl. the newly-added CGNAT + IPv6 site-local) and that
 * guardedEgressFetch refuses a denied host / insecure scheme BEFORE any socket.
 */
import { describe, it, expect } from 'vitest';
import { isDeniedWebhookHost, guardedEgressFetch, WebhookEgressDeniedError } from '../webhookEgressGuard.js';

describe('isDeniedWebhookHost', () => {
  it('denies loopback / RFC1918 private / link-local + metadata', () => {
    for (const h of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', 'localhost', '::1', 'metadata.google.internal']) {
      expect(isDeniedWebhookHost(h)).toBe(true);
    }
  });
  it('denies CGNAT 100.64.0.0/10 (newly added — cloud internal LBs / PSC)', () => {
    expect(isDeniedWebhookHost('100.64.0.1')).toBe(true);
    expect(isDeniedWebhookHost('100.127.255.254')).toBe(true);
    // boundaries: 100.63.x and 100.128.x are NOT in /10
    expect(isDeniedWebhookHost('100.63.0.1')).toBe(false);
    expect(isDeniedWebhookHost('100.128.0.1')).toBe(false);
  });
  it('denies IPv6 site-local fec0::/10 (newly added) + link-local + ULA', () => {
    expect(isDeniedWebhookHost('fec0::1')).toBe(true);
    expect(isDeniedWebhookHost('[fec0::1]')).toBe(true);
    expect(isDeniedWebhookHost('fe80::1')).toBe(true);
    expect(isDeniedWebhookHost('fd00::1')).toBe(true);
  });
  it('allows ordinary public hosts', () => {
    for (const h of ['api.openai.com', 'example.com', '8.8.8.8', '1.1.1.1']) {
      expect(isDeniedWebhookHost(h)).toBe(false);
    }
  });
  it('does NOT block public DOMAINS that start with fc/fd/fe/fec (the IPv6-prefix false-positive)', () => {
    for (const h of ['fec.gov', 'fdic.gov', 'fc2.com', 'fca.com', 'fd-tech.example.com', 'feedback.example.com']) {
      expect(isDeniedWebhookHost(h)).toBe(false);
    }
  });
});

describe('guardedEgressFetch (precheck refuses before any socket)', () => {
  it('rejects a denied-range host', async () => {
    await expect(guardedEgressFetch('https://169.254.169.254/latest/meta-data/')).rejects.toBeInstanceOf(WebhookEgressDeniedError);
    await expect(guardedEgressFetch('https://100.64.0.5/x')).rejects.toBeInstanceOf(WebhookEgressDeniedError);
  });
  it('rejects a non-https scheme', async () => {
    await expect(guardedEgressFetch('http://example.com/x')).rejects.toThrow(/https/);
  });
  it('rejects a malformed URL', async () => {
    await expect(guardedEgressFetch('not a url')).rejects.toThrow(/invalid URL/);
  });
});
