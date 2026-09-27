/**
 * USERS-14 — the conformance seam's externalId-addressed ops write the
 * DETERMINISTIC subject-link realm (`OPENWOP_SCIM_TENANT`), not the caller's
 * tenant. With `OPENWOP_TEST_SCIM_URL` set and NO bearer configured, the seam
 * was open to ANY caller (an anonymous session is minted by the middleware), so
 * on a host with a production SAML SP an attacker could provision then
 * deactivate an arbitrary externalId and deny that NameID's real SSO login.
 *
 * Witness over the REAL auth middleware + seam:
 *   - production SAML configured + no SCIM bearer ⇒ an anonymous / foreign
 *     caller's externalId-addressed `create-user` AND `deactivate-user` are
 *     refused 403 `scim_bearer_required`, and NO deny row / NO row in the link
 *     realm is written;
 *   - a plain userName-addressed op (caller-tenant, no link-realm write) still
 *     works — the guard is scoped to the realm write, not the seam;
 *   - with NO production SAML SP (pure-conformance host) the externalId ops keep
 *     the open posture the RFC 0159 scenario drives (stated residual);
 *   - with a bearer configured, the existing `requireScimBearer` 401s a caller
 *     that does not present it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express, { type Express } from 'express';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authMiddleware } from '../src/middleware/auth.js';
import { errorEnvelopeMiddleware } from '../src/middleware/errorEnvelope.js';
import { registerScimAuthRoutes } from '../src/routes/authScim.js';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { __resetUsersStore, getScimUserByExternalId } from '../src/features/users/usersService.js';
import { __resetSubjectLinkStore, isLinkedSubjectDenied } from '../src/host/auth/subjectLinkService.js';

const REALM = 'scim-guard';
const SAML_ENV = {
  OPENWOP_SAML_IDP_SSO_URL: 'https://example.okta.com/app/abc/sso/saml',
  OPENWOP_SAML_IDP_CERT: 'MIIBdummybase64certbodywithoutpemheaders0000000000',
  OPENWOP_SAML_SP_ENTITY_ID: 'https://app.openwop.dev/saml',
  OPENWOP_SAML_ACS_URL: 'https://app.openwop.dev/api/v1/host/openwop-app/auth/saml/sso/acs',
  OPENWOP_SAML_TENANT: REALM,
};
const dir = mkdtempSync(join(tmpdir(), 'owop-scim-guard-'));
let server: http.Server;
let port: number;

const seam = (body: unknown, bearer?: string, cookie?: string): Promise<Response> =>
  fetch(`http://127.0.0.1:${port}/v1/host/openwop-app/auth/scim/provision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });
/** The seam sits behind the global auth middleware, which refuses a foreign
 *  bearer unless a healthy session cookie rides along (pre-existing) — mint an
 *  anon cookie first so the SCIM bearer reaches the seam's own check. */
async function anonCookie(): Promise<string> {
  const res = await seam({ scimUrl: 'x', op: 'link', linkKey: 'externalId' });
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

beforeAll(async () => {
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  process.env.OPENWOP_TEST_SCIM_URL = 'http://scim.invalid/scim/v2';
  process.env.OPENWOP_SCIM_TENANT = REALM;
  delete process.env.OPENWOP_SCIM_BEARER;
  delete process.env.OPENWOP_AUTH_ENFORCE_BEARER;
  const app: Express = express();
  app.use(express.json());
  app.use(authMiddleware()); // anon sessions ARE minted — that is the exposure
  registerScimAuthRoutes(app);
  app.use(errorEnvelopeMiddleware());
  server = await new Promise<http.Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  port = (server.address() as { port: number }).port;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
  for (const k of ['OPENWOP_TEST_SCIM_URL', 'OPENWOP_SCIM_TENANT', 'OPENWOP_SCIM_BEARER', ...Object.keys(SAML_ENV)]) delete process.env[k];
});
beforeEach(async () => {
  __resetHostExtPersistence();
  initHostExtPersistence(openSqliteStorage(join(dir, 'scim.db')));
  await __resetUsersStore();
  await __resetSubjectLinkStore();
  for (const k of Object.keys(SAML_ENV)) delete process.env[k];
  delete process.env.OPENWOP_SCIM_BEARER;
});

describe('USERS-14 — externalId-addressed seam ops on a host with a production SAML SP', () => {
  beforeEach(() => { Object.assign(process.env, SAML_ENV); });

  it('an anonymous caller cannot provision into the link realm (403 scim_bearer_required, nothing written)', async () => {
    const res = await seam({ scimUrl: 'x', op: 'create-user', externalId: 'ext-victim', userName: 'victim@acme.test' });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { details?: { reason?: string } }).details?.reason).toBe('scim_bearer_required');
    expect(await getScimUserByExternalId(REALM, 'ext-victim')).toBeNull();
  });

  it('an anonymous caller cannot deny a NameID via deactivate-user by externalId (403, no deny row)', async () => {
    const res = await seam({ scimUrl: 'x', op: 'deactivate-user', externalId: 'ext-victim' });
    expect(res.status).toBe(403);
    expect(await isLinkedSubjectDenied(REALM, 'ext-victim')).toBe(false);
  });

  it('a plain userName-addressed op (caller tenant, no realm write) still works', async () => {
    const res = await seam({ scimUrl: 'x', op: 'create-user', userName: 'plain@acme.test' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { principal: { tenantId: string } };
    expect(body.principal.tenantId).not.toBe(REALM); // the caller's (anon) tenant, not the link realm
  });

  it('with a bearer configured, the externalId op is reachable ONLY by presenting it', async () => {
    const cookie = await anonCookie();
    process.env.OPENWOP_SCIM_BEARER = 'guard-bearer-0123456789abcdef';
    expect((await seam({ scimUrl: 'x', op: 'create-user', externalId: 'ext-ok', userName: 'ok@acme.test' }, undefined, cookie)).status).toBe(401);
    expect((await seam({ scimUrl: 'x', op: 'create-user', externalId: 'ext-ok', userName: 'ok@acme.test' }, 'guard-bearer-0123456789abcdef', cookie)).status).toBe(201);
    expect(await getScimUserByExternalId(REALM, 'ext-ok')).not.toBeNull();
  });
});

describe('USERS-14 — the pure-conformance posture (no production SAML SP) is preserved, and stated', () => {
  it('externalId ops stay open when the only SAML lane is the validate seam', async () => {
    const created = await seam({ scimUrl: 'x', op: 'create-user', externalId: 'ext-conf', userName: 'conf@acme.test' });
    expect(created.status).toBe(201);
    const deact = await seam({ scimUrl: 'x', op: 'deactivate-user', externalId: 'ext-conf' });
    expect(deact.status).toBe(200);
    expect(await isLinkedSubjectDenied(REALM, 'ext-conf')).toBe(true);
  });
});
