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
 * Discovery reads env per call, so the claim is a function of env + the v2
 * discovery builder (no app boot, no HTTP). ADR 0812 P4 re-pointed this from
 * the deleted v1 builder. The v2 `auth` record has no `subjectLinking` flag and
 * no `profiles` list: the claim is the PAIR of `saml` + `scim` lanes, which
 * `advertisedAuthProfiles()` only emits together when the combined contract is
 * active (RFC 0164's mandatory-both drop). `subjectLinkKey` is stated only
 * with BOTH lanes (spec-steward ruling 2026-10-10, ADR 0858 § "P4 slice").
 *
 * Sabotage that turns it red: `subjectLinkService.ts` making the trust-root
 * check ignore `OPENWOP_SCIM_IDP_ENTITY_ID` reds the ALIGNED case (the seam
 * posture in `auth-subject-link.test.ts` stays green — it supplies the root via
 * `OPENWOP_TEST_SCIM_URL`).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildV2Advertisement } from '../src/routes/discovery.js';
import { loadConfigFromEnv } from '../src/index.js';
import { subjectLinkRealmAlignment } from '../src/host/auth/subjectLinkService.js';

const SAML_ENV = {
  OPENWOP_SAML_IDP_SSO_URL: 'https://example.okta.com/app/abc/sso/saml',
  OPENWOP_SAML_IDP_CERT: 'MIIBdummybase64certbodywithoutpemheaders0000000000',
  OPENWOP_SAML_SP_ENTITY_ID: 'https://app.openwop.dev/saml',
  OPENWOP_SAML_ACS_URL: 'https://app.openwop.dev/api/host/openwop-app/auth/saml/sso/acs',
};
const KEYS = [...Object.keys(SAML_ENV), 'OPENWOP_SAML_TENANT', 'OPENWOP_SCIM_TENANT', 'OPENWOP_SCIM_BEARER', 'OPENWOP_SCIM_IDP_ENTITY_ID', 'OPENWOP_TEST_SAML_IDP_URL', 'OPENWOP_TEST_SCIM_URL'];
const prior: Record<string, string | undefined> = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

/** The v2 `auth` record, reduced to the lane names and the link key. */
async function auth(): Promise<{ lanes: string[]; subjectLinkKey?: string }> {
  const rec = buildV2Advertisement(loadConfigFromEnv())['auth'] as { lanes?: Array<{ lane: string }>; subjectLinkKey?: string } | undefined;
  return { lanes: (rec?.lanes ?? []).map((l) => l.lane), ...(rec?.subjectLinkKey ? { subjectLinkKey: rec.subjectLinkKey } : {}) };
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
    // Both lanes together IS the subject-linking claim at v2.
    expect(a.lanes).toEqual(expect.arrayContaining(['saml', 'scim']));
    expect(a.subjectLinkKey).toBe('opaque-idp');
  });

  it('one profile only ⇒ absent (unchanged §B rule)', async () => {
    Object.assign(process.env, { OPENWOP_SCIM_BEARER: 'b-0123456789abcdef', OPENWOP_SCIM_TENANT: 'acme' });
    const a = await auth();
    expect(a.lanes).toContain('scim');
    // One lane only: the pair that makes the subject-linking claim is absent.
    expect(a.lanes).not.toContain('saml');
    // …and so is the key: a one-lane host forms no link (steward ruling 2026-10-10).
    expect(a).not.toHaveProperty('subjectLinkKey');
  });
});
