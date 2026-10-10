/**
 * Production SAML SSO — config/gating tests (ADR 0002 / RFC 0050).
 *
 * Covers the integration glue this app owns: the `OPENWOP_SAML_*` config parsing
 * (incl. bare-base64 → 64-column PEM cert normalization), the `samlConfigured()`
 * gate, and that every SP route answers the host's canonical `not_found` envelope
 * when SAML is not configured — the "never claim SAML we can't back" posture. The
 * XML-DSig validation of a really-signed assertion is witnessed in
 * `adr0833-saml-hardening.test.ts`; the ACS decision path in
 * `auth-saml-disabled-user.test.ts` / `auth-saml-sso-trust-root.test.ts`.
 *
 * Sabotage that turns it red: `samlSso.ts` `if (t.includes('BEGIN CERTIFICATE')) return t;`
 * → `return t;` (PEM wrapping); deleting an `if (!s) throw new OpenwopError('not_found'`
 * guard in `authSamlSso.ts` (that route answers 400/500, not the not_found envelope).
 */
import { afterEach, describe, expect, it, beforeAll, afterAll } from 'vitest';
import express, { type Express } from 'express';
import http from 'node:http';
import { samlSettings, samlConfigured } from '../src/host/auth/samlSso.js';
import { registerSamlSsoRoutes } from '../src/routes/authSamlSso.js';
import { errorEnvelopeMiddleware } from '../src/middleware/errorEnvelope.js';

const SAML_ENV = ['OPENWOP_SAML_IDP_SSO_URL', 'OPENWOP_SAML_IDP_CERT', 'OPENWOP_SAML_SP_ENTITY_ID', 'OPENWOP_SAML_ACS_URL', 'OPENWOP_SAML_TENANT'];
function clearSamlEnv() { for (const k of SAML_ENV) delete process.env[k]; }
const SAVED_ENV = Object.fromEntries(SAML_ENV.map((k) => [k, process.env[k]]));
afterAll(() => {
  for (const k of SAML_ENV) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
});

function configureSaml() {
  process.env.OPENWOP_SAML_IDP_SSO_URL = 'https://example.okta.com/app/abc/sso/saml';
  process.env.OPENWOP_SAML_IDP_CERT = 'MIIBdummybase64certbodywithoutpemheaders0000000000';
  process.env.OPENWOP_SAML_SP_ENTITY_ID = 'https://app.openwop.dev/saml';
  process.env.OPENWOP_SAML_ACS_URL = 'https://app.openwop.dev/api/host/openwop-app/auth/saml/sso/acs';
  process.env.OPENWOP_SAML_TENANT = 'acme-corp';
}

describe('SAML SSO config + gating', () => {
  afterEach(() => clearSamlEnv());

  it('samlSettings() is null until all four required vars are set', () => {
    clearSamlEnv();
    expect(samlSettings()).toBeNull();
    expect(samlConfigured()).toBe(false);

    process.env.OPENWOP_SAML_IDP_SSO_URL = 'https://idp';
    expect(samlSettings()).toBeNull(); // still missing cert/issuer/acs
  });

  it('samlSettings() populates + normalizes a bare-base64 cert to PEM', () => {
    configureSaml();
    const s = samlSettings();
    expect(s).not.toBeNull();
    expect(s!.entryPoint).toBe('https://example.okta.com/app/abc/sso/saml');
    expect(s!.tenantId).toBe('acme-corp');
    // bare base64 → wrapped PEM
    expect(s!.idpCert).toBe('-----BEGIN CERTIFICATE-----\nMIIBdummybase64certbodywithoutpemheaders0000000000\n-----END CERTIFICATE-----');
    expect(samlConfigured()).toBe(true);
  });

  it('wraps a long single-line cert body at 64 columns (whitespace stripped)', () => {
    configureSaml();
    const body = 'A'.repeat(64) + 'B'.repeat(64) + 'C'.repeat(10);
    process.env.OPENWOP_SAML_IDP_CERT = `  ${body.slice(0, 70)} ${body.slice(70)}  `;
    expect(samlSettings()!.idpCert).toBe(
      `-----BEGIN CERTIFICATE-----\n${'A'.repeat(64)}\n${'B'.repeat(64)}\n${'C'.repeat(10)}\n-----END CERTIFICATE-----`,
    );
  });

  it('passes a full PEM cert through unchanged', () => {
    configureSaml();
    process.env.OPENWOP_SAML_IDP_CERT = '-----BEGIN CERTIFICATE-----\nMIIBpem\n-----END CERTIFICATE-----';
    expect(samlSettings()!.idpCert).toBe('-----BEGIN CERTIFICATE-----\nMIIBpem\n-----END CERTIFICATE-----');
  });

  it('defaults the tenant to `default` when OPENWOP_SAML_TENANT is unset', () => {
    configureSaml();
    delete process.env.OPENWOP_SAML_TENANT;
    expect(samlSettings()!.tenantId).toBe('default');
  });
});

describe('SAML SSO routes — 404 when unconfigured', () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    clearSamlEnv(); // SAML OFF
    const app: Express = express();
    app.use(express.json());
    registerSamlSsoRoutes(app);
    app.use(errorEnvelopeMiddleware());
    server = await new Promise<http.Server>((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    port = (server.address() as { port: number }).port;
  });
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); clearSamlEnv(); });

  it.each([
    ['GET', '/host/openwop-app/auth/saml/sso/login'],
    ['GET', '/host/openwop-app/auth/saml/sso/metadata'],
    ['POST', '/host/openwop-app/auth/saml/sso/acs'],
  ])('%s %s → 404 not_found envelope (the route refuses, not an unmatched path)', async (method, path) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, redirect: 'manual' });
    expect(res.status).toBe(404);
    // Express's own unmatched-route 404 is HTML; the canonical envelope proves the
    // route ran and its `samlSettings() === null` guard refused.
    expect(((await res.json()) as { error?: string }).error).toBe('not_found');
  });
});
