/**
 * USERS-13 (ADR 0613 residual) → RFC 0164 (ADR 0623) — `capabilities.auth.
 * subjectLinking` is a wire claim that the SCIM→SAML leaver deny FIRES. It fires
 * only when the production SAML ACS consults the SAME realm the SCIM lanes write
 * (`OPENWOP_SAML_TENANT == OPENWOP_SCIM_TENANT`) AND a shared trust root is
 * configurable for the SCIM lane.
 *
 * RFC 0164 makes the contract MANDATORY when both profiles are advertised:
 * "both profiles + no subjectLinking" is now a FAILURE (was `inapplicable`). So
 * when the deployment cannot honour the combined contract the host DROPS
 * `openwop-auth-scim` instead of advertising both-without-the-flag:
 *
 *   - both profiles + ALIGNED realms + trust-root seat ⇒ `subjectLinking: true`
 *   - MISALIGNED realms                                ⇒ `openwop-auth-scim` DROPPED
 *   - conformance-only SAML (validate seam, no production SP) ⇒ `true` — the
 *     seam consults the SCIM realm itself AND supplies the trust root, so the
 *     link is consistent by construction (what `auth-subject-link.test.ts` relies on)
 *
 * Discovery reads env per request, so one app serves all postures.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/index.js';
import { subjectLinkRealmAlignment } from '../src/host/auth/subjectLinkService.js';

const SAML_ENV = {
  OPENWOP_SAML_IDP_SSO_URL: 'https://example.okta.com/app/abc/sso/saml',
  OPENWOP_SAML_IDP_CERT: 'MIIBdummybase64certbodywithoutpemheaders0000000000',
  OPENWOP_SAML_SP_ENTITY_ID: 'https://app.openwop.dev/saml',
  OPENWOP_SAML_ACS_URL: 'https://app.openwop.dev/api/v1/host/openwop-app/auth/saml/sso/acs',
};
const KEYS = [...Object.keys(SAML_ENV), 'OPENWOP_SAML_TENANT', 'OPENWOP_SCIM_TENANT', 'OPENWOP_SCIM_BEARER', 'OPENWOP_SCIM_IDP_ENTITY_ID', 'OPENWOP_TEST_SAML_IDP_URL', 'OPENWOP_TEST_SCIM_URL'];
let BASE = '';
let server: http.Server;

async function auth(): Promise<{ profiles?: string[]; subjectLinking?: boolean }> {
  const doc = (await (await fetch(`${BASE}/.well-known/openwop`)).json()) as { capabilities?: { auth?: { profiles?: string[]; subjectLinking?: boolean } } };
  return doc.capabilities?.auth ?? {};
}

beforeAll(async () => {
  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  for (const k of KEYS) delete process.env[k];
  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; r(); }); });
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  for (const k of KEYS) delete process.env[k];
});
beforeEach(() => { for (const k of KEYS) delete process.env[k]; });

describe('USERS-13 — subjectLinking is advertised only when the leaver deny can actually fire', () => {
  it('production SAML + SCIM bearer, ALIGNED tenants + trust-root seat ⇒ subjectLinking:true', async () => {
    // RFC 0164 §A.2 — the real /scim/v2 lane's shared trust root is
    // OPENWOP_SCIM_IDP_ENTITY_ID; a combined-contract production deployment sets it.
    Object.assign(process.env, SAML_ENV, {
      OPENWOP_SAML_TENANT: 'acme',
      OPENWOP_SCIM_TENANT: 'acme',
      OPENWOP_SCIM_BEARER: 'b-0123456789abcdef',
      OPENWOP_SCIM_IDP_ENTITY_ID: 'https://example.okta.com/app/abc',
    });
    expect(subjectLinkRealmAlignment()).toEqual({ aligned: true, scimRealm: 'acme', samlRealm: 'acme' });
    const a = await auth();
    expect(a.profiles).toEqual(expect.arrayContaining(['openwop-auth-saml', 'openwop-auth-scim']));
    expect(a.subjectLinking).toBe(true);
  });

  it('production SAML + SCIM bearer under the DEFAULT tenants (`default` vs `scim`) ⇒ openwop-auth-scim DROPPED (RFC 0164)', async () => {
    // Trust-root seat present so misalignment is the SOLE reason for the drop.
    Object.assign(process.env, SAML_ENV, {
      OPENWOP_SCIM_BEARER: 'b-0123456789abcdef',
      OPENWOP_SCIM_IDP_ENTITY_ID: 'https://example.okta.com/app/abc',
    });
    expect(subjectLinkRealmAlignment()).toEqual({ aligned: false, scimRealm: 'scim', samlRealm: 'default' });
    const a = await auth();
    // RFC 0164: the host never advertises BOTH profiles without the leaver
    // guarantee — SAML (the production login path) stays, SCIM is dropped.
    expect(a.profiles).toContain('openwop-auth-saml');
    expect(a.profiles).not.toContain('openwop-auth-scim');
    expect('subjectLinking' in a).toBe(false);
  });

  it('conformance-only SAML (validate seam) + SCIM seam ⇒ true regardless of OPENWOP_SCIM_TENANT (the seam consults the SCIM realm itself)', async () => {
    Object.assign(process.env, { OPENWOP_TEST_SAML_IDP_URL: 'http://127.0.0.1:1/idp', OPENWOP_TEST_SCIM_URL: 'http://scim.invalid', OPENWOP_SCIM_TENANT: 'scim-test' });
    expect(subjectLinkRealmAlignment()).toEqual({ aligned: true, scimRealm: 'scim-test', samlRealm: null });
    expect((await auth()).subjectLinking).toBe(true);
  });

  it('one profile only ⇒ absent (unchanged §B rule)', async () => {
    Object.assign(process.env, { OPENWOP_SCIM_BEARER: 'b-0123456789abcdef', OPENWOP_SCIM_TENANT: 'acme' });
    const a = await auth();
    expect(a.profiles).not.toContain('openwop-auth-saml');
    expect('subjectLinking' in a).toBe(false);
  });
});
