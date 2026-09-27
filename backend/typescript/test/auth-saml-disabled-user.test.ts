/**
 * USERS-1 (fail-closed, finding H5) — the SAML SSO ACS lane must consult the
 * durable user's status BEFORE minting a session. Pre-fix, a VALID IdP
 * assertion for a host-DISABLED user cheerfully issued a full user-tier cookie:
 * the disable lifecycle was enforced only on the users feature's own routes,
 * and `isActiveUser` had zero enforcement callers.
 *
 * `samlValidate` (the @node-saml XML-DSig validation) is mocked — the crypto is
 * vetted upstream and exercised elsewhere; what THIS test pins is the host's
 * own decision AFTER a valid assertion: active → session cookie + redirect,
 * disabled → 403 canonical envelope, NO cookie.
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
import { __resetUsersStore, getUserByPrincipal, setUserStatus, upsertFromPrincipal } from '../src/features/users/usersService.js';
import { denyLinkedSubject, clearLinkedSubjectDeny } from '../src/host/auth/subjectLinkService.js';

// Mutable per-test identity the mocked validator returns (hoisted so the mock
// factory may reference it safely).
const mockState = vi.hoisted(() => ({ nameId: 'nameid-active' }));

vi.mock('../src/host/auth/samlSso.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/host/auth/samlSso.js')>();
  return {
    ...actual,
    // A VALID assertion for whichever subject the test configured — the point
    // is what the host does next, not the XML-DSig (vetted upstream).
    samlValidate: vi.fn(async () => ({
      nameId: mockState.nameId,
      email: `${mockState.nameId}@acme.test`,
      displayName: 'Saml User',
      groups: [],
    })),
  };
});

const TENANT = 'acme-corp';
const dir = mkdtempSync(join(tmpdir(), 'owop-saml-disabled-'));
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

  const app: Express = express();
  registerSamlSsoRoutes(app);
  app.use(errorEnvelopeMiddleware());
  // H41: bind loopback v4 EXPLICITLY. `listen(0)` takes the `[::]` wildcard, and a
  // resident 127.0.0.1 listener on the port the OS hands back answers the test's
  // fetch instead of this server. `scripts/check-test-ports.mjs` enforces it.
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
  mockState.nameId = 'nameid-active';
});

async function postAcs(relayState = '/dash'): Promise<Response> {
  return fetch(`${BASE}/v1/host/openwop-app/auth/saml/sso/acs`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ SAMLResponse: 'valid-by-mock', RelayState: relayState }).toString(),
  });
}

describe('USERS-1 — SAML ACS refuses a disabled user before minting a session', () => {
  it('ACTIVE polarity: a valid assertion mints a session cookie and redirects to RelayState', async () => {
    mockState.nameId = 'nameid-active';
    const res = await postAcs('/dash');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/dash');
    expect(res.headers.get('set-cookie') ?? '').toMatch(/__session=[^;]/);
    // The lane provisioned the durable user.
    const user = await getUserByPrincipal(TENANT, 'saml:nameid-active');
    expect(user).not.toBeNull();
    expect(user!.status).toBe('active');
  });

  it('DISABLED polarity: a valid assertion for a disabled user → 403 canonical envelope, NO cookie', async () => {
    mockState.nameId = 'nameid-disabled';
    // Provision, then disable — the fail-closed lockout an admin actually uses.
    const user = await upsertFromPrincipal({ tenantId: TENANT, principalId: 'saml:nameid-disabled', source: 'saml' });
    await setUserStatus(user.userId, 'disabled', { reason: 'admin' });

    const res = await postAcs('/dash');
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string; message?: string };
    expect(body.error).toBe('forbidden');
    // The load-bearing assertion: no session material leaves the host.
    expect(res.headers.get('set-cookie') ?? '').not.toMatch(/__session=[^;]/);
    // And the record stays disabled (the refusal did not fail-open anything).
    expect((await getUserByPrincipal(TENANT, 'saml:nameid-disabled'))!.status).toBe('disabled');
  });

  it('re-enable restores the SAML login (both polarities, same subject)', async () => {
    mockState.nameId = 'nameid-disabled';
    const user = await getUserByPrincipal(TENANT, 'saml:nameid-disabled');
    expect(user).not.toBeNull();
    await setUserStatus(user!.userId, 'active', { reason: 'admin' });

    const res = await postAcs('/back');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/back');
    expect(res.headers.get('set-cookie') ?? '').toMatch(/__session=[^;]/);
  });
});

describe('USERS-13 / RFC 0159 §A.3 — the PRODUCTION ACS refuses a SCIM-denied linked subject', () => {
  it('a valid assertion for a NameID whose linked SCIM identity is denied → redirect to /?ssoError=1 with NO cookie; clearing the deny restores login', async () => {
    mockState.nameId = 'nameid-linked-leaver';
    // The SCIM lane wrote the deny under the aligned realm (OPENWOP_SCIM_TENANT ==
    // OPENWOP_SAML_TENANT — the MUST this row makes concrete): keyed on the
    // opaque externalId == persistent NameID.
    await denyLinkedSubject(TENANT, 'nameid-linked-leaver');
    const denied = await postAcs('/dash');
    expect(denied.status).toBe(302);
    expect(denied.headers.get('location')).toBe('/?ssoError=1');
    expect(denied.headers.get('set-cookie') ?? '').not.toMatch(/__session=[^;]/);
    // Refused BEFORE provisioning: no durable row was minted for the leaver.
    expect(await getUserByPrincipal(TENANT, 'saml:nameid-linked-leaver')).toBeNull();

    await clearLinkedSubjectDeny(TENANT, 'nameid-linked-leaver'); // re-hire
    const ok = await postAcs('/dash');
    expect(ok.status).toBe(302);
    expect(ok.headers.get('location')).toBe('/dash');
    expect(ok.headers.get('set-cookie') ?? '').toMatch(/__session=[^;]/);
  });

  it('a deny written under a DIFFERENT realm (misaligned OPENWOP_SCIM_TENANT) is invisible to the ACS — the misalignment USERS-13 names', async () => {
    mockState.nameId = 'nameid-misaligned';
    await denyLinkedSubject('scim', 'nameid-misaligned'); // the DEFAULT scim realm, ≠ TENANT
    const res = await postAcs('/dash');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/dash'); // the leaver got in — which is why discovery withholds subjectLinking
    await clearLinkedSubjectDeny('scim', 'nameid-misaligned');
  });
});
