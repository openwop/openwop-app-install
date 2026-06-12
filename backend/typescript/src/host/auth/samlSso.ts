/**
 * Production SAML 2.0 Service Provider — real enterprise SSO (Okta / Azure AD /
 * Ping…), distinct from the conformance `samlValidationService` (which validates
 * the synthetic §A test assertions). This wires a REAL IdP via the vetted
 * `@node-saml/node-saml` library (proper XML-DSig: canonicalization, enveloped
 * signatures, the XSW defenses) — hand-rolling that is the classic SAML footgun.
 *
 * EASY ENABLEMENT (white-label / per-company): the SP is OFF until the four
 * `OPENWOP_SAML_*` env vars are set. When set, the host advertises
 * `openwop-auth-saml` in /.well-known/openwop and exposes the SP routes. A company
 * enabling Okta SSO does exactly two things: (1) create a SAML app in Okta using
 * this SP's metadata URL + ACS URL, (2) paste Okta's SSO URL + signing cert into
 * the env. See `.env.example` and DEPLOY.md.
 *
 * @see docs/adr/0002-users-authentication.md  @see ../openwop/RFCS/0050 (openwop-auth-saml)
 */
import { SAML, type SamlConfig } from '@node-saml/node-saml';

export interface SamlSettings {
  /** Okta SSO URL (where SP-initiated AuthnRequests go). */
  entryPoint: string;
  /** Our SP entity id (the SAML `issuer`/audience the IdP is configured with). */
  issuer: string;
  /** Our ACS URL (where the IdP POSTs the SAMLResponse). */
  callbackUrl: string;
  /** The IdP's signing certificate (X.509). */
  idpCert: string;
  /** Tenant SAML-authenticated users belong to (a white-label org tenant). */
  tenantId: string;
}

/** Wrap a bare base64 cert (env-friendly, single line) as PEM; pass full PEM through. */
function normalizeCert(raw: string): string {
  const t = raw.trim();
  if (t.includes('BEGIN CERTIFICATE')) return t;
  const body = t.replace(/\s+/g, '').match(/.{1,64}/g)?.join('\n') ?? t;
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----`;
}

/** The SAML SP config from env, or `null` when not configured (→ feature OFF,
 *  un-advertised, routes 404 — honest: never claim SAML we can't back). */
export function samlSettings(): SamlSettings | null {
  const entryPoint = process.env.OPENWOP_SAML_IDP_SSO_URL;
  const idpCert = process.env.OPENWOP_SAML_IDP_CERT;
  const issuer = process.env.OPENWOP_SAML_SP_ENTITY_ID;
  const callbackUrl = process.env.OPENWOP_SAML_ACS_URL;
  if (!entryPoint || !idpCert || !issuer || !callbackUrl) return null;
  return {
    entryPoint,
    issuer,
    callbackUrl,
    idpCert: normalizeCert(idpCert),
    tenantId: process.env.OPENWOP_SAML_TENANT ?? 'default',
  };
}

export function samlConfigured(): boolean {
  return samlSettings() !== null;
}

function client(s: SamlSettings): SAML {
  const cfg: SamlConfig = {
    idpCert: s.idpCert,
    issuer: s.issuer,
    callbackUrl: s.callbackUrl,
    entryPoint: s.entryPoint,
    audience: s.issuer,
    // Okta signs the ASSERTION by default; require it (the security guarantee).
    // The response wrapper signature is optional and IdP-dependent.
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    // Accept whatever NameID format the IdP is configured to send (email / unspecified).
    identifierFormat: null,
  };
  return new SAML(cfg);
}

/** SP-initiated: the Okta redirect URL carrying a (relay-stated) AuthnRequest. */
export async function samlAuthorizeUrl(s: SamlSettings, relayState: string): Promise<string> {
  return client(s).getAuthorizeUrlAsync(relayState, undefined, {});
}

export interface SamlIdentity {
  /** The IdP's stable subject (SAML NameID) — the durable User join key `saml:<nameId>`. */
  nameId: string;
  email?: string;
  displayName?: string;
  /** Raw IdP group attributes, verbatim (group→role mapping is ADR 0006). */
  groups: string[];
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}
function asGroups(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  return typeof v === 'string' ? [v] : [];
}

/** Validate a POSTed SAMLResponse (full XML-DSig via node-saml) and extract the
 *  identity. Throws on any invalid/forged/expired assertion. */
export async function samlValidate(
  s: SamlSettings,
  samlResponse: string,
  relayState?: string,
): Promise<SamlIdentity> {
  const { profile } = await client(s).validatePostResponseAsync({
    SAMLResponse: samlResponse,
    ...(relayState ? { RelayState: relayState } : {}),
  });
  if (!profile) throw new Error('SAML response carried no profile.');
  const a = profile as Record<string, unknown>;
  return {
    nameId: profile.nameID,
    email: profile.email ?? profile.mail ?? asString(a.email) ?? (profile.nameID.includes('@') ? profile.nameID : undefined),
    displayName: asString(a.displayName) ?? asString(a.name) ?? asString(a['urn:oid:2.16.840.1.113730.3.1.241']),
    groups: asGroups(a.groups ?? a.Groups ?? a['http://schemas.xmlsoap.org/claims/Group']),
  };
}

/** SP metadata XML — the company uploads this (or its URL) to Okta. */
export function samlMetadata(s: SamlSettings): string {
  return client(s).generateServiceProviderMetadata(null, null);
}
