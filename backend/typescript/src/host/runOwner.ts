/**
 * RFC 0048 §C + RFC 0165 §B — the run's owning identity as OpenWOP sees it
 * (ADR 0625).
 *
 * ONE module owns the projection so `GET /v1/runs/{id}` (`projectRunSnapshot`),
 * the `run.started` echo (`executor.ts`) and the `:fork` copy cannot drift:
 *
 *   - `ownerStampFromRequest(req)` mints the RFC 0165 Subject from the
 *     authenticated caller at run creation. It is persisted as the RESERVED
 *     `run.metadata.owner` key (a client MUST NOT name its own owner — the
 *     `actingUserId` discipline, `runDispatch.ts`).
 *   - `runOwner(run)` projects `{ tenant, principal?, principalKind?, subject }`
 *     for the snapshot and the echo. A run with no stamp (created before
 *     2026-09-02, or by a host-internal lane) reads back with the §B.3 legacy
 *     subject `issuer: "urn:openwop:legacy"`, which is never linkable.
 *
 * Identity facts, and how each lane is attested (RFC 0165 §B.1 `lane`):
 *   - `oidc:<sub>` bearer / cookie subjects  → lane `oidc`, issuer = the
 *     configured OIDC issuer.
 *   - `saml:<nameId>` principals              → lane `saml`, `keyClass:
 *     "opaque-idp"` (`subjectLinkService.ts` SUBJECT_LINK_KEY), issuer = the
 *     IdP entityID the SCIM trust root is bound to.
 *   - `apikey:<keyId>` (ADR 0270 delegation)  → lane `api-key`, kind `workload`.
 *   - `bearer:<prefix>` (`OPENWOP_API_KEYS`)  → lane `api-key`, kind `workload`.
 *   - test-seam principal                     → lane `api-key`, kind `workload`.
 *   - a durable `user:<id>` cookie session and an anonymous cookie session have
 *     NO lane in the RFC 0165 enum (the host is its own credential authority;
 *     RFC 0132's anonymous surface is not an auth-profile). Both take the
 *     RFC's own floor for an unattestable lane — `api-key` (§B.3's rule for a
 *     host that "kept no record", applied at mint time) — with an issuer that
 *     names the real authority (`urn:openwop-app:session`,
 *     `urn:openwop-app:anon-surface`). Recorded upstream as RFC 0165 G6.
 *
 * `principal` and `subject.subjectId` are the SAME opaque projection
 * (truncated SHA-256 of the RBAC subject), so §B.2's equality holds by
 * construction and neither is PII (SECURITY `subject-record-opaque`). An anon
 * run keeps the already-opaque `anonPrincipal` RFC 0132 minted.
 *
 * `actor` is never set: the host has no delegation lane at run creation and a
 * caller MUST NOT self-assert one (§B.5). `keyClass` is set only on `saml`.
 */

import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { callerSubject } from './requestSubject.js';

export type SubjectLane = 'api-key' | 'oauth2' | 'oidc' | 'mtls' | 'saml' | 'scim' | 'ldap' | 'workload';
export type SubjectKind = 'user' | 'agent' | 'anonymous' | 'workload';

/** `schemas/subject.schema.json` (RFC 0165 §B.1). */
export interface RunSubject {
  issuer: string;
  subjectId: string;
  tenant: string;
  lane: SubjectLane;
  kind: SubjectKind;
  keyClass?: 'opaque-idp' | 'configured-immutable';
  actor?: RunSubject;
}

/** What `run.metadata.owner` persists (tenant lives on the run row). */
export interface RunOwnerStamp {
  principal: string;
  principalKind?: 'user' | 'agent' | 'anonymous';
  subject: Omit<RunSubject, 'tenant'>;
}

/** `RunSnapshot.owner` / the `run.started` owner echo. */
export interface RunOwnerBlock {
  tenant: string;
  principal?: string;
  principalKind?: 'user' | 'agent' | 'anonymous';
  subject?: RunSubject;
}

export const OWNER_METADATA_KEY = 'owner';
export const LEGACY_SUBJECT_ISSUER = 'urn:openwop:legacy';
export const SESSION_SUBJECT_ISSUER = 'urn:openwop-app:session';
export const ANON_SUBJECT_ISSUER = 'urn:openwop-app:anon-surface';
export const API_KEY_SUBJECT_ISSUER = 'urn:openwop-app:api-key';
export const ENV_KEY_SUBJECT_ISSUER = 'urn:openwop-app:env-key';
export const TEST_SEAM_SUBJECT_ISSUER = 'urn:openwop-app:test-seam';
/** RFC 0165 §B.5 — refuse, never truncate, beyond this depth. */
export const SUBJECT_ACTOR_MAX_DEPTH = 4;

/** Truncated SHA-256 (16 hex / 64 bits): opaque, deterministic, non-PII. */
export function opaquePrincipal(subject: string): string {
  return createHash('sha256').update(subject, 'utf8').digest('hex').slice(0, 16);
}

function oidcIssuer(): string {
  return process.env.OPENWOP_OIDC_ISSUER || 'urn:openwop-app:oidc';
}
function samlIssuer(): string {
  return process.env.OPENWOP_SCIM_IDP_ENTITY_ID || process.env.OPENWOP_SAML_IDP_ENTITY_ID || 'urn:openwop-app:saml';
}

/**
 * RFC 0165 §B — the Subject minted from the authenticated caller. `undefined`
 * for a request with no principal at all (no principal ⇒ no subject).
 */
export function ownerStampFromRequest(req: Request): RunOwnerStamp | undefined {
  const rbacSubject = callerSubject(req);
  const principal = req.principal;
  if (!rbacSubject || !principal) return undefined;
  const subjectId = opaquePrincipal(rbacSubject);
  const auth = principal.auth;
  const id = principal.principalId;
  let subject: Omit<RunSubject, 'tenant'>;
  let principalKind: RunOwnerStamp['principalKind'];
  if (auth?.kind === 'api-key') {
    subject = { issuer: API_KEY_SUBJECT_ISSUER, subjectId, lane: 'api-key', kind: 'workload' };
  } else if (auth?.kind === 'env-key') {
    subject = { issuer: ENV_KEY_SUBJECT_ISSUER, subjectId, lane: 'api-key', kind: 'workload' };
  } else if (auth?.kind === 'test-seam') {
    subject = { issuer: TEST_SEAM_SUBJECT_ISSUER, subjectId, lane: 'api-key', kind: 'workload' };
  } else if (auth?.kind === 'anon') {
    subject = { issuer: ANON_SUBJECT_ISSUER, subjectId, lane: 'api-key', kind: 'anonymous' };
    principalKind = 'anonymous';
  } else if (id.startsWith('oidc:')) {
    subject = { issuer: oidcIssuer(), subjectId, lane: 'oidc', kind: 'user' };
    principalKind = 'user';
  } else if (id.startsWith('saml:')) {
    subject = { issuer: samlIssuer(), subjectId, lane: 'saml', kind: 'user', keyClass: 'opaque-idp' };
    principalKind = 'user';
  } else {
    // Durable `user:<id>` session (or a principal minted outside the auth
    // boundary): the host is its own authority; no enum lane fits (G6).
    subject = { issuer: SESSION_SUBJECT_ISSUER, subjectId, lane: 'api-key', kind: 'user' };
    principalKind = 'user';
  }
  return { principal: subjectId, ...(principalKind ? { principalKind } : {}), subject };
}

/** RFC 0132 anon-actor run: the already-opaque anon principal, kind `anonymous`. */
export function anonOwnerStamp(anonPrincipal: string): RunOwnerStamp {
  return {
    principal: anonPrincipal,
    principalKind: 'anonymous',
    subject: { issuer: ANON_SUBJECT_ISSUER, subjectId: anonPrincipal, lane: 'api-key', kind: 'anonymous' },
  };
}

/** RFC 0165 §B.3 — the synthesized subject for a run that carries no stamp. */
export function legacySubject(principal: string, tenant: string, kind: SubjectKind = 'user'): RunSubject {
  return { issuer: LEGACY_SUBJECT_ISSUER, subjectId: principal, tenant, lane: 'api-key', kind };
}

export function isLegacySubject(subject: Pick<RunSubject, 'issuer'> | undefined): boolean {
  return subject?.issuer === LEGACY_SUBJECT_ISSUER;
}

export function subjectChainDepth(subject: RunSubject | undefined): number {
  let depth = 0;
  for (let s: RunSubject | undefined = subject; s !== undefined; s = s.actor) depth += 1;
  return depth;
}

function readStamp(md: Record<string, unknown> | undefined): RunOwnerStamp | undefined {
  const o = md?.[OWNER_METADATA_KEY] as RunOwnerStamp | undefined;
  if (!o || typeof o !== 'object') return undefined;
  const s = o.subject;
  if (typeof o.principal !== 'string' || o.principal.length === 0) return undefined;
  if (!s || typeof s !== 'object' || typeof s.issuer !== 'string' || typeof s.subjectId !== 'string' || typeof s.lane !== 'string' || typeof s.kind !== 'string') return undefined;
  return o;
}

/**
 * The owner block for the snapshot and the `run.started` echo. Precedence:
 * the persisted stamp; else the RFC 0132 anon markers; else the ADR 0024
 * `actingUserId` projected opaquely with the legacy subject; else none.
 * `subject.tenant` is ALWAYS the run's tenant (§B.2, by construction) and
 * `subject.subjectId` ALWAYS equals `principal` — a stamp that disagrees is a
 * host bug and falls back to the legacy form rather than emit a payload that
 * fails the spec's own invariant.
 */
export function runOwner(run: { tenantId: string; metadata?: Record<string, unknown> | null }): RunOwnerBlock | undefined {
  const md = run.metadata ?? undefined;
  const tenant = run.tenantId;
  const stamp = readStamp(md);
  if (stamp) {
    const consistent = stamp.subject.subjectId === stamp.principal && subjectChainDepth({ ...stamp.subject, tenant }) <= SUBJECT_ACTOR_MAX_DEPTH;
    const subject: RunSubject = consistent
      ? { ...stamp.subject, tenant }
      : legacySubject(stamp.principal, tenant, stamp.principalKind ?? 'user');
    return { tenant, principal: stamp.principal, ...(stamp.principalKind ? { principalKind: stamp.principalKind } : {}), subject };
  }
  const anonPrincipal = md?.anonPrincipal;
  if (md?.principalKind === 'anonymous' && typeof anonPrincipal === 'string' && anonPrincipal.length > 0) {
    return { tenant, principal: anonPrincipal, principalKind: 'anonymous', subject: legacySubject(anonPrincipal, tenant, 'anonymous') };
  }
  const acting = md?.actingUserId;
  if (typeof acting === 'string' && acting.length > 0) {
    const principal = opaquePrincipal(acting);
    // No `principalKind`: a pre-stamp run never asserted one (RFC 0132 absent ⇒
    // unconstrained); the subject takes the §B.3 `kind` floor `user`.
    return { tenant, principal, subject: legacySubject(principal, tenant) };
  }
  return undefined;
}

/**
 * `spec/v2/core/identity.md` §1.1 "Shape" (RFC 0170 §A.1) — the major-2 owner
 * block: `{ tenant, workspace?, subject }`, CLOSED, `subject` REQUIRED,
 * `principal` and `principalKind` REMOVED (`subject.subjectId` and
 * `subject.kind` carry them).
 *
 * A READ PROJECTION over the SAME persisted `metadata.owner` stamp the v1 block
 * above projects — nothing is re-stamped and nothing is rewritten. That matters
 * twice over:
 *
 *   - §1.2 (the legacy subject rule) says a host MUST stamp the legacy subject
 *     at first read and MUST NOT rewrite it later. A projection cannot rewrite.
 *   - the v1 lane enum has eight members and v2 adds `session` and `anonymous`
 *     (§A.2). This host mints a session and an anonymous subject under the
 *     RFC 0165 §B.3 `api-key` FLOOR with an issuer naming the real authority
 *     (`urn:openwop-app:session`, `urn:openwop-app:anon-surface`) — recorded
 *     upstream as RFC 0165 G6 and the reason §A.2 exists. The issuer IS the
 *     attestation, so under major 2 the lane is read back from it. Migration row
 *     `openwop.migration.C3.4` is exactly this: "a v1 subject minted with the
 *     api-key floor for a session reads back with `lane: session` only if the
 *     host attested it". Re-minting instead would put a lane the v1 enum does
 *     not contain onto the v1 wire.
 *
 * `kind: anonymous` REQUIRES `lane: anonymous` and vice versa (§A.2), and
 * `keyClass` MUST be present iff `lane ∈ {saml, scim}` — both are schema
 * conditions in `schemas/v2/subject.schema.json`, so they are enforced here
 * rather than hoped for.
 */
export type SubjectLaneV2 = SubjectLane | 'session' | 'anonymous';

/** `schemas/v2/subject.schema.json` — closed; the v1 record plus the two v2 lanes. */
export interface RunSubjectV2 {
  issuer: string;
  subjectId: string;
  tenant: string;
  lane: SubjectLaneV2;
  kind: SubjectKind;
  keyClass?: 'opaque-idp' | 'configured-immutable';
  actor?: RunSubjectV2;
}

export interface RunOwnerBlockV2 {
  tenant: string;
  workspace?: string;
  subject: RunSubjectV2;
}

/** `identity.md` §1.2 — the subjectId a run with no principal at all reads under. */
const LEGACY_SUBJECT_ID = 'legacy';

function toV2Subject(subject: RunSubject): RunSubjectV2 {
  let lane: SubjectLaneV2 = subject.lane;
  let kind: SubjectKind = subject.kind;
  if (subject.issuer === SESSION_SUBJECT_ISSUER) lane = 'session';
  if (subject.issuer === ANON_SUBJECT_ISSUER) {
    lane = 'anonymous';
    kind = 'anonymous';
  }
  // The §A.2 biconditional, applied in the other direction too: a legacy stamp
  // recorded `kind: anonymous` under the `api-key` floor, and the v2 schema
  // rejects that pair outright.
  if (kind === 'anonymous') lane = 'anonymous';
  if (lane === 'anonymous') kind = 'anonymous';
  const out: RunSubjectV2 = {
    issuer: subject.issuer,
    subjectId: subject.subjectId,
    tenant: subject.tenant,
    lane,
    kind,
    // `keyClass` MUST be present iff `lane ∈ {saml, scim}`.
    ...((lane === 'saml' || lane === 'scim') && subject.keyClass ? { keyClass: subject.keyClass } : {}),
    ...(subject.actor ? { actor: toV2Subject(subject.actor) } : {}),
  };
  return out;
}

export function runOwnerV2(run: { tenantId: string; metadata?: Record<string, unknown> | null }): RunOwnerBlockV2 {
  const v1 = runOwner(run);
  const tenant = run.tenantId;
  // §1.2 — a run created before this host emitted subjects (and with no
  // principal recorded at all, so the v1 projection declines to invent one)
  // reads with the legacy subject. Stamped at read, never persisted.
  const subject = v1?.subject ?? legacySubject(LEGACY_SUBJECT_ID, tenant);
  return { tenant, subject: toV2Subject(subject) };
}

/**
 * `spec/v2/core/events.md` §Payloads + RFC 0170 §A.1 — "`run.started` carries
 * `owner { tenant, workspace?, subject }`, the same closed block as
 * `RunSnapshot.owner`". The persisted echo is the v1 block (it carries
 * `principal`), and the v1 log is never rewritten, so the major-2 reader
 * projects it the same way `runOwnerV2` projects the snapshot — one function
 * for the record shape so the snapshot and the echo cannot disagree, which is
 * the whole reason §A.1 words them as the same block.
 *
 * Returns the payload unchanged when it carries no `owner` this host wrote.
 */
export function projectV2OwnerEcho(payload: unknown, runTenant?: string): unknown {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  const p = payload as Record<string, unknown>;
  const owner = p['owner'];
  // NO OWNER AT ALL is the pre-cut case §1.2 is written for, and returning the
  // payload unchanged here was the defect: "On EVERY read of a run created before
  // the host began emitting subjects, the host MUST stamp `issuer:
  // urn:openwop:legacy`". A run.started logged before this host emitted owners
  // carries no `owner` key, so the early return skipped precisely the runs the
  // rule governs — absence read as "nothing to do" rather than as the condition.
  //
  // The tenant cannot come from the payload (there is no owner block to read it
  // from), so the caller supplies the RUN's tenant. Without one there is nothing
  // honest to stamp — a subject is tenant-scoped — so the payload is returned
  // unchanged rather than stamped against a guess.
  if (owner === null || typeof owner !== 'object' || Array.isArray(owner)) {
    if (typeof runTenant !== 'string' || runTenant.length === 0) return payload;
    return { ...p, owner: { tenant: runTenant, subject: toV2Subject(legacySubject(LEGACY_SUBJECT_ID, runTenant)) } satisfies RunOwnerBlockV2 };
  }
  const o = owner as { tenant?: unknown; workspace?: unknown; subject?: unknown };
  if (typeof o.tenant !== 'string') return payload;
  const subject = o.subject as RunSubject | undefined;
  const v2: RunOwnerBlockV2 = {
    tenant: o.tenant,
    ...(typeof o.workspace === 'string' ? { workspace: o.workspace } : {}),
    subject: toV2Subject(
      subject !== undefined && typeof subject === 'object' && typeof subject.issuer === 'string'
        ? { ...subject, tenant: o.tenant }
        : legacySubject(LEGACY_SUBJECT_ID, o.tenant),
    ),
  };
  return { ...p, owner: v2 };
}
