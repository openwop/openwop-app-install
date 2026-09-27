/**
 * RFC 0154 §A/§B — workload identity and the delegated actor chain (ADR 0556 P3).
 *
 * The machine-caller counterpart of `middleware/auth.ts`. A *workload* (a
 * background worker, a peer service, a CI job) proves which workload it is; this
 * module verifies that proof, binds it to the request, checks the audience and
 * the delegation chain, and resolves it to an OpenWOP principal with bounded
 * scopes — **before** any authorization decision, and **failing closed** on
 * every error.
 *
 * ── The one rule that governs the shape ─────────────────────────────────────
 * **Identity is not authorization** (RFC 0147 R12, `spec/v1/auth.md`
 * §"Workload identity and delegated actor chain"). Nothing here grants anything.
 * A `ResolvedWorkloadPrincipal` says *who called*; `protocolAuthorization.ts` and
 * RFC 0049 still decide *what they may do*, at every boundary, afterwards. The
 * delegation chain in particular is **provenance**: a hop that would not be
 * authorized on its own does not become authorized by appearing in a chain.
 *
 * ── Two entry points, and why the split is load-bearing ─────────────────────
 * Verification and resolution are DELIBERATELY separate functions:
 *
 *   `verifyWorkloadCredential(token)`  — cryptographic. Takes a presented
 *       credential (a compact JWS), verifies its signature against a configured
 *       trust root's key, checks `exp`/`nbf`/`aud`, and PROJECTS the closed
 *       `WorkloadIdentity` object `schemas/workload-identity.schema.json`
 *       describes. Credential material never leaves this function.
 *
 *   `resolveWorkloadIdentity(identity, provenance)` — policy. Takes an ALREADY
 *       PROJECTED identity and applies §A's binding rules and §B's chain rules,
 *       ending at a principal or a closed refusal.
 *
 * The split exists because the projected object carries no proof — by design,
 * since it reaches events, spans and audit records where credential material
 * must never go. That makes the projection **unverifiable on its own**, so
 * `resolveWorkloadIdentity` cannot be handed caller-controlled input. It takes a
 * `provenance` argument naming where the projection came from, and there are
 * exactly two admissible sources:
 *
 *   - `'verified-credential'` — produced by `verifyWorkloadCredential` above;
 *   - `'test-seam'` — the RFC 0154 §20 conformance seam, which is refused
 *     outright unless `OPENWOP_TEST_SEAM_ENABLED=true` (off in production).
 *
 * A forwarded identity HEADER is not on that list, and that is the point:
 * `auth.md` §A calls forwarded identity headers attacker-controlled unless the
 * terminator is a configured-trusted one. This host configures no such
 * terminator, so it accepts no such header — the check is structural rather than
 * a rule someone has to remember.
 *
 * ── What this host honestly claims ──────────────────────────────────────────
 * `schemes[]` is DERIVED from the configured trust roots (see
 * `advertisedWorkloadSchemes`), never a literal. A scheme is claimed iff a root
 * that can verify it is configured. `mtls-san` and `cloud-subject` are therefore
 * unclaimable here: this host terminates no client certificates and performs no
 * cloud attestation. `senderConstraint[]` is likewise the configured set, empty
 * by default — and per §C an empty array IS the explicit bearer-fallback
 * advertisement, which is why the advert emits it rather than omitting it.
 *
 * @see spec/v1/auth.md §"Workload identity and delegated actor chain"
 * @see spec/v1/host-sample-test-seams.md §20
 * @see schemas/workload-identity.schema.json
 * @see docs/adr/0556-production-metrics-workload-identity-and-assurance-operations.md (P3)
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { resolveSecret } from '../byok/secretResolver.js';
import { readSessionSecret } from '../middleware/cookieSession.js';
import { PROTOCOL_SCOPES, type Scope } from './accessControlService.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.workload-identity');

// ── The wire projection (schemas/workload-identity.schema.json) ─────────────

/** RFC 0154 §A — closed. An unrecognized scheme is a verification path nobody
 *  implemented, and accepting the NAME without the verification is the failure
 *  the profile exists to prevent. */
export const WORKLOAD_IDENTITY_SCHEMES = ['spiffe', 'mtls-san', 'cloud-subject', 'oauth-client'] as const;
export type WorkloadIdentityScheme = (typeof WORKLOAD_IDENTITY_SCHEMES)[number];

/** RFC 0154 §D — the issuer *class*, never the issuer URL (`observability.md`
 *  §"Identity and delegation attributes"). A URL identifies a deployment; the
 *  class is what an audit fact may carry. */
export const ISSUER_CLASSES = ['spiffe', 'mtls', 'cloud', 'oauth', 'oidc', 'api-key', 'anonymous'] as const;
export type IssuerClass = (typeof ISSUER_CLASSES)[number];

export type SenderConstraintMethod = 'mtls' | 'dpop';

/** One verified hop. `subject` is opaque; a hop carries nothing else because a
 *  hop that carried a proof would put the proof into every record it reaches. */
export interface DelegationHop {
  readonly subject: string;
  readonly issuer?: string;
  /** RFC 0154 §B — the effective scopes VERIFIED for this hop. Provenance, not
   *  authorization: the resolved principal's own scopes still decide. When two
   *  consecutive hops both carry scopes, the later MUST NOT exceed the earlier. */
  readonly scopes?: readonly string[];
}

/** RFC 0154 §B — the verified delegation context, if any. */
export interface DelegationContext {
  readonly chain: readonly DelegationHop[];
  readonly audience: string;
  readonly expiresAt?: string;
  readonly proofRef?: string;
}

/**
 * RFC 0154 §A — an authenticated workload identity, as projected onto the wire.
 *
 * Closed by construction, mirroring the schema: raw certificates, tokens,
 * proofs and credentials MUST NOT enter this object. `subject` is an OPAQUE
 * verified identifier and `proofRef` / `thumbprintRef` are digest REFERENCES.
 */
export interface WorkloadIdentity {
  readonly scheme: WorkloadIdentityScheme;
  readonly subject: string;
  readonly issuer?: string;
  readonly audience?: string;
  readonly keyBinding?: { readonly method: SenderConstraintMethod; readonly thumbprintRef?: string };
  readonly delegation?: DelegationContext;
  /** RFC 0154 §B — the principal the actor acts for. NEVER self-asserted: it
   *  reaches this object only from claims `verifyWorkloadCredential` checked a
   *  signature over, and `resolveInner` refuses it outright on any projection
   *  whose provenance is not `'verified-credential'`. */
  readonly onBehalfOf?: { readonly principalId: string; readonly kind: 'user' | 'agent' | 'service' };
}

// ── Refusals ───────────────────────────────────────────────────────────────

/**
 * The CLOSED wire vocabulary (`host-sample-test-seams.md` §20). Five codes, and
 * a refusal is always non-retriable: an identity that does not resolve will not
 * resolve on retry, and marking it retriable invites a caller to hammer a
 * failing authorization path.
 */
export const WORKLOAD_REFUSAL_REASONS = [
  'identity_unverified',
  'identity_unresolvable',
  'audience_mismatch',
  'delegation_expired',
  'sender_constraint_missing',
  // RFC 0154 §B / `auth.md` §"Bounds" — the three chain-bound refusals, added
  // to the seam's closed set on 2026-08-16 (`host-sample-test-seams.md` §20).
  // Before this they collapsed into `identity_unverified`, which is a true
  // statement that hides WHICH bound the chain broke — and the bound is the
  // fact a peer needs to repair its chain.
  'delegation_chain_too_long',
  'delegation_chain_cyclic',
  'delegation_scope_amplified',
] as const;
export type WorkloadRefusalReason = (typeof WORKLOAD_REFUSAL_REASONS)[number];

/**
 * The INTERNAL cause, which is finer than the wire vocabulary and stays inside
 * the host.
 *
 * The two are separate on purpose. §20 pins the wire codes to five, so a chain
 * cycle and an unknown issuer both leave as `identity_unverified` — but an
 * operator debugging a refusal needs to know which, and a test asserting "the
 * cycle guard fired" must not be satisfiable by any other refusal. The cause is
 * the assertable fact; the reason is the wire fact. `CAUSE_TO_REASON` is the one
 * mapping between them, so no call site invents its own.
 */
export const WORKLOAD_REFUSAL_CAUSES = [
  'profile_disabled',
  'projection_unverified',
  'malformed_identity',
  'credential_invalid',
  'credential_expired',
  'scheme_unadvertised',
  'issuer_unknown',
  'audience_absent',
  'audience_mismatch',
  'sender_constraint_missing',
  'delegation_audience_mismatch',
  'delegation_expired',
  'delegation_no_expiry',
  'chain_too_deep',
  'chain_cycle',
  'chain_issuer_unknown',
  'scope_amplification',
  'self_asserted_on_behalf_of',
  'tenant_mismatch',
  'subject_unmapped',
] as const;
export type WorkloadRefusalCause = (typeof WORKLOAD_REFUSAL_CAUSES)[number];

const CAUSE_TO_REASON: Readonly<Record<WorkloadRefusalCause, WorkloadRefusalReason>> = {
  profile_disabled: 'identity_unresolvable',
  projection_unverified: 'identity_unverified',
  malformed_identity: 'identity_unverified',
  credential_invalid: 'identity_unverified',
  credential_expired: 'identity_unverified',
  scheme_unadvertised: 'identity_unverified',
  issuer_unknown: 'identity_unverified',
  audience_absent: 'audience_mismatch',
  audience_mismatch: 'audience_mismatch',
  sender_constraint_missing: 'sender_constraint_missing',
  delegation_audience_mismatch: 'audience_mismatch',
  delegation_expired: 'delegation_expired',
  // A delegation with no expiry is a STANDING GRANT, which is not what
  // delegation means (`auth.md` §B). This host takes the SHOULD-refuse branch,
  // and reports it as the expiry failure it is.
  delegation_no_expiry: 'delegation_expired',
  chain_too_deep: 'delegation_chain_too_long',
  chain_cycle: 'delegation_chain_cyclic',
  chain_issuer_unknown: 'identity_unverified',
  scope_amplification: 'delegation_scope_amplified',
  self_asserted_on_behalf_of: 'identity_unverified',
  // Neutralization WITHOUT disclosure (RFC 0132 §A.2, `auth.md` §B): a chain
  // asserting a tenant the principal is not bound to must not reveal whether
  // that tenant exists, so it leaves as the same generic refusal an unmapped
  // subject produces.
  tenant_mismatch: 'identity_unresolvable',
  subject_unmapped: 'identity_unresolvable',
};

/** `match` | `mismatch` | `absent` — the §D audit fact's audience decision. */
export type AudienceDecision = 'match' | 'mismatch' | 'absent';

export interface ResolvedWorkloadPrincipal {
  /**
   * The OpenWOP principal the identity mapped to. OPAQUE, and never the
   * presented `subject` verbatim: it is `workload:<scheme>:<salted-hash>` under
   * the tenant's rotatable salt, so an audit reader can correlate two facts
   * about one workload without the subject ever being recorded.
   */
  readonly principalId: string;
  readonly tenantId: string;
  /** Bounded authority. Always a subset of the trust root's scopes — a
   *  credential asking for more is `scope_amplification`, never a truncation. */
  readonly scopes: readonly Scope[];
  readonly scheme: WorkloadIdentityScheme;
  readonly issuerClass: IssuerClass;
  /** Hop count in the verified chain; `0` when there is none. The chain itself
   *  is never recorded (`observability.md`: "The chain itself is never an
   *  attribute"). */
  readonly delegationDepth: number;
  readonly senderConstraint: SenderConstraintMethod | 'none';
  readonly audienceDecision: AudienceDecision;
  /** Opaque, hashed. Present only when a verified delegation carried one. */
  readonly onBehalfOf?: string;
  readonly expiresAt?: string;
}

export type WorkloadIdentityResolution =
  | { readonly ok: true; readonly principal: ResolvedWorkloadPrincipal }
  | { readonly ok: false; readonly reason: WorkloadRefusalReason; readonly cause: WorkloadRefusalCause };

function refuse(cause: WorkloadRefusalCause): WorkloadIdentityResolution {
  return { ok: false, reason: CAUSE_TO_REASON[cause], cause };
}

// ── Configuration ──────────────────────────────────────────────────────────

/**
 * A configured trust root: an issuer this host will believe, the scheme it
 * issues, the tenant its workloads bind to, and the CEILING on the authority any
 * credential from it may carry.
 */
export interface WorkloadTrustRoot {
  readonly issuer: string;
  readonly scheme: WorkloadIdentityScheme;
  readonly issuerClass: IssuerClass;
  /**
   * `'root'` — the tenant is fixed by configuration, and a credential asserting
   * a different one is neutralized. `'credential'` — the tenant rides the
   * SIGNED claims, which only the host's own issuer may do, because only it
   * signs with a key nobody else holds.
   */
  readonly tenantBinding: 'root' | 'credential';
  readonly tenantId?: string;
  /** The authority ceiling. A credential's requested scopes must be a SUBSET. */
  readonly scopes: readonly Scope[];
  /** BYOK credentialRef holding the HS256 verification key for credentials this
   *  root issues. Absent ⇒ this host cannot verify a presented credential from
   *  the root, so `verifyWorkloadCredential` refuses one. */
  readonly keyRef?: string;
}

export interface WorkloadIdentityConfig {
  /** The audience this host answers to. An identity minted for anything else is
   *  refused: accepting one is how a credential valid elsewhere becomes a
   *  credential valid here. */
  readonly audience: string;
  /** The issuer name on credentials THIS host mints for its own workers. */
  readonly hostIssuer: string;
  readonly maxChainDepth: number;
  readonly roots: ReadonlyMap<string, WorkloadTrustRoot>;
  /** What this host requires as proof-of-possession. EMPTY by default, and per
   *  §C an empty array is the explicit, policy-controlled bearer-fallback
   *  advertisement — not an omission. */
  readonly senderConstraints: readonly SenderConstraintMethod[];
}

/** Default hop ceiling. Four is enough for user → gateway → dispatcher →
 *  worker, and a chain longer than that is not provenance anyone audits. */
const DEFAULT_MAX_CHAIN_DEPTH = 4;

/** Scopes a HOST-MINTED worker credential may ever carry.
 *
 *  Deliberately a subset of `PROTOCOL_SCOPES` and deliberately excluding every
 *  `host:` management scope: a background worker re-dispatching an orphaned run
 *  needs to read and execute, never to administer an org. The ceiling is here,
 *  in one place, so a mint site cannot widen it. */
export const HOST_WORKER_SCOPES: readonly Scope[] = ['manifest:read', 'runs:read', 'runs:create', 'artifacts:read'];

function parseScopes(raw: unknown, where: string): readonly Scope[] {
  if (!Array.isArray(raw)) return [];
  const known = new Set<string>(PROTOCOL_SCOPES);
  const out: Scope[] = [];
  for (const s of raw) {
    if (typeof s !== 'string') continue;
    // Closed-world: an unknown scope string is dropped rather than carried, so a
    // typo in operator config can never mint authority the host does not model.
    if (!known.has(s)) {
      log.warn('workload_identity_unknown_scope_dropped', { where, scope: s });
      continue;
    }
    out.push(s as Scope);
  }
  return out;
}

function parseTrustRoots(raw: string | undefined): WorkloadTrustRoot[] {
  if (!raw?.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.error('workload_identity_trust_parse_failed', { error: err instanceof Error ? err.message : String(err) });
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const roots: WorkloadTrustRoot[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const issuer = typeof e.issuer === 'string' ? e.issuer.trim() : '';
    const scheme = e.scheme;
    if (!issuer || typeof scheme !== 'string' || !(WORKLOAD_IDENTITY_SCHEMES as readonly string[]).includes(scheme)) {
      log.error('workload_identity_trust_root_rejected', { reason: 'issuer or scheme missing/unknown' });
      continue;
    }
    const tenantId = typeof e.tenantId === 'string' && e.tenantId ? e.tenantId : undefined;
    if (!tenantId) {
      // An external root with no tenant cannot bind its workloads to anything,
      // and a root that binds to nothing is a root that binds to everything.
      log.error('workload_identity_trust_root_rejected', { reason: 'external root has no tenantId' });
      continue;
    }
    const issuerClass = typeof e.issuerClass === 'string' && (ISSUER_CLASSES as readonly string[]).includes(e.issuerClass)
      ? (e.issuerClass as IssuerClass)
      : classFor(scheme as WorkloadIdentityScheme);
    roots.push({
      issuer,
      scheme: scheme as WorkloadIdentityScheme,
      issuerClass,
      tenantBinding: 'root',
      tenantId,
      scopes: parseScopes(e.scopes, issuer),
      keyRef: typeof e.keyRef === 'string' && e.keyRef ? e.keyRef : undefined,
    });
  }
  return roots;
}

function classFor(scheme: WorkloadIdentityScheme): IssuerClass {
  switch (scheme) {
    case 'spiffe':
      return 'spiffe';
    case 'mtls-san':
      return 'mtls';
    case 'cloud-subject':
      return 'cloud';
    case 'oauth-client':
      return 'oauth';
  }
}

/**
 * Sender-constraint methods this host can actually VERIFY.
 *
 * Empty, and that is the honest value: `keyBinding` is only ever READ
 * (`:774`, `middleware/workloadIdentity.ts:123`). The single place it can be
 * SET is the RFC 0154 §20 test seam, which takes it from the request body —
 * `verifyWorkloadCredential` never populates it, because no DPoP proof or mTLS
 * client-certificate verifier exists here. Cloud Run does not terminate client
 * certs, so DPoP is the realistic first entry.
 *
 * Adding a verifier is what lifts the refusal below: put its method here in the
 * same change, and `sender-constraint-config.test.ts` will stop expecting a
 * throw.
 */
const IMPLEMENTED_SENDER_CONSTRAINTS: readonly SenderConstraintMethod[] = [];

/**
 * Thrown at config-read time when the operator asks for a constraint this host
 * cannot verify. Fail-closed on purpose — see `parseSenderConstraints`.
 */
export class UnverifiableSenderConstraintError extends Error {}

function parseSenderConstraints(raw: string | undefined): readonly SenderConstraintMethod[] {
  if (!raw?.trim()) return [];
  const out: SenderConstraintMethod[] = [];
  for (const part of raw.split(',').map((p) => p.trim()).filter(Boolean)) {
    if (part === 'mtls' || part === 'dpop') out.push(part);
    else log.error('workload_identity_sender_constraint_rejected', { value: part });
  }

  // REFUSE rather than advertise something we cannot honour (2026-08-18) —
  // but only where nothing could satisfy it.
  //
  // Accepting it in production advertises
  // `auth.workloadIdentity.senderConstraint: ['dpop']` on the wire while
  // `verifyWorkloadCredential` never sets `keyBinding`, so §C's check at :774
  // refuses EVERY verified credential with `sender_constraint_missing` — a wire
  // claim the host cannot meet AND a self-inflicted outage, discovered only by
  // whoever set the variable. Silently downgrading to `[]` would be the same
  // class as a config that lies: the operator asked for a constraint, got
  // bearer, and the advert agreed with the wrong one.
  //
  // The RFC 0154 §20 seam is the ONE caller that can present a `keyBinding`
  // (it takes the identity from the request body), which is how §C's
  // enforcement path is legitimately exercised. So the rule is not "never
  // configure a constraint" — it is "do not configure one where nothing can
  // satisfy it". With the seam off, that is exactly the production case.
  const unverifiable =
    process.env.OPENWOP_TEST_SEAM_ENABLED === 'true'
      ? []
      : out.filter((m) => !IMPLEMENTED_SENDER_CONSTRAINTS.includes(m));
  if (unverifiable.length > 0) {
    throw new UnverifiableSenderConstraintError(
      `OPENWOP_WORKLOAD_IDENTITY_SENDER_CONSTRAINTS requests ${unverifiable.join(', ')}, which this host cannot verify: `
        + 'no DPoP or mTLS verifier is implemented, so `keyBinding` is never populated on a verified credential and '
        + 'every request would be refused with `sender_constraint_missing`. RFC 0154 §C makes sender constraint a '
        + 'SHOULD and an empty set the conformant bearer-fallback advertisement — leave it unset until a verifier '
        + 'lands (add its method to IMPLEMENTED_SENDER_CONSTRAINTS in the same change). The RFC 0154 §20 test '
        + 'seam can present a keyBinding, so this is configurable with OPENWOP_TEST_SEAM_ENABLED=true — which '
        + 'is not a production posture.',
    );
  }
  return out;
}

/**
 * Read the profile's configuration, or `null` when it is not configured.
 *
 * `null` is what makes the advertisement honest: the same predicate gates the
 * capability, the middleware and the seam, so a deployment that has not
 * configured an audience claims nothing, verifies nothing, and 404s the seam —
 * the `readOidcConfigFromEnv()` pattern one profile over.
 *
 * Read per call (env-driven, like the OIDC config) rather than cached at module
 * scope, so a test can configure the profile without re-importing the module.
 */
export function readWorkloadIdentityConfigFromEnv(): WorkloadIdentityConfig | null {
  const audience = process.env.OPENWOP_WORKLOAD_IDENTITY_AUDIENCE?.trim();
  if (!audience) return null;
  const hostIssuer = process.env.OPENWOP_WORKLOAD_IDENTITY_ISSUER?.trim() || 'urn:openwop:workload-issuer';
  const depthRaw = Number(process.env.OPENWOP_WORKLOAD_IDENTITY_MAX_CHAIN_DEPTH ?? DEFAULT_MAX_CHAIN_DEPTH);
  const maxChainDepth = Number.isInteger(depthRaw) && depthRaw >= 1 ? depthRaw : DEFAULT_MAX_CHAIN_DEPTH;

  const roots = new Map<string, WorkloadTrustRoot>();
  // The host's OWN issuer is always a root, and it is the only one permitted to
  // carry its tenant in the credential: it is the only issuer whose signing key
  // this host holds, so a claim it signed is a claim it made.
  roots.set(hostIssuer, {
    issuer: hostIssuer,
    scheme: 'oauth-client',
    issuerClass: 'oauth',
    tenantBinding: 'credential',
    scopes: HOST_WORKER_SCOPES,
    keyRef: HOST_SIGNING_KEY_REF,
  });
  for (const root of parseTrustRoots(process.env.OPENWOP_WORKLOAD_IDENTITY_TRUST)) {
    if (root.issuer === hostIssuer) {
      log.error('workload_identity_trust_root_rejected', { reason: 'an external root may not shadow the host issuer' });
      continue;
    }
    roots.set(root.issuer, root);
  }

  return {
    audience,
    hostIssuer,
    maxChainDepth,
    roots,
    senderConstraints: parseSenderConstraints(process.env.OPENWOP_WORKLOAD_IDENTITY_SENDER_CONSTRAINTS),
  };
}

/** True when the profile is configured — the single predicate the advert, the
 *  middleware and the seam all read, so they can never disagree. */
export function isWorkloadIdentityEnabled(): boolean {
  return readWorkloadIdentityConfigFromEnv() !== null;
}

/**
 * `capabilities.auth.workloadIdentity.schemes[]` — DERIVED from the configured
 * roots, never a literal.
 *
 * A literal list is how a host ends up claiming `mtls-san` because someone
 * pasted the RFC's example: the advert would name a verification path with no
 * code behind it, which §A calls the exact failure the profile prevents. Here
 * the only way to advertise a scheme is to configure a root that issues it.
 */
export function advertisedWorkloadSchemes(cfg: WorkloadIdentityConfig): WorkloadIdentityScheme[] {
  const seen = new Set<WorkloadIdentityScheme>();
  for (const root of cfg.roots.values()) seen.add(root.scheme);
  return WORKLOAD_IDENTITY_SCHEMES.filter((s) => seen.has(s));
}

// ── Hashed subjects (§D privacy rule / RFC 0154 gap G5) ────────────────────

/** The BYOK ref holding the host's workload-credential signing key. */
export const HOST_SIGNING_KEY_REF = 'auth:workload-identity-signing-key';
/** The BYOK ref holding a tenant's subject-hash salt. Per-tenant and ROTATABLE:
 *  a deletion request is satisfied by rotating this value, after which prior
 *  hashes are unlinkable — no append-only audit log is ever edited. */
export const SUBJECT_SALT_REF = 'auth:workload-identity-subject-salt';

/**
 * The host's signing key.
 *
 * Resolved from the existing BYOK resolver first (`OPENWOP_BOOT_SECRETS`, the
 * Secrets Vault, or a KMS-backed ref — whatever the deployment already uses).
 * When unset it is DERIVED from the session secret under a distinct
 * domain-separation label rather than inventing a second secret store: the
 * derived key cannot be confused with, or used to forge, a session cookie, and
 * `readSessionSecret()` already hard-fails in production when unconfigured.
 */
async function signingKey(): Promise<Buffer> {
  const configured = await tryResolveSecret(HOST_SIGNING_KEY_REF);
  if (configured) return Buffer.from(configured, 'utf8');
  return createHmac('sha256', readSessionSecret()).update('openwop:workload-identity:signing:v1').digest();
}

/**
 * `resolveSecret`, but a secret STORE that was never configured is treated as
 * "no stored value" rather than as an error.
 *
 * The distinction matters and cuts the opposite way to the fail-closed rule
 * elsewhere in this file. A resolver error while checking an IDENTITY is a
 * refusal (`resolveWorkloadIdentity`'s catch) because the thing being checked
 * might be hostile. An unconfigured BYOK store is not a fact about the caller at
 * all — it is a deployment that has not set one up — and failing closed on it
 * would make the profile unusable on every host without BYOK while adding no
 * safety: the fallback is DERIVED from `readSessionSecret()`, which is itself
 * secret and which hard-fails in production when unset.
 *
 * A genuine decrypt failure still returns `null` inside `resolveSecret`, so a
 * corrupted stored key falls back rather than throwing — the same posture the
 * rest of the BYOK call sites take.
 */
async function tryResolveSecret(ref: string, scope?: { tenantId: string }): Promise<string | null> {
  try {
    return await resolveSecret(ref, scope);
  } catch (err) {
    log.warn('workload_identity_secret_store_unavailable', {
      ref,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * A tenant's subject salt — per-tenant and rotatable (§D, gap G5).
 *
 * Derived from the host key when no explicit salt is stored, so the hash is
 * stable without operator setup; an operator rotates by WRITING the ref
 * (`setSecret(SUBJECT_SALT_REF, …, { tenantId })`), which makes every prior hash
 * for that tenant unlinkable.
 */
async function subjectSalt(tenantId: string): Promise<Buffer> {
  const stored = await tryResolveSecret(SUBJECT_SALT_REF, { tenantId });
  if (stored) return Buffer.from(stored, 'utf8');
  const key = await signingKey();
  return createHmac('sha256', key).update(`openwop:workload-identity:subject-salt:v1:${tenantId}`).digest();
}

/**
 * The subject → principal mapping (host policy, documented in the discovery doc
 * and in ADR 0556 P3).
 *
 * NEVER the presented subject verbatim (§A's explicit MUST NOT): a SPIFFE ID
 * names a deployment topology, and putting it into a principal id publishes that
 * topology into every event, span and audit record the principal reaches.
 */
async function principalIdFor(tenantId: string, scheme: WorkloadIdentityScheme, subject: string): Promise<string> {
  const salt = await subjectSalt(tenantId);
  const digest = createHmac('sha256', salt).update(`${scheme}\u0000${subject}`).digest('base64url');
  return `workload:${scheme}:${digest.slice(0, 22)}`;
}

/** Hash a delegated-principal id under the same tenant salt. Exported shape is
 *  opaque for the same reason the principal id is. */
async function opaqueOnBehalfOf(tenantId: string, principal: string): Promise<string> {
  const salt = await subjectSalt(tenantId);
  return `obo:${createHmac('sha256', salt).update(principal).digest('base64url').slice(0, 22)}`;
}

// ── Minting and verifying host credentials (§C token exchange, narrow) ─────

export interface MintWorkloadCredentialInput {
  /** Opaque workload name, e.g. `worker/dispatch-sweeper`. */
  readonly subject: string;
  readonly tenantId: string;
  /** Requested authority. Silently NOT widened: anything outside
   *  `HOST_WORKER_SCOPES` makes the credential fail its own verification with
   *  `scope_amplification`, which is a loud failure rather than a quiet trim. */
  readonly scopes: readonly Scope[];
  /** Lifetime in seconds. Short by construction — see `MAX_CREDENTIAL_TTL_S`. */
  readonly ttlSeconds?: number;
  /** RFC 0154 §B — the principal this worker acts for, when it acts for one.
   *  Signed into the credential, which is what makes it not self-asserted. */
  readonly onBehalfOf?: { readonly principalId: string; readonly kind: 'user' | 'agent' | 'service' };
}

/**
 * The ceiling on a minted credential's lifetime.
 *
 * "Short-lived" is the requirement (ADR 0556: workers receive short-lived,
 * audience-bound credentials, not copied user bearer tokens), so the bound lives
 * in code rather than in a caller's argument. Five minutes comfortably covers a
 * sweeper's dispatch and expires long before a leaked credential is useful.
 */
export const MAX_CREDENTIAL_TTL_S = 300;
const DEFAULT_CREDENTIAL_TTL_S = 120;

interface CredentialClaims {
  readonly iss: string;
  readonly sub: string;
  readonly aud: string;
  readonly exp: number;
  readonly iat: number;
  readonly jti: string;
  readonly scheme: WorkloadIdentityScheme;
  readonly tenant: string;
  readonly scopes: readonly string[];
  readonly obo?: { readonly principalId: string; readonly kind: 'user' | 'agent' | 'service' };
  readonly del?: DelegationContext;
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64url');
}

/**
 * Mint a short-lived, AUDIENCE-BOUND workload credential for one of this host's
 * own workers.
 *
 * This is what a background worker presents instead of a copied user bearer
 * token. The difference is not cosmetic: a copied bearer carries the user's full
 * authority, for the user's full session lifetime, to any audience that accepts
 * it. This carries a bounded scope set, for at most `MAX_CREDENTIAL_TTL_S`, to
 * exactly this host.
 */
export async function mintWorkloadCredential(input: MintWorkloadCredentialInput): Promise<string> {
  const cfg = readWorkloadIdentityConfigFromEnv();
  if (!cfg) throw new Error('mintWorkloadCredential: the workload-identity profile is not configured');
  const ttl = Math.min(Math.max(1, Math.floor(input.ttlSeconds ?? DEFAULT_CREDENTIAL_TTL_S)), MAX_CREDENTIAL_TTL_S);
  const now = Math.floor(Date.now() / 1000);
  const claims: CredentialClaims = {
    iss: cfg.hostIssuer,
    sub: input.subject,
    aud: cfg.audience,
    exp: now + ttl,
    iat: now,
    jti: randomUUID(),
    scheme: 'oauth-client',
    tenant: input.tenantId,
    scopes: [...input.scopes],
    ...(input.onBehalfOf ? { obo: input.onBehalfOf } : {}),
  };
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'openwop-wid+jwt' }));
  const body = b64url(JSON.stringify(claims));
  const key = await signingKey();
  const sig = createHmac('sha256', key).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

export type CredentialVerification =
  | { readonly ok: true; readonly identity: WorkloadIdentity; readonly tenantId: string; readonly scopes: readonly string[] }
  | { readonly ok: false; readonly reason: WorkloadRefusalReason; readonly cause: WorkloadRefusalCause };

/**
 * Verify a presented credential and PROJECT it — the cryptographic half of §A.
 *
 * The projection returned carries no credential material: that is the whole
 * contract of `workload-identity.schema.json`, and it is why this function and
 * not its caller owns the signature check.
 */
export async function verifyWorkloadCredential(token: string): Promise<CredentialVerification> {
  const cfg = readWorkloadIdentityConfigFromEnv();
  if (!cfg) return { ok: false, reason: CAUSE_TO_REASON.profile_disabled, cause: 'profile_disabled' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'identity_unverified', cause: 'credential_invalid' };
  const [header, body, sig] = parts;

  let claims: CredentialClaims;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    const h: unknown = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
    // `alg` is pinned rather than read. Honouring a credential's own `alg` is
    // the classic JWS confusion bug ("alg":"none", or HS256 verified against an
    // RSA public key); the host decides the algorithm, the credential does not.
    if (typeof h !== 'object' || h === null || (h as { alg?: unknown }).alg !== 'HS256') {
      return { ok: false, reason: 'identity_unverified', cause: 'credential_invalid' };
    }
    claims = decoded as CredentialClaims;
  } catch {
    return { ok: false, reason: 'identity_unverified', cause: 'credential_invalid' };
  }
  if (typeof claims?.iss !== 'string' || typeof claims?.sub !== 'string' || typeof claims?.exp !== 'number') {
    return { ok: false, reason: 'identity_unverified', cause: 'credential_invalid' };
  }

  const root = cfg.roots.get(claims.iss);
  if (!root) return { ok: false, reason: 'identity_unverified', cause: 'issuer_unknown' };
  // A root with no key material cannot verify anything this host is handed. The
  // refusal is the point: without it, an unkeyed root would silently accept the
  // credential's own claims — i.e. trust a header.
  const keyRef = root.keyRef;
  if (!keyRef) return { ok: false, reason: 'identity_unverified', cause: 'credential_invalid' };
  const key = keyRef === HOST_SIGNING_KEY_REF
    ? await signingKey()
    : await tryResolveSecret(keyRef).then((v) => (v === null ? null : Buffer.from(v, 'utf8')));
  if (!key) return { ok: false, reason: 'identity_unverified', cause: 'credential_invalid' };

  const expected = createHmac('sha256', key).update(`${header}.${body}`).digest();
  const presented = Buffer.from(sig, 'base64url');
  if (expected.length !== presented.length || !timingSafeEqual(expected, presented)) {
    return { ok: false, reason: 'identity_unverified', cause: 'credential_invalid' };
  }
  if (claims.exp * 1000 <= Date.now()) {
    return { ok: false, reason: 'identity_unverified', cause: 'credential_expired' };
  }

  const identity: WorkloadIdentity = {
    scheme: root.scheme,
    subject: claims.sub,
    issuer: claims.iss,
    audience: typeof claims.aud === 'string' ? claims.aud : undefined,
    ...(claims.del ? { delegation: claims.del } : {}),
    // `onBehalfOf` reaches the projection ONLY from here — from claims this host
    // verified a signature over. That is the mechanical form of §B's "a caller
    // MUST NOT self-assert `onBehalfOf`".
    ...(claims.obo ? { onBehalfOf: claims.obo } : {}),
  };
  const tenantId = root.tenantBinding === 'credential' ? claims.tenant : (root.tenantId ?? claims.tenant);
  return { ok: true, identity, tenantId, scopes: Array.isArray(claims.scopes) ? claims.scopes : [] };
}

// ── Resolution (§A bind/audience + §B chain) ───────────────────────────────

/**
 * Where a projected identity came from. There is no `'header'` member, and its
 * absence is the enforcement of `auth.md` §A's rule that forwarded identity
 * headers are attacker-controlled unless the terminator is configured-trusted.
 */
export type IdentityProvenance = 'verified-credential' | 'test-seam';

export interface ResolveOptions {
  /** The audience the CALLER expected, when it has an opinion (the §20 seam
   *  passes the suite's). It must agree with the host's own — a caller cannot
   *  talk the host into answering to a different name. */
  readonly expectedAudience?: string;
  /** Tenant + scopes established by the verification step. Absent for the test
   *  seam, which resolves against the trust root's own binding. */
  readonly verified?: { readonly tenantId: string; readonly scopes: readonly string[] };
}

/**
 * The §A/§B decision path: bind → audience → sender constraint → chain →
 * principal. Every branch that is not a resolution is a REFUSAL; there is no
 * default-allow, and a thrown error from the salt/key resolver surfaces as a
 * refusal too (`auth.md` §A: "A resolver error, cache miss, or unreachable
 * trust root is a refusal, never a default-allow").
 */
export async function resolveWorkloadIdentity(
  identity: WorkloadIdentity,
  provenance: IdentityProvenance,
  opts: ResolveOptions = {},
): Promise<WorkloadIdentityResolution> {
  try {
    return await resolveInner(identity, provenance, opts);
  } catch (err) {
    // Fail CLOSED on a resolver error. The log carries the cause; the caller
    // gets a refusal indistinguishable from any other, so a probe cannot use
    // resolver failures as an oracle.
    log.error('workload_identity_resolver_error', { error: err instanceof Error ? err.message : String(err) });
    return refuse('subject_unmapped');
  }
}

async function resolveInner(
  identity: WorkloadIdentity,
  provenance: IdentityProvenance,
  opts: ResolveOptions,
): Promise<WorkloadIdentityResolution> {
  const cfg = readWorkloadIdentityConfigFromEnv();
  if (!cfg) return refuse('profile_disabled');
  // The test seam is a projection source only while the seam itself is enabled.
  // In production `OPENWOP_TEST_SEAM_ENABLED` is unset, so this arm makes the
  // seam's provenance unusable even if a route were left registered.
  if (provenance === 'test-seam' && process.env.OPENWOP_TEST_SEAM_ENABLED !== 'true') {
    return refuse('projection_unverified');
  }
  if (!isWellFormedIdentity(identity)) return refuse('malformed_identity');

  const root = identity.issuer ? cfg.roots.get(identity.issuer) : undefined;
  if (!root) return refuse('issuer_unknown');
  if (root.scheme !== identity.scheme) return refuse('scheme_unadvertised');

  // §A(3) — audience. An identity minted for a different host is how a
  // credential valid elsewhere becomes a credential valid here.
  const audienceDecision: AudienceDecision =
    identity.audience === undefined ? 'absent' : identity.audience === cfg.audience ? 'match' : 'mismatch';
  if (audienceDecision === 'absent') return refuse('audience_absent');
  if (audienceDecision === 'mismatch') return refuse('audience_mismatch');
  if (opts.expectedAudience !== undefined && opts.expectedAudience !== cfg.audience) {
    return refuse('audience_mismatch');
  }

  // §C — sender constraint. Only bites when the host has configured one; with
  // the default empty set this host advertises bearer fallback and takes it.
  const constraint = identity.keyBinding?.method;
  if (cfg.senderConstraints.length > 0 && (constraint === undefined || !cfg.senderConstraints.includes(constraint))) {
    return refuse('sender_constraint_missing');
  }

  const tenantId = root.tenantBinding === 'credential' ? opts.verified?.tenantId : root.tenantId;
  if (!tenantId) return refuse('subject_unmapped');
  // Neutralization WITHOUT disclosure: a verified credential whose tenant
  // disagrees with a root-bound issuer never acts in the asserted tenant, and
  // the refusal says nothing about whether that tenant exists.
  if (root.tenantBinding === 'root' && opts.verified && opts.verified.tenantId !== tenantId) {
    return refuse('tenant_mismatch');
  }

  // §B — the delegated actor chain.
  const chain = identity.delegation;
  let delegationDepth = 0;
  if (chain) {
    const chainRefusal = checkDelegation(chain, cfg);
    if (chainRefusal) return chainRefusal;
    delegationDepth = chain.chain.length;
  }
  if (identity.onBehalfOf && provenance !== 'verified-credential') {
    // A projection that did not come from a verified credential cannot carry an
    // `onBehalfOf` — that is the self-assertion §B forbids.
    return refuse('self_asserted_on_behalf_of');
  }

  // Bounded scopes. The requested set is INTERSECTED with the root's ceiling,
  // and asking for more is a refusal rather than a trim: a silent trim hides
  // the amplification attempt from the audit trail.
  const requested = opts.verified?.scopes;
  let scopes: readonly Scope[] = root.scopes;
  if (requested !== undefined) {
    const ceiling = new Set<string>(root.scopes);
    if (requested.some((s) => !ceiling.has(s))) return refuse('scope_amplification');
    scopes = requested.filter((s): s is Scope => ceiling.has(s));
  }

  const principalId = await principalIdFor(tenantId, identity.scheme, identity.subject);
  return {
    ok: true,
    principal: {
      principalId,
      tenantId,
      scopes,
      scheme: identity.scheme,
      issuerClass: root.issuerClass,
      delegationDepth,
      senderConstraint: constraint ?? 'none',
      audienceDecision,
      ...(identity.onBehalfOf ? { onBehalfOf: await opaqueOnBehalfOf(tenantId, identity.onBehalfOf.principalId) } : {}),
      ...(chain?.expiresAt ? { expiresAt: chain.expiresAt } : {}),
    },
  };
}

/**
 * §B's bounds, in the order the RFC states them and the order a reader can
 * reason about: audience, then expiry, then depth, then acyclicity, then issuer.
 *
 * The order matters for one specific case the conformance witness exercises: an
 * expired delegation whose single hop names the presenting workload itself. That
 * is not a cycle — the presenter appearing at the head of its own chain is what
 * a one-hop chain looks like — so acyclicity is checked WITHIN the chain only,
 * and expiry is answered first regardless.
 */
function checkDelegation(del: DelegationContext, cfg: WorkloadIdentityConfig): WorkloadIdentityResolution | null {
  if (del.audience !== cfg.audience) return refuse('delegation_audience_mismatch');
  if (!del.expiresAt) return refuse('delegation_no_expiry');
  const expiry = Date.parse(del.expiresAt);
  if (!Number.isFinite(expiry) || expiry <= Date.now()) return refuse('delegation_expired');
  if (del.chain.length > cfg.maxChainDepth) return refuse('chain_too_deep');
  const seen = new Set<string>();
  let previousScopes: ReadonlySet<string> | undefined;
  for (const hop of del.chain) {
    if (seen.has(hop.subject)) return refuse('chain_cycle');
    seen.add(hop.subject);
    // §B "Bounds": a chain is provenance; a later hop cannot hold a scope the
    // hop before it did not. Only checked when BOTH consecutive hops carry
    // scopes — an absent set is "unstated", not "everything" and not "nothing".
    if (hop.scopes !== undefined) {
      if (previousScopes !== undefined && hop.scopes.some((sc) => !previousScopes!.has(sc))) return refuse('scope_amplification');
      previousScopes = new Set(hop.scopes);
    }
    // Every hop MUST be verified — which, for a chain this host did not mint,
    // means every hop's issuer must be one this host trusts. An unknown issuer
    // in the middle of a chain is an unverified hop wearing a verified chain's
    // clothes.
    if (hop.issuer !== undefined && !cfg.roots.has(hop.issuer)) return refuse('chain_issuer_unknown');
  }
  return null;
}

/**
 * Closed-world shape check, mirroring `workload-identity.schema.json`.
 *
 * The schema's rule is negative — raw certificates, tokens, proofs and
 * credentials MUST NOT enter these objects — and a closed check is how that is
 * enforced on input this host did not construct. An unexpected key is refused
 * rather than ignored, because "ignored" is where a token rides along.
 */
export function isWellFormedIdentity(value: unknown): value is WorkloadIdentity {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const allowed = new Set(['scheme', 'subject', 'issuer', 'audience', 'keyBinding', 'delegation', 'onBehalfOf']);
  for (const key of Object.keys(v)) if (!allowed.has(key)) return false;
  if (typeof v.scheme !== 'string' || !(WORKLOAD_IDENTITY_SCHEMES as readonly string[]).includes(v.scheme)) return false;
  if (typeof v.subject !== 'string' || v.subject.length === 0) return false;
  for (const key of ['issuer', 'audience'] as const) {
    if (v[key] !== undefined && (typeof v[key] !== 'string' || (v[key] as string).length === 0)) return false;
  }
  if (v.keyBinding !== undefined) {
    if (typeof v.keyBinding !== 'object' || v.keyBinding === null) return false;
    const kb = v.keyBinding as Record<string, unknown>;
    for (const key of Object.keys(kb)) if (key !== 'method' && key !== 'thumbprintRef') return false;
    if (kb.method !== 'mtls' && kb.method !== 'dpop') return false;
    if (kb.thumbprintRef !== undefined && !/^sha256:[0-9a-f]{64}$/.test(String(kb.thumbprintRef))) return false;
  }
  if (v.delegation !== undefined && !isWellFormedDelegation(v.delegation)) return false;
  if (v.onBehalfOf !== undefined) {
    if (typeof v.onBehalfOf !== 'object' || v.onBehalfOf === null) return false;
    const o = v.onBehalfOf as Record<string, unknown>;
    for (const key of Object.keys(o)) if (key !== 'principalId' && key !== 'kind') return false;
    if (typeof o.principalId !== 'string' || !o.principalId) return false;
    if (o.kind !== 'user' && o.kind !== 'agent' && o.kind !== 'service') return false;
  }
  return true;
}

function isWellFormedDelegation(value: unknown): value is DelegationContext {
  if (typeof value !== 'object' || value === null) return false;
  const d = value as Record<string, unknown>;
  for (const key of Object.keys(d)) {
    if (!['chain', 'audience', 'expiresAt', 'proofRef'].includes(key)) return false;
  }
  if (!Array.isArray(d.chain) || d.chain.length === 0) return false;
  for (const hop of d.chain) {
    if (typeof hop !== 'object' || hop === null) return false;
    const h = hop as Record<string, unknown>;
    for (const key of Object.keys(h)) if (key !== 'subject' && key !== 'issuer' && key !== 'scopes') return false;
    if (typeof h.subject !== 'string' || !h.subject) return false;
    if (h.issuer !== undefined && (typeof h.issuer !== 'string' || !h.issuer)) return false;
    if (h.scopes !== undefined) {
      if (!Array.isArray(h.scopes) || h.scopes.some((sc) => typeof sc !== 'string' || !sc)) return false;
      if (new Set(h.scopes).size !== h.scopes.length) return false; // schema: uniqueItems
    }
  }
  if (typeof d.audience !== 'string' || !d.audience) return false;
  if (d.expiresAt !== undefined && typeof d.expiresAt !== 'string') return false;
  // A `proofRef` is a digest REFERENCE. The pattern is what stops a JWT being
  // pasted here and riding into every record this object reaches.
  if (d.proofRef !== undefined && !/^sha256:[0-9a-f]{64}$/.test(String(d.proofRef))) return false;
  return true;
}
