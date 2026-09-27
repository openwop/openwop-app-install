/**
 * kicktodo-accountability (ADR 0419 P1) — circles + grants + the
 * resource-conversation binding seam.
 *
 * A circle is a PRODUCT resource, never workspace membership (PRD §6.6): a
 * grantee sees exactly the granted scopes of ONE enrollment's progress and a
 * shared conversation — nothing else in the workspace. Invariants:
 *
 *  - grants are LIVE-checked on every read (revocation bites immediately —
 *    the PRD §8.7 exception to run-freezing);
 *  - denial is uniform not-found (no existence oracle);
 *  - the BINDING SEAM resolves a circle's OWNING tenant from its opaque id
 *    (a global id-keyed pointer row), proves the caller's live grant, then
 *    operates the ONE conversation owner under that tenant. Generic chat is
 *    untouched and never accepts a client-supplied tenant (test-enforced).
 */

import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { createLogger } from '../../observability/logger.js';
import { ensureConversationMeta } from '../../host/conversationStore.js';

const log = createLogger('kicktodo.circles');

export type CircleType = 'partner' | 'circle' | 'cohort' | 'coach';
export const GRANT_SCOPES = ['progress-summary', 'action-status', 'check-in-note', 'message', 'coach-plan-proposal'] as const;
export type GrantScope = (typeof GRANT_SCOPES)[number];

export interface AccountabilityCircle {
  id: string;
  tenantId: string;
  type: CircleType;
  enrollmentId: string;
  ownerSubject: string;
  name: string;
  conversationId: string;
  createdAt: string;
}

export interface AccountabilityGrant {
  tenantId: string;
  circleId: string;
  enrollmentId: string;
  grantorSubject: string;
  granteeSubject: string;
  scopes: GrantScope[];
  state: 'invited' | 'active' | 'revoked';
  invitedAt: string;
  acceptedAt?: string;
  revokedAt?: string;
  expiresAt?: string;
}

const circles = new DurableCollection<AccountabilityCircle>(
  'kicktodo-circles',
  (c) => `${c.tenantId}::${c.id}`,
);

/** The opaque-id → owning-tenant pointer (the binding seam's first hop).
 *  Content-free: circle id + tenant only. */
const circleIndex = new DurableCollection<{ circleId: string; tenantId: string }>(
  'kicktodo-circle-index',
  (r) => r.circleId,
);

const grants = new DurableCollection<AccountabilityGrant>(
  'kicktodo-grants',
  (g) => `${g.tenantId}::${g.circleId}::${g.granteeSubject}`,
);

const nowIso = (): string => new Date().toISOString();

export class CircleDeniedError extends Error {
  constructor() {
    super('No such circle.'); // uniform — indistinguishable from absent
  }
}

export async function createCircle(input: {
  tenantId: string;
  type: CircleType;
  enrollmentId: string;
  ownerSubject: string;
  name: string;
}): Promise<AccountabilityCircle> {
  const id = `circle:${randomUUID()}`;
  // The circle's conversation is deterministic per circle and lives with the
  // ONE conversation owner under the OWNING tenant.
  const conversationId = `subjc-circle-${id.slice(7, 31)}`;
  const circle: AccountabilityCircle = {
    id,
    tenantId: input.tenantId,
    type: input.type,
    enrollmentId: input.enrollmentId,
    ownerSubject: input.ownerSubject,
    name: input.name,
    conversationId,
    createdAt: nowIso(),
  };
  await circles.put(circle);
  await circleIndex.put({ circleId: id, tenantId: input.tenantId });
  // OWNED, not unowned: `isVisibleTo` treats an ownerless conversation as
  // tenant-visible (the legacy posture) — a circle chat must be invisible to
  // the rest of the workspace; only the owner (and later, seam-admitted
  // grantees) may see it. (The unweakened-chat test caught this live.)
  await ensureConversationMeta(input.tenantId, conversationId, { type: 'group', ownerUserId: input.ownerSubject });
  // The owner is implicitly a full member (grantor side).
  await grants.put({
    tenantId: input.tenantId,
    circleId: id,
    enrollmentId: input.enrollmentId,
    grantorSubject: input.ownerSubject,
    granteeSubject: input.ownerSubject,
    scopes: [...GRANT_SCOPES],
    state: 'active',
    invitedAt: nowIso(),
    acceptedAt: nowIso(),
  });
  log.info('kicktodo_circle_created', { circleId: id, type: input.type });
  return circle;
}

/** LIVE grant check — the single authorization primitive. */
export async function liveGrant(tenantId: string, circleId: string, subject: string): Promise<AccountabilityGrant | null> {
  const g = await grants.get(`${tenantId}::${circleId}::${subject}`);
  if (!g || g.state !== 'active' || g.revokedAt) return null;
  if (g.expiresAt && Date.parse(g.expiresAt) < Date.now()) return null;
  return g;
}

/** Owner-or-member read of the circle (uniform denial). */
export async function getCircleFor(tenantId: string, circleId: string, subject: string): Promise<AccountabilityCircle> {
  const c = await circles.get(`${tenantId}::${circleId}`);
  if (!c) throw new CircleDeniedError();
  const g = await liveGrant(tenantId, circleId, subject);
  if (!g && c.ownerSubject !== subject) throw new CircleDeniedError();
  return c;
}

/**
 * THE BINDING SEAM (ADR 0419's load-bearing piece): resolve by OPAQUE id
 * across tenants, prove the caller's LIVE grant under the owning tenant, and
 * return the binding for the conversation owner to operate under. The caller
 * may be signed into a DIFFERENT active tenant — that is the point. A
 * client-supplied tenant id is never accepted.
 */
export async function resolveCircleConversation(
  circleId: string,
  callerSubject: string,
): Promise<{ tenantId: string; conversationId: string; scopes: GrantScope[] }> {
  const ptr = await circleIndex.get(circleId);
  if (!ptr) throw new CircleDeniedError();
  const circle = await circles.get(`${ptr.tenantId}::${circleId}`);
  if (!circle) throw new CircleDeniedError();
  const grant = await liveGrant(ptr.tenantId, circleId, callerSubject);
  if (!grant) throw new CircleDeniedError();
  return { tenantId: ptr.tenantId, conversationId: circle.conversationId, scopes: grant.scopes };
}

/** Opaque-id circle resolution (the same first hop the seam uses) — the
 *  AUTHORIZATION still happens against the returned circle's tenant. */
export async function resolveCircleByOpaqueId(circleId: string): Promise<AccountabilityCircle> {
  const ptr = await circleIndex.get(circleId);
  if (!ptr) throw new CircleDeniedError();
  const circle = await circles.get(`${ptr.tenantId}::${circleId}`);
  if (!circle) throw new CircleDeniedError();
  return circle;
}

export class GrantError extends Error {}

/** Invite: the OWNER names an opaque grantee subject + a scope subset. The
 *  invitation payload IS the disclosure (scopes visible before acceptance). */
export async function inviteToCircle(
  tenantId: string,
  circleId: string,
  actorSubject: string,
  granteeSubject: string,
  scopes: GrantScope[],
): Promise<AccountabilityGrant> {
  const c = await circles.get(`${tenantId}::${circleId}`);
  if (!c || c.ownerSubject !== actorSubject) throw new CircleDeniedError();
  const clean = scopes.filter((s): s is GrantScope => (GRANT_SCOPES as readonly string[]).includes(s));
  if (clean.length === 0) throw new GrantError('At least one valid scope is required.');
  if (granteeSubject === c.ownerSubject) throw new GrantError('The owner already holds full scopes.');
  const grant: AccountabilityGrant = {
    tenantId,
    circleId,
    enrollmentId: c.enrollmentId,
    grantorSubject: actorSubject,
    granteeSubject,
    scopes: clean,
    state: 'invited',
    invitedAt: nowIso(),
  };
  await grants.put(grant);
  return grant;
}

/** Accept: only the named grantee can accept — and only scope SUBSETS ever
 *  narrow (a grantee can never broaden their own grant). */
export async function acceptGrant(circleId: string, granteeSubject: string): Promise<AccountabilityGrant> {
  const ptr = await circleIndex.get(circleId);
  if (!ptr) throw new CircleDeniedError();
  const g = await grants.get(`${ptr.tenantId}::${circleId}::${granteeSubject}`);
  if (!g || g.state === 'revoked') throw new CircleDeniedError();
  if (g.state === 'active') return g;
  const next: AccountabilityGrant = { ...g, state: 'active', acceptedAt: nowIso() };
  await grants.put(next);
  return next;
}

/** Revoke: the OWNER (or the grantee themself, leaving) — immediate. */
export async function revokeGrant(
  tenantId: string,
  circleId: string,
  actorSubject: string,
  granteeSubject: string,
): Promise<AccountabilityGrant> {
  const c = await circles.get(`${tenantId}::${circleId}`);
  if (!c) throw new CircleDeniedError();
  if (actorSubject !== c.ownerSubject && actorSubject !== granteeSubject) throw new CircleDeniedError();
  const g = await grants.get(`${tenantId}::${circleId}::${granteeSubject}`);
  if (!g) throw new CircleDeniedError();
  if (g.state === 'revoked') return g;
  const next: AccountabilityGrant = { ...g, state: 'revoked', revokedAt: nowIso() };
  await grants.put(next);
  log.info('kicktodo_grant_revoked', { circleId, grantee: granteeSubject });
  return next;
}

export async function listGrants(tenantId: string, circleId: string, actorSubject: string): Promise<AccountabilityGrant[]> {
  const c = await circles.get(`${tenantId}::${circleId}`);
  if (!c) throw new CircleDeniedError();
  if (c.ownerSubject !== actorSubject && !(await liveGrant(tenantId, circleId, actorSubject))) throw new CircleDeniedError();
  return (await grants.listByPrefix(`${tenantId}::${circleId}::`)).sort((a, b) => a.invitedAt.localeCompare(b.invitedAt));
}

/** PACKAGE-INTERNAL (ADR 0428): ungated grant rows for aggregate computation
 *  inside this feature package only — route code MUST use `listGrants` (actor-
 *  gated). Never return these rows across the package boundary. */
export async function listGrantsInternal(tenantId: string, circleId: string): Promise<AccountabilityGrant[]> {
  return await grants.listByPrefix(`${tenantId}::${circleId}::`);
}

export async function listCirclesOwnedBy(tenantId: string, ownerSubject: string): Promise<AccountabilityCircle[]> {
  const rows = await circles.listByPrefix(`${tenantId}::`);
  return rows.filter((c) => c.ownerSubject === ownerSubject).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// ── ADR 0458 Phase 0 — compliance (subject erasure) ──
/**
 * DSAR erasure: delete every grant in this tenant where the subject is EITHER the
 * grantor OR the grantee. Deleting a grant carries revocation semantics (the same
 * effect as `revokeGrant`, minus the row-kept-for-history posture — a DSAR removes
 * the row): a grantee's access ends, and a grant the subject issued to others is
 * withdrawn. The circle rows themselves are shared PRODUCT resources (the ADR 0419
 * "a circle is a product resource, never workspace membership" framing) keyed by an
 * opaque owner subject (ADR 0426 — never PII), so they are retained like a published
 * challenge; erasure removes the subject's MEMBERSHIP, not other members' circle.
 * Idempotent; fail-closed on a falsy tenant/subject. Returns the count removed.
 */
export async function eraseSubjectGrants(tenantId: string, subjectKey: string): Promise<number> {
  if (!tenantId || !subjectKey) return 0;
  let removed = 0;
  for (const g of await grants.listByPrefix(`${tenantId}::`)) {
    if (g.tenantId !== tenantId) continue;
    if (g.granteeSubject === subjectKey || g.grantorSubject === subjectKey) {
      if (await grants.delete(`${g.tenantId}::${g.circleId}::${g.granteeSubject}`)) removed += 1;
    }
  }
  return removed;
}
