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
import { SAML, ValidateInResponseTo, type SamlConfig, type CacheProvider, type CacheItem } from '@node-saml/node-saml';
import type { Storage } from '../../storage/storage.js';

/** How long a pending SP-initiated AuthnRequest id stays replay-valid. */
const SAML_REQUEST_TTL_MS = 10 * 60 * 1000;

/**
 * Durable, multi-instance-safe replay cache backing node-saml's
 * `validateInResponseTo` (SEC-1). The SP-initiated login mints an AuthnRequest
 * id here; the ACS rejects any `SAMLResponse` whose `InResponseTo` isn't a
 * known, unconsumed id — so a captured-and-replayed assertion fails even within
 * its signature-validity window. Backed by the shared kv Storage (NOT process
 * memory), so the request may be minted on one instance and consumed on
 * another (Cloud Run scale-out). Single-use: the id is removed on consume.
 */
/** The kv subset the replay cache needs — a full `Storage` satisfies it. */
type KvStore = Pick<Storage, 'kvGet' | 'kvSet' | 'kvDelete'>;

export function createSamlReplayCache(storage: KvStore): CacheProvider {
  const k = (key: string | null) => `saml:reqid:${key ?? ''}`;
  return {
    async saveAsync(key: string, value: string): Promise<CacheItem | null> {
      const item: CacheItem = { value, createdAt: Date.now() };
      await storage.kvSet(k(key), JSON.stringify(item));
      return item;
    },
    async getAsync(key: string): Promise<string | null> {
      const raw = await storage.kvGet(k(key));
      if (!raw) return null;
      let item: CacheItem;
      try {
        item = JSON.parse(raw) as CacheItem;
      } catch {
        return null;
      }
      if (Date.now() - item.createdAt > SAML_REQUEST_TTL_MS) {
        await storage.kvDelete(k(key));
        return null;
      }
      return item.value;
    },
    async removeAsync(key: string | null): Promise<string | null> {
      await storage.kvDelete(k(key));
      return key;
    },
  };
}

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

function client(s: SamlSettings, storage?: Storage): SAML {
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
    // Replay protection (SEC-1): when a durable cache is available, validate
    // the assertion's InResponseTo against minted-and-unconsumed AuthnRequest
    // ids. `ifPresent` (default) protects SP-initiated flows while letting
    // IdP-initiated flows (no InResponseTo) work. (2026-07 vuln-scan) A
    // deployment that does NOT use IdP-initiated SSO can set
    // OPENWOP_SAML_VALIDATE_INRESPONSETO=always for full replay protection —
    // then an assertion with no InResponseTo is rejected (an IdP-initiated
    // assertion has no single-use record, so its residual replay window within
    // NotOnOrAfter is closed). Follow-up: a durable per-assertion-ID one-time
    // cache would let IdP-initiated flows keep replay protection too.
    ...(storage
      ? {
          validateInResponseTo:
            process.env.OPENWOP_SAML_VALIDATE_INRESPONSETO === 'always'
              ? ValidateInResponseTo.always
              : ValidateInResponseTo.ifPresent,
          requestIdExpirationPeriodMs: SAML_REQUEST_TTL_MS,
          cacheProvider: createSamlReplayCache(storage),
        }
      : {}),
  };
  return new SAML(cfg);
}

/** SP-initiated: the Okta redirect URL carrying a (relay-stated) AuthnRequest.
 *  Pass `storage` so the minted AuthnRequest id is persisted for replay
 *  validation at the ACS (SEC-1). */
export async function samlAuthorizeUrl(s: SamlSettings, relayState: string, storage?: Storage): Promise<string> {
  return client(s, storage).getAuthorizeUrlAsync(relayState, undefined, {});
}

export interface SamlIdentity {
  /** The IdP's stable subject (SAML NameID) — the durable User join key `saml:<nameId>`. */
  nameId: string;
  email?: string;
  displayName?: string;
  /** Raw IdP group attributes, verbatim (group→role mapping is ADR 0006). */
  groups: string[];
  /** The assertion's AuthnContextClassRef, when present (grade-pass SEC-G2) —
   *  lets the host judge whether the IdP sign-in was multi-factor instead of
   *  assuming it. Extracted from the validated assertion XML (node-saml does
   *  not surface it as a first-class field). */
  authnContextClassRef?: string;
  /** RFC 0163 §B — the assertion's `<saml:Issuer>` entityID (the SAML lane's
   *  trust-root identity). The ACS compares this against the SCIM connection's
   *  bound entityID before honouring a cross-lane link. Extracted from the
   *  VALIDATED assertion XML — node-saml has already verified the signature that
   *  covers this element, so the issuer cannot have been swapped post-signing. */
  issuer?: string;
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
  storage?: Storage,
): Promise<SamlIdentity> {
  const { profile } = await client(s, storage).validatePostResponseAsync({
    SAMLResponse: samlResponse,
    ...(relayState ? { RelayState: relayState } : {}),
  });
  if (!profile) throw new Error('SAML response carried no profile.');
  const a = profile as Record<string, unknown>;
  const getXml = (profile as { getAssertionXml?: () => string }).getAssertionXml;
  const assertionXml = typeof getXml === 'function' ? getXml.call(profile) : undefined;
  const acr = assertionXml
    ? /<(?:\w+:)?AuthnContextClassRef[^>]*>([^<]+)</.exec(assertionXml)?.[1]?.trim()
    : undefined;
  // RFC 0163 §B — the signed `<saml:Issuer>` (IdP entityID). node-saml also
  // exposes it on the profile as `issuer`; prefer that, fall back to the
  // validated assertion XML.
  const issuer =
    asString((a as { issuer?: unknown }).issuer) ??
    (assertionXml ? /<(?:\w+:)?Issuer[^>]*>([^<]+)</.exec(assertionXml)?.[1]?.trim() : undefined);
  return {
    ...(acr ? { authnContextClassRef: acr } : {}),
    ...(issuer ? { issuer } : {}),
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
