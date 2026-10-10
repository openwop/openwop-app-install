/**
 * ADR 0851 (#4516) — the client address is the first UNTRUSTED hop walking
 * X-Forwarded-For from the right, never the client-written leftmost entry.
 *
 * Door shapes (MEASURED 2026-10-07, ADR 0851 §Context):
 *   direct run.app / domain mapping : <client-supplied…>, <client>
 *   Firebase Hosting /api rewrite    : <client-supplied…>, <client>, <Hosting egress>
 * The leftmost entries are attacker-chosen; a fresh one per request used to
 * mint a fresh rate-limit bucket per request.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import express, { type Request } from 'express';
import http from 'node:http';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { BlockList, isIP } from 'node:net';
import { GOOGLE_FRONT_END_CIDRS, clientIp, isTrustedProxy, normaliseAddress } from '../src/host/clientIp.js';
import { ipRateLimitMiddleware, _resetRateLimitState } from '../src/middleware/rateLimit.js';

const CLIENT = '198.51.100.23';
const HOSTING_EGRESS = '74.125.215.197'; // a measured Firebase-door peer

function fakeReq(xff: string | undefined, peer = '127.0.0.1'): Request {
  return {
    header: (n: string) => (n.toLowerCase() === 'x-forwarded-for' ? xff : undefined),
    socket: { remoteAddress: peer },
  } as unknown as Request;
}

const ENV_KEYS = ['K_SERVICE', 'OPENWOP_TRUSTED_PROXY_CIDRS', 'OPENWOP_TRUSTED_PROXY_DEFAULTS'] as const;
const saved: Record<string, string | undefined> = {};
beforeEach(() => { for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; } });
afterEach(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

describe('ADR 0851 — clientIp', () => {
  it('a missing X-Forwarded-For falls back to the socket address', () => {
    expect(clientIp(fakeReq(undefined, '203.0.113.5'))).toBe('203.0.113.5');
    expect(clientIp(fakeReq(undefined, '::ffff:127.0.0.1'))).toBe('127.0.0.1');
  });

  it('direct door: the GFE-appended entry is the client, whatever was written to its left', () => {
    expect(clientIp(fakeReq(CLIENT))).toBe(CLIENT);
    expect(clientIp(fakeReq(`1.2.3.4, ${CLIENT}`))).toBe(CLIENT);
    expect(clientIp(fakeReq(`10.0.0.1, 9.9.9.9, 1.1.1.1, ${CLIENT}`))).toBe(CLIENT);
  });

  it('Firebase door: the Hosting egress hop is skipped and the client behind it is read', () => {
    expect(clientIp(fakeReq(`${CLIENT}, ${HOSTING_EGRESS}`))).toBe(CLIENT);
    expect(clientIp(fakeReq(`6.6.6.6, ${CLIENT}, ${HOSTING_EGRESS}`))).toBe(CLIENT);
    for (const egress of ['192.178.15.134', '66.102.6.195', '64.233.160.5', '66.249.93.203', '142.250.1.1']) {
      expect(clientIp(fakeReq(`6.6.6.6, ${CLIENT}, ${egress}`)), egress).toBe(CLIENT);
    }
  });

  it('IPv6 clients at both doors', () => {
    const v6 = '2001:db8::7';
    expect(clientIp(fakeReq(`::1, ${v6}`))).toBe(v6);
    expect(clientIp(fakeReq(`fe80::1, ${v6}, 2607:f8b0:4001::5`))).toBe(v6);
  });

  it('a socket peer that is not a proxy means X-Forwarded-For is ignored entirely (directly exposed host)', () => {
    expect(clientIp(fakeReq(`1.2.3.4, ${CLIENT}`, '203.0.113.99'))).toBe('203.0.113.99');
  });

  it('on Cloud Run (K_SERVICE) the socket peer is the platform, whatever its address', () => {
    process.env.K_SERVICE = 'openwop-app-backend';
    expect(clientIp(fakeReq(`1.2.3.4, ${CLIENT}`, '203.0.113.99'))).toBe(CLIENT);
  });

  it('a GCP customer address (cloud.json) is NOT trusted — a caller on a VM cannot hide behind it', () => {
    expect(isTrustedProxy('34.120.1.1')).toBe(false);
    expect(clientIp(fakeReq(`1.2.3.4, 34.120.1.1`))).toBe('34.120.1.1');
  });

  it('no trusted default overlaps a GCP customer-assignable range (cloud.json snapshot)', () => {
    // A customer VM's address must never be skipped as a proxy hop: the walk
    // would then read the spoofed entry to its left — the #4516 bypass again.
    const cloud = JSON.parse(readFileSync(join(import.meta.dirname, 'fixtures/gcp-cloud-ranges.json'), 'utf8')) as { prefixes: string[] };
    expect(cloud.prefixes.length).toBeGreaterThan(1000);
    const fam = (a: string) => (isIP(a) === 4 ? 'ipv4' : 'ipv6') as 'ipv4' | 'ipv6';
    const toList = (cidrs: readonly string[]) => {
      const l = new BlockList();
      for (const c of cidrs) { const [n, b] = c.split('/'); l.addSubnet(n!, Number(b), fam(n!)); }
      return l;
    };
    const cloudList = toList(cloud.prefixes);
    const trustedGoogle = toList(GOOGLE_FRONT_END_CIDRS);
    const overlaps: string[] = [];
    // Two CIDRs overlap iff one contains the other's network address.
    for (const c of cloud.prefixes) { const n = c.split('/')[0]!; if (trustedGoogle.check(n, fam(n))) overlaps.push(`trusted ⊇ ${c}`); }
    for (const t of GOOGLE_FRONT_END_CIDRS) { const n = t.split('/')[0]!; if (cloudList.check(n, fam(n))) overlaps.push(`${t} ⊆ cloud`); }
    expect(overlaps).toEqual([]);
    // And through the real predicate, one address from every cloud.json prefix.
    expect(cloud.prefixes.filter((c) => isTrustedProxy(c.split('/')[0]!))).toEqual([]);
  });

  it('every hop trusted → the farthest one (a Google crawler on the direct door)', () => {
    expect(clientIp(fakeReq('66.249.93.203'))).toBe('66.249.93.203');
  });

  it('operator knobs: extra CIDRs, and dropping the Google defaults', () => {
    process.env.OPENWOP_TRUSTED_PROXY_CIDRS = '203.0.113.0/24, not-a-cidr';
    expect(clientIp(fakeReq(`1.2.3.4, ${CLIENT}, 203.0.113.10`))).toBe(CLIENT);
    process.env.OPENWOP_TRUSTED_PROXY_CIDRS = '';
    process.env.OPENWOP_TRUSTED_PROXY_DEFAULTS = 'private';
    expect(clientIp(fakeReq(`${CLIENT}, ${HOSTING_EGRESS}`))).toBe(HOSTING_EGRESS);
  });

  it('normalises mapped, bracketed and port-bearing entries; a non-address is never trusted', () => {
    expect(normaliseAddress('::ffff:10.1.2.3')).toBe('10.1.2.3');
    expect(normaliseAddress('203.0.113.4:5050')).toBe('203.0.113.4');
    expect(normaliseAddress('[2001:db8::1]:443')).toBe('2001:db8::1');
    expect(isTrustedProxy('unknown')).toBe(false);
    expect(clientIp(fakeReq(`${CLIENT}:6000, ${HOSTING_EGRESS}`))).toBe(CLIENT);
  });
});

describe('ADR 0851 — spoofed leftmost entries share ONE bucket (the #4516 witness)', () => {
  let server: http.Server;
  let base: string;
  const prev: Record<string, string | undefined> = {};
  const LIMIT_ENV = { OPENWOP_RATELIMIT_DISABLED: '', OPENWOP_FORCE_RATE_LIMIT: '', OPENWOP_RATELIMIT_TRUST_LOOPBACK: 'false', OPENWOP_RATELIMIT_IP_REQS_PER_MIN: '5', OPENWOP_RATELIMIT_IP_READ_REQS_PER_MIN: '5' };

  beforeEach(async () => {
    for (const [k, v] of Object.entries(LIMIT_ENV)) { prev[k] = process.env[k]; process.env[k] = v; }
    _resetRateLimitState();
    const app = express();
    app.use(ipRateLimitMiddleware());
    app.post('/write', (_req, res) => res.json({ ok: true }));
    await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => r()); });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterEach(async () => {
    for (const k of Object.keys(LIMIT_ENV)) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; }
    await new Promise<void>((r) => server.close(() => r()));
  });
  afterAll(() => _resetRateLimitState());

  async function burst(shape: (spoof: string) => string): Promise<number[]> {
    const out: number[] = [];
    for (let i = 0; i < 8; i++) {
      const r = await fetch(`${base}/write`, { method: 'POST', headers: { 'x-forwarded-for': shape(`10.${i}.${i}.${i}, 203.0.113.${i + 1}`) } });
      out.push(r.status);
    }
    return out;
  }

  it('direct-door shape: a fresh spoofed prefix per request still hits 429 after the write budget', async () => {
    const statuses = await burst((spoof) => `${spoof}, ${CLIENT}`);
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses.slice(5)).toEqual([429, 429, 429]);
  });

  it('Firebase-door shape: same, with the Hosting egress hop appended', async () => {
    const statuses = await burst((spoof) => `${spoof}, ${CLIENT}, ${HOSTING_EGRESS}`);
    expect(statuses.slice(5)).toEqual([429, 429, 429]);
  });

  it('a caller on a GCE VM (customer range) is bucketed on the VM address, not its spoofed entry', async () => {
    const vm = '35.185.128.9'; // cloud.json 35.185.128.0/19 — a customer VM, not a front end
    const out: number[] = [];
    for (let i = 0; i < 8; i++) {
      const r = await fetch(`${base}/write`, { method: 'POST', headers: { 'x-forwarded-for': `203.0.113.${i + 1}, ${vm}` } });
      out.push(r.status);
    }
    expect(out.slice(5)).toEqual([429, 429, 429]);
    expect(clientIp(fakeReq(`203.0.113.1, ${vm}`))).toBe(vm);
  });

  it('two real clients behind the Firebase door keep separate buckets (no global bucket on the egress)', async () => {
    await burst((spoof) => `${spoof}, ${CLIENT}, ${HOSTING_EGRESS}`);
    const other = await fetch(`${base}/write`, { method: 'POST', headers: { 'x-forwarded-for': `198.51.100.99, ${HOSTING_EGRESS}` } });
    expect(other.status).toBe(200);
  });
});

describe('ADR 0851 — ONE reader of the client address', () => {
  const SRC = join(import.meta.dirname, '../src');
  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
      else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
    }
    return out;
  }
  // Comments are stripped first: several files explain WHY they don't read these.
  const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

  it('no module outside host/clientIp.ts reads X-Forwarded-For, req.ip(s) or the socket peer', () => {
    const offenders: string[] = [];
    for (const p of sourceFiles(SRC)) {
      if (p.endsWith('/host/clientIp.ts')) continue;
      const code = stripComments(readFileSync(p, 'utf8'));
      if (/x-forwarded-for|\breq\.ips?\b|remoteAddress/i.test(code)) offenders.push(p.slice(SRC.length + 1));
    }
    expect(offenders, 'Derive the client address with host/clientIp.ts (ADR 0851) — a second reader is how #4516 happened.').toEqual([]);
  });
});
