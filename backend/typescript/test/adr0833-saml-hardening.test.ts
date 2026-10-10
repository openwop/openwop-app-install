/**
 * ADR 0833 S5 / S6 — SAML hardening, against REAL node-saml validation of a
 * REALLY signed assertion (xml-crypto, RSA-SHA256, enveloped), not a mock.
 *
 * RED on `97baad74b`:
 *  - S6: the same signed IdP-initiated response was accepted twice (no
 *    assertion-ID one-time cache; `validateInResponseTo: ifPresent` skips the
 *    request-id cache when the UNSIGNED outer `InResponseTo` is absent);
 *  - S5: the RelayState / returnTo predicate accepted `/\evil.com`, which
 *    Express emits unchanged in `Location` and a browser resolves off-site.
 *
 * Each refusal is pinned to the HOST's own error message, so a throw from
 * somewhere else (node-saml, a TypeError) cannot stand in for the claim.
 * Sabotage that turns it red: `samlSso.ts` `if (!swapped) throw` → `if (false) throw`
 * (replay case); `if (!id) throw` → `if (false) throw` (no-ID case);
 * `safeRedirect.ts` drop `url.includes('\\') ||` (backslash cases + the login relay).
 * The KV fixture is a REAL in-memory sqlite `Storage`, not a cast stub.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { SignedXml } from 'xml-crypto';
import { samlValidate, type SamlSettings } from '../src/host/auth/samlSso.js';
import { registerSamlSsoRoutes } from '../src/routes/authSamlSso.js';
import { errorEnvelopeMiddleware } from '../src/middleware/errorEnvelope.js';
import { isSafeInAppPath } from '../src/host/safeRedirect.js';
import type { Storage } from '../src/storage/storage.js';
import { openSqliteStorage } from '../src/storage/sqlite/index.js';
import { protocolVersionMiddleware } from '../src/middleware/protocolVersion.js';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const SP = 'https://sp.adr0833.test/saml';
const ACS = 'https://sp.adr0833.test/acs';
const IDP = 'urn:idp:adr0833';

const settings: SamlSettings = {
  entryPoint: 'https://idp.adr0833.test/sso',
  issuer: SP,
  callbackUrl: ACS,
  idpCert: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  tenantId: 'adr0833-saml',
};

/** A fresh, real (in-memory sqlite) Storage — the production kv + CAS code path. */
function kvStore(): Storage {
  return openSqliteStorage(':memory:');
}

/** A signed IdP-initiated Response (no InResponseTo anywhere). */
function signedResponse(opts: { assertionId?: string | null } = {}): string {
  const now = new Date();
  const later = new Date(now.getTime() + 5 * 60_000).toISOString();
  const before = new Date(now.getTime() - 60_000).toISOString();
  const aid = opts.assertionId === undefined ? `_a${randomUUID().replace(/-/g, '')}` : opts.assertionId;
  const idAttr = aid === null ? '' : ` ID="${aid}"`;
  const assertion =
    `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"${idAttr} Version="2.0" IssueInstant="${now.toISOString()}">` +
    `<saml:Issuer>${IDP}</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified">adr0833-user</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${later}" Recipient="${ACS}"/></saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${before}" NotOnOrAfter="${later}"><saml:AudienceRestriction><saml:Audience>${SP}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${now.toISOString()}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:Password</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
    `</saml:Assertion>`;
  const xml =
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_r${randomUUID().replace(/-/g, '')}" Version="2.0" IssueInstant="${now.toISOString()}" Destination="${ACS}">` +
    `<saml:Issuer xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion">${IDP}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    assertion +
    `</samlp:Response>`;
  const sig = new SignedXml({
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
    canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
  });
  sig.addReference({
    xpath: "//*[local-name(.)='Assertion']",
    transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'],
    digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
  });
  sig.computeSignature(xml, { location: { reference: "//*[local-name(.)='Issuer' and parent::*[local-name(.)='Assertion']]", action: 'after' } });
  return Buffer.from(sig.getSignedXml()).toString('base64');
}

describe('S6 / D5 — every accepted assertion is single-use', () => {
  it('precondition: a fresh signed assertion validates (the fixture is real)', async () => {
    const id = await samlValidate(settings, signedResponse(), undefined, kvStore());
    expect(id.nameId).toBe('adr0833-user');
    expect(id.issuer).toBe(IDP);
  });

  it('the SAME response a second time is refused (IdP-initiated lane — no InResponseTo)', async () => {
    const storage = kvStore();
    const resp = signedResponse();
    await samlValidate(settings, resp, undefined, storage);
    await expect(samlValidate(settings, resp, undefined, storage)).rejects.toThrow(/already used/);
  });

  it('an assertion with no ID is refused (nothing to make single-use)', async () => {
    // xml-crypto stamps an `Id` for its reference when none exists; the
    // validator must refuse a missing SAML `ID` regardless of what signed.
    await expect(samlValidate(settings, signedResponse({ assertionId: null }), undefined, kvStore())).rejects.toThrow(/carries no ID/);
  });

  it('with no storage the ACS refuses rather than skipping the check', async () => {
    await expect(samlValidate(settings, signedResponse(), undefined, undefined)).rejects.toThrow(/needs durable storage/);
  });
});

describe('S5 / D5 — one safe-redirect predicate', () => {
  it.each(['/\\evil.com', '//evil.com', '/\\/evil.com', 'https://evil.com', 'javascript:alert(1)', '/ok\nLocation: x', ' /x'])(
    'rejects %j', (v) => { expect(isSafeInAppPath(v)).toBe(false); },
  );
  it.each(['/', '/dashboard', '/a/b?c=1#d'])('accepts %j', (v) => { expect(isSafeInAppPath(v)).toBe(true); });

  let server: http.Server;
  let BASE = '';
  beforeAll(async () => {
    process.env.OPENWOP_SAML_IDP_SSO_URL = settings.entryPoint;
    process.env.OPENWOP_SAML_IDP_CERT = 'MIIBdummybase64certbodywithoutpemheaders0000000000';
    process.env.OPENWOP_SAML_SP_ENTITY_ID = SP;
    process.env.OPENWOP_SAML_ACS_URL = ACS;
    const app = express();
    // The canonical `/host/…` root, through the SAME rewrite `createApp` uses (ADR 0671).
    app.use(protocolVersionMiddleware());
    registerSamlSsoRoutes(app);
    app.use(errorEnvelopeMiddleware());
    server = await new Promise<http.Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    BASE = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    for (const k of ['OPENWOP_SAML_IDP_SSO_URL', 'OPENWOP_SAML_IDP_CERT', 'OPENWOP_SAML_SP_ENTITY_ID', 'OPENWOP_SAML_ACS_URL']) delete process.env[k];
  });

  it('the SP-initiated login never relays a backslash path to the IdP', async () => {
    const res = await fetch(`${BASE}/host/openwop-app/auth/saml/sso/login?returnTo=${encodeURIComponent('/\\evil.com')}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    const relay = new URL(res.headers.get('location')!).searchParams.get('RelayState');
    expect(relay).toBe('/');
  });
});
