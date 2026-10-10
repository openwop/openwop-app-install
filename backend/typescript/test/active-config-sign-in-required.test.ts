/**
 * `GET /byok/active-config` → `signInRequired`.
 *
 * Under `OPENWOP_MANAGED_ANON_SIGNIN_REQUIRED` the free tier refuses `anon:` callers
 * (`managedProvider.ts` throws `sign_in_required`), yet this route reports that same tier
 * as the visitor's ready default. Before the flag the SPA learned the refusal only after
 * the visitor typed and sent a message. The flag lets it say so up front.
 *
 * Each leg is a different arm of the predicate, so removing any one conjunct reds a leg:
 *   leg 1 — the positive case (all conjuncts true)
 *   leg 2 — the host does not require sign-in            (posture conjunct)
 *   leg 3 — the caller is signed in                       (anon conjunct)
 *   leg 4 — the anon visitor bound their OWN key          (managed-ref conjunct)
 *   leg 5 — a stored managed binding still requires sign-in (stored/default parity)
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../src/index.js';

let server: Server;
let BASE = '';
let n = 0;
const AC = '/host/openwop-app/byok/active-config';
const FLAG = 'OPENWOP_MANAGED_ANON_SIGNIN_REQUIRED';
const prevFlag = process.env[FLAG];
const prevKey = process.env.MINIMAX_API_KEY;

beforeAll(async () => {
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_AUTH_ENABLED = 'true';
  delete process.env.OPENWOP_AUTH_DISABLE_COOKIES;
  // A seeded managed tier is the precondition for any default to be reported at all
  // (adr0711-managed-default-report leg 3); without it every leg would read false.
  process.env.MINIMAX_API_KEY = 'sk-signin-required';
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  // After createApp, which configures the managed provider's storage.
  const { bootstrapManagedProvider } = await import('../src/providers/managedProvider.js');
  await bootstrapManagedProvider();
  await new Promise<void>((res) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; res(); }); });
});
afterEach(() => { if (prevFlag === undefined) delete process.env[FLAG]; else process.env[FLAG] = prevFlag; });
afterAll(async () => {
  if (prevKey === undefined) delete process.env.MINIMAX_API_KEY; else process.env.MINIMAX_API_KEY = prevKey;
  await new Promise<void>((res) => (server ? server.close(() => res()) : res()));
});

interface Body {
  config: { credentialRef: string } | null;
  valid: boolean;
  anonymous: boolean;
  stored?: boolean;
  signInRequired?: boolean;
}

/** A cookie-jar client. Each instance is its own session ⇒ its own tenant. */
function client() {
  let cookie = '';
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: Body }> => {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const set = (res.headers as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
    for (const ck of set) { const m = /(__session=[^;]+)/.exec(ck); if (m) cookie = m[1]; }
    return { status: res.status, body: (await res.json().catch(() => ({}))) as Body };
  };
  return {
    get: (p: string) => call('GET', p),
    post: (p: string, b?: unknown) => call('POST', p, b),
    put: (p: string, b?: unknown) => call('PUT', p, b),
  };
}

describe('active-config signInRequired', () => {
  it('leg 1: an anon visitor on the free default is told up front when the host requires sign-in', async () => {
    process.env[FLAG] = 'true';
    const r = await client().get(AC);
    expect(r.status).toBe(200);
    expect(r.body.anonymous).toBe(true);
    expect(r.body.config?.credentialRef, 'the free default is what is reported').toBe('managed:openwop-free');
    expect(r.body.valid, '`valid` is about the key, and the key is seeded — unchanged').toBe(true);
    expect(r.body.signInRequired).toBe(true);
  });

  it('leg 2: a host that does not require sign-in reports false', async () => {
    process.env[FLAG] = 'false';
    const r = await client().get(AC);
    expect(r.body.config?.credentialRef).toBe('managed:openwop-free');
    expect(r.body.signInRequired).toBe(false);
  });

  it('leg 3: a signed-in caller is never told to sign in', async () => {
    process.env[FLAG] = 'true';
    const c = client();
    await c.post('/host/openwop-app/test/login', { email: `signin-req-${Date.now()}-${n++}@acme.test` });
    const r = await c.get(AC);
    expect(r.body.anonymous).toBe(false);
    expect(r.body.signInRequired).toBe(false);
  });

  it('leg 4: an anon visitor who bound their OWN key is not told to sign in', async () => {
    process.env[FLAG] = 'true';
    const c = client();
    expect((await c.post('/host/openwop-app/byok/secrets', { credentialRef: 'byok:google', value: 'AIza-own-key' })).status).toBe(201);
    const put = await c.put(AC, { provider: 'google', model: 'gemini-3.8-flash', credentialRef: 'byok:google' });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.signInRequired, 'successful writes carry the same eligibility verdict as reads').toBe(false);
    const r = await c.get(AC);
    expect(r.body.anonymous, 'still the anon tenant — only the binding changed').toBe(true);
    expect(r.body.stored).toBe(true);
    expect(r.body.signInRequired, 'their own key dispatches; the free-tier refusal does not apply').toBe(false);
  });

  it('leg 5: choosing the managed tile still requires sign-in, for both PUT and GET', async () => {
    process.env[FLAG] = 'true';
    const c = client();
    const put = await c.put(AC, { provider: 'openwop-free', model: 'minimax-text', credentialRef: 'managed:openwop-free' });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    const r = await c.get(AC);
    expect(r.body.stored).toBe(true);
    expect(r.body.valid).toBe(true);
    expect(r.body.signInRequired, 'a stored managed binding is subject to the same dispatch posture').toBe(true);
    expect(put.body.signInRequired).toBe(true);

    process.env[FLAG] = 'false';
    expect((await c.get(AC)).body.signInRequired, 'stored managed binding respects a host allowing anonymous dispatch').toBe(false);
  });
});
