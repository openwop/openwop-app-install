/**
 * RFC 0159 — SCIM ⟷ SAML subject linking (the combined leaver contract), plus
 * its RFC 0163 hardening (ADR 0620): a declarable link-key CLASS advertised in
 * discovery, and a same-IdP TRUST-ROOT MUST before a cross-lane link may form.
 *
 * Host route-level witness over the reference host's real routes (`createApp` +
 * TWO synthetic IdPs), mirroring the merged conformance scenarios
 * (`auth-subject-link.test.ts` + `auth-subject-link-key-class.test.ts`):
 *
 *   1. advertisement — capabilities.auth.subjectLinking:true iff BOTH profiles,
 *      and (RFC 0163 §A) subjectLinkKey === 'opaque-idp' (a member of the closed
 *      safe-class enum);
 *   2. cross-lane deny (RFC 0159 §A.3) — a SCIM deactivation fail-closes the
 *      LINKED SAML identity (a provisioned leaver cannot still SSO in);
 *   3. link-key hygiene (RFC 0159 §A.2) — a mutable/PII link key (email) is
 *      rejected 4xx and forms NO cross-lane link;
 *   4. same-IdP trust root (RFC 0163 §B) — a SAML assertion from the SAME IdP
 *      that provisioned the SCIM record links + authenticates (positive control);
 *      a valid assertion for the SAME opaque id but from a DIFFERENT IdP (a
 *      cross-IdP identifier collision) MUST NOT authenticate — 401
 *      `subject_link_trust_root_mismatch`;
 *   5. the `/v1/host/sample/auth/*` aliases are reachable.
 *
 * Drives the `sample`-spelled seams with OPENWOP_TEST_SEAM_ENABLED UNSET, so the
 * explicit both-spellings alias registration (not the testSeam namespace rewrite)
 * is what serves them.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createServer } from 'node:http';
import { createHash, createSign, generateKeyPairSync } from 'node:crypto';
import { createApp } from '../src/index.js';

// ── Two-trust-root synthetic IdP fixture (RFC 0163 §B) ─────────────────────────
// Each IdP has a distinct signing key AND a distinct `entityID` it signs into the
// `<saml:Issuer>` — two independent trust roots. Byte-identical to the signed
// canonical form the host ACS validates over the live seam (suite ≥1.147.0: the
// Issuer is INSIDE the signed element).
const SIG_RSA_SHA256 = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';

interface SyntheticIdp {
  entityID: string;
  certificatePem: string;
  mintValid(subject: string): string;
}

function makeIdp(entityID: string): SyntheticIdp {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const certificatePem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const digest = (s: string): string => createHash('sha256').update(s, 'utf8').digest('base64');
  const sign = (s: string): string => createSign('RSA-SHA256').update(s, 'utf8').sign(privateKey, 'base64');
  const canonical = (id: string, subject: string, nb: string, noa: string): string =>
    `<saml:Assertion ID="${id}" Version="2.0">` +
    `<saml:Issuer>${entityID}</saml:Issuer>` +
    `<saml:Conditions NotBefore="${nb}" NotOnOrAfter="${noa}"/>` +
    `<saml:Subject><saml:NameID>${subject}</saml:NameID></saml:Subject>` +
    `</saml:Assertion>`;
  return {
    entityID,
    certificatePem,
    mintValid(subject: string): string {
      const id = 'a-valid';
      const now = Date.now();
      const nb = new Date(now - 3_600_000).toISOString();
      const noa = new Date(now + 3_600_000).toISOString();
      const inner = canonical(id, subject, nb, noa);
      const sig =
        `<ds:Signature><ds:SignedInfo><ds:SignatureMethod Algorithm="${SIG_RSA_SHA256}"/>` +
        `<ds:Reference URI="#${id}"><ds:DigestValue>${digest(inner)}</ds:DigestValue></ds:Reference>` +
        `</ds:SignedInfo><ds:SignatureValue>${sign(inner)}</ds:SignatureValue></ds:Signature>`;
      return `<samlp:Response>${inner.replace('</saml:Assertion>', `${sig}</saml:Assertion>`)}</samlp:Response>`;
    },
  };
}

/** Serve a synthetic IdP over HTTP: GET {url}?variant=valid → {certificatePem, assertion}. */
function serveIdp(idp: SyntheticIdp): Promise<{ server: Server; url: string }> {
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ certificatePem: idp.certificatePem, assertion: idp.mintValid('idp-op-8f3a') }));
  });
  return new Promise((r) =>
    server.listen(0, '127.0.0.1', () => r({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/idp` })),
  );
}

const idpA = makeIdp('urn:openwop:conformance:idp-A');
const idpB = makeIdp('urn:openwop:conformance:idp-B');

let BASE: string;
let server: Server;
let idpAServer: Server;
let idpBServer: Server;
let IDP_A_URL: string;
let IDP_B_URL: string;
const EXTERNAL_ID = 'idp-op-8f3a';

const JSON_HEADERS = { 'content-type': 'application/json' };
const post = (path: string, body: unknown): Promise<Response> =>
  fetch(`${BASE}${path}`, { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify(body) });

beforeAll(async () => {
  ({ server: idpAServer, url: IDP_A_URL } = await serveIdp(idpA));
  ({ server: idpBServer, url: IDP_B_URL } = await serveIdp(idpB));

  process.env.OPENWOP_STORAGE_DSN = 'memory://';
  process.env.OPENWOP_SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
  delete process.env.OPENWOP_TEST_SEAM_ENABLED; // prove the explicit alias, not the rewrite
  delete process.env.OPENWOP_SCIM_BEARER; // seam open + tenant-isolated to the caller
  delete process.env.OPENWOP_SCIM_IDP_ENTITY_ID; // trust root comes from the seam's idpUrl
  process.env.OPENWOP_TEST_SAML_IDP_URL = IDP_A_URL; // advertises openwop-auth-saml (trust root A)
  process.env.OPENWOP_TEST_SAML_IDP_URL_B = IDP_B_URL; // the cross-root collider (RFC 0163 §B)
  process.env.OPENWOP_TEST_SCIM_URL = 'http://scim.invalid/scim/v2'; // advertises openwop-auth-scim (never fetched)
  process.env.OPENWOP_SCIM_TENANT = 'scim-test'; // deterministic link-deny realm

  const app = await createApp({ port: 0, storageDsn: 'memory://', serviceName: 'test', serviceVersion: '0.0.1', enableConsoleTracer: false });
  await new Promise<void>((r) => { server = app.listen(0, '127.0.0.1', () => { BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; r(); }); });
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await new Promise<void>((r) => idpAServer.close(() => r()));
  await new Promise<void>((r) => idpBServer.close(() => r()));
  delete process.env.OPENWOP_TEST_SAML_IDP_URL_B;
});

describe('RFC 0159/0163 subject linking — advertisement', () => {
  it('claims subjectLinking + a closed-enum subjectLinkKey only alongside BOTH profiles', async () => {
    const res = await fetch(`${BASE}/.well-known/openwop`);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { capabilities?: { auth?: { profiles?: string[]; subjectLinking?: boolean; subjectLinkKey?: string } } };
    const auth = doc.capabilities?.auth;
    expect(auth?.profiles).toContain('openwop-auth-saml');
    expect(auth?.profiles).toContain('openwop-auth-scim');
    expect(auth?.subjectLinking).toBe(true);
    // RFC 0163 §A — a member of the closed safe-class enum; openwop-app is opaque-idp.
    expect(auth?.subjectLinkKey).toBe('opaque-idp');
    expect(['opaque-idp', 'configured-immutable']).toContain(auth?.subjectLinkKey);
  });
});

describe('RFC 0159 subject linking — cross-lane deactivation (§A.3)', () => {
  it('a SCIM deactivation fail-closes the LINKED SAML identity (over the sample alias)', async () => {
    // 1. Provision a SCIM user carrying the opaque externalId, bound to IdP-A.
    const provision = await post('/v1/host/sample/auth/scim/provision', {
      scimUrl: 'x', idpUrl: IDP_A_URL, op: 'create-user', externalId: EXTERNAL_ID, userName: 'r.smith',
    });
    expect(provision.status, `provision failed: ${provision.status}`).toBeLessThan(400);

    // 2. A valid SAML assertion from IdP-A (same trust root) authenticates BEFORE deactivation.
    const before = await post('/v1/host/sample/auth/saml/validate', { idpUrl: IDP_A_URL, variant: 'valid', nameId: EXTERNAL_ID });
    expect(before.status).toBe(200);
    const beforeBody = (await before.json()) as { authenticated?: boolean; linkedDenied?: boolean };
    expect(beforeBody.authenticated).toBe(true);
    expect(beforeBody.linkedDenied).toBe(false);

    // 3. SCIM-deactivate the provisioned user, addressed by externalId.
    const deactivate = await post('/v1/host/sample/auth/scim/provision', { scimUrl: 'x', op: 'deactivate-user', externalId: EXTERNAL_ID });
    expect(deactivate.status, `deactivate failed: ${deactivate.status}`).toBeLessThan(400);

    // 4. THE CONTRACT — a subsequent SAML assertion for the linked subject MUST NOT authenticate.
    const after = await post('/v1/host/sample/auth/saml/validate', { idpUrl: IDP_A_URL, variant: 'valid', nameId: EXTERNAL_ID });
    const afterBody = (await after.json()) as { authenticated?: boolean; linkedDenied?: boolean; reason?: string };
    expect(afterBody.authenticated === true).toBe(false);
    expect(afterBody.linkedDenied).toBe(true);
    expect(afterBody.reason).toBe('subject_linked_deactivated');
  });
});

describe('RFC 0159 subject linking — link-key hygiene (§A.2)', () => {
  it('rejects a mutable/PII link key (email) with 4xx and forms no cross-lane link', async () => {
    const link = await post('/v1/host/sample/auth/scim/provision', {
      scimUrl: 'x', op: 'link', linkKey: 'email', email: 'r.smith@example.test',
    });
    expect(link.status).toBeGreaterThanOrEqual(400);
    expect(link.status).toBeLessThan(500);

    // An unrelated opaque subject (no SCIM record) must NOT be denied — no link, so it authenticates.
    const other = await post('/v1/host/sample/auth/saml/validate', { idpUrl: IDP_A_URL, variant: 'valid', nameId: 'idp-op-DIFFERENT' });
    const body = (await other.json()) as { authenticated?: boolean; linkedDenied?: boolean };
    expect(body.linkedDenied === true).toBe(false);
    expect(body.authenticated).toBe(true);
  });
});

describe('RFC 0163 subject linking — same-IdP trust root (§B)', () => {
  it('a SAML assertion from the SAME IdP as the SCIM lane links + authenticates (positive control)', async () => {
    const sameId = 'idp-op-same-8f3a';
    const prov = await post('/v1/host/sample/auth/scim/provision', {
      scimUrl: 'x', idpUrl: IDP_A_URL, op: 'create-user', externalId: sameId, userName: 's.same',
    });
    expect(prov.status, `provision failed: ${prov.status}`).toBeLessThan(400);

    const res = await post('/v1/host/sample/auth/saml/validate', { idpUrl: IDP_A_URL, variant: 'valid', nameId: sameId });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { authenticated?: boolean; linkedDenied?: boolean };
    expect(body.authenticated).toBe(true);
    expect(body.linkedDenied).toBe(false);
  });

  it('a cross-IdP identifier collision MUST NOT authenticate (§B.1)', async () => {
    // SCIM record provisioned from IdP-A; a VALID assertion for the SAME opaque
    // id but issued by IdP-B (a different trust root). The string collides; the
    // trust roots do not — the link MUST NOT form.
    const collideId = 'idp-op-collide-8f3a';
    const prov = await post('/v1/host/sample/auth/scim/provision', {
      scimUrl: 'x', idpUrl: IDP_A_URL, op: 'create-user', externalId: collideId, userName: 'a.other',
    });
    expect(prov.status, `provision failed: ${prov.status}`).toBeLessThan(400);

    const res = await post('/v1/host/sample/auth/saml/validate', { idpUrl: IDP_B_URL, variant: 'valid', nameId: collideId });
    const body = (await res.json()) as { authenticated?: boolean; reason?: string; linkedDenied?: boolean };
    // Not a vacuous 403: the SSRF allowlist now includes IdP-B, so the assertion
    // reaches the trust-root check — the refusal is the load-bearing assertion.
    expect(res.status).toBe(401);
    expect(body.authenticated === true).toBe(false);
    expect(body.reason).toBe('subject_link_trust_root_mismatch');
    expect(body.linkedDenied).toBe(false);
  });
});

// ── RFC 0164 (ADR 0623) — the MANDATORY-both invariant ────────────────────────
// RFC 0164 makes the SCIM⟷SAML leaver contract MANDATORY: a host advertising BOTH
// `openwop-auth-saml` AND `openwop-auth-scim` MUST derive `subjectLinking:true` +
// `subjectLinkKey`, and (§A.2) MUST fail closed on the SAML lane for any subject
// it cannot link. "Both profiles + no subjectLinking" is a conformance FAILURE
// (was `inapplicable`). openwop-app enforces this STRUCTURALLY: the host drops
// `openwop-auth-scim` from discovery whenever the combined contract cannot be
// honoured for the deployment as a whole — either the realms MISALIGN or no
// SHARED TRUST ROOT is configurable for the SCIM lane — so it never advertises
// both profiles without the guarantee. The SAML lanes read the SAME
// `combinedSubjectLinkingActive()` predicate, so §A.2's `unbound` fail-closed and
// the advert can never disagree.
//
// WITNESS FORM: end-to-end against the real `${BASE}/.well-known/openwop` + the
// `sample` auth seams (the same surfaces every other leg drives).
// `advertisedAuthProfiles()` / `combinedSubjectLinkingActive()` read `process.env`
// per request, so each leg toggles the relevant env around a single call and
// restores it — no app restart. The two arms of the `aligned && trustRoot` gate
// are witnessed SEPARATELY so each is proven load-bearing on its own.
describe('RFC 0164 subject linking — mandatory-both invariant', () => {
  // A production SAML SP (samlSettings() non-null) whose tenant differs from
  // OPENWOP_SCIM_TENANT ('scim-test', file-level beforeAll) ⇒ realms MISALIGN.
  const PROD_SAML_ENV: Record<string, string> = {
    OPENWOP_SAML_IDP_SSO_URL: 'https://idp.example.test/sso',
    OPENWOP_SAML_IDP_CERT: 'MIIBdummyBase64CertBodyForSettingsResolutionOnly',
    OPENWOP_SAML_SP_ENTITY_ID: 'urn:openwop:app:sp',
    OPENWOP_SAML_ACS_URL: 'https://app.example.test/auth/saml/acs',
    OPENWOP_SAML_TENANT: 'tenant-a', // != 'scim-test' ⇒ realms MISALIGN
  };

  async function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
    const prior: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(overrides)) {
      prior[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      return await fn();
    } finally {
      for (const k of Object.keys(overrides)) {
        if (prior[k] === undefined) delete process.env[k];
        else process.env[k] = prior[k];
      }
    }
  }

  const readAuth = async (): Promise<{ profiles?: string[]; subjectLinking?: boolean; subjectLinkKey?: string }> => {
    const res = await fetch(`${BASE}/.well-known/openwop`);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { capabilities?: { auth?: { profiles?: string[]; subjectLinking?: boolean; subjectLinkKey?: string } } };
    return doc.capabilities?.auth ?? {};
  };

  it('(i) DROP-arm A — misaligned realms (trust-root seat present) ⇒ openwop-auth-scim DROPPED (born-red on origin/main)', async () => {
    // Trust-root seat present (OPENWOP_TEST_SCIM_URL, file-level); only the realms
    // misalign. This arm alone must drop SCIM.
    await withEnv(PROD_SAML_ENV, async () => {
      const auth = await readAuth();
      expect(auth.profiles).toContain('openwop-auth-saml'); // SAML (production login) kept
      expect(auth.profiles).not.toContain('openwop-auth-scim'); // never "both" without the guarantee
      expect(auth.subjectLinking).toBeUndefined();
      expect(auth.subjectLinkKey).toBeUndefined();
    });
  });

  it('(ii) DROP-arm B — aligned realms but NO trust-root seat ⇒ openwop-auth-scim DROPPED', async () => {
    // Realms align (no production SAML), SCIM still ADVERTISED (via a bearer), but
    // NO shared trust root is configurable (neither OPENWOP_SCIM_IDP_ENTITY_ID nor
    // the seam's OPENWOP_TEST_SCIM_URL). This arm alone must also drop SCIM.
    await withEnv(
      { OPENWOP_SCIM_BEARER: 'test-bearer-advertises-scim', OPENWOP_TEST_SCIM_URL: undefined, OPENWOP_SCIM_IDP_ENTITY_ID: undefined },
      async () => {
        const auth = await readAuth();
        expect(auth.profiles).toContain('openwop-auth-saml');
        expect(auth.profiles).not.toContain('openwop-auth-scim');
        expect(auth.subjectLinking).toBeUndefined();
        expect(auth.subjectLinkKey).toBeUndefined();
      },
    );
  });

  it('(iii) aligned realms + trust-root seat ⇒ BOTH profiles + subjectLinking:true + subjectLinkKey (born-green)', async () => {
    // The file's default posture: OPENWOP_TEST_SAML_IDP_URL (aligned, samlRealm
    // null) + OPENWOP_TEST_SCIM_URL (advertises SCIM AND supplies the trust root).
    const auth = await readAuth();
    expect(auth.profiles).toContain('openwop-auth-saml');
    expect(auth.profiles).toContain('openwop-auth-scim');
    expect(auth.subjectLinking).toBe(true);
    expect(auth.subjectLinkKey).toBe('opaque-idp');
  });

  it('(iv) §A.2 — an UNBOUND subject in a both-profiles deployment ⇒ SAML FAIL-CLOSED (subject_link_unbound)', async () => {
    // Default posture ⇒ combinedSubjectLinkingActive() === true. Provision a SCIM
    // record WITHOUT an idpUrl ⇒ no trust root recorded ⇒ evaluateSubjectLinkTrustRoot
    // returns 'unbound'. RFC 0164 removes 0163's deny-only carve-out here: refuse.
    const unboundId = 'idp-op-unbound-iv';
    const prov = await post('/v1/host/sample/auth/scim/provision', {
      scimUrl: 'x', op: 'create-user', externalId: unboundId, userName: 'u.unbound',
    });
    expect(prov.status, `provision failed: ${prov.status}`).toBeLessThan(400);

    const res = await post('/v1/host/sample/auth/saml/validate', { idpUrl: IDP_A_URL, variant: 'valid', nameId: unboundId });
    const body = (await res.json()) as { authenticated?: boolean; reason?: string; linkedDenied?: boolean };
    expect(res.status).toBe(401);
    expect(body.authenticated === true).toBe(false);
    // DISTINCT reason from the trust-root mismatch so logs tell them apart.
    expect(body.reason).toBe('subject_link_unbound');
    expect(body.linkedDenied).toBe(false);
  });

  it('(v) single-profile deployment + UNBOUND subject ⇒ RFC 0159 deny-only carve-out SURVIVES (authenticates)', async () => {
    // Drop the trust-root seat AND the SCIM advertisement (delete OPENWOP_TEST_SCIM_URL)
    // ⇒ single-profile deployment ⇒ combinedSubjectLinkingActive() === false. An
    // unbound subject (not deactivated) must fall through to 0159 deny-only and
    // authenticate — RFC 0164's fail-closed applies ONLY to combined deployments.
    const unboundId = 'idp-op-unbound-v';
    // Provision the unbound record while the sample alias is reachable (it is, env
    // -independent), then flip to single-profile for the SAML validate.
    const prov = await post('/v1/host/sample/auth/scim/provision', {
      scimUrl: 'x', op: 'create-user', externalId: unboundId, userName: 's.single',
    });
    expect(prov.status, `provision failed: ${prov.status}`).toBeLessThan(400);

    await withEnv({ OPENWOP_TEST_SCIM_URL: undefined, OPENWOP_SCIM_IDP_ENTITY_ID: undefined }, async () => {
      const res = await post('/v1/host/sample/auth/saml/validate', { idpUrl: IDP_A_URL, variant: 'valid', nameId: unboundId });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { authenticated?: boolean; linkedDenied?: boolean };
      expect(body.authenticated).toBe(true);
      expect(body.linkedDenied).toBe(false);
    });
  });
});
