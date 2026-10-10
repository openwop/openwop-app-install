/**
 * USERS-13 (ADR 0613 residual) → RFC 0164 (ADR 0623) — `capabilities.auth.
 * subjectLinking` is a wire claim that the SCIM→SAML leaver deny FIRES. It fires
 * only when the production SAML ACS consults the SAME realm the SCIM lanes write
 * (`OPENWOP_SAML_TENANT == OPENWOP_SCIM_TENANT`) AND a shared trust root is
 * configurable for the SCIM lane.
 *
 * What THIS file owns (the production-SP postures):
 *   - production SAML + SCIM bearer, ALIGNED realms + the real lane's trust-root
 *     seat (`OPENWOP_SCIM_IDP_ENTITY_ID`) ⇒ `subjectLinking: true`;
 *   - one profile only ⇒ the flag is absent (RFC 0159 §B).
 *
 * Not repeated here (same break, covering test named): misaligned realms ⇒
 * `openwop-auth-scim` DROPPED is `auth-subject-link.test.ts` "(i) DROP-arm A";
 * the conformance-seam posture ⇒ `true` is `auth-subject-link.test.ts` "(iii)".
 *
 * Discovery reads env per call, so the claim is a function of env + the v1
 * discovery BUILDER (no app boot, no HTTP): ADR 0812 — `subjectLinking` has no
 * v2 facet yet, so the v1 builder is read directly. THIS IS DEBT (ADR 0858):
 * re-point at the v2 `auth` record once projected; ADR 0812 P3c deletes the
 * builder and this read with it.
 *
 * Sabotage that turns it red: `subjectLinkService.ts` making the trust-root
 * check ignore `OPENWOP_SCIM_IDP_ENTITY_ID` reds the ALIGNED case (the seam
 * posture in `auth-subject-link.test.ts` stays green — it supplies the root via
 * `OPENWOP_TEST_SCIM_URL`).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { v1Advertisement } from './support/v1Advertisement.js';
import { subjectLinkRealmAlignment } from '../src/host/auth/subjectLinkService.js';

const SAML_ENV = {
  OPENWOP_SAML_IDP_SSO_URL: 'https://example.okta.com/app/abc/sso/saml',
  OPENWOP_SAML_IDP_CERT: 'MIIBdummybase64certbodywithoutpemheaders0000000000',
  OPENWOP_SAML_SP_ENTITY_ID: 'https://app.openwop.dev/saml',
  OPENWOP_SAML_ACS_URL: 'https://app.openwop.dev/api/host/openwop-app/auth/saml/sso/acs',
};
const KEYS = [...Object.keys(SAML_ENV), 'OPENWOP_SAML_TENANT', 'OPENWOP_SCIM_TENANT', 'OPENWOP_SCIM_BEARER', 'OPENWOP_SCIM_IDP_ENTITY_ID', 'OPENWOP_TEST_SAML_IDP_URL', 'OPENWOP_TEST_SCIM_URL'];
const prior: Record<string, string | undefined> = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

async function auth(): Promise<{ profiles?: string[]; subjectLinking?: boolean; subjectLinkKey?: string }> {
  const doc = (await v1Advertisement()) as { capabilities?: { auth?: { profiles?: string[]; subjectLinking?: boolean; subjectLinkKey?: string } } };
  return doc.capabilities?.auth ?? {};
}

// Warm the builder's module graph once (a cold import of `src/index.js` can
// exceed a single test's timeout) — no boot, no listener.
beforeAll(async () => { await import('../src/routes/discovery.js'); await import('../src/index.js'); }, 120_000);
beforeEach(() => { for (const k of KEYS) delete process.env[k]; });
afterAll(() => {
  for (const k of KEYS) {
    if (prior[k] === undefined) delete process.env[k];
    else process.env[k] = prior[k];
  }
});

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
    expect(a.subjectLinkKey).toBe('opaque-idp');
  });

  it('one profile only ⇒ absent (unchanged §B rule)', async () => {
    Object.assign(process.env, { OPENWOP_SCIM_BEARER: 'b-0123456789abcdef', OPENWOP_SCIM_TENANT: 'acme' });
    const a = await auth();
    expect(a.profiles).toContain('openwop-auth-scim');
    expect(a.profiles).not.toContain('openwop-auth-saml');
    expect('subjectLinking' in a).toBe(false);
    expect('subjectLinkKey' in a).toBe(false);
  });
});
