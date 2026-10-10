/**
 * ADR 0841 D2 — principals stay unqualified (`oidc:<sub>`, `saml:<NameID>`,
 * `scim:<userName>`) ONLY because each protocol has exactly one IdP per host.
 * This ratchet pins that invariant: the IdP configuration surface is exactly
 * these env names, and nothing stores per-tenant SSO / IdP connections. Adding
 * a second issuer or a stored IdP makes the same principal string able to name
 * two humans (CONNCD-15) — so it fails here, pointing at ADR 0841 D3, instead of
 * shipping silently.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dirname, '../src');

const PINNED_IDP_ENV = [
  'OPENWOP_OIDC_AUDIENCE', 'OPENWOP_OIDC_ISSUER', 'OPENWOP_OIDC_JWKS_URL',
  'OPENWOP_SAML_ACS_URL', 'OPENWOP_SAML_ASSUME_MFA', 'OPENWOP_SAML_IDP_CERT', 'OPENWOP_SAML_IDP_ENTITY_ID',
  'OPENWOP_SAML_IDP_SSO_URL', 'OPENWOP_SAML_SP_ENTITY_ID', 'OPENWOP_SAML_TENANT', 'OPENWOP_SAML_VALIDATE_INRESPONSETO',
  'OPENWOP_SCIM_BEARER', 'OPENWOP_SCIM_IDP_ENTITY_ID', 'OPENWOP_SCIM_TENANT',
].sort();

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}
const files = sourceFiles(SRC).map((p) => ({ p, text: readFileSync(p, 'utf8') }));

describe('ADR 0841 D2 — one IdP per protocol per host', () => {
  it('the IdP configuration surface is exactly the pinned env names', () => {
    const found = new Set<string>();
    for (const { text } of files) {
      for (const m of text.matchAll(/process\.env(?:\.|\[['"])(OPENWOP_(?:OIDC|SAML|SCIM)_[A-Z0-9_]+)/g)) found.add(m[1]!);
    }
    expect(
      [...found].sort(),
      'A new OIDC/SAML/SCIM config input appeared. If it adds a SECOND issuer or a per-tenant IdP, ' +
        'unqualified principals can now name two humans: implement ADR 0841 D3 in this change. ' +
        'If it is a single-IdP knob, re-pin it here and say so in the ADR.',
    ).toEqual(PINNED_IDP_ENV);
  });

  it('no durable collection stores SSO / IdP connection settings', () => {
    const offenders: string[] = [];
    for (const { p, text } of files) {
      for (const m of text.matchAll(/new DurableCollection<[^>]*>\(\s*['"]([^'"]+)['"]/g)) {
        if (/(sso|idp|saml|oidc)[-:_.]?(config|connection|setting|provider)/i.test(m[1]!)) offenders.push(`${p.slice(SRC.length + 1)}: ${m[1]}`);
      }
    }
    expect(offenders, 'A stored IdP/SSO connection makes per-tenant IdPs possible — ADR 0841 D3 first.').toEqual([]);
  });
});
