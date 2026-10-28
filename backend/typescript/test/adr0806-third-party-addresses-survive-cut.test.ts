/**
 * ADR 0806 — the addresses third parties hold survive the v1 cut.
 *
 * `versioning.md` §5: the `/v1/host/<org>/…` twin "retires atomically with
 * `/v1`", so on a retired host it is not served. What survives:
 *
 * - a READ of a vendor address outsiders hold (the auth layer's unauthenticated
 *   set) forwards `308` to the unversioned address — generalising ADR 0669's
 *   asset rule to public pages, feeds, shared cards, email links, `embed.js`;
 * - nothing else: a write still answers `410` (a provider webhook does not
 *   reliably follow a redirect; the operator re-points it before the cut), and
 *   so does a read of an authenticated vendor address or any protocol path.
 *
 * Plus the emitters: every address this host hands to an outsider is now the
 * unversioned one; the OAuth `redirect_uri` stays on the provider-registered
 * `/v1` twin unless the operator opts in. Tracker: TST-BVC-1.
 *
 * Red when (wave 60 probes w60g4-fwd-*, redirect-uri, ingest-url, oauth-held,
 * embed-api, form-action): a write or an authenticated read is forwarded; a dot
 * segment or a non-vendor path reaches the Location; the log carries the
 * token-bearing path; the CORS / no-cache headers, the `/api` prefix or the
 * query are dropped; the redirect_uri ignores the opt-in or a pending flow's
 * stored value; the ingest URL is versioned; the OAuth callback is not held;
 * `embed.js` rewrites a `/api/v1` base wrongly; any server-rendered form posts
 * to `/v<N>/`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import vm from 'node:vm';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { beginAuthorization, consumePendingAuth, inboundIngestUrl, redirectUri } from '../src/features/connections/oauthFlow.js';
import { retiredVendorTwinPath } from '../src/middleware/protocolVersion.js';

let server: http.Server; let base = '';
const ENV = ['OPENWOP_STORAGE_DSN', 'OPENWOP_AUTH_DISABLE_COOKIES', 'OPENWOP_TEST_SEAM_ENABLED'] as const;
const savedEnv: Record<string, string | undefined> = {};
beforeAll(async () => {
  for (const k of ENV) savedEnv[k] = process.env[k];
  process.env.OPENWOP_STORAGE_DSN = 'memory://'; process.env.OPENWOP_AUTH_DISABLE_COOKIES = 'true'; process.env.OPENWOP_TEST_SEAM_ENABLED = 'true';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  for (const k of ENV) { const v = savedEnv[k]; if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

/** A GET whose path reaches the server BYTE-FOR-BYTE. `fetch` normalises `/./`
 *  and `/../` client-side, which would test a different path than the one named. */
function rawGet(path: string): Promise<number> {
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    r.on('error', reject); r.end();
  });
}
async function req(method: string, path: string): Promise<Response> {
  return fetch(`${base}${path}`, { method, redirect: 'manual', headers: { 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) });
}

describe('ADR 0806 — held addresses forward; everything else is retired', () => {
  it('RETIRED: a read of a held address forwards 308 to the unversioned one, query kept', async () => {
    for (const method of ['GET', 'HEAD']) {
      const res = await req(method, '/v1/host/openwop-app/public/pricing?currency=eur');
      expect(res.status, method).toBe(308);
      expect(res.headers.get('location'), method).toBe('/host/openwop-app/public/pricing?currency=eur');
      expect(await res.text(), `${method}: a retired address serves no body`).toBe('');
    }
    const followed = await fetch(`${base}/v1/host/openwop-app/public/pricing`);
    expect(followed.status).toBe(200);
  });

  it('RETIRED: each forward is logged with its family and caller class, and nothing identifying', async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => { lines.push(String(chunk)); return true; });
    try {
      await fetch(`${base}/v1/host/openwop-app/shared/secret-token-123/card`, { redirect: 'manual', headers: { accept: 'text/html' } });
    } finally { spy.mockRestore(); }
    const logged = lines.flatMap((l) => l.split('\n')).filter((l) => l.includes('retired_twin_forward')).map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ family: 'host/openwop-app/shared', caller: 'browser' });
    expect(JSON.stringify(logged[0])).not.toContain('secret-token-123');
  });

  it('RETIRED: a WRITE to a held address is still 410 — the operator re-points webhooks', async () => {
    for (const path of ['/v1/host/openwop-app/billing/webhook', '/v1/host/openwop-app/public-email/events/x']) {
      expect((await req('POST', path)).status, path).toBe(410);
    }
  });

  it('RETIRED: a read of an authenticated vendor address or a protocol path is 410', async () => {
    for (const path of ['/v1/host/openwop-app/orgs', '/v1/runs', '/v1/.well-known/openwop']) {
      expect((await req('GET', path)).status, path).toBe(410);
    }
  });

  it('RETIRED: a crafted path cannot turn the forward into an open redirect', async () => {
    for (const path of ['/v1//evil.example/x', '/v1/host/openwop-app//evil.example/x', '/v1/host/other-org/public/x']) {
      const res = await req('GET', path);
      expect(res.status, path).toBe(410);
    }
    expect(retiredVendorTwinPath('/v1//evil.example')).toBeNull();
    expect(retiredVendorTwinPath('/v1/host/openwop-app//evil.example')).toBeNull();
    expect(retiredVendorTwinPath('/v2/host/openwop-app/public/x')).toBe('/host/openwop-app/public/x');
  });
});

describe('ADR 0806 — review fixes on the forward', () => {
  it('behind an /api-only proxy the Location keeps the /api prefix', async () => {
    const res = await req('GET', '/api/v1/host/openwop-app/public/pricing?x=1');
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe('/api/host/openwop-app/public/pricing?x=1');
  });

  it('a cross-origin read gets a CORS-readable redirect; every forward revalidates', async () => {
    const res = await fetch(`${base}/v1/host/openwop-app/public/pricing`, { redirect: 'manual', headers: { Origin: 'https://customer.example' } });
    expect(res.status).toBe(308);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('cache-control')).toBe('no-cache');
  });

  it('a dot segment under a HELD prefix is refused, not resolved by the browser onto another path', async () => {
    // These are on the public list, so it is the target check — not the held
    // predicate — that refuses them.
    for (const path of ['/v1/host/openwop-app/public/../orgs', '/v1/host/openwop-app/public/%2e%2e/orgs', '/v1/host/openwop-app/public/./pricing']) {
      expect(await rawGet(path), path).toBe(410);
    }
    // Control: the same prefix without a dot segment does forward.
    expect(await rawGet('/v1/host/openwop-app/public/pricing')).toBe(308);
  });

  it('the OAuth callback is forwarded: a provider redirect in flight at the cut still lands', async () => {
    const res = await req('GET', '/v1/host/openwop-app/connections/slack/callback?code=c&state=s');
    expect(res.status).toBe(308);
    expect(res.headers.get('location')).toBe('/host/openwop-app/connections/slack/callback?code=c&state=s');
  });

  it('a flow started BEFORE the cut replays the redirect_uri it sent, not the post-cut value', async () => {
    process.env.OPENWOP_OAUTH_SLACK_CLIENT_ID = 'cid';
    process.env.OPENWOP_OAUTH_SLACK_CLIENT_SECRET = 'csecret';
    process.env.OPENWOP_OAUTH_CALLBACK_BASE_URL = 'https://host.example';
    try {
      const begun = await beginAuthorization({ provider: 'slack', tenantId: 't-oauth', userId: 'u1', reqOrigin: 'https://host.example' });
      const sent = new URL(begun.authorizeUrl).searchParams.get('redirect_uri');
      expect(sent).toBe('https://host.example/v1/host/openwop-app/connections/slack/callback');
      process.env.OPENWOP_OAUTH_REDIRECT_UNVERSIONED = 'true'; // the operator opted in mid-flow
      expect(redirectUri('slack', 'https://host.example')).not.toBe(sent);
      const p = await consumePendingAuth(begun.state);
      expect(p?.redirectUri).toBe(sent);
    } finally {
      delete process.env.OPENWOP_OAUTH_REDIRECT_UNVERSIONED;
      delete process.env.OPENWOP_OAUTH_SLACK_CLIENT_ID;
      delete process.env.OPENWOP_OAUTH_SLACK_CLIENT_SECRET;
      delete process.env.OPENWOP_OAUTH_CALLBACK_BASE_URL;
    }
  });

  it('no server-rendered form posts to a versioned address (the email-approval blocker)', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) { walk(p); continue; }
        if (!p.endsWith('.ts')) continue;
        readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
          if (/(action|formaction)=\\?["']\/v[0-9]+\//.test(line)) offenders.push(`${p}:${i + 1}`);
        });
      }
    };
    walk(join(process.cwd(), 'src'));
    expect(offenders).toEqual([]);
  });
});

describe('ADR 0806 — emitters hand outsiders the unversioned address', () => {
  it('embed.js loaded from an old /v1 snippet still talks to the unversioned root', async () => {
    const js = await (await fetch(`${base}/host/openwop-app/public/widget/embed.js`)).text();
    // Run the served script's own base derivation, not a copy of it: everything
    // up to the first statement that needs a DOM.
    const head = js.slice(0, js.indexOf("  var token="));
    const derive = (src: string): string => {
      const ctx = { document: { currentScript: { src } }, out: '' };
      vm.runInNewContext(`${head.replace('(function(){', '')}\nout=base;`, ctx);
      return ctx.out;
    };
    expect(derive('https://h.example/v1/host/openwop-app/public/widget/embed.js'))
      .toBe('https://h.example/host/openwop-app/public');
    expect(derive('https://h.example/host/openwop-app/public/widget/embed.js'))
      .toBe('https://h.example/host/openwop-app/public');
    expect(derive('https://h.example/api/v1/host/openwop-app/public/widget/embed.js'))
      .toBe('https://h.example/api/host/openwop-app/public');
    // Not ours to rewrite: a customer proxy path that merely contains the shape.
    expect(derive('https://h.example/proxy/v3/host/openwop-app/public/widget/embed.js'))
      .toBe('https://h.example/proxy/v3/host/openwop-app/public');
  });

  it('the inbound-event URL an operator gives a provider is unversioned', () => {
    expect(inboundIngestUrl('c1', 'https://h.example')).toBe('https://h.example/host/openwop-app/connections-inbound/c1');
  });

  it('the OAuth redirect_uri stays on the registered /v1 twin; unversioned is an operator opt-in', () => {
    // The /v1 callback GET is forwarded after the cut, so the registered URI keeps working.
    expect(redirectUri('google', 'https://h.example')).toBe('https://h.example/v1/host/openwop-app/connections/google/callback');
    process.env.OPENWOP_OAUTH_REDIRECT_UNVERSIONED = 'true';
    try {
      expect(redirectUri('google', 'https://h.example')).toBe('https://h.example/host/openwop-app/connections/google/callback');
    } finally { delete process.env.OPENWOP_OAUTH_REDIRECT_UNVERSIONED; }
  });
});
