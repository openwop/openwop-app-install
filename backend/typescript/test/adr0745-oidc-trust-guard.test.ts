/**
 * ADR 0745 D4 — a Cloud Run service refuses to boot trusting the conformance
 * harness's OIDC issuer. The guard is a pure function of the env; the last leg pins
 * that `main()` actually calls it, because a guard nothing invokes is the
 * gate-that-cannot-fail this repo keeps rediscovering.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { oidcTrustRootStartupError } from '../src/host/oidcTrustGuard.js';

const PROD = {
  K_SERVICE: 'openwop-app-backend',
  OPENWOP_OIDC_ISSUER: 'https://securetoken.google.com/openwop-dev',
  OPENWOP_OIDC_AUDIENCE: 'openwop-dev',
  OPENWOP_OIDC_JWKS_URL: 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com',
};

describe('oidcTrustRootStartupError', () => {
  it('CONTROL: the production Firebase configuration boots', () => {
    expect(oidcTrustRootStartupError(PROD)).toBeNull();
  });

  it('off Cloud Run it never fires — the release-image lane trusts the harness by design', () => {
    const { K_SERVICE: _k, ...local } = PROD;
    expect(oidcTrustRootStartupError({ ...local, OPENWOP_OIDC_ISSUER: 'http://host.docker.internal:18102', OPENWOP_OIDC_AUDIENCE: 'openwop-conformance' })).toBeNull();
  });

  it.each([
    ['http issuer', { OPENWOP_OIDC_ISSUER: 'http://issuer.example.com' }],
    ['docker-host issuer', { OPENWOP_OIDC_ISSUER: 'https://host.docker.internal:18102' }],
    ['loopback issuer', { OPENWOP_OIDC_ISSUER: 'https://127.0.0.1:18102' }],
    ['private-range issuer', { OPENWOP_OIDC_ISSUER: 'https://10.1.2.3' }],
    ['IPv6 loopback issuer', { OPENWOP_OIDC_ISSUER: 'https://[::1]:8443' }],
    ['IPv4-mapped IPv6 loopback (URL normalises it to hex)', { OPENWOP_OIDC_ISSUER: 'https://[::ffff:127.0.0.1]' }],
    ['IPv4-mapped metadata address', { OPENWOP_OIDC_ISSUER: 'https://[::ffff:169.254.169.254]' }],
    ['CGNAT issuer', { OPENWOP_OIDC_ISSUER: 'https://100.64.0.1' }],
    ['site-local IPv6 issuer', { OPENWOP_OIDC_ISSUER: 'https://[fec0::1]' }],
    ['trailing-dot internal name', { OPENWOP_OIDC_ISSUER: 'https://metadata.google.internal.' }],
    ['single-label host', { OPENWOP_OIDC_ISSUER: 'https://metadata/' }],
    ['private JWKS url', { OPENWOP_OIDC_JWKS_URL: 'https://192.168.1.5/jwks.json' }],
    ['harness issuer env present', { OPENWOP_TEST_OIDC_ISSUER_URL: 'https://tunnel.example.com' }],
    ['harness host env present', { OPENWOP_CONFORMANCE_HARNESS_HOST: 'host.docker.internal' }],
    ['the suite audience', { OPENWOP_OIDC_AUDIENCE: 'openwop-conformance' }],
  ])('refuses on Cloud Run: %s', (_label, override) => {
    expect(oidcTrustRootStartupError({ ...PROD, ...override })).toMatch(/ADR 0745 D4/);
  });

  // ADR 0754 — "deployed" is not "Cloud Run". Each marker alone arms the guard.
  it.each([
    ['Kubernetes', { KUBERNETES_SERVICE_HOST: '10.96.0.1' }],
    ['Fly.io', { FLY_APP_NAME: 'acme-openwop' }],
    ['AWS ECS', { ECS_CONTAINER_METADATA_URI_V4: 'http://169.254.170.2/v4/x' }],
    ['AWS Lambda', { AWS_LAMBDA_FUNCTION_NAME: 'openwop' }],
    ['Azure App Service', { WEBSITE_SITE_NAME: 'openwop' }],
    ['Heroku', { DYNO: 'web.1' }],
    ['Render', { RENDER_SERVICE_ID: 'srv-1' }],
    ['Railway', { RAILWAY_ENVIRONMENT: 'production' }],
    ['the auth posture', { OPENWOP_DEPLOY_POSTURE: 'auth' }],
    ['a Postgres store', { OPENWOP_STORAGE_DSN: 'postgres://u:p@db/openwop' }],
  ])('refuses a harness issuer on %s, not only Cloud Run', (_label, marker) => {
    const { K_SERVICE: _k, ...offCloudRun } = PROD;
    expect(oidcTrustRootStartupError({ ...offCloudRun, ...marker, OPENWOP_OIDC_ISSUER: 'http://host.docker.internal:18102' })).toMatch(/ADR 0745 D4/);
    expect(oidcTrustRootStartupError({ ...offCloudRun, ...marker, OPENWOP_TEST_OIDC_ISSUER_URL: 'https://tunnel.example.com' })).toMatch(/ADR 0745 D4/);
  });

  it('CONTROL: the release-image lane (memory://, no platform marker) still boots with the harness issuer', () => {
    const { K_SERVICE: _k, ...local } = PROD;
    expect(oidcTrustRootStartupError({ ...local, OPENWOP_STORAGE_DSN: 'memory://', NODE_ENV: 'production', OPENWOP_OIDC_ISSUER: 'http://host.docker.internal:18102', OPENWOP_CONFORMANCE_HARNESS_HOST: 'host.docker.internal' })).toBeNull();
  });

  it('does not mistake a public hostname that merely starts with "fc"/"fd" for a private IPv6', () => {
    expect(oidcTrustRootStartupError({ ...PROD, OPENWOP_OIDC_ISSUER: 'https://fdauth.example.com' })).toBeNull();
  });

  it('main() calls it and exits on a refusal', () => {
    const src = readFileSync(resolve(import.meta.dirname, '..', 'src', 'index.ts'), 'utf8');
    const main = src.slice(src.indexOf('async function main('));
    expect(main).toMatch(/const trustRootError = oidcTrustRootStartupError\(\);\s*if \(trustRootError\) \{\s*log\.error\([^\n]*\);\s*process\.exit\(1\);/);
  });
});
