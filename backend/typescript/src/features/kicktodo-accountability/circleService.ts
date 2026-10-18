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

import { createHash, randomUUID } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { createLogger } from '../../observability/logger.js';
import { ensureConversationMeta } from '../../host/conversationStore.js';
import { registerKvAgeOut } from '../../host/kvAgeOut.js';
import { KICKTODO_REVOKED_ROW_RETENTION_DAYS } from '../kicktodo-core/types.js';

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

// KTACC-6 (KickTodo wave 4C) — revoked grants were kept forever. A revoked grant
// reads exactly like an absent one (`liveGrant` / `grantAcceptable` /
// `acceptGrant` all refuse both), so past the window it is reclaimed on the
// default-on kvAgeOut lane. Keyed on `revokedAt`, which only `revokeGrant` sets;
// live and invited grants carry none and are skipped. A re-invite writes a FRESH
// row without it, so a re-joined member is never aged out.
registerKvAgeOut({
  id: 'kicktodo-grants:revoked',
  prefix: 'hostext:kicktodo-grants:',
  ttlDays: KICKTODO_REVOKED_ROW_RETENTION_DAYS,
  timestampField: 'revokedAt',
});

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
  /** KTACC-5 — a client idempotency key (the `Idempotency-Key` header). Present ⇒
   *  the circle id is DERIVED from (tenant, owner, key) and created by CAS, so a
   *  double submit returns the first circle instead of minting a second. Absent ⇒
   *  a fresh random id, exactly as before. */
  idempotencyKey?: string;
}): Promise<AccountabilityCircle> {
  const id = input.idempotencyKey
    ? idempotentCircleId(input.tenantId, input.ownerSubject, input.idempotencyKey)
    : `circle:${randomUUID()}`;
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
  if (input.idempotencyKey) {
    // Only the CAS winner proceeds to the side rows; a replay returns the
    // stored circle (and converges its idempotent side rows below).
    if (!(await circles.compareAndSwap(null, circle))) {
      const existing = await circles.get(`${input.tenantId}::${id}`);
      if (!existing) throw new CircleDeniedError(); // vanished between CAS and read
      await circleIndex.put({ circleId: id, tenantId: existing.tenantId });
      await ensureConversationMeta(existing.tenantId, existing.conversationId, { type: 'group', ownerUserId: existing.ownerSubject });
      return existing;
    }
  } else {
    await circles.put(circle);
  }
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

/** KTACC-5 — `circle:<uuid-shaped digest>`: the same shape as a random id, so
 *  the `conversationId` slice and every id consumer are unchanged. The owner is
 *  in the digest, so one caller's key can never resolve to another's circle. */
function idempotentCircleId(tenantId: string, ownerSubject: string, key: string): string {
  const h = createHash('sha256').update(`kicktodo-circle|${tenantId}|${ownerSubject}|${key}`).digest('hex');
  return `circle:${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
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
/** KTA-3 — a grant row kept moving under four consecutive transition CASes. */
export class GrantConflictError extends Error {
  constructor() { super('Concurrent grant updates — retry.'); }
}

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
  // KTA-3 — every grant transition is a CAS against the row it read. The old
  // get-then-put let an accept that read `invited` land AFTER a concurrent
  // revoke and write `active` over it: the owner was told access was gone,
  // and the grantee kept it. A lost CAS re-reads, so the accept now sees the
  // revoke and is refused.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const g = await grants.get(`${ptr.tenantId}::${circleId}::${granteeSubject}`);
    if (!g || g.state === 'revoked') throw new CircleDeniedError();
    if (g.state === 'active') return g;
    const next: AccountabilityGrant = { ...g, state: 'active', acceptedAt: nowIso() };
    if (await grants.compareAndSwap(g, next)) return next;
  }
  throw new GrantConflictError();
}

/** KT-COHORT-FULL-GRANT-1 — true when {@link acceptGrant} would succeed (the
 *  grant exists and is not revoked), WITHOUT accepting it. `joinCohort` checks
 *  this before claiming a seat, so a full cohort never activates a grant. */
export async function grantAcceptable(circleId: string, granteeSubject: string): Promise<boolean> {
  const ptr = await circleIndex.get(circleId);
  if (!ptr) return false;
  const g = await grants.get(`${ptr.tenantId}::${circleId}::${granteeSubject}`);
  return g !== null && g.state !== 'revoked';
}

/** KTCOM-4 — whether ANY grant row (invited / active / revoked) exists for the
 *  subject in this circle. The seat reconcile repairs only a buyer the paid
 *  observer never reached, so an owner's revocation is never overridden. */
export async function grantRowExists(tenantId: string, circleId: string, subject: string): Promise<boolean> {
  return (await grants.get(`${tenantId}::${circleId}::${subject}`)) !== null;
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
  // KTA-3 — CAS, re-read on loss (see acceptGrant): a revoke that read
  // `invited` must not be overwritten by — nor overwrite — a concurrent accept
  // without seeing it.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const g = await grants.get(`${tenantId}::${circleId}::${granteeSubject}`);
    if (!g) throw new CircleDeniedError();
    if (g.state === 'revoked') return g;
    const next: AccountabilityGrant = { ...g, state: 'revoked', revokedAt: nowIso() };
    if (await grants.compareAndSwap(g, next)) {
      log.info('kicktodo_grant_revoked', { circleId, grantee: granteeSubject });
      return next;
    }
  }
  throw new GrantConflictError();
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

// ── KTACC-2 (KickTodo wave 4C) — circle end-of-life on the owner's erasure ──
/**
 * The name a handed-over circle carries. `name` is free text the departing owner
 * typed (`createCircle`), so it must not outlive their erasure; the route's own
 * default ("My circle") would read as the HEIR's possessive, hence a neutral one.
 */
export const HANDED_OVER_CIRCLE_NAME = 'Accountability circle';

export type CircleHandover =
  | { circleId: string; outcome: 'transferred'; newOwner: string }
  | { circleId: string; outcome: 'dissolved'; memberSubjects: string[] };

/** A member's join instant: when they accepted (an invite is not a join), else
 *  when they were invited — the owner's own self-grant is accepted at creation. */
const joinedAt = (g: AccountabilityGrant): string => g.acceptedAt ?? g.invitedAt;

function isLiveMember(g: AccountabilityGrant, nowMs: number): boolean {
  if (g.state !== 'active' || g.revokedAt) return false;
  return !(g.expiresAt && Date.parse(g.expiresAt) < nowMs);
}

/**
 * KTACC-2 — decided by the product owner 2026-10-17: a circle SURVIVES its owner's
 * erasure. Ownership passes to the LONGEST-STANDING remaining live member (earliest
 * join; ties broken by subject so the choice is deterministic across replays and
 * instances). With no live member left the circle DISSOLVES: its pointer, row and
 * every grant are deleted here, and the returned `dissolved` outcome tells the
 * caller (compliance.ts) to drop the cohort/seat/hold/session children this module
 * does not own.
 *
 * What the departing owner leaves behind is rewritten, never kept: the circle's
 * `ownerSubject` and free-text `name`, and `grantorSubject` on every grant they
 * issued (all of them — only the owner may invite). Their OWN self-grant is left
 * for `eraseSubjectGrants`, which deletes it in the same eraser pass.
 *
 * RACE-SAFE: every write is a CAS against the row read. The heir's grant is CASed
 * FIRST (promoting it to the owner's full scopes, the `createCircle` invariant), so
 * a concurrent revoke of the heir makes the promotion lose and the loop re-picks.
 * The circle CAS then refuses if another handover already moved it. And if the
 * heir disappears right after (their own concurrent erasure), the loop treats THEM
 * as departing and hands over again — so the circle never settles on an owner
 * with no grant. Idempotent: a circle no longer owned by `departingSubject`
 * returns null.
 */
export async function handOverCircle(
  tenantId: string,
  circleId: string,
  departingSubject: string,
): Promise<CircleHandover | null> {
  if (!tenantId || !circleId || !departingSubject) return null;
  const key = `${tenantId}::${circleId}`;
  let departing = departingSubject;
  let outcome: CircleHandover | null = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const c = await circles.get(key);
    if (!c || c.tenantId !== tenantId || c.ownerSubject !== departing) return outcome;
    const all = await grants.listByPrefix(`${tenantId}::${circleId}::`);
    const now = Date.now();
    const heirs = all
      .filter((g) => g.granteeSubject !== departing && isLiveMember(g, now))
      .sort((a, b) => joinedAt(a).localeCompare(joinedAt(b)) || a.granteeSubject.localeCompare(b.granteeSubject));
    if (heirs.length === 0) return await dissolveCircle(c, all);
    const heir = heirs[0];
    const promoted: AccountabilityGrant = {
      ...heir,
      scopes: [...GRANT_SCOPES],
      grantorSubject: heir.grantorSubject === departing ? heir.granteeSubject : heir.grantorSubject,
    };
    if (!(await grants.compareAndSwap(heir, promoted))) continue;
    if (!(await circles.compareAndSwap(c, { ...c, ownerSubject: heir.granteeSubject, name: HANDED_OVER_CIRCLE_NAME }))) continue;
    // Every other grant the departing owner issued now names the heir as grantor.
    for (const g of all) {
      if (g.grantorSubject !== departing || g.granteeSubject === departing || g.granteeSubject === heir.granteeSubject) continue;
      await rewriteGrantor(`${tenantId}::${circleId}::${g.granteeSubject}`, departing, heir.granteeSubject);
    }
    log.info('kicktodo_circle_handed_over', { circleId });
    outcome = { circleId, outcome: 'transferred', newOwner: heir.granteeSubject };
    if (await liveGrant(tenantId, circleId, heir.granteeSubject)) return outcome;
    departing = heir.granteeSubject; // the heir vanished concurrently — hand over again
  }
  throw new GrantConflictError();
}

async function rewriteGrantor(grantKey: string, from: string, to: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const g = await grants.get(grantKey);
    if (!g || g.grantorSubject !== from) return;
    if (await grants.compareAndSwap(g, { ...g, grantorSubject: to })) return;
  }
  throw new GrantConflictError();
}

/** No live member is left: delete the pointer FIRST (so no accept/join can land on
 *  a circle being removed), then the row, then every grant. A crash part-way leaves
 *  the row still owned by the departing subject, so a re-run of the eraser finishes. */
async function dissolveCircle(c: AccountabilityCircle, all: AccountabilityGrant[]): Promise<CircleHandover> {
  // The pointer is keyed by circle id alone; delete it only when it names THIS
  // tenant's circle (never another tenant's row under a colliding id).
  if ((await circleIndex.get(c.id))?.tenantId === c.tenantId) await circleIndex.delete(c.id);
  await circles.delete(`${c.tenantId}::${c.id}`);
  for (const g of all) await grants.delete(`${g.tenantId}::${g.circleId}::${g.granteeSubject}`);
  log.info('kicktodo_circle_dissolved', { circleId: c.id });
  return { circleId: c.id, outcome: 'dissolved', memberSubjects: [...new Set(all.map((g) => g.granteeSubject))] };
}

/** KTA-11 — the circles in this tenant anchored to one enrollment (a circle is
 *  always anchored to its OWNER's own enrollment — the create route checks it). */
export async function circlesAnchoredTo(tenantId: string, enrollmentId: string): Promise<AccountabilityCircle[]> {
  if (!tenantId || !enrollmentId) return [];
  return (await circles.listByPrefix(`${tenantId}::`)).filter((c) => c.tenantId === tenantId && c.enrollmentId === enrollmentId);
}

// ── ADR 0458 Phase 0 — compliance (subject erasure) ──
/**
 * DSAR erasure: delete every grant in this tenant where the subject is EITHER the
 * grantor OR the grantee. Deleting a grant carries revocation semantics (the same
 * effect as `revokeGrant`, minus the row-kept-for-history posture — a DSAR removes
 * the row): a grantee's access ends, and a grant the subject issued to others is
 * withdrawn. The circle rows themselves are shared PRODUCT resources (the ADR 0419
 * "a circle is a product resource, never workspace membership" framing), so they are
 * retained; erasure removes the subject's MEMBERSHIP, not other members' circle.
 * KTACC-2: a circle the subject OWNS is handed over (or dissolved) by
 * `handOverCircle` BEFORE this runs, so the grants the owner issued have already
 * been re-attributed to the heir and survive this grantor match.
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
