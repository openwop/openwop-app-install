/**
 * SSRF egress guard (2026-07 vuln-scan Phase 5, ADR 0405; RFC 0093 §A.1 shared predicate).
 * isDeniedWebhookHost is the shared deny-predicate for every host outbound fetch;
 * guardedEgressFetch is the shared SSRF-guarded fetch new call sites (a2aSurface, oauthFlow)
 * adopt. This asserts the deny-list ranges (incl. the newly-added CGNAT + IPv6 site-local)
 * and that guardedEgressFetch refuses a denied host / insecure scheme BEFORE any socket:
 * undici's `fetch` is mocked (the real `Agent` stays), so every refusal also asserts that
 * no request was handed to undici, and a regressed arm can never reach the network.
 *
 * The predicate cases overlap `test/rfc0093-webhook-egress.test.ts` ('rfc0093 shared
 * denied-range predicate') and `test/whd27-ssrf-embedded-ipv4.test.ts` (the fc/fd/fe DOMAIN
 * guard); all protected, kept. Unique here: the bracketed `[fec0::1]`, 100.127.255.254, and
 * the whole guardedEgressFetch block.
 *
 * Red when (w74g4-we-* probes, wave 74): the CGNAT bounds move; metadata.google.internal,
 * 127/8 or 172.16/12 leave the deny list; fe80/fec0/fc00 stop matching; IPv6 brackets are
 * not stripped; a public host is denied, or an fc/fd/fe DOMAIN is; the denied-host refusal
 * stops being a WebhookEgressDeniedError; the malformed-URL message changes; (round 2,
 * w74g4-r2-we-*) the https arm, the denied-host arm, or the 169.254 / 100.64 ranges are
 * dropped.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: vi.fn(async () => new actual.Response('unexpected')) };
});

import { fetch as undiciFetch } from 'undici';
import { isDeniedWebhookHost, guardedEgressFetch, WebhookEgressDeniedError } from '../webhookEgressGuard.js';

const fetchSpy = vi.mocked(undiciFetch);

beforeEach(() => {
  fetchSpy.mockClear();
});

describe('isDeniedWebhookHost', () => {
  it('denies loopback / RFC1918 private / link-local + metadata', () => {
    for (const h of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', 'localhost', '::1', 'metadata.google.internal']) {
      expect(isDeniedWebhookHost(h), h).toBe(true);
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
      expect(isDeniedWebhookHost(h), h).toBe(false);
    }
  });
  it('does NOT block public DOMAINS that start with fc/fd/fe/fec (the IPv6-prefix false-positive)', () => {
    for (const h of ['fec.gov', 'fdic.gov', 'fc2.com', 'fca.com', 'fd-tech.example.com', 'feedback.example.com']) {
      expect(isDeniedWebhookHost(h), h).toBe(false);
    }
  });
});

describe('guardedEgressFetch (precheck refuses before any socket)', () => {
  it('rejects a denied-range host', async () => {
    await expect(guardedEgressFetch('https://169.254.169.254/latest/meta-data/')).rejects.toBeInstanceOf(WebhookEgressDeniedError);
    await expect(guardedEgressFetch('https://100.64.0.5/x')).rejects.toMatchObject({ code: 'OPENWOP_WEBHOOK_EGRESS_DENIED' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('rejects a non-https scheme', async () => {
    await expect(guardedEgressFetch('http://example.invalid/x')).rejects.toThrow('guardedEgressFetch: endpoint must be https');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('rejects a malformed URL', async () => {
    await expect(guardedEgressFetch('not a url')).rejects.toThrow('guardedEgressFetch: invalid URL');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('positive control: an allowed https host IS handed to undici (so the zero-call asserts above can fail)', async () => {
    const res = await guardedEgressFetch('https://example.invalid/x');
    expect(await res.text()).toBe('unexpected');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[0]).toBe('https://example.invalid/x');
  });
});
