/**
 * RFC 0200 / RFC 0210 on this host — the `oidc` lane is advertised with `exp-only`,
 * and every claim that advertisement makes is enforced here.
 *
 * WHY THESE FOUR THINGS SHIP TOGETHER (WHD-31): advertising `exp-only` without the
 * lifetime bound is the over-claim RFC 0210 was written to stop — MyndHyve advertises
 * `short-lived`/3600 while never re-checking revocation, which is the case the RFC
 * cites. The window is the ONLY thing standing between "revoked upstream" and "still
 * accepted", so the advert, the bound, the metadata a refused client discovers, and the
 * challenge that points at it are one change or none.
 *
 * The lifetime legs mirror the suite's (`v2-lane-exp-only-bound.test.ts`) INCLUDING its
 * skew: a token minted at `now` with an `exp` past the window is outside BOTH bounds, so
 * such a leg passes against a host enforcing either one and witnesses neither. Each leg
 * below therefore isolates ONE bound, and the sabotage record in the PR shows each one
 * going red alone.
 *
 * Round-2 notes. The lifetime comparisons are pinned by a BOUNDARY case (strict `>`:
 * exactly W is accepted, W + 1 refused) instead of a grep of the verifier's source.
 * The §A/§B helper cases run against a REAL Express request/response (a throwaway
 * app below), so no partial `Request`/`Response` is cast into place. The audience
 * case drives the COOKIE-ENABLED branch of `middleware/auth.ts` (the `bearerRejected`
 * refusal), not the cookies-disabled one; round-1 probe 8fw2g1-oidc-audience was
 * aimed at the cookies-disabled copy and was therefore vacuous (re-aimed in r2).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OidcVerifier, OidcVerificationError, OIDC_REVOCATION_WINDOW_S } from '../src/middleware/oidcVerifier.js';
import { prmUrlFor, resourceIdentifier, apiPathPrefixOf, setBearerChallenge, PRM_SEGMENT } from '../src/middleware/authChallenge.js';
import express, { type Request, type Response } from 'express';
import { scopesSupported } from '../src/host/protocolAuthorization.js';

const W = OIDC_REVOCATION_WINDOW_S;
const MARGIN = 60;

/**
 * A synthetic issuer: a real RSA keypair, a real signed JWT, and a real JWKS endpoint
 * the verifier fetches over HTTP. The legs below therefore exercise
 * `OidcVerifier.verify` end to end rather than a re-implementation of its comparisons —
 * a test that wires its own copy of the rule tests the copy (the replica trap).
 */
import { createServer, type Server } from 'node:http';
import { generateKeyPairSync, createSign } from 'node:crypto';
import type { AddressInfo } from 'node:net';

const b64u = (b: Buffer): string => b.toString('base64url');
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'test-key-1';

function mint(claims: Record<string, unknown>): string {
  const header = b64u(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: KID })));
  const payload = b64u(Buffer.from(JSON.stringify(claims)));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${b64u(signer.sign(privateKey))}`;
}

let jwks: Server | null = null;
let jwksUrl = '';
beforeAll(async () => {
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  const body = JSON.stringify({ keys: [{ ...jwk, kid: KID, alg: 'RS256', use: 'sig' }] });
  jwks = createServer((_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(body); });
  await new Promise<void>((r) => jwks!.listen(0, '127.0.0.1', () => r()));
  jwksUrl = `http://127.0.0.1:${(jwks!.address() as AddressInfo).port}/jwks.json`;
});
afterAll(async () => { if (jwks) { const s = jwks; jwks = null; await new Promise<void>((r) => s.close(() => r())); } });

/**
 * A throwaway Express app that hands the test the REAL `req`/`res` of one request.
 * The caller reached it as `https://app.openwop.dev` (forwarded headers, which
 * `requestOrigin` reads), so the expected URLs below are hand-written literals.
 */
let probe: Server | null = null;
let probeBase = '';
let onProbe: ((req: Request, res: Response) => void) | null = null;
beforeAll(async () => {
  const app = express();
  app.use((req, res) => { onProbe?.(req, res); if (!res.headersSent) res.end(); });
  probe = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => probe!.once('listening', () => r()));
  probeBase = `http://127.0.0.1:${(probe!.address() as AddressInfo).port}`;
});
afterAll(async () => { if (probe) { const s = probe; probe = null; await new Promise<void>((r) => s.close(() => r())); } });

/** Run `fn` inside a real request to `path`; returns what it returned + the wire response. */
async function onRealRequest(path: string, fn: (req: Request, res: Response) => string): Promise<{ value: string; res: globalThis.Response }> {
  let value: string | undefined;
  onProbe = (req, res) => { value = fn(req, res); };
  try {
    const res = await fetch(`${probeBase}${path}`, { headers: { 'x-forwarded-host': 'app.openwop.dev', 'x-forwarded-proto': 'https' } });
    await res.text();
    if (value === undefined) throw new Error(`the probe handler never ran for ${path}`);
    return { value, res };
  } finally {
    onProbe = null;
  }
}

const ISS = 'https://issuer.test';
const AUD = 'test-audience';
/** Present a token to the REAL verifier; returns the refusal code, or null if accepted. */
async function present(claims: Record<string, unknown>): Promise<string | null> {
  const v = new OidcVerifier({ issuer: ISS, audience: AUD, jwksUrl });
  try { await v.verify(mint({ iss: ISS, aud: AUD, sub: 'subject-1', ...claims })); return null; }
  catch (e) { return e instanceof OidcVerificationError ? e.code : `other:${String(e)}`; }
}

describe('RFC 0210 §B.4 — both lifetime bounds, each isolated', () => {
  it('CONTROL: a credential inside the window is accepted — without this the refusals witness nothing', async () => {
    // A host that refuses everything passes both sabotage legs. This is what stops that.
    const now = Math.floor(Date.now() / 1000);
    expect(await present({ iat: now, exp: now + W - MARGIN })).toBeNull();
  });

  it('TOTAL lifetime beyond the window is refused, though its REMAINING lifetime is inside it', async () => {
    // `iat` dated BEHIND our clock: exp − iat = W + MARGIN (outside), exp − now =
    // W − MARGIN (inside). Minting at `now` instead would be outside BOTH bounds, and
    // the leg would pass against a host enforcing only the remaining-life comparison.
    const now = Math.floor(Date.now() / 1000);
    expect(await present({ iat: now - 2 * MARGIN, exp: now + W - MARGIN })).toBe('credential_lifetime_exceeded');
  });

  it('REMAINING lifetime beyond the window is refused, though its TOTAL lifetime is inside it', async () => {
    // `iat` dated AHEAD: exp − iat = W − MARGIN (inside), exp − now = W + MARGIN (outside).
    const now = Math.floor(Date.now() / 1000);
    const iat = now + 2 * MARGIN;
    expect(await present({ iat, exp: iat + W - MARGIN })).toBe('credential_lifetime_exceeded');
  });

  it('a credential carrying NO iat is refused with the SAME code — the bound fails closed', async () => {
    // RFC 0210 §B.4: `exp − iat` is unevaluable without `iat`, and §2.1 fails closed
    // rather than skipping the bound. A separate `missing_iat` reason would let a token
    // escape the bound by omitting the claim the bound is computed from.
    const now = Math.floor(Date.now() / 1000);
    expect(await present({ exp: now + W - MARGIN })).toBe('credential_lifetime_exceeded');
  });

  it('an EXPIRED credential still reads `expired`, not the lifetime code', async () => {
    // The codes must stay distinguishable: a client that sees the lifetime code learns
    // the operator's window is shorter than its token, which is actionable; `expired`
    // means refresh and retry.
    const now = Math.floor(Date.now() / 1000);
    expect(await present({ iat: now - 2 * W, exp: now - W })).toBe('expired');
  });
});

describe('RFC 0210 — the advertised window is a bound, not a number we print', () => {
  it('exposes ONE constant that both the advert and the refusal read', () => {
    // Drift between "what we advertise" and "what we enforce" is the entire defect
    // class; a second literal anywhere reintroduces it.
    expect(Number.isInteger(W)).toBe(true);
    expect(W).toBeGreaterThanOrEqual(2 * MARGIN); // below this the suite records `blocked`
    expect(W).toBeLessThanOrEqual(3600); // RFC 0210 §C.7 — "one hour or less"
  });

  it('the lifetime bound is STRICT: a total lifetime of exactly W is accepted, W + 1 is refused', async () => {
    // Replaces a grep of the verifier's source for the two comparisons (a reworded
    // comparison read red with no behaviour change). `iat` sits behind the clock, so
    // the REMAINING lifetime (exp − now = W − 2·MARGIN [+1]) stays inside the window
    // and only the TOTAL bound decides each leg.
    const now = Math.floor(Date.now() / 1000);
    const iat = now - 2 * MARGIN;
    expect(await present({ iat, exp: iat + W })).toBeNull();
    expect(await present({ iat, exp: iat + W + 1 })).toBe('credential_lifetime_exceeded');
  });
});

describe('RFC 0200 §A — the protected-resource metadata URL', () => {
  it('forms the RFC 9728 §3.1 sub-path URL, inserting the segment before the path', () => {
    // The production shape: the backend is reached at `https://app.openwop.dev/api`.
    expect(prmUrlFor('https://app.openwop.dev/api')).toBe(
      'https://app.openwop.dev/.well-known/oauth-protected-resource/api');
    // The bare shape (local, direct Cloud Run) — the root form, no trailing slash.
    expect(prmUrlFor('http://localhost:8080')).toBe(
      `http://localhost:8080${PRM_SEGMENT}`);
    // A terminating slash is removed, per §3.1.
    expect(prmUrlFor('https://h/api/')).toBe(`https://h${PRM_SEGMENT}/api`);
  });

  it('derives the resource identifier from the path the caller actually used', async () => {
    expect((await onRealRequest('/api/v1/runs', (req) => apiPathPrefixOf(req))).value).toBe('/api');
    expect((await onRealRequest('/runs', (req) => apiPathPrefixOf(req))).value).toBe('');
    expect((await onRealRequest('/api/v1/runs', (req) => resourceIdentifier(req, '/api'))).value).toBe('https://app.openwop.dev/api');
  });
});

describe('RFC 0200 §B — the challenge', () => {
  const META = 'resource_metadata="https://app.openwop.dev/.well-known/oauth-protected-resource"';
  /** The header the helper set, as it reached the wire on a real response. */
  const challengeFor = async (opts: Parameters<typeof setBearerChallenge>[2]): Promise<string> => {
    const { res } = await onRealRequest('/runs', (req, r) => { setBearerChallenge(req, r, opts); return 'set'; });
    return res.headers.get('www-authenticate') ?? '';
  };

  it('a refusal with NO credential presented names Bearer and the metadata, and carries NO error', async () => {
    // RFC 6750 §3.1: an error code describes a credential that was refused. Inventing
    // one tells a client its absent token was rejected — the §B leg that asserts this.
    expect(await challengeFor({ presented: false })).toBe(`Bearer ${META}`);
  });

  it('a refusal of a credential that WAS presented carries error="invalid_token" and the metadata', async () => {
    expect(await challengeFor({ presented: true })).toBe(`Bearer error="invalid_token", ${META}`);
  });

  it('a scope refusal names every scope the operation requires', async () => {
    expect(await challengeFor({ presented: true, error: 'insufficient_scope', scope: ['runs:create', 'runs:read'] }))
      .toBe(`Bearer error="insufficient_scope", scope="runs:create runs:read", ${META}`);
  });

  it('§B.3 — setting a challenge NEVER writes a status or a body', async () => {
    // The negative that keeps a challenge from turning a non-disclosure 404 into a 401:
    // the helper can only set one header. If it could send, a caller could smuggle a
    // status change into a refusal that deliberately does not disclose existence.
    // Read on the REAL response straight after the call: status still the default,
    // nothing sent, nothing ended.
    const { value } = await onRealRequest('/runs', (req, res) => {
      setBearerChallenge(req, res, { presented: true });
      return JSON.stringify({ status: res.statusCode, headersSent: res.headersSent, ended: res.writableEnded });
    });
    expect(JSON.parse(value)).toEqual({ status: 200, headersSent: false, ended: false });
  });
});

/**
 * Through the HTTP boundary, because three of these are observable nowhere else: whether
 * the lane reaches the live advertisement, whether the metadata is readable WITHOUT a
 * credential (a route behind auth could not serve a client that was just refused), and
 * whether the refusal carries the challenge.
 *
 * THE POSTURE IS PINNED AT APP CONSTRUCTION, and that is a measured fact rather than a
 * style choice: setting `OPENWOP_AUTH_DISABLE_COOKIES` after `createApp` changes nothing
 * — the first cut of these legs did exactly that and read 404/400 where it expected 401,
 * which looked like a missing challenge and was a mis-built harness. Likewise
 * `OPENWOP_OIDC_JWKS_URL` must point at the synthetic issuer BEFORE construction, or
 * every token is refused `jwks_unavailable` and the lifetime legs witness nothing.
 */
async function startApp(env: Record<string, string>): Promise<{ base: string; stop: () => Promise<void> }> {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) { prev[k] = process.env[k]; process.env[k] = v; }
  const { createApp } = await import('../src/index.js');
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => server.once('listening', () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    stop: async () => {
      for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

/** The OIDC env every app below boots with — issuer, audience, and the LOCAL JWKS. */
const oidcEnv = (): Record<string, string> => ({
  OPENWOP_OIDC_ISSUER: ISS,
  OPENWOP_OIDC_AUDIENCE: AUD,
  OPENWOP_OIDC_JWKS_URL: jwksUrl,
});

describe('RFC 0200 §A — served (HTTP, bearer-only posture)', () => {
  let app: { base: string; stop: () => Promise<void> };
  beforeAll(async () => { app = await startApp({ ...oidcEnv(), OPENWOP_AUTH_DISABLE_COOKIES: 'true' }); }, 60_000);
  afterAll(async () => { if (app) await app.stop(); });

  it('advertises the oidc lane with exp-only and the window it enforces', async () => {
    const r = await fetch(`${app.base}/.well-known/openwop`, { headers: { 'OpenWOP-Version': '2' } });
    const doc = await r.json() as { auth?: { lanes?: Array<Record<string, unknown>> } };
    const lane = (doc.auth?.lanes ?? []).find((l) => l['lane'] === 'oidc');
    expect(lane, 'the oidc lane must be advertised when the verifier is configured').toBeDefined();
    expect(lane?.['revocation']).toBe('exp-only');
    // The number advertised IS the number enforced — both read one constant.
    expect(lane?.['revocationWindowSeconds']).toBe(OIDC_REVOCATION_WINDOW_S);
    expect(lane?.['issuers']).toEqual([ISS]);
    // `exp-only` is schema-forbidden where the host issues the credential itself.
    for (const l of doc.auth?.lanes ?? []) {
      if (l['lane'] === 'api-key' || l['lane'] === 'session') expect(l['revocation']).not.toBe('exp-only');
    }
  });

  it('serves the metadata at BOTH the root and the RFC 9728 sub-path form, unauthenticated', async () => {
    for (const [path, suffix] of [[PRM_SEGMENT, ''], [`${PRM_SEGMENT}/api`, '/api']] as const) {
      const r = await fetch(`${app.base}${path}`);
      expect(r.status, `${path} must answer 200 with NO credential, in a bearer-only posture`).toBe(200);
      const prm = await r.json() as Record<string, unknown>;
      // A projection: `resource` echoes the identifier the URL was formed from, and the
      // round trip back through the RFC 9728 §3.1 rule returns the URL we asked for.
      expect(prm['resource']).toBe(`${app.base}${suffix}`);
      expect(prmUrlFor(String(prm['resource']))).toBe(`${app.base}${path}`);
      expect(prm['authorization_servers']).toEqual([ISS]);
      // No invented claims: exactly the enforced scopes (ADR 0745 D2 — the field was
      // absent here while nothing enforced any), and no binding required. ADR 0972 D2:
      // the list includes the proposal scopes once the RFC 0249 wire is on.
      expect(prm['scopes_supported']).toEqual([...scopesSupported()]);
      expect(prm['dpop_bound_access_tokens_required']).toBeUndefined();
    }
  });

  it('a 401 with NO credential carries the challenge and NO error; a refused bearer carries invalid_token', async () => {
    // No `OpenWOP-Version: 2` on a `/v1/` path: that pairing is a
    // `protocol_version_mismatch` 400 which never reaches auth (measured).
    const body = JSON.stringify({ workflowId: 'noop' });
    const none = await fetch(`${app.base}/runs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    const bad = await fetch(`${app.base}/runs`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer not-a-real-token' }, body });
    for (const [label, res, wantError] of [['no credential', none, false], ['refused bearer', bad, true]] as const) {
      // NO skip path: a non-401 fails. An earlier cut guarded with `continue` and passed
      // while both legs returned 400, asserting nothing.
      expect(res.status, `${label}: must be refused 401 in a bearer-only posture`).toBe(401);
      const h = res.headers.get('www-authenticate');
      expect(h, `${label}: a 401 MUST carry a Bearer challenge`).toMatch(/^Bearer /);
      expect(h, `${label}: the challenge MUST name the §A.2 metadata URL`).toContain(`resource_metadata="${app.base}${PRM_SEGMENT}"`);
      // RFC 6750 §3.1 — an error code describes a credential that WAS refused; inventing
      // one tells a client its absent token was rejected.
      expect(h?.includes('error="invalid_token"'), `${label}: error param present? got ${h}`).toBe(wantError);
    }
  });
});

describe('cookie-ENABLED posture (production) — one boot shared by §B lifetime and §D audience', () => {
let app: { base: string; stop: () => Promise<void> };
// Both blocks below boot the identical env, so they share this one app.
beforeAll(async () => { app = await startApp(oidcEnv()); }, 60_000);
afterAll(async () => { if (app) await app.stop(); });

describe('RFC 0210 §B — the lifetime refusal is terminal even where a fallthrough exists', () => {
  // Cookies ENABLED: the posture where a stale bearer deliberately falls through to the
  // cookie path. The lifetime refusal must not take that path, or the advertised window
  // is a number we print — and the suite, which presents no cookie, would get a 201.

  it('answers 401 with the REGISTERED code credential_lifetime_exceeded', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = mint({ iss: ISS, aud: AUD, sub: 'subject-1', iat: now - 2 * MARGIN, exp: now + W - MARGIN });
    const r = await fetch(`${app.base}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ workflowId: 'noop' }),
    });
    expect(r.status, 'an over-lifetime credential must not fall through to the cookie lane').toBe(401);
    // §B.6 — the code on the wire, not nested in `details`: the suite reads `error`.
    expect((await r.json() as { error?: string }).error).toBe('credential_lifetime_exceeded');
    expect(r.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  it('CONTROL: a credential INSIDE the window is not refused by this host', async () => {
    // Without this the leg above is satisfied by a host that refuses every token.
    const now = Math.floor(Date.now() / 1000);
    const token = mint({ iss: ISS, aud: AUD, sub: 'subject-1', iat: now, exp: now + W - MARGIN });
    const r = await fetch(`${app.base}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ workflowId: 'noop' }),
    });
    expect(r.status, 'a credential inside the window must not be refused 401').not.toBe(401);
    // It got PAST auth: the route itself answered (no such workflow), not an auth refusal.
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'not_found', message: 'Workflow not found in this catalog.', details: { workflowId: 'noop' } });
  });
});

describe('RFC 0200 §D — audience_mismatch in the COOKIE-ENABLED posture (production)', () => {
  // Cookies ENABLED, as production runs. MEASURED on a colocated boot of
  // production's image: a wrong-audience token with no session answered a
  // generic `unauthenticated` here, while the cookies-disabled boot said
  // `audience_mismatch` — the refusal code depended on posture.

  it('a verified token for ANOTHER relying party, with no session, is 401 audience_mismatch', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = mint({ iss: ISS, aud: 'some-other-relying-party', sub: 'subject-aud', iat: now - 5, exp: now + 300 });
    const r = await fetch(`${app.base}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ workflowId: 'noop' }),
    });
    expect(r.status).toBe(401);
    const body = (await r.json()) as { error?: string };
    expect(body.error, 'the credential verified; its audience is not this host').toBe('audience_mismatch');
    expect(r.headers.get('set-cookie'), 'ADR 0434: never a fresh identity for a refused bearer').toBeNull();
  });

  it('a same-audience token is still admitted (the control)', async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = mint({ iss: ISS, aud: AUD, sub: 'subject-aud-ok', iat: now - 5, exp: now + 300 });
    const r = await fetch(`${app.base}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ workflowId: 'noop' }),
    });
    expect(r.status).not.toBe(401);
    // It got PAST auth: the route itself answered (no such workflow), not an auth refusal.
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'not_found', message: 'Workflow not found in this catalog.', details: { workflowId: 'noop' } });
  });
});
});
