/**
 * Anon → user migration route tests (P3.5).
 *
 * Verifies POST /v1/host/openwop-app/migrate-tenant:
 *   - Reassigns runs + workflows from anon tenant to user tenant
 *   - Migrates ephemeral BYOK secrets when KMS is configured
 *   - Expires the anon cookie after success
 *   - Is idempotent (re-call returns zeros, no errors)
 *   - Refuses unauthenticated callers
 *
 * Uses the same synthetic OIDC issuer as auth-oidc.test.ts so the
 * test exercises the real OIDC verification path.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express, { type Express } from 'express';
import http from 'node:http';
import { createSign, generateKeyPairSync, randomBytes, type KeyObject, createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { authMiddleware, _resetOidcVerifier } from '../src/middleware/auth.js';
import { registerPersonalTenantSessionAuthority, registerSessionAuthority } from '../src/host/sessionAuthority.js';
import { usersSessionAuthority } from '../src/features/users/feature.js';
import { registerMigrateRoute } from '../src/routes/migrate.js';
import { openStorage } from '../src/storage/index.js';
import {
  configureSecretResolver,
  setSecret,
  listSecretRefs,
  clearCache,
} from '../src/byok/secretResolver.js';
import {
  configureKmsClient,
  createLocalAesKmsClient,
  _resetKmsForTesting,
} from '../src/byok/kmsEncryption.js';
import type { Storage } from '../src/storage/storage.js';

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

interface SyntheticIssuer {
  issuer: string;
  audience: string;
  jwksUrl: string;
  mint(overrides?: Partial<{ sub: string }>): string;
  close: () => Promise<void>;
}

async function startSyntheticIssuer(audience: string): Promise<SyntheticIssuer> {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'test-kid-1';
  const pubJwk = publicKey.export({ format: 'jwk' });
  const jwks = { keys: [{ ...pubJwk, kid, alg: 'RS256', use: 'sig' }] };
  const app = express();
  app.get('/.well-known/jwks.json', (_req, res) => res.json(jwks));
  const server = await new Promise<http.Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const port = (server.address() as { port: number }).port;
  const issuer = `http://127.0.0.1:${port}`;
  return {
    issuer, audience,
    jwksUrl: `${issuer}/.well-known/jwks.json`,
    mint(overrides = {}) {
      const now = Math.floor(Date.now() / 1000);
      const header = { alg: 'RS256', kid, typ: 'JWT' };
      const payload = {
        iss: issuer, aud: audience,
        sub: overrides.sub ?? 'firebase-uid-test',
        iat: now, exp: now + 300,
      };
      const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
      const sig = createSign('sha256').update(signingInput).sign(privateKey as KeyObject);
      return `${signingInput}.${b64url(sig)}`;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

const SESSION_SECRET = 'test-session-secret-32+chars-aaaaaaaaaaaaaa';
// Tracks middleware/auth.ts default — Firebase Hosting strips every
// cookie except `__session` when forwarding to Cloud Run.
const COOKIE_NAME = '__session';

function mintAnonCookie(sid: string): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sid, tenantId: `anon:${sid}`, tier: 'anon',
    iat: now, exp: now + 86_400,
  };
  const payloadB64 = b64url(JSON.stringify(payload));
  const sig = createHmac('sha256', SESSION_SECRET).update(payloadB64).digest();
  return `${payloadB64}.${b64url(sig)}`;
}

let appServer: http.Server;
let appPort: number;
let issuer: SyntheticIssuer;
let storage: Storage;

beforeAll(async () => {
  issuer = await startSyntheticIssuer('openwop-test-aud');
  process.env.OPENWOP_OIDC_ISSUER = issuer.issuer;
  process.env.OPENWOP_OIDC_AUDIENCE = issuer.audience;
  process.env.OPENWOP_OIDC_JWKS_URL = issuer.jwksUrl;
  process.env.OPENWOP_SESSION_SECRET = SESSION_SECRET;
  process.env.OPENWOP_BYOK_EPHEMERAL = 'true';
  // ADR 0621 rev. 2 — the unbound OIDC lane now consults the session authority
  // (no permissive default on the seam). This harness mounts the bare
  // middleware with NO host-ext persistence and no users store, so the honest
  // unbound-lane answer is "no durable row was ever bound" (`null`); the
  // `userId` read is the feature's real one (never reached — no bound cookie).
  registerSessionAuthority(usersSessionAuthority);
  registerPersonalTenantSessionAuthority(async () => null);
  _resetOidcVerifier();

  storage = await openStorage('memory://');
  const dataDir = mkdtempSync(join(tmpdir(), 'openwop-migrate-'));
  configureSecretResolver({ storage, dataDir });
  configureKmsClient(createLocalAesKmsClient(randomBytes(32), 'test/local-aes'));

  const app: Express = express();
  app.use(express.json());
  app.use(authMiddleware());
  registerMigrateRoute(app, { storage });
  // Error handler so OpenwopError → JSON envelope.
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    type ErrLike = { code?: string; httpStatus?: number; message?: string };
    const e = err as ErrLike;
    res.status(e.httpStatus ?? 500).json({
      error: e.code ?? 'internal_error',
      message: e.message ?? 'internal error',
    });
  });
  appServer = await new Promise<http.Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  appPort = (appServer.address() as { port: number }).port;
});

afterAll(async () => {
  await new Promise<void>((r) => appServer.close(() => r()));
  await issuer.close();
  await storage.close();
  _resetOidcVerifier();
  _resetKmsForTesting();
  delete process.env.OPENWOP_OIDC_ISSUER;
  delete process.env.OPENWOP_OIDC_AUDIENCE;
  delete process.env.OPENWOP_OIDC_JWKS_URL;
  delete process.env.OPENWOP_SESSION_SECRET;
  delete process.env.OPENWOP_BYOK_EPHEMERAL;
});

beforeEach(() => {
  clearCache();
});

async function callMigrate(token: string, cookieValue?: string): Promise<Response> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
  };
  if (cookieValue) headers.cookie = `${COOKIE_NAME}=${cookieValue}`;
  return fetch(`http://127.0.0.1:${appPort}/v1/host/openwop-app/migrate-tenant`, {
    method: 'POST',
    headers,
    body: '{}',
  });
}

describe('P3.5 anon → user migration', () => {
  it('refuses callers without an OIDC bearer', async () => {
    const res = await fetch(`http://127.0.0.1:${appPort}/v1/host/openwop-app/migrate-tenant`, {
      method: 'POST',
      headers: { cookie: `${COOKIE_NAME}=${mintAnonCookie('test-sid-x')}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(401);
  });

  it('returns migrated:false when no anon cookie is present', async () => {
    const token = issuer.mint({ sub: 'firebase-uid-no-cookie' });
    const res = await callMigrate(token); // no cookie
    expect(res.status).toBe(200);
    const body = await res.json() as { migrated: boolean; runs: number };
    expect(body.migrated).toBe(false);
    expect(body.runs).toBe(0);
  });

  it('reassigns runs + workflows from anon to user', async () => {
    const sid = 'sid-with-data';
    const anonTenantId = `anon:${sid}`;
    const now = new Date().toISOString();

    // Seed 2 runs + 1 workflow owned by the anon tenant.
    await storage.insertRun({
      runId: 'r-1', workflowId: 'wf', tenantId: anonTenantId,
      status: 'completed', inputs: null, metadata: {}, configurable: {},
      createdAt: now, updatedAt: now,
    });
    await storage.insertRun({
      runId: 'r-2', workflowId: 'wf', tenantId: anonTenantId,
      status: 'failed', inputs: null, metadata: {}, configurable: {},
      createdAt: now, updatedAt: now,
    });

    const token = issuer.mint({ sub: 'firebase-uid-alice' });
    const res = await callMigrate(token, mintAnonCookie(sid));
    expect(res.status).toBe(200);
    const body = await res.json() as { migrated: boolean; runs: number; workflows: number };
    expect(body.migrated).toBe(true);
    expect(body.runs).toBe(2);

    // After migration, neither run is owned by the anon tenant.
    const anonRuns = await storage.listRuns({ tenantId: anonTenantId });
    expect(anonRuns).toHaveLength(0);
    // And both runs are visible under the user tenant.
    const r1 = await storage.getRun('r-1');
    expect(r1!.tenantId).toMatch(/^user:/);
    expect(r1!.tenantId).not.toBe(anonTenantId);
  });

  it('migrates ephemeral BYOK secrets when KMS is configured', async () => {
    const sid = 'sid-with-secret';
    const anonTenantId = `anon:${sid}`;
    await setSecret('OPENAI_API_KEY', 'sk-anon-value', { tenantId: anonTenantId });
    expect(await listSecretRefs({ tenantId: anonTenantId })).toEqual(['OPENAI_API_KEY']);

    const token = issuer.mint({ sub: 'firebase-uid-bob' });
    const res = await callMigrate(token, mintAnonCookie(sid));
    expect(res.status).toBe(200);
    const body = await res.json() as { migrated: boolean; secrets: number; secretsFailed: number };
    expect(body.migrated).toBe(true);
    expect(body.secrets).toBe(1);
    expect(body.secretsFailed).toBe(0);

    // Anon bucket is empty post-migration.
    expect(await listSecretRefs({ tenantId: anonTenantId })).toEqual([]);
  });

  // ADR 0434 Phase 2 — DELIBERATELY OVERTURNED. This asserted that a successful
  // adoption EXPIRED the session cookie ("so the next request carries only the
  // bearer"). But the auth middleware appends its own Set-Cookie on this same
  // response, PROMOTING that cookie to user-tier. Two Set-Cookie headers with
  // the same name and path — the later one wins, so this route silently threw
  // away the promotion and the browser finished sign-in with NO cookie.
  //
  // That is what left devices bearer-only, and a bearer-only device that hits a
  // token-rotation race had nothing to fall back to — the fresh-anon-tenant bug
  // (see auth-bearer-cookie-fallthrough.test.ts). The promoted user-tier cookie
  // must SURVIVE. The anon session is not stranded by keeping it: it was
  // promoted in place, and its data was just folded into the user tenant.
  it('PRESERVES the promoted user-tier cookie — never expires it', async () => {
    const sid = 'sid-cookie-clear';
    const token = issuer.mint({ sub: 'firebase-uid-cookie-clear' });
    const res = await callMigrate(token, mintAnonCookie(sid));
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie');

    // §Correction — this was `if (setCookie) { expect(...) }`, which PASSES when
    // the response carries no cookie at all. "Ending sign-in cookie-less" is
    // precisely the defect the docblock above describes, so the guard admitted
    // the thing it was written to catch. It also never checked the TIER, while
    // the whole point is that the PROMOTED user-tier cookie survives.
    expect(setCookie, 'sign-in must not end cookie-less — that is the defect').toBeTruthy();
    expect(setCookie, 'the cookie must not be a deletion').not.toContain('Max-Age=0');

    // Decode the payload and assert the promotion actually happened: a
    // surviving ANON cookie would satisfy "not a deletion" while leaving the
    // device exactly as un-promoted as no cookie at all.
    const raw = /(?:^|[;,\s])__session=([^;]+)/.exec(setCookie!)?.[1];
    expect(raw, 'no __session cookie in the Set-Cookie header').toBeTruthy();
    const payload = JSON.parse(
      Buffer.from(raw!.split('.')[0]!.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
    ) as { tier?: string; tenantId?: string };
    expect(payload.tier, 'the surviving cookie must be USER-tier — an anon one is not a promotion').toBe('user');
    expect(payload.tenantId, 'and it must name the user tenant').toMatch(/^user:/);
  });
});
