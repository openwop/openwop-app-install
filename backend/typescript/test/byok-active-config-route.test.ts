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
 * Red when (sabotage-witnessed, w78): GET reports `anonymous: false`; `valid` stops
 * consulting the secret; the own-ref check, or both own-ref guards, are dropped
 * (IDOR); the provider list or the empty-model check is dropped; the MiniMax
 * free-tier refusal is dropped; the managed wizard id is not resolved; the ADR 0499
 * consumer stops seeing the binding; DELETE stops clearing; `refsForProvider` loses
 * its colon boundary.
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
const AC = '/host/openwop-app/byok/active-config';
const SECRETS = '/host/openwop-app/byok/secrets';

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
  stored?: boolean;
  error?: string;
  message?: string;
  details?: { field?: string; reason?: string };
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
  await c.post('/host/openwop-app/test/login', { email: `${who}-${Date.now()}-${n++}@acme.test` });
  return c;
}

describe('/byok/active-config (ADR 0517)', () => {
  it('GET returns an empty, honest envelope before anything is bound', async () => {
    const c = client();
    const r = await c.get(AC);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.config).toBeNull();
    expect(r.body.stored).toBe(false);
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

    const put = await c.put(AC, { provider: 'google', model: 'gemini-3.8-flash', credentialRef: 'byok:google' });
    expect(put.status, JSON.stringify(put.body)).toBe(200);

    // A fresh request carrying only the session cookie, which is what a returning
    // user presents: nothing client-local is read, the binding is on the server.
    const again = await c.get(AC);
    expect(again.body.config).toMatchObject({ provider: 'google', model: 'gemini-3.8-flash', credentialRef: 'byok:google' });
    expect(again.body.valid).toBe(true);
  });

  it('round-trips a labeled Keys-page ref only inside its owning tenant', async () => {
    const owner = client();
    const other = client();
    const ref = 'google:qa-label';
    expect((await owner.post(SECRETS, { credentialRef: ref, value: 'local-test-only' })).status).toBe(201);
    const listed = await owner.get(SECRETS);
    const adopted = refsForProvider(listed.body.credentialRefs ?? [], 'google');
    expect(adopted).toContain(ref);
    const binding = { provider: 'google', model: 'gemini-3.8-flash', credentialRef: ref };
    const denied = await other.put(AC, binding);
    expect([denied.status, denied.body.message]).toEqual([400, 'credentialRef is not a stored BYOK secret for this workspace.']);
    expect((await other.get(AC)).body.stored).toBe(false);
    expect((await owner.put(AC, binding)).status).toBe(200);
    const readback = await owner.get(AC);
    expect(readback.body.config).toMatchObject(binding);
    expect(readback.body.valid).toBe(true);
  });

  it('refuses a binding whose ref is not one of the caller\'s own secrets (IDOR)', async () => {
    // The ref REALLY exists, in another session's tenant: refusing a ref nobody holds
    // would prove "400 on a missing ref", not isolation. Two guards hold this
    // (`setChatByokConfig`: the caller's own ref list, then `resolveSecret` in the
    // caller's scope); the message pins the FIRST, a break of both turns this 200.
    const alice = client();
    expect((await alice.post(SECRETS, { credentialRef: 'byok:google:shared', value: 'AIza-alice-shared' })).status).toBe(201);
    const bob = client();
    const r = await bob.put(AC, { provider: 'google', model: 'gemini-3.8-flash', credentialRef: 'byok:google:shared' });
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(r.body.error).toBe('validation_error');
    expect(r.body.message).toBe('credentialRef is not a stored BYOK secret for this workspace.');
    expect((await bob.get(AC)).body.stored).toBe(false);
    // Owner control: the same ref binds for the session that holds it.
    expect((await alice.put(AC, { provider: 'google', model: 'gemini-3.8-flash', credentialRef: 'byok:google:shared' })).status).toBe(200);
  });

  it('validates provider and model rather than storing junk the chat would choke on', async () => {
    const c = client();
    await c.post(SECRETS, { credentialRef: 'byok:google', value: 'AIza-validate' });
    // Each refusal by its own message: `notaprovider` would ALSO be refused by the
    // ADR 0990 D6 selectable-provider check, so a status alone cannot tell them apart.
    const badProvider = await c.put(AC, { provider: 'notaprovider', model: 'm', credentialRef: 'byok:google' });
    expect([badProvider.status, badProvider.body.error, badProvider.body.details?.field]).toEqual([400, 'validation_error', 'provider']);
    expect(String(badProvider.body.message)).toMatch(/^provider MUST be one of: /);
    const noModel = await c.put(AC, { provider: 'google', model: '', credentialRef: 'byok:google' });
    expect([noModel.status, noModel.body.error, noModel.body.details?.field]).toEqual([400, 'validation_error', 'model']);
    expect(String(noModel.body.message)).toMatch(/^model MUST be a non-empty string/);
    expect((await c.get(AC)).body.stored).toBe(false);
  });

  // ADR 0990 D6: MiniMax backs the free tier and is never a user's own key, even
  // when a caller stored one by hand. The SPA already hides it; this is the API.
  it('refuses a MiniMax binding on a stored key (free tier only, never user BYOK)', async () => {
    const c = client();
    expect((await c.post(SECRETS, { credentialRef: 'byok:minimax', value: 'mm-by-hand' })).status).toBe(201);
    const r = await c.put(AC, { provider: 'minimax', model: 'MiniMax-M3', credentialRef: 'byok:minimax' });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/not available with your own key/);
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
    await c.put(AC, { provider: 'google', model: 'gemini-3.8-flash', credentialRef: 'byok:google' });

    const blocked = await c.del(`${SECRETS}/byok%3Agoogle`);
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(409);
    expect(JSON.stringify(blocked.body)).toMatch(/active chat binding/);
  });

  it('reports valid:false — never a usable-looking binding — once the key is force-deleted', async () => {
    const c = client();
    await c.post(SECRETS, { credentialRef: 'byok:google', value: 'AIza-forced' });
    await c.put(AC, { provider: 'google', model: 'gemini-3.8-flash', credentialRef: 'byok:google' });
    expect((await c.del(`${SECRETS}/byok%3Agoogle?force=true`)).status).toBe(204);

    const r = await c.get(AC);
    expect(r.body.config).not.toBeNull(); // the binding is still recorded…
    expect(r.body.valid).toBe(false);     // …but the server refuses to vouch for it
  });

  it('DELETE clears the binding', async () => {
    const c = client();
    await c.post(SECRETS, { credentialRef: 'byok:google', value: 'AIza-clear' });
    await c.put(AC, { provider: 'google', model: 'gemini-3.8-flash', credentialRef: 'byok:google' });
    expect((await c.get(AC)).body.stored).toBe(true);
    expect((await c.del(AC)).status).toBe(204);
    const after = await c.get(AC);
    expect(after.body.config).toBeNull();
    expect(after.body.stored).toBe(false);
  });

  it('one session\'s binding is invisible to another (tenant isolation)', async () => {
    const alice = client();
    await alice.post(SECRETS, { credentialRef: 'byok:google', value: 'AIza-alice' });
    await alice.put(AC, { provider: 'google', model: 'gemini-3.8-flash', credentialRef: 'byok:google' });

    // Owner control: alice reads her own binding back.
    expect((await alice.get(AC)).body).toMatchObject({ stored: true, config: { credentialRef: 'byok:google' } });
    const bob = client();
    const theirs = await bob.get(AC);
    expect(theirs.body.config).toBeNull();
    expect(theirs.body.stored).toBe(false);
  });
});

describe('refsForProvider (ADR 0517 adoption seam)', () => {
  it('includes Keys page refs and retains exact provider boundaries', () => {
    expect(refsForProvider(['google:team', 'google', 'byok:google', 'google-vertex', 'google-vertex:team', 'googlex:team'], 'google')).toEqual(['byok:google', 'google', 'google:team']);
    expect(refsForProvider(['anthropic:team'], 'anthropic')).toEqual(['anthropic:team']);
  });

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
