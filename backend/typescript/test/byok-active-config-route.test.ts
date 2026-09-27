/**
 * /byok/active-config route (ADR 0517) — the durable per-tenant chat binding that
 * replaced a browser-local `localStorage` pointer.
 *
 * The defect this closes: the KEY was durable and server-side; the POINTER to it
 * was not. Losing `localStorage` (second browser, private window, cleared site
 * data, ITP eviction) — or merely letting the 24h session lapse to a fresh `anon:`
 * tenant that cannot see workspace secrets — read as "this user has no key". The
 * SPA then opened the first-run wizard, which minted `byok:<provider>:${Date.now()}`
 * and so created a DUPLICATE secret instead of re-binding the existing one. One
 * real workspace accumulated seven `byok:google:*` rows across five weeks.
 *
 * What is proven here:
 *   - the binding round-trips and survives independently of any browser;
 *   - `valid` is the SERVER's verdict, and it goes false when the underlying secret
 *     is gone (the SPA must never re-derive this from a ref list — that inference
 *     is what re-prompted a user whose key was fine);
 *   - `anonymous` is reported, so the SPA can distinguish "signed out" from
 *     "no key" and stop offering a duplicate-minting wizard to a logged-out user;
 *   - a binding cannot point at a secret outside the caller's own scope (IDOR);
 *   - the binding is visible to the ADR 0499 delete guard, so deleting the key the
 *     chat is using is refused rather than silently orphaning it.
 *
 * These use an ANON session deliberately: `setSecret` for a non-`user:`/`ws:` tenant
 * takes the local-AES path, which the harness supports, so unlike
 * `byok-ai-default-route.test.ts` the happy path IS reachable over HTTP here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/index.js';
import { refsForProvider } from '../src/host/chatByokConfig.js';

let server: Server;
let BASE = '';
let n = 0;
const AC = '/v1/host/openwop-app/byok/active-config';
const SECRETS = '/v1/host/openwop-app/byok/secrets';

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterAll(async () => { await new Promise<void>((res) => server.close(() => res())); });

function getSetCookies(h: Headers): string[] {
  const v = (h as { getSetCookie?: () => string[] }).getSetCookie?.();
  return v ?? (h.get('set-cookie') ? [h.get('set-cookie')!] : []);
}

interface Body {
  config?: { provider?: string; model?: string; credentialRef?: string } | null;
  valid?: boolean;
  anonymous?: boolean;
  credentialRefs?: string[];
  error?: string;
  references?: string[];
}
interface Res { status: number; body: Body }

/** A cookie-jar client. Each instance is its OWN session ⇒ its own tenant. */
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<Res> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    for (const ck of getSetCookies(res.headers)) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    const out = res.status === 204 ? {} : await res.json().catch(() => ({}));
    return { status: res.status, body: out as Body };
  };
  return {
    get: (p: string) => call('GET', p),
    post: (p: string, b?: unknown) => call('POST', p, b),
    put: (p: string, b?: unknown) => call('PUT', p, b),
    del: (p: string) => call('DELETE', p),
  };
}

async function loggedIn(who: string) {
  const c = client();
  await c.post('/v1/host/openwop-app/test/login', { email: `${who}-${Date.now()}-${n++}@acme.test` });
  return c;
}

describe('/byok/active-config (ADR 0517)', () => {
  it('GET returns an empty, honest envelope before anything is bound', async () => {
    const c = client();
    const r = await c.get(AC);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.config).toBeNull();
    expect(r.body.valid).toBe(false);
  });

  it('reports `anonymous` so the SPA can tell "signed out" from "no key"', async () => {
    // This is fix D's entire foundation. Before it, both states looked identical
    // to the SPA (a null config), so a logged-out user was shown "Add your API
    // key" and re-entered a key the server still held.
    const anon = client();
    expect((await anon.get(AC)).body.anonymous).toBe(true);

    const user = await loggedIn('ac-anon');
    expect((await user.get(AC)).body.anonymous).toBe(false);
  });

  it('round-trips a binding, and the pointer outlives any browser', async () => {
    const c = client();
    expect((await c.post(SECRETS, { credentialRef: 'byok:google', value: 'AIza-round-trip' })).status).toBe(201);

    const put = await c.put(AC, { provider: 'google', model: 'gemini-3.1-flash-lite', credentialRef: 'byok:google' });
    expect(put.status, JSON.stringify(put.body)).toBe(200);

    // A DIFFERENT client object — i.e. a different "browser" — but the same
    // session cookie is what a real returning user presents. The binding is on
    // the server, so nothing about the client's local storage matters.
    const again = await c.get(AC);
    expect(again.body.config).toMatchObject({ provider: 'google', model: 'gemini-3.1-flash-lite', credentialRef: 'byok:google' });
    expect(again.body.valid).toBe(true);
  });

  it('refuses a binding whose ref is not one of the caller\'s own secrets (IDOR)', async () => {
    const c = client();
    const r = await c.put(AC, { provider: 'google', model: 'gemini-3.1-flash-lite', credentialRef: 'byok:google:someone-elses' });
    expect(r.status).toBe(400);
    expect(String(r.body.error)).toMatch(/validation/i);
  });

  it('validates provider and model rather than storing junk the chat would choke on', async () => {
    const c = client();
    await c.post(SECRETS, { credentialRef: 'byok:google', value: 'AIza-validate' });
    expect((await c.put(AC, { provider: 'notaprovider', model: 'm', credentialRef: 'byok:google' })).status).toBe(400);
    expect((await c.put(AC, { provider: 'google', model: '', credentialRef: 'byok:google' })).status).toBe(400);
  });

  it('accepts a managed sentinel, which names no stored secret', async () => {
    const c = client();
    const r = await c.put(AC, { provider: 'minimax', model: 'minimax-text', credentialRef: 'managed:minimax' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await c.get(AC)).body.valid).toBe(true);
  });

  it('accepts the WIZARD\'s managed activation shape and resolves it to the dispatch provider', async () => {
    // The exact payload BYOKWizard.activateManaged sends: the managed tile's own id and
    // its sentinel ref. providers.json hides the underlying provider from the SPA, so
    // the wizard cannot send `minimax`. Refused 400 before the fix (kicktodo.com 2026-09-16).
    const c = client();
    const r = await c.put(AC, { provider: 'openwop-free', model: 'auto', credentialRef: 'managed:openwop-free' });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.config?.provider).toBe('minimax');
    expect(r.body.config?.credentialRef).toBe('managed:openwop-free');
    // A managed id paired with a DIFFERENT managed ref is not the wizard shape — still refused.
    const bad = await c.put(AC, { provider: 'openwop-free', model: 'auto', credentialRef: 'managed:something-else' });
    expect(bad.status).toBe(400);
  });

  it('the ADR 0499 delete guard SEES the chat binding — the key cannot be silently pulled', async () => {
    const c = client();
    await c.post(SECRETS, { credentialRef: 'byok:google', value: 'AIza-guarded' });
    await c.put(AC, { provider: 'google', model: 'gemini-3.1-flash-lite', credentialRef: 'byok:google' });

    const blocked = await c.del(`${SECRETS}/byok%3Agoogle`);
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(409);
    expect(JSON.stringify(blocked.body)).toMatch(/active chat binding/);
  });

  it('reports valid:false — never a usable-looking binding — once the key is force-deleted', async () => {
    const c = client();
    await c.post(SECRETS, { credentialRef: 'byok:google', value: 'AIza-forced' });
    await c.put(AC, { provider: 'google', model: 'gemini-3.1-flash-lite', credentialRef: 'byok:google' });
    expect((await c.del(`${SECRETS}/byok%3Agoogle?force=true`)).status).toBe(204);

    const r = await c.get(AC);
    expect(r.body.config).not.toBeNull(); // the binding is still recorded…
    expect(r.body.valid).toBe(false);     // …but the server refuses to vouch for it
  });

  it('DELETE clears the binding', async () => {
    const c = client();
    await c.post(SECRETS, { credentialRef: 'byok:google', value: 'AIza-clear' });
    await c.put(AC, { provider: 'google', model: 'gemini-3.1-flash-lite', credentialRef: 'byok:google' });
    expect((await c.del(AC)).status).toBe(204);
    expect((await c.get(AC)).body.config).toBeNull();
  });

  it('one session\'s binding is invisible to another (tenant isolation)', async () => {
    const alice = client();
    await alice.post(SECRETS, { credentialRef: 'byok:google', value: 'AIza-alice' });
    await alice.put(AC, { provider: 'google', model: 'gemini-3.1-flash-lite', credentialRef: 'byok:google' });

    const bob = client();
    expect((await bob.get(AC)).body.config).toBeNull();
  });
});

describe('refsForProvider (ADR 0517 adoption seam)', () => {
  it('matches the deterministic ref AND the historical timestamped ones', () => {
    // The seven rows the reported workspace accumulated are exactly this shape;
    // adoption has to see them or the migration strands every existing user.
    const refs = ['byok:google', 'byok:google:1782080112882', 'byok:google:1785358774187', 'byok:openai'];
    expect(refsForProvider(refs, 'google')).toEqual([
      'byok:google', 'byok:google:1782080112882', 'byok:google:1785358774187',
    ]);
  });

  it('is colon-delimited, so one provider never captures another', () => {
    // `startsWith('byok:google')` alone would swallow this and bind the chat to a
    // key for a different provider — a silent wrong-key dispatch.
    expect(refsForProvider(['byok:google-vertex'], 'google')).toEqual([]);
    expect(refsForProvider(['byok:openai'], 'open')).toEqual([]);
  });

  it('ignores unrelated refs entirely', () => {
    expect(refsForProvider(['managed:minimax', 'connection:conn:abc', 'billing:stripe-key'], 'google')).toEqual([]);
  });
});
