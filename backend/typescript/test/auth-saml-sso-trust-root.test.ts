/**
 * RFC 0163 §B.1 (ADR 0620) — the PRODUCTION SAML SSO ACS applies the same-IdP
 * trust-root check, not just the conformance test seam. A valid assertion whose
 * signed `<saml:Issuer>` does NOT match the IdP entityID the SCIM connection was
 * bound to (a cross-IdP identifier collision) MUST NOT mint a session — even
 * though the assertion itself is cryptographically valid.
 *
 * `samlValidate` (the @node-saml XML-DSig validation) is mocked — the crypto is
 * vetted upstream and exercised elsewhere; what THIS test pins is the host's own
 * decision AFTER a valid assertion, in the real ACS route, parallel to the
 * validate seam. Same mock pattern as `auth-saml-disabled-user.test.ts`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { type Express } from 'express';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { __resetHostExtPersistence, initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { errorEnvelopeMiddleware } from '../src/middleware/errorEnvelope.js';
import { registerSamlSsoRoutes } from '../src/routes/authSamlSso.js';
import { __resetUsersStore } from '../src/features/users/usersService.js';
import { provisionUser } from '../src/host/auth/scimProvisioningService.js';

const TENANT = 'acme-corp';
const SCIM_TRUST_ROOT = 'urn:idp:acme'; // the IdP entityID the SCIM connection is bound to

// Mutable per-test identity the mocked validator returns. `issuer` is the SAML
// lane's signed trust root — same as SCIM ⇒ link; different ⇒ cross-root refuse.
// The initial `issuer` literal MUST equal SCIM_TRUST_ROOT (the hoisted factory
// runs before module consts, so it cannot reference the const).
const mockState = vi.hoisted(() => ({ nameId: 'collide-id', issuer: 'urn:idp:acme' }));

vi.mock('../src/host/auth/samlSso.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/host/auth/samlSso.js')>();
  return {
    ...actual,
    samlValidate: vi.fn(async () => ({
      nameId: mockState.nameId,
      issuer: mockState.issuer,
      email: `${mockState.nameId}@acme.test`,
      displayName: 'Saml User',
      groups: [],
    })),
  };
});

const dir = mkdtempSync(join(tmpdir(), 'owop-saml-trustroot-'));
let server: http.Server;
let BASE: string;

beforeAll(async () => {
  process.env.OPENWOP_SAML_IDP_SSO_URL = 'https://example.okta.com/app/abc/sso/saml';
  process.env.OPENWOP_SAML_IDP_CERT = 'MIIBdummybase64certbodywithoutpemheaders0000000000';
  process.env.OPENWOP_SAML_SP_ENTITY_ID = 'https://app.openwop.dev/saml';
  process.env.OPENWOP_SAML_ACS_URL = 'https://app.openwop.dev/api/v1/host/openwop-app/auth/saml/sso/acs';
  process.env.OPENWOP_SAML_TENANT = TENANT;
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';

  __resetHostExtPersistence();
  initHostExtPersistence(openSqliteStorage(join(dir, 'saml.db')));
  await __resetUsersStore();

  // A SCIM record for the colliding externalId, bound to IdP-A's trust root.
  // The ACS consults `s.tenantId` (OPENWOP_SAML_TENANT); provision there.
  await provisionUser({ tenantId: TENANT, userName: 'collider', externalId: 'collide-id', idpEntityId: SCIM_TRUST_ROOT });

  const app: Express = express();
  registerSamlSsoRoutes(app);
  app.use(errorEnvelopeMiddleware());
  server = await new Promise<http.Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  BASE = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  for (const k of ['OPENWOP_SAML_IDP_SSO_URL', 'OPENWOP_SAML_IDP_CERT', 'OPENWOP_SAML_SP_ENTITY_ID', 'OPENWOP_SAML_ACS_URL', 'OPENWOP_SAML_TENANT']) {
    delete process.env[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  mockState.nameId = 'collide-id';
  mockState.issuer = SCIM_TRUST_ROOT;
});

async function postAcs(): Promise<Response> {
  return fetch(`${BASE}/v1/host/openwop-app/auth/saml/sso/acs`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ SAMLResponse: 'valid-by-mock', RelayState: '/dash' }).toString(),
  });
}

describe('RFC 0163 §B — production ACS same-IdP trust-root check', () => {
  it('SAME trust root (issuer matches the SCIM connection) mints a session', async () => {
    mockState.issuer = SCIM_TRUST_ROOT; // IdP-A both lanes
    const res = await postAcs();
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/dash');
    expect(res.headers.get('set-cookie') ?? '').toMatch(/__session=[^;]/);
  });

  it('CROSS trust root (issuer from a different IdP) refuses — NO session', async () => {
    mockState.issuer = 'urn:idp:evil'; // IdP-B: valid assertion, wrong trust root
    const res = await postAcs();
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/?ssoError=1');
    // The load-bearing assertion: no session material leaves the host.
    expect(res.headers.get('set-cookie') ?? '').not.toMatch(/__session=[^;]/);
  });
});
