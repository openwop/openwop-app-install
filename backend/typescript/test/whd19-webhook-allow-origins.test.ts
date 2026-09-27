/**
 * WHD-19 — `OPENWOP_WEBHOOK_ALLOW_ORIGINS`, the exact-origin replacement for the
 * blanket `OPENWOP_WEBHOOK_ALLOW_PRIVATE` in the in-process conformance lane.
 *
 * What these tests have to prove is NOT "the allowlisted origin gets through" —
 * the blanket flag passed that test too, and it is how the lane came to certify
 * `webhooks` with the guard off. They have to prove the NEGATIVE around it: the
 * same host on another port, the same socket under the other scheme, `localhost`
 * for `127.0.0.1`, and every destination class `v2-webhook-egress-refusal`
 * probes (`webhooks.md` §SSRF) are all still refused while the allowlist is
 * set. An allowlist that admitted any of those would be a CIDR wearing an
 * origin's name.
 *
 * Three layers, because the knob is consulted at three:
 *   1. the parser — fail closed, WHOLE list, on any malformed entry;
 *   2. the guard — the ordered URL predicate + the connect-time connector
 *      (a real socket, because the connector is the only arm that can see a
 *      port for a HOSTNAME origin);
 *   3. the HTTP registration route — createApp + app.listen, POST /webhooks at
 *      major 2, exactly what the conformance row does.
 */
import http, { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetch as undiciFetch } from 'undici';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  assertEgressUrlAllowed,
  EgressUrlRejectedError,
  guardedEgressFetch,
  makeGuardedAgent,
  parseWebhookAllowOrigins,
  webhookEgressDispatcher,
  webhookPrivateEgressAllowedFor,
  WEBHOOK_ALLOW_ORIGINS_ENV,
} from '../src/host/webhookEgressGuard.js';
import { createApp } from '../src/index.js';

/** The eight destinations `v2-webhook-egress-refusal` (suite ≥ 2.33.0)
 *  registers, verbatim. Each is port 443 or 80 — which is precisely why an
 *  exact-port allowlist can never admit one of them. */
const EGRESS_REFUSAL_PROBES: ReadonlyArray<readonly [string, string]> = [
  ['non-https scheme', 'http://webhook-egress-probe.example.com/hook'],
  ['loopback (IPv4)', 'https://127.0.0.1/openwop-egress-probe'],
  ['loopback (IPv6)', 'https://[::1]/openwop-egress-probe'],
  ['localhost', 'https://localhost/openwop-egress-probe'],
  ['RFC 1918 (10/8)', 'https://10.255.255.1/openwop-egress-probe'],
  ['RFC 1918 (192.168/16)', 'https://192.168.255.1/openwop-egress-probe'],
  ['link-local / cloud metadata', 'https://169.254.169.254/latest/meta-data/'],
  ['IPv6 ULA', 'https://[fd00::1]/openwop-egress-probe'],
];

/** A port nothing listens on — registration never connects, so it only has to
 *  be a number the allowlist names. Chosen high and fixed so a sabotage run
 *  reads the same every time. */
const P = 47_919;

const savedAllowPrivate = process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;
const savedAllowOrigins = process.env[WEBHOOK_ALLOW_ORIGINS_ENV];
function setOrigins(v: string | undefined): void {
  if (v === undefined) delete process.env[WEBHOOK_ALLOW_ORIGINS_ENV];
  else process.env[WEBHOOK_ALLOW_ORIGINS_ENV] = v;
}
beforeAll(() => {
  // The blanket flag would make every negative below vacuous — it must be OFF
  // for the whole file, not merely unset by accident.
  delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;
});
afterEach(() => setOrigins(undefined));
afterAll(() => {
  if (savedAllowPrivate === undefined) delete process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE;
  else process.env.OPENWOP_WEBHOOK_ALLOW_PRIVATE = savedAllowPrivate;
  setOrigins(savedAllowOrigins);
});

function disposition(url: string, honorDevFlag = true): string {
  try {
    assertEgressUrlAllowed(url, { honorDevFlag });
    return 'ACCEPTED';
  } catch (e) {
    return e instanceof EgressUrlRejectedError ? e.reason : `other:${String(e)}`;
  }
}

// ── 1. the parser ─────────────────────────────────────────────────────────────

describe('parseWebhookAllowOrigins — exact origins, fail closed on the WHOLE list', () => {
  it('unset / blank is the production posture: no origins, no rejection', () => {
    expect(parseWebhookAllowOrigins(undefined)).toEqual({ origins: new Set() });
    expect(parseWebhookAllowOrigins('   ')).toEqual({ origins: new Set() });
  });

  it('canonicalises a well-formed list to scheme://host:port keys', () => {
    const r = parseWebhookAllowOrigins(' http://127.0.0.1:4001 ,https://Hooks.Example.test:8443/,http://[::1]:4002');
    expect(r.rejected).toBeUndefined();
    expect([...r.origins].sort()).toEqual(['http://127.0.0.1:4001', 'http://[::1]:4002', 'https://hooks.example.test:8443']);
  });

  it.each([
    ['no explicit port', 'http://127.0.0.1'],
    ['a path', 'http://127.0.0.1:4001/hook'],
    ['a CIDR', 'http://10.0.0.0/8'],
    ['a CIDR with a port', 'http://10.0.0.0:80/8'],
    ['a wildcard host', 'http://*.example.test:443'],
    ['userinfo', 'http://user@127.0.0.1:4001'],
    ['a query', 'http://127.0.0.1:4001?x=1'],
    ['a non-http scheme', 'ftp://127.0.0.1:21'],
    ['a bare host:port', '127.0.0.1:4001'],
    ['port 0', 'http://127.0.0.1:0'],
    ['port out of range', 'http://127.0.0.1:70000'],
    ['an empty entry (stray comma)', 'http://127.0.0.1:4001,,http://127.0.0.1:4002'],
  ])('%s is malformed and discards the ENTIRE list, good entries included', (_label, bad) => {
    const r = parseWebhookAllowOrigins(`http://127.0.0.1:4001,${bad}`);
    expect(r.rejected, `"${bad}" was accepted as an origin`).toBeDefined();
    expect(r.origins.size, 'a partially-applied relaxation — the good entry survived a bad one').toBe(0);
  });
});

// ── 2. the guard ──────────────────────────────────────────────────────────────

describe('assertEgressUrlAllowed with the allowlist set — exactly one socket opens', () => {
  it('admits the allowlisted origin (any path) and nothing adjacent to it', () => {
    setOrigins(`http://127.0.0.1:${P}`);
    expect(disposition(`http://127.0.0.1:${P}/hook`)).toBe('ACCEPTED');
    expect(disposition(`http://127.0.0.1:${P}/`)).toBe('ACCEPTED');
    // Same host, another port.
    expect(disposition(`http://127.0.0.1:${P + 1}/hook`)).toBe('insecure_scheme');
    expect(disposition(`https://127.0.0.1:${P + 1}/hook`)).toBe('denied_host');
    // Same host + port, the OTHER scheme.
    expect(disposition(`https://127.0.0.1:${P}/hook`)).toBe('denied_host');
    // The same machine under another NAME.
    expect(disposition(`http://localhost:${P}/hook`)).toBe('insecure_scheme');
    expect(disposition(`https://localhost:${P}/hook`)).toBe('denied_host');
  });

  it.each(EGRESS_REFUSAL_PROBES)('still refuses the egress-refusal probe: %s', (_cls, url) => {
    setOrigins(`http://127.0.0.1:${P}`);
    expect(disposition(url)).not.toBe('ACCEPTED');
  });

  it('a strict site (A2A push, honorDevFlag:false) ignores the allowlist entirely', () => {
    setOrigins(`http://127.0.0.1:${P}`);
    expect(disposition(`http://127.0.0.1:${P}/hook`, false)).toBe('insecure_scheme');
  });

  it('a malformed list fails CLOSED: the origin it tried to name is refused', () => {
    setOrigins(`http://127.0.0.1:${P},http://10.0.0.0/8`);
    expect(disposition(`http://127.0.0.1:${P}/hook`)).toBe('insecure_scheme');
    expect(webhookPrivateEgressAllowedFor(new URL(`http://127.0.0.1:${P}/`))).toBe(false);
  });

  it('unset: the default posture refuses the loopback origin (production unchanged)', () => {
    setOrigins(undefined);
    expect(disposition(`http://127.0.0.1:${P}/hook`)).toBe('insecure_scheme');
    expect(disposition(`https://127.0.0.1:${P}/hook`)).toBe('denied_host');
  });
});

describe('the connect-time connector — the arm that can see a PORT for a hostname', () => {
  let a: Server; let b: Server; let portA = 0; let portB = 0;
  beforeAll(async () => {
    const mk = async (): Promise<[Server, number]> => {
      const s = http.createServer((_q, r) => { r.writeHead(200, { connection: 'close' }); r.end('reached'); });
      await new Promise<void>((res) => s.listen(0, 'localhost', () => res()));
      return [s, (s.address() as AddressInfo).port];
    };
    [a, portA] = await mk();
    [b, portB] = await mk();
  });
  afterAll(async () => {
    await new Promise<void>((r) => a.close(() => r()));
    await new Promise<void>((r) => b.close(() => r()));
  });

  /** Only the DNS-resolved arm is exercised here: Node never calls `lookup` for
   *  an IP literal (measured — see `makeWebhookConnector`), so a `127.0.0.1`
   *  URL would pass the connector whatever the allowlist said and prove nothing. */
  async function viaDispatcher(url: string): Promise<string> {
    try {
      const r = await undiciFetch(url, { dispatcher: webhookEgressDispatcher(), redirect: 'error' });
      return `${r.status} ${await r.text()}`;
    } catch (e) {
      const cause = (e as { cause?: { code?: string } }).cause;
      return cause?.code ?? `other:${String(e)}`;
    }
  }

  it('dials the allowlisted hostname origin and refuses the same host on another port', async () => {
    setOrigins(`http://localhost:${portA}`);
    expect(await viaDispatcher(`http://localhost:${portB}/`)).toBe('OPENWOP_WEBHOOK_EGRESS_DENIED');
    expect(await viaDispatcher(`http://localhost:${portA}/`)).toBe('200 reached');
  });

  it('with no allowlist the same socket is refused at connect (the default posture)', async () => {
    setOrigins(undefined);
    expect(await viaDispatcher(`http://localhost:${portA}/`)).toBe('OPENWOP_WEBHOOK_EGRESS_DENIED');
  });

  it('a caller with its OWN gate (safeFetch) never inherits the webhook allowlist', async () => {
    setOrigins(`http://localhost:${portA}`);
    const agent = makeGuardedAgent({ allowPrivate: () => false });
    try {
      await undiciFetch(`http://localhost:${portA}/`, { dispatcher: agent });
      expect.fail('safeFetch reached an origin only the WEBHOOK allowlist names');
    } catch (e) {
      expect((e as { cause?: { code?: string } }).cause?.code).toBe('OPENWOP_WEBHOOK_EGRESS_DENIED');
    } finally {
      await agent.close();
    }
  });

  it('guardedEgressFetch (the A2A dispatch path) admits exactly the allowlisted literal origin', async () => {
    const lit = http.createServer((_q, r) => { r.writeHead(200, { connection: 'close' }); r.end('peer'); });
    await new Promise<void>((res) => lit.listen(0, '127.0.0.1', () => res()));
    const port = (lit.address() as AddressInfo).port;
    try {
      setOrigins(`http://127.0.0.1:${port}`);
      const ok = await guardedEgressFetch(`http://127.0.0.1:${port}/`);
      expect(`${ok.status} ${await ok.text()}`).toBe('200 peer');
      await expect(guardedEgressFetch(`http://127.0.0.1:${port + 1}/`)).rejects.toMatchObject({ code: 'OPENWOP_WEBHOOK_EGRESS_DENIED' });
      await expect(guardedEgressFetch(`http://localhost:${port}/`)).rejects.toMatchObject({ code: 'OPENWOP_WEBHOOK_EGRESS_DENIED' });
    } finally {
      await new Promise<void>((r) => lit.close(() => r()));
    }
  });
});

// ── 3. the HTTP registration route ────────────────────────────────────────────

describe('POST /webhooks (major 2) under the allowlist — what the conformance row sees', () => {
  let server: Server; let base = '';
  const HEADERS = { Authorization: 'Bearer dev-token', 'Content-Type': 'application/json', 'OpenWOP-Version': '2' };

  beforeAll(async () => {
    process.env.OPENWOP_STORAGE_DSN = 'memory://';
    process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true';
    const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
    server = await new Promise<Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

  async function register(url: string): Promise<string> {
    const res = await fetch(`${base}/webhooks`, { method: 'POST', headers: HEADERS, body: JSON.stringify({ url, events: ['run.completed'] }) });
    const json = (await res.json()) as { error?: unknown; code?: unknown };
    if (res.status === 201) return '201';
    const code = typeof json.error === 'string'
      ? json.error
      : typeof json.error === 'object' && json.error !== null && 'code' in json.error
        ? String((json.error as { code: unknown }).code)
        : String(json.code);
    return `${res.status} ${code}`;
  }

  it('accepts the allowlisted receiver origin — the lane can still register its receiver', async () => {
    setOrigins(`http://127.0.0.1:${P}`);
    expect(await register(`http://127.0.0.1:${P}/hook`)).toBe('201');
  });

  const ROUTE_REFUSALS: ReadonlyArray<readonly [string, string]> = [
    ['same host, another port', `http://127.0.0.1:${P + 1}/hook`],
    ['localhost for 127.0.0.1', `http://localhost:${P}/hook`],
    ['https on the same host + port', `https://127.0.0.1:${P}/hook`],
    ...EGRESS_REFUSAL_PROBES,
  ];
  it.each(ROUTE_REFUSALS)('refuses %s with 400 webhook_url_rejected while the allowlist is set', async (_label, url) => {
    setOrigins(`http://127.0.0.1:${P}`);
    expect(await register(url)).toBe('400 webhook_url_rejected');
  });

  it('a malformed list fails closed at the route too', async () => {
    setOrigins(`http://127.0.0.1:${P},http://*.example.test:80`);
    expect(await register(`http://127.0.0.1:${P}/hook`)).toBe('400 webhook_url_rejected');
  });

  it('unset: the loopback receiver is refused (production posture unchanged)', async () => {
    setOrigins(undefined);
    expect(await register(`http://127.0.0.1:${P}/hook`)).toBe('400 webhook_url_rejected');
  });
});
