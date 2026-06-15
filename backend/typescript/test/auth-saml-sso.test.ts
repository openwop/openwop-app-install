/**
 * Production SAML SSO — config/gating tests (ADR 0002 / RFC 0050).
 *
 * Covers the integration glue this app owns: the `OPENWOP_SAML_*` config parsing
 * (incl. bare-base64 → PEM cert normalization), the `samlConfigured()` gate, and
 * that every SP route 404s when SAML is not configured. The XML-DSig assertion
 * validation is `@node-saml/node-saml` (vetted upstream); the full signed-response
 * → session round-trip is exercised against a live IdP (Okta).
 */
import { afterEach, describe, expect, it, beforeAll, afterAll } from 'vitest';
import express, { type Express } from 'express';
import http from 'node:http';
import { samlSettings, samlConfigured } from '../src/host/auth/samlSso.js';
import { registerSamlSsoRoutes } from '../src/routes/authSamlSso.js';

const SAML_ENV = ['OPENWOP_SAML_IDP_SSO_URL', 'OPENWOP_SAML_IDP_CERT', 'OPENWOP_SAML_SP_ENTITY_ID', 'OPENWOP_SAML_ACS_URL', 'OPENWOP_SAML_TENANT'];
function clearSamlEnv() { for (const k of SAML_ENV) delete process.env[k]; }

function configureSaml() {
  process.env.OPENWOP_SAML_IDP_SSO_URL = 'https://example.okta.com/app/abc/sso/saml';
  process.env.OPENWOP_SAML_IDP_CERT = 'MIIBdummybase64certbodywithoutpemheaders0000000000';
  process.env.OPENWOP_SAML_SP_ENTITY_ID = 'https://app.openwop.dev/saml';
  process.env.OPENWOP_SAML_ACS_URL = 'https://app.openwop.dev/api/v1/host/openwop-app/auth/saml/sso/acs';
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
    expect(s!.idpCert).toContain('-----BEGIN CERTIFICATE-----');
    expect(s!.idpCert).toContain('-----END CERTIFICATE-----');
    expect(samlConfigured()).toBe(true);
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
    registerSamlSsoRoutes(app);
    app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const e = err as { httpStatus?: number; code?: string };
      res.status(e.httpStatus ?? 500).json({ error: e.code ?? 'internal_error' });
    });
    server = await new Promise<http.Server>((r) => { const s = app.listen(0, () => r(s)); });
    port = (server.address() as { port: number }).port;
  });
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); clearSamlEnv(); });

  it.each([
    ['GET', '/v1/host/openwop-app/auth/saml/sso/login'],
    ['GET', '/v1/host/openwop-app/auth/saml/sso/metadata'],
    ['POST', '/v1/host/openwop-app/auth/saml/sso/acs'],
  ])('%s %s → 404', async (method, path) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, redirect: 'manual' });
    expect(res.status).toBe(404);
  });
});
