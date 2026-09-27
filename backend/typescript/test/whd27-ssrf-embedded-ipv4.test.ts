/**
 * WHD-27 — an IPv4 address embedded in an IPv6 literal must meet the IPv4 ranges.
 *
 * Reported 2026-09-21 by the corpus session (found by MyndHyve in its copy of
 * this guard): the WHATWG URL parser normalises `https://[::ffff:127.0.0.1]/` to
 * the hostname `::ffff:7f00:1`, and the old predicate stripped a literal
 * `::ffff:` and matched DOTTED quads only, so the hex tail passed. And undici
 * never calls `connect.lookup` for an IP-literal host, so the connect-time guard
 * never saw it either.
 *
 * Measured against a REAL loopback listener — arrivals are the oracle, not the
 * predicate's return value — with a positive control proving the same request
 * DOES land when private egress is allowed (so "0 arrivals" is not a probe that
 * could never have been non-zero).
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fetch as undiciFetch } from 'undici';
import { isDeniedWebhookHost, makeGuardedAgent, webhookEgressDispatcher } from '../src/host/webhookEgressGuard.js';

const EMBEDDED_DENIED = [
  '[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[0:0:0:0:0:ffff:7f00:1]',   // mapped loopback, both spellings
  '[::ffff:a9fe:a9fe]',                                                // mapped 169.254.169.254 (metadata)
  '[::ffff:a00:1]', '[::ffff:c0a8:101]', '[::ffff:ac10:1]',            // mapped RFC 1918
  '[::ffff:6440:1]', '[::ffff:0:0]',                                   // mapped CGNAT, mapped 0.0.0.0
  '[::7f00:1]', '[::a9fe:a9fe]',                                       // IPv4-compatible
  '[64:ff9b::7f00:1]', '[64:ff9b::a9fe:a9fe]',                         // NAT64
  '[::]', '[::1]', '[0:0:0:0:0:0:0:1]',
];

describe('isDeniedWebhookHost — embedded IPv4 (WHD-27)', () => {
  it('denies every embedded private/loopback/metadata form, in the spelling URL.hostname produces', () => {
    for (const lit of EMBEDDED_DENIED) {
      const hostname = new URL(`https://${lit}/`).hostname;
      expect(isDeniedWebhookHost(hostname), `${lit} → ${hostname}`).toBe(true);
    }
  });

  it('still allows public addresses in the same embedded forms, and ordinary public IPv6', () => {
    for (const lit of ['[::ffff:808:808]', '[::ffff:8.8.8.8]', '[64:ff9b::808:808]', '[2001:4860:4860::8888]', '[2606:4700:4700::1111]']) {
      const hostname = new URL(`https://${lit}/`).hostname;
      expect(isDeniedWebhookHost(hostname), `${lit} → ${hostname}`).toBe(false);
    }
  });

  it('keeps the existing IPv6 ranges and the fc/fd/fe DOMAIN false-positive guard', () => {
    for (const h of ['fe80::1', 'febf::1', 'fec0::1', 'fc00::1', 'fdff::1']) expect(isDeniedWebhookHost(h), h).toBe(true);
    for (const h of ['fec.gov', 'fdic.gov', 'fc2.com', 'fe.example.com']) expect(isDeniedWebhookHost(h), h).toBe(false);
  });
});

describe('the dialled socket — a literal never reaches the listener (WHD-27)', () => {
  let server: http.Server;
  let port = 0;
  let arrivals = 0;

  beforeAll(async () => {
    server = http.createServer((_req, res) => { arrivals++; res.end('ok'); });
    // `::` with ipv6Only false is dual-stack, so `::ffff:127.0.0.1` reaches it.
    await new Promise<void>((resolve) => server.listen({ port: 0, host: '::', ipv6Only: false }, resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => { await new Promise<void>((resolve) => server.close(() => resolve())); });
  afterEach(() => {
    delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;
    delete process.env.OPENWOP_SAFEFETCH_ALLOW_PRIVATE;
    arrivals = 0;
  });

  const target = (lit: string) => `http://${lit}:${port}/`;

  it('positive control: with private egress ALLOWED the same mapped literal DOES land', async () => {
    process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = 'true';
    const res = await undiciFetch(target('[::ffff:7f00:1]'), { dispatcher: makeGuardedAgent() });
    expect(res.status).toBe(200);
    expect(arrivals).toBe(1);
  });

  it('the webhook dispatcher refuses mapped loopback in both spellings — 0 arrivals', async () => {
    for (const lit of ['[::ffff:7f00:1]', '[::ffff:127.0.0.1]']) {
      await expect(undiciFetch(target(lit), { dispatcher: webhookEgressDispatcher() })).rejects.toThrow();
    }
    expect(arrivals).toBe(0);
  });

  it('the safeFetch-shaped agent (its own gate) refuses a mapped literal too — 0 arrivals', async () => {
    const agent = makeGuardedAgent({ allowPrivate: () => process.env.OPENWOP_SAFEFETCH_ALLOW_PRIVATE === 'true' });
    await expect(undiciFetch(target('[::ffff:7f00:1]'), { dispatcher: agent })).rejects.toThrow();
    expect(arrivals).toBe(0);
  });

  it('a plain dotted loopback literal is refused at connect time as well (not only by a precheck)', async () => {
    await expect(undiciFetch(`http://127.0.0.1:${port}/`, { dispatcher: webhookEgressDispatcher() })).rejects.toThrow();
    expect(arrivals).toBe(0);
  });
});
