/**
 * ADR 0906 P0 / D8 — a FAILED custom-host lookup fails closed.
 *
 * Only a host that can never be a custom domain passes through; a customer host
 * gets 503 + Retry-After and never reaches the next handler (in the app: sign-in
 * and the API). Each platform-set member is covered. `*.run.app` is the
 * load-bearing one: MEASURED 2026-10-17 from the openwop-dev Cloud Run request
 * logs (read-only), every prod request arrives with `Host` set to one of the two
 * run.app forms (`…-89896419173.us-central1.run.app`, `…-jkav3gnlqa-uc.a.run.app`),
 * never `app.openwop.dev` — the Firebase rewrite does not forward the public Host.
 *
 * Tracker TST-CQG-1 (w68). The unit legs drive `customDomainMiddleware()` on a
 * bare `express()` app over a real socket (no hand-built req/res casts); a request
 * that reaches the terminal handler is "passed through". Sabotage-witnessed: red
 * when a failed lookup lets every host through, when Retry-After changes, when
 * `*.run.app` leaves the platform suffixes, when the configured origins stop
 * counting as platform hosts, when a sixth pending claim is admitted, and when an
 * `anon:` tenant may add a domain.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const lookup = vi.hoisted(() => ({ fail: false }));
vi.mock('../src/host/customDomains.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/host/customDomains.js')>();
  return {
    ...actual,
    resolveCustomHost: async (host: string) => {
      if (lookup.fail) throw new Error('store unavailable');
      return actual.resolveCustomHost(host);
    },
  };
});

import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { openStorage } from '../src/storage/index.js';
import { vendorPath } from '../src/middleware/protocolVersion.js';
import { customDomainMiddleware } from '../src/middleware/customDomain.js';
import {
  __resetCustomDomains, addDomain, isPlatformHost,
} from '../src/host/customDomains.js';

const ENV_KEYS = ['OPENWOP_PUBLIC_BASE_URL', 'OPENWOP_CORS_ORIGINS'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.OPENWOP_PUBLIC_BASE_URL = 'https://app.example.dev';
  process.env.OPENWOP_CORS_ORIGINS = 'https://studio.example.dev, https://admin.example.dev:8443';
  lookup.fail = false;
  await __resetCustomDomains();
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

/** The ErrorEnvelope shape (middleware/errorEnvelope.ts) plus the terminal handler's marker. */
interface Body { passed?: boolean; error?: string; message?: string }

let unit: http.Server; let unitPort = 0;
beforeAll(async () => {
  const app = express();
  app.use(customDomainMiddleware());
  app.use((_req, res) => { res.status(200).json({ passed: true }); }); // reached ⇒ passed through
  await new Promise<void>((res) => { unit = app.listen(0, '127.0.0.1', () => { unitPort = (unit.address() as AddressInfo).port; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => unit.close(() => res())); });

/** One GET through the middleware with a spoofed Host (fetch forbids overriding Host). */
function run(host: string): Promise<{ passed: boolean; status: number; retryAfter?: string; body: Body }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: unitPort, method: 'GET', path: '/runs', headers: { host } }, (res) => {
      let raw = ''; res.on('data', (c) => (raw += c));
      res.on('end', () => {
        let body: Body = {};
        try { body = JSON.parse(raw); } catch { /* a non-JSON answer (express's default error page) is not a pass */ }
        const retry = res.headers['retry-after'];
        resolve({ passed: body.passed === true, status: res.statusCode ?? 0, ...(typeof retry === 'string' ? { retryAfter: retry } : {}), body });
      });
    });
    req.on('error', reject); req.end();
  });
}

describe('ADR 0906 D8 — a failed lookup fails closed', () => {
  it.each([
    ['the public origin', 'app.example.dev'],
    ['the public origin with a port', 'app.example.dev:443'],
    ['a CORS origin', 'studio.example.dev'],
    ['a CORS origin that carries a port', 'admin.example.dev:8443'],
    ['the Firebase-rewritten Cloud Run host (hash form)', 'openwop-app-backend-abc123xyz-uc.a.run.app'],
    ['the Cloud Run host (project-number form)', 'openwop-app-backend-123456789.us-central1.run.app'],
    ['a Firebase Hosting default host', 'app-openwop-dev.web.app'],
    ['a Firebase legacy host', 'openwop-dev.firebaseapp.com'],
    ['localhost', 'localhost:8080'],
    ['an IPv4 literal (health checks)', '10.0.0.7:8080'],
    ['an IPv6 literal', '[::1]:8080'],
  ])('passes %s through', async (_label, host) => {
    lookup.fail = true;
    const out = await run(host);
    expect(out.passed).toBe(true);
    expect(out.status).toBe(200); // reached the next handler with no error forwarded
  });

  it('a customer host gets 503 service_unavailable with Retry-After, and never reaches the next handler', async () => {
    lookup.fail = true;
    const out = await run('pages.customer.com');
    expect(out.passed).toBe(false);
    expect(out.status).toBe(503);
    expect(out.retryAfter).toBe('30');
    expect(out.body.error).toBe('service_unavailable');
  });

  it('a healthy lookup is unchanged: an unbound customer host passes through', async () => {
    const out = await run('pages.customer.com');
    expect(out.passed).toBe(true);
  });

  it('every platform suffix is refused at add time, so "platform" and "claimable" never overlap', async () => {
    for (const hostname of ['evil.run.app', 'evil.web.app', 'evil.firebaseapp.com']) {
      expect(isPlatformHost(hostname)).toBe(true);
      await expect(addDomain({ tenantId: 't1', orgId: 'o1', createdBy: 'u1', hostname })).rejects.toThrow(/hosting provider/);
    }
    expect(isPlatformHost('pages.customer.com')).toBe(false);
  });
});


describe('ADR 0906 D2/C4 — add limits', () => {
  it('an anon: tenant cannot add a domain', async () => {
    await expect(addDomain({ tenantId: 'anon:abc', orgId: 'o1', createdBy: 'u1', hostname: 'pages.example.com' })).rejects.toThrow(/Sign in/);
  });

  it('a sixth pending claim is refused', async () => {
    for (let i = 0; i < 5; i++) await addDomain({ tenantId: 't1', orgId: 'o1', createdBy: 'u1', hostname: `p${i}.example.com` });
    await expect(addDomain({ tenantId: 't1', orgId: 'o1', createdBy: 'u1', hostname: 'p5.example.com' })).rejects.toThrow(/waiting for verification/);
    await expect(addDomain({ tenantId: 't2', orgId: 'o1', createdBy: 'u1', hostname: 'other.example.com' })).resolves.toMatchObject({ status: 'pending' });
  });
});

describe('ADR 0906 D8 — over HTTP: a customer host never reaches an authed route', () => {
  let server: http.Server; let port = 0;
  beforeAll(async () => {
    const { createApp } = await import('../src/index.js');
    process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { port = (server.address() as AddressInfo).port; res(); }); });
  });
  afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

  const get = (path: string, host: string): Promise<{ status: number; body: string }> => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path, headers: { host } }, (res) => {
      let raw = ''; res.on('data', (c) => (raw += c)); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: raw }));
    });
    req.on('error', reject); req.end();
  });

  it('customer host ⇒ 503 on the authed orgs route; the platform host still reaches it', async () => {
    lookup.fail = true;
    const customer = await get(vendorPath('/orgs'), 'pages.customer.com');
    expect(customer.status).toBe(503);
    const customerBody: Body = JSON.parse(customer.body);
    expect(customerBody.error).toBe('service_unavailable');
    const platform = await get(vendorPath('/orgs'), `127.0.0.1:${port}`);
    // The platform host reaches the app's own route and is answered by it (this
    // test app admits an anonymous caller there), never by the fail-closed guard.
    expect(platform.status).toBe(200);
    const platformBody: Body = JSON.parse(platform.body);
    expect(platformBody.error).toBeUndefined();
  });
});
