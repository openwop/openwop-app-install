/**
 * Users store — durable identity records (ADR 0002, Phase 1).
 *
 * The foundational identity surface of the MyndHyve->openwop-app port. A `User`
 * is the durable, tenant-scoped record behind a principal: the existing auth
 * paths (oidcVerifier, cookie/session) produce a transient `req.principal`; this
 * gives that principal a record you can disable, list, and (in ADR 0006) assign
 * roles to. Backed by the same read-through, per-entity `DurableCollection` as
 * the CRM/roster surfaces — no schema migration.
 *
 * BOUNDARY (ADR 0002 §"principal/role boundary", finding H6): this captures raw
 * IdP `groups[]` onto the user at authentication time. Mapping groups -> roles
 * is RFC 0049 / RBAC and belongs to ADR 0006. NOTHING in this module decides
 * authorization — it only records identity.
 *
 * REPLAY/FORK (finding C4): a user's `userId` is STABLE across logins
 * (`upsertFromPrincipal` finds-or-creates by the `(tenantId, principalId)` join
 * key and never re-mints), so a run that stamped a creating principal resolves
 * to the same durable record on replay/fork even after the user is later
 * disabled — historical replay must not break when identity changes.
 */

import { createHash } from 'node:crypto';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { declarePiiFields } from '../../host/dataClassification.js';
import { registerSubjectEraser, registerSubjectKeyResolver } from '../../host/subjectErasure.js';
import type { HostEventOrigin } from '../../host/hostEventDispatcher.js';
import { userDeactivated, userProvisioned, userReactivated, type LifecycleReason } from './emit.js';

// ADR 0077 P1 — a User's email + display name are personal data (the `userId`
// itself is an opaque, non-PII principal id per RFC 0048, so it is NOT listed).
declarePiiFields('users.user', ['email', 'displayName']);

/** Account lifecycle state. `disabled` is FAIL-CLOSED (finding H5): a disabled
 *  user is denied; there is no fail-open path. */
export type UserStatus = 'active' | 'disabled';

/** Which auth method last minted/updated the record (provenance, not a role). */
export type UserSource = 'oidc' | 'password' | 'saml' | 'scim' | 'manual';
export const USER_SOURCES: readonly UserSource[] = ['oidc', 'password', 'saml', 'scim', 'manual'];

/** ADR 0622 D7 — who asserted the row's `email` (see `User.emailProvenance`).
 *  Review S1: provenance comes from the LANE that wrote the address, never from
 *  a request body's `source` — `createUser` takes it explicitly and defaults to
 *  `'self'` (fail-closed) when a caller omits it. */
export type EmailProvenance = 'idp' | 'admin' | 'self';

/** Review S2 — a row with NO provenance reads as `'self'`, the fail-closed
 *  meaning. App migration 20 (`backfillEmailProvenance`) stamps every legacy
 *  row once at boot, so on a migrated host this fallback only ever bites a row
 *  written without one. */
export const effectiveEmailProvenance = (u: Pick<User, 'emailProvenance'>): EmailProvenance => u.emailProvenance ?? 'self';

export interface User {
  userId: string;
  tenantId: string;
  /** The auth join key — `req.principal.principalId` (e.g. `oidc:<sub>`, later a
   *  SAML NameID or SCIM userName). Unique within a tenant. */
  principalId: string;
  /** RFC 0159 (ADR 0613) — the OPAQUE, IdP-stable subject id a SCIM IdP asserts
   *  (`externalId`), equal to the persistent SAML `NameID`. Persisted ONLY for
   *  `source:'scim'` records; it is the cross-lane LINK key the subject-link deny
   *  store is keyed on so a SCIM leaver fail-closes the linked SAML identity. NOT
   *  the durable `userId` (that stays a pure hash of the principal — LINK, not
   *  MERGE). */
  externalId?: string;
  /** RFC 0163 §B (ADR 0620) — the IdP entityID (SAML `<saml:Issuer>`) of the IdP
   *  that provisioned this SCIM record: the SCIM lane's trust-root identity,
   *  BOUND at provision/config time and never inferred from a later request. The
   *  SAML decision path compares the assertion's signed issuer against this value
   *  and refuses to form a cross-lane link across two distinct trust roots even
   *  when `externalId` collides. Persisted ONLY for `source:'scim'` records. */
  idpEntityId?: string;
  email?: string;
  /** ADR 0622 D7 (`ORGINV-9`) — WHO asserted `email`, written ONLY at the three
   *  email-write sites, each stating the provenance of ITS lane (review S1 —
   *  never derived from a request body's `source`): `createUser` (explicit —
   *  `'idp'` from the SCIM provisioner and the IdP first-login lanes, `'admin'`
   *  from the admin POST in a shared workspace / the demo seed, `'self'` from
   *  the admin POST under the personal-owner short-circuit; omitted ⇒ `'self'`),
   *  `upsertFromPrincipal` when the input carries an email (`'idp'` — the SAML
   *  ACS, SCIM re-provision, OIDC bind + lazy canonical fold (verified claim
   *  only), test seam), and `updateUser` with the caller's stated provenance
   *  (`'self'` when the actor is the target or acts under the implicit
   *  personal-owner short-circuit, else `'admin'`). The org-invitation
   *  accept/decline gates refuse a `'self'`-asserted address (`403
   *  email_unverified`): the token is the credential; the email match is
   *  defense-in-depth, and an unverified self-set address is no defense.
   *  Absent ⇒ `'self'` (review S2, fail-closed; migration 20 stamps legacy rows). */
  emailProvenance?: EmailProvenance;
  displayName?: string;
  /** Raw IdP group membership captured at auth time. Group->role mapping is
   *  ADR 0006 (RBAC) — this is just what the IdP asserted, verbatim. */
  groups: string[];
  source: UserSource;
  status: UserStatus;
  /** ADR 0621 D2 — the session epoch. Every user-tier cookie is stamped with
   *  the epoch current at mint (`SessionPayload.epoch`); the auth middleware
   *  compares per request and refuses a mismatch as `session_revoked`. Bumped
   *  ONLY by {@link bumpSessionEpoch}: disable, erase, "sign out everywhere"
   *  (admin + self), and authenticator removal. Re-enable does NOT reset it — a
   *  re-enabled user signs in again; old cookies stay dead by construction.
   *  Absent on legacy rows ⇒ 0. */
  sessionEpoch?: number;
  createdAt: string;
  updatedAt: string;
}

const store = new DurableCollection<User>('users:user', (u) => u.userId);

/** The user's current session epoch (legacy rows carry none ⇒ 0). */
export function sessionEpochOf(user: Pick<User, 'sessionEpoch'>): number {
  return typeof user.sessionEpoch === 'number' && Number.isFinite(user.sessionEpoch) ? user.sessionEpoch : 0;
}

/** Bounded CAS retry budget for the epoch bump — two admins revoking the same
 *  user at once is the realistic worst case; a lost write here would leave a
 *  session alive that was told it is dead, so the loop never falls back to a
 *  blind `put`. */
const EPOCH_CAS_ATTEMPTS = 5;

/**
 * ADR 0621 D2 — the ONE epoch writer. Read-CAS-retry on the row (the
 * `DurableCollection.compareAndSwap` atomic primitive, correct across
 * instances), so two concurrent bumps both land (+2), never one overwriting
 * the other. `mutate` lets a lifecycle write (disable) ride the SAME swap so
 * "status = disabled" and "epoch + 1" are one atomic row transition — a crash
 * between two separate writes could otherwise disable the row without ending
 * its sessions. Returns the updated row, or `null` when no row exists.
 */
export async function bumpSessionEpoch(
  userId: string,
  mutate?: (row: User) => User,
): Promise<User | null> {
  return swapUserRow(userId, (existing) => {
    const base = mutate ? mutate(existing) : existing;
    return { ...base, sessionEpoch: sessionEpochOf(existing) + 1 };
  });
}

/**
 * The ONE read-CAS-retry loop over a user row (ADR 0621 D2 mechanism; review
 * SHOULD-3 of ADR 0617 widened it to every lifecycle write). `mutate` is
 * re-run against the row the swap is attempted on, so a decision taken inside
 * it ("did the status actually change?") is decided on the row that LANDS —
 * never on a stale pre-read. Returning `null` from `mutate` means "nothing to
 * write": the current row is returned untouched, with no swap attempted.
 * Returns `null` when no row exists.
 */
async function swapUserRow(
  userId: string,
  mutate: (row: User) => User | null,
): Promise<User | null> {
  for (let attempt = 0; attempt < EPOCH_CAS_ATTEMPTS; attempt += 1) {
    const existing = await store.get(userId);
    if (!existing) return null;
    const base = mutate(existing);
    if (base === null) return existing;
    const next: User = { ...base, updatedAt: new Date().toISOString() };
    if (await store.compareAndSwap(existing, next)) return next;
  }
  // Review SHOULD-5 — a typed, retryable refusal, not a bare 500: the row is
  // being written concurrently (two admins revoking at once); the caller can
  // simply retry. Nothing was lost — no attempt fell back to a blind put.
  throw new OpenwopError(
    'conflict',
    `The account's session epoch is being updated concurrently; retry.`,
    409,
    { retry: true, userId, attempts: EPOCH_CAS_ATTEMPTS },
  );
}

/** Tenant's users, newest first. */
export async function listUsers(tenantId: string): Promise<User[]> {
  const all = await store.list();
  return all.filter((u) => u.tenantId === tenantId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function getUser(userId: string): Promise<User | null> {
  return store.get(userId);
}

/** Look a user up by the auth join key `(tenantId, principalId)`.
 *
 *  USERS-3: this is an AUTH HOT PATH (every `upsertFromPrincipal` — i.e. every
 *  login/reconciliation — calls it), and `userIdFor` is a pure hash of exactly
 *  the join key, so the common case is a POINT READ of the deterministic id.
 *  The full scan survives ONLY as a fallback for legacy rows minted before the
 *  deterministic id existed (randomUUID-era records are keyed by an unrelated
 *  id, and re-keying them would break every owner/assignee field + replay that
 *  stamped the old id — see the REPLAY/FORK note above). */
export async function getUserByPrincipal(tenantId: string, principalId: string): Promise<User | null> {
  const direct = await store.get(userIdFor(tenantId, principalId));
  // Verify the join key rather than trusting the hash alone — fail-closed on
  // the (astronomically unlikely) collision, falling through to the scan.
  if (direct && direct.tenantId === tenantId && direct.principalId === principalId) return direct;
  const all = await store.list();
  return all.find((u) => u.tenantId === tenantId && u.principalId === principalId) ?? null;
}

/** Manually create a user (admin path). For auth-driven creation use
 *  `upsertFromPrincipal`, which is idempotent across logins. */
/** DETERMINISTIC durable id for a `(tenantId, principalId)` — so concurrent
 *  first-access reconciliations converge on ONE row (same key, last-writer-wins)
 *  instead of racing the unindexed get-then-put to two `randomUUID()` records.
 *  Same hazard + fix as `personalOwnerMemberId` (ADR 0015 Phase 2). Fixed at
 *  creation and never re-derived — account-linking adds `linkedIds`, it does not
 *  re-key the `userId` — so coupling the id to the *primary* principal is safe. */
/** Exported for ROUTE TESTS that must know the caller's subject BEFORE minting a
 *  session: RBAC membership is keyed on this exact value (`isWorkspaceMember`
 *  matches `m.subject === session.userId`), so a test provisioning membership has
 *  to derive it rather than guess. Exported rather than re-implemented in the
 *  test, because a duplicated hash silently diverges the day this format changes
 *  — and it would diverge into a test that passes while proving nothing. */
export function userIdFor(tenantId: string, principalId: string): string {
  return `user:${createHash('sha256').update(`${tenantId}:${principalId}`).digest('hex').slice(0, 32)}`;
}

/**
 * ADR 0617 D1 — the ONE funnel every creator delegates to (admin POST, SCIM
 * `provisionUser`, `upsertFromPrincipal` for SSO first-login + lazy
 * `resolveCallerUser`, the canonical fold `resolveCanonicalUserForTenant`, and
 * `host/demoPeopleSeed.ts`), so `host.users.user.provisioned` is emitted HERE
 * and nowhere else, on a NEW row only (the idempotent `existing` return emits
 * nothing). `silent` is for the demo seed: N seeded coworkers must not fan out
 * N `provisioned` events to webhooks + bindings.
 */
export async function createUser(input: {
  tenantId: string;
  principalId: string;
  externalId?: string;
  idpEntityId?: string;
  email?: string;
  displayName?: string;
  groups?: string[];
  source?: UserSource;
  status?: UserStatus;
  /** Review S1 — WHO asserted `email`, stated by the calling LANE. Ignored
   *  without an email; omitted WITH one ⇒ `'self'` (fail-closed). Never derive
   *  it from `source`: the admin POST accepts `source` from the request body,
   *  so `source:'saml'` there is a claim, not a lane. */
  emailProvenance?: EmailProvenance;
}, opts: { silent?: boolean } = {}): Promise<User> {
  const existing = await getUserByPrincipal(input.tenantId, input.principalId);
  if (existing) return existing; // idempotent: never two records per principal
  const now = new Date().toISOString();
  const user: User = {
    userId: userIdFor(input.tenantId, input.principalId),
    tenantId: input.tenantId,
    principalId: input.principalId,
    groups: input.groups ?? [],
    source: input.source ?? 'manual',
    status: input.status ?? 'active',
    createdAt: now,
    updatedAt: now,
    ...(input.externalId ? { externalId: input.externalId } : {}),
    ...(input.idpEntityId ? { idpEntityId: input.idpEntityId } : {}),
    ...(input.email ? { email: input.email, emailProvenance: input.emailProvenance ?? 'self' } : {}),
    ...(input.displayName ? { displayName: input.displayName } : {}),
  };
  await store.put(user);
  if (!opts.silent) userProvisioned({ userId: user.userId, tenantId: user.tenantId, source: user.source });
  return user;
}

/**
 * Resolve a SCIM-provisioned user by its opaque IdP `externalId` (RFC 0159 /
 * ADR 0613). IDOR-guarded like `resolveScimUser`: matches ONLY within `tenantId`
 * AND ONLY `source:'scim'` records — a SCIM bearer must never reach a
 * password/OIDC user that merely shares the tenant, and the externalId is a
 * SCIM-realm concept. A full scan (there is no externalId index), acceptable on
 * the cold provisioning/deactivation lane — never the auth hot path.
 */
export async function getScimUserByExternalId(tenantId: string, externalId: string): Promise<User | null> {
  if (!tenantId || !externalId) return null;
  const all = await store.list();
  return all.find((u) => u.tenantId === tenantId && u.source === 'scim' && u.externalId === externalId) ?? null;
}

/**
 * Find-or-create the durable record for an authenticated principal — the
 * reconciliation seam the auth paths call so a transient `req.principal` becomes
 * a durable `User` (ADR 0002 Phase 1). Idempotent and STABLE: the `userId`
 * persists across logins (finding C4); subsequent logins refresh `email` /
 * `displayName` / `groups` / `source` but never re-mint the id and never flip a
 * `disabled` status back to active (only the explicit lifecycle call does that —
 * fail-closed, finding H5).
 */
export async function upsertFromPrincipal(input: {
  tenantId: string;
  principalId: string;
  email?: string;
  displayName?: string;
  groups?: string[];
  source?: UserSource;
}): Promise<User> {
  const existing = await getUserByPrincipal(input.tenantId, input.principalId);
  if (!existing) {
    // Every caller of THIS funnel is an identity-provider lane (see the
    // `emailProvenance` docblock), so an email here is IdP-asserted.
    return createUser({
      ...input,
      source: input.source ?? 'oidc',
      ...(input.email !== undefined ? { emailProvenance: 'idp' as const } : {}),
    });
  }
  const next: User = { ...existing, updatedAt: new Date().toISOString() };
  // ADR 0622 D7 — an email on this lane was asserted by the identity provider
  // (SAML ACS, SCIM re-provision, the OIDC/test-seam bind); never by the user.
  if (input.email !== undefined) { next.email = input.email; next.emailProvenance = 'idp'; }
  if (input.displayName !== undefined) next.displayName = input.displayName;
  if (input.groups !== undefined) next.groups = input.groups;
  if (input.source !== undefined) next.source = input.source;
  // NOTE: status is intentionally NOT touched here — a disabled user staying
  // signed in does not silently re-activate (fail-closed).
  await store.put(next);
  return next;
}

/** Update mutable profile fields (admin/self path). Identity keys
 *  (`userId`/`principalId`/`tenantId`) and `status` are not editable here.
 *  ADR 0622 D7 — a caller that sets `email` states its provenance (`'self'`
 *  when the actor is the target or the implicit personal owner, `'admin'` when
 *  a shared-workspace manager vouches for it, `'idp'` on the SCIM re-provision
 *  lane); omitted ⇒ `'admin'`, the pre-D7 meaning of this path. Clearing the
 *  email clears the provenance with it. */
export async function updateUser(
  userId: string,
  patch: { email?: string | null; displayName?: string | null; groups?: string[]; idpEntityId?: string; emailProvenance?: EmailProvenance },
): Promise<User | null> {
  const existing = await store.get(userId);
  if (!existing) return null;
  const next: User = { ...existing, updatedAt: new Date().toISOString() };
  if (patch.groups !== undefined) next.groups = patch.groups;
  // RFC 0163 §B — backfill the SCIM trust-root entityID when a re-provision now
  // carries it and the record predates it. Never CLEARED here (a link that lost
  // its trust root must be reconfigured, not silently unbound).
  if (patch.idpEntityId) next.idpEntityId = patch.idpEntityId;
  if (patch.email !== undefined) {
    if (patch.email === null || patch.email === '') { delete next.email; delete next.emailProvenance; }
    else { next.email = patch.email; next.emailProvenance = patch.emailProvenance ?? 'admin'; }
  }
  if (patch.displayName !== undefined) {
    if (patch.displayName === null || patch.displayName === '') delete next.displayName;
    else next.displayName = patch.displayName;
  }
  await store.put(next);
  return next;
}

/**
 * The account lifecycle (disable/enable). Disabling is the fail-closed control
 * (finding H5). WHERE a disabled user is denied (ADR 0621 — this docblock used
 * to say "at the resolver", which named nothing): (1) every session MINT refuses
 * a non-`active` row before issuing a cookie — password/OIDC bind
 * (`authRoutes.ts`), the SAML ACS (`routes/authSamlSso.ts`), the workspace
 * switch (`routes/workspaces.ts`), the test seam; (2) every LIVE session is
 * refused per request by `middleware/auth.ts` `assertSessionSubjectLive`
 * through the `host/sessionAuthority.ts` seam this feature registers
 * (`401 account_disabled`, cookie cleared); (3) `disabled` ALSO bumps the
 * session epoch in the SAME atomic write, so a cookie minted before the disable
 * is dead on epoch even if the status read were ever bypassed. Re-enable does
 * NOT reset the epoch (a re-enabled user signs in again).
 */
export async function setUserStatus(
  userId: string,
  status: UserStatus,
  opts: { reason: LifecycleReason; origin?: HostEventOrigin },
): Promise<User | null> {
  // ADR 0617 D1 — the ONLY status writer, so `host.users.user.deactivated` /
  // `.reactivated` are emitted from THIS site and nowhere else, and ONLY on a
  // transition: a SCIM/IdP retry on an already-disabled row (the D5
  // compensation) must not start a second offboarding run. `changed` is decided
  // on the row the write actually LANDS on — inside the CAS mutate on BOTH
  // lanes (review SHOULD-3: the re-enable lane used to be get→put, so two
  // concurrent re-enables each read `disabled`, both emitted `reactivated`, and
  // a blind put could clobber an epoch bump that landed in between).
  let changed = false;
  let updated: User | null;
  if (status === 'disabled') {
    // ADR 0621 D2 — the third write of the leaver sequence rides the disable
    // itself: admin Disable, SCIM `deactivateUser` and `setScimActive(false)`
    // all funnel through here, so every disable lane ends live sessions.
    updated = await bumpSessionEpoch(userId, (row) => {
      changed = row.status !== status;
      return { ...row, status };
    });
  } else {
    // Re-enable does NOT bump the epoch (a re-enabled user signs in again; old
    // cookies stay dead by construction) — same swap loop, no epoch increment,
    // and an already-active row is left untouched (no write, no event).
    updated = await swapUserRow(userId, (row) => {
      changed = row.status !== status;
      return changed ? { ...row, status } : null;
    });
  }
  if (updated && changed) {
    const event = { userId: updated.userId, tenantId: updated.tenantId, source: updated.source, reason: opts.reason, ...(opts.origin ? { origin: opts.origin } : {}) };
    if (status === 'disabled') userDeactivated(event);
    else userReactivated(event);
  }
  return updated;
}

export async function deleteUser(userId: string): Promise<boolean> {
  return store.delete(userId);
}

// ADR 0077/0081 P5 — DSAR erasure. `subjectKey` is an anon id OR a `User.userId`
// (the profiles-eraser precedent), so the lookup is a tenant-guarded point-get.
// The user row is the AUTH JOIN record — `principalId` maps logins, `userId` is
// what every owner/assignee field resolves for display, and historical replay
// must not break when identity changes (REPLAY/FORK note above) — so erasure
// SCRUBS the declared PII fields (`email`, `displayName`) in place and keeps the
// opaque skeleton. Deleting the account is `deleteUser` (an explicit admin
// action), never this seam. Fail-closed on a falsy subject / foreign tenant;
// idempotent (a second erasure finds nothing left to scrub).
const userEraser = async (tenantId: string, subjectKey: string): Promise<{ rowsTouched: number }> => {
  if (!subjectKey) return { rowsTouched: 0 };
  const existing = await store.get(subjectKey);
  if (!existing || existing.tenantId !== tenantId) return { rowsTouched: 0 }; // fail-closed, tenant-scoped
  if (existing.email === undefined && existing.displayName === undefined) return { rowsTouched: 0 };
  const next: User = { ...existing, updatedAt: new Date().toISOString() };
  delete next.email;
  delete next.displayName;
  await store.put(next);
  // WF-TWIN-3 — REPORT. This is the one eraser that must touch a row in any real
  // subject deletion, so a zero here is the sharpest available signal that the
  // fan-out was handed a tenant the subject's data does not live in.
  return { rowsTouched: 1 };
};
registerSubjectEraser(userEraser);

/**
 * ADR 0622 D6 (`ORGINV-8`) — the userId → EMAIL subject-key resolver. The users
 * erase route hands `eraseSubject` a `User.userId`; email-keyed stores (a
 * pending org invitation to that address, CRM/analytics identity rows) were
 * unreachable from it — only the consent DSAR route, which takes an email key
 * directly, could reach them. This resolver expands a userId to the row's
 * stored email (store-backed and tenant-guarded — never a heuristic match, the
 * ADR 0381 over-erasure rule) so erasing a joined user by id also reaches the
 * invitation that brought them in. DELIBERATE WIDENING, recorded: every
 * email-keyed eraser now also runs for a by-userId erasure of that person.
 * Runs UPFRONT (before any eraser), so `userEraser` scrubbing the email
 * afterwards cannot hide it from the expansion.
 */
export async function usersEmailKeyResolver(tenantId: string, subjectKey: string): Promise<readonly string[]> {
  if (!tenantId || !subjectKey || subjectKey.includes('@')) return [];
  const user = await store.get(subjectKey);
  if (!user || user.tenantId !== tenantId || !user.email) return [];
  return [user.email.trim().toLowerCase()];
}
registerSubjectKeyResolver(usersEmailKeyResolver);


/**
 * Fail-closed activity check (finding H5): true ONLY when a durable record
 * exists for the principal AND its status is `active`. An unknown principal or a
 * disabled one is denied. CALLERS (2026-09, ADR 0621 docblock correction —
 * this used to promise "cross-surface enforcement is wired in ADR 0006 with
 * RBAC", which never happened through this function): its one live caller is
 * the SCIM seam's `isPrincipalResolvable` proof point. Cross-surface
 * enforcement of `disabled` is NOT this predicate — it is the per-request
 * `assertSessionSubjectLive` read in `middleware/auth.ts` via the
 * `host/sessionAuthority.ts` seam (keyed on `userId`, not the principal) plus
 * the mint-site refusals listed on `setUserStatus`.
 */
export async function isActiveUser(tenantId: string, principalId: string): Promise<boolean> {
  const user = await getUserByPrincipal(tenantId, principalId);
  return user?.status === 'active';
}

// ── Canonical identity per personal tenant (one human → one durable user) ──
//
// In the personal-tenant model (Firebase/OIDC: every human owns a single
// `user:<hash(issuer:uid)>` tenant), the SAME human reaches the host over more
// than one auth channel — an `oidc:<sub>` bearer, a bound user-tier cookie
// (`user:<userId>`), an unbound `session:<sid>`. `upsertFromPrincipal` keys the
// durable user on the *principal*, so those channels mint/resolve DIFFERENT
// users, and per-user data (profile, pinned agents, notification prefs) silently
// fragments across them (caught 2026-06-12: a pinned agent written on the oidc
// identity was invisible to reads on the bound-cookie identity).
//
// The fix: ONE canonical durable user per personal tenant, resolved by the
// stable tenant key (not the volatile principal). A pointer row maps the home
// tenant → the chosen userId. First resolution ADOPTS a pre-existing
// principal-keyed record if one exists (legacy / pre-canonical logins),
// preferring an `oidc` record (the federated identity) so two split rows
// converge on the one that holds the user's data — no data migration needed.
//
// SAFETY: only valid for a SINGLE-HUMAN tenant (`user:` personal tenants, which
// derive 1:1 from the OIDC subject). A shared/org tenant has many humans on one
// tenantId — callers MUST NOT route it here (resolveCallerUser gates on the
// `user:` prefix), or distinct humans would collapse onto one record.
interface CanonicalUserRow {
  homeTenant: string;
  userId: string;
}
// tenantOf: `homeTenant` IS the tenant this canonical pointer belongs to, so tenant
// teardown reaches it (else the {homeTenant,userId} pointer orphans — the RATCHET-BLINDSPOT class).
const canonicalByTenant = new DurableCollection<CanonicalUserRow>('users:canonical', (r) => r.homeTenant, undefined, (r) => r.homeTenant);

/**
 * ADR 0621 D1 (rev. 2, review BLOCKER-1) — the READ-ONLY canonical resolution
 * for a personal tenant, registered as the middleware's unbound-lane session
 * authority. It never creates: an `oidc:<sub>` bearer whose human was disabled
 * or erased must be refused BEFORE any route (and before the promotion mint)
 * can reach the creating fold below.
 *
 * Resolution order, all keyed point reads (no scan on the request path — the
 * ADR 0015 §0 invariant):
 *   1. the `users:canonical` pointer → `getUser` (the hot path once `/me` has
 *      run; a DANGLING pointer is the erase TOMBSTONE — see
 *      {@link tombstoneCanonicalPointer});
 *   2. the deterministic `(homeTenant, subject)` id the OIDC bind mints under
 *      (`upsertFromPrincipal` → `userIdFor`) — a bound-then-disabled human whose
 *      `/me` never ran has a row but no pointer yet.
 * A legacy randomUUID-era row with no pointer is NOT found here (that would need
 * the fold's scan) — it gains its pointer the first time `/me` resolves it,
 * which the SPA does on boot, so the gap is one request wide at most.
 */
export async function resolveCanonicalUserReadOnly(
  homeTenant: string,
  subject: string,
): Promise<{ user: User } | { erased: true; userId: string } | null> {
  const ptr = await canonicalByTenant.get(homeTenant);
  if (ptr) {
    const u = await getUser(ptr.userId);
    return u ? { user: u } : { erased: true, userId: ptr.userId };
  }
  const direct = await store.get(userIdFor(homeTenant, subject));
  if (direct && direct.tenantId === homeTenant && direct.principalId === subject) return { user: direct };
  return null;
}

/**
 * Make the admin erase leave a TOMBSTONE (ADR 0621 rev. 2, the erase family of
 * BLOCKER-1): pin the canonical pointer of a `user:`-shaped personal tenant to
 * the row about to be deleted, so that once `deleteUser` runs the pointer
 * dangles and BOTH `resolveCanonicalUserReadOnly` (the middleware) and the
 * creating fold refuse with `account_erased` instead of silently minting a
 * fresh active row for the same IdP identity. No-op for a shared/org tenant
 * (identity there is principal-keyed) and when the pointer already names a
 * DIFFERENT row (the human's real row survives; e.g. a demo-seeded coworker
 * row being cleared must never tombstone the human). The tenant teardown of
 * the personal tenant (self-service account delete) removes the pointer —
 * that lane is a clean slate by design, this one is an admin's "this human is
 * gone".
 */
export async function tombstoneCanonicalPointer(target: Pick<User, 'tenantId' | 'userId'>): Promise<boolean> {
  if (!target.tenantId.startsWith('user:')) return false;
  const ptr = await canonicalByTenant.get(target.tenantId);
  if (ptr && ptr.userId !== target.userId) return false;
  if (!ptr) await canonicalByTenant.put({ homeTenant: target.tenantId, userId: target.userId });
  return true;
}

export async function resolveCanonicalUserForTenant(input: {
  homeTenant: string;
  principalId: string;
  source: UserSource;
  email?: string;
  displayName?: string;
}): Promise<User> {
  const ptr = await canonicalByTenant.get(input.homeTenant);
  if (ptr) {
    const u = await getUser(ptr.userId);
    if (u) return applyIdpEmail(u, input.email); // hot path: a point lookup, no scan (the fold is a no-op unless the verified address differs)
    // ADR 0621 rev. 2 — a DANGLING pointer is the erase tombstone. This used to
    // "fall through and re-pick", which re-created an ACTIVE row for an erased
    // human on their very next bearer request (review BLOCKER-1, erase family).
    // Refuse instead: the creating path below is for a human this host has
    // never seen, not for one an admin removed.
    throw new OpenwopError('account_erased', 'This account no longer exists. Sign in again.', 401, {});
  }
  // Adopt a pre-existing record for this human, if any (the legacy split rows).
  // Prefer the federated `oidc` identity, then the oldest as a stable tiebreak.
  const existing = (await listUsers(input.homeTenant)).slice().sort((a, b) => {
    if ((a.source === 'oidc') !== (b.source === 'oidc')) return a.source === 'oidc' ? -1 : 1;
    return a.createdAt.localeCompare(b.createdAt);
  });
  const chosen =
    existing[0] ??
    (await createUser({
      tenantId: input.homeTenant,
      principalId: input.principalId,
      source: input.source,
      // ADR 0622 D7 / USERS-20 — the ONLY email that reaches this fold is the
      // bearer's `email_verified` claim (`req.oidcEmail`): IdP-asserted.
      ...(input.email !== undefined ? { email: input.email, emailProvenance: 'idp' as const } : {}),
      ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
    }));
  await canonicalByTenant.put({ homeTenant: input.homeTenant, userId: chosen.userId });
  return applyIdpEmail(chosen, input.email);
}

/**
 * ADR 0622 D7 / USERS-20 — fold an IdP-VERIFIED email into an existing row.
 * A no-op on the hot path (same address, already `'idp'`); otherwise the
 * verified claim REPLACES whatever the row held — an admin-vouched or
 * self-set address is weaker than the IdP's attestation, and a row that has
 * none gains one. The caller MUST pass only a verified address (the middleware
 * drops unverified claims before they reach `req.oidcEmail`), so an
 * unverified claim can never overwrite an IdP email: it never gets here.
 */
export async function applyIdpEmail(user: User, verifiedEmail: string | undefined): Promise<User> {
  if (verifiedEmail === undefined) return user;
  if (user.email === verifiedEmail && user.emailProvenance === 'idp') return user;
  const next: User = { ...user, email: verifiedEmail, emailProvenance: 'idp', updatedAt: new Date().toISOString() };
  await store.put(next);
  return next;
}

/**
 * Review S2 (ADR 0622 D7 correction) — the ONE-SHOT boot stamp for rows that
 * predate `emailProvenance` (app migration 20). Provenance cannot be re-derived
 * from history, so it is assigned from the row's LANE, conservatively:
 * `'idp'` iff `source ∈ {saml, scim}` (those lanes only ever wrote IdP
 * addresses); `'self'` iff the row lives in a personal tenant (`user:` /
 * `anon:` — the only writer there was the person, via the personal-owner
 * short-circuit); else `'admin'` (a shared-workspace row: the admin POST/PATCH
 * or the demo seed). `source:'oidc'` is deliberately NOT `'idp'`: the OIDC
 * lane never wrote an email before USERS-20, so an OIDC row's address came from
 * a human PATCH. Idempotent (a stamped row no longer matches), per-row CAS
 * (concurrent boots converge), never throws (per-row failures are counted —
 * migration 16's invariant-4 lesson).
 */
export async function backfillEmailProvenance(): Promise<{
  examined: number; stamped: number; idp: number; self: number; admin: number; casLost: number; failed: number;
}> {
  const { isPersonalTenantId } = await import('../../host/requestSubject.js');
  const r = { examined: 0, stamped: 0, idp: 0, self: 0, admin: 0, casLost: 0, failed: 0 };
  for (const u of await store.list()) {
    r.examined += 1;
    if (!u.email || u.emailProvenance !== undefined) continue;
    const provenance: EmailProvenance =
      u.source === 'saml' || u.source === 'scim' ? 'idp'
        : isPersonalTenantId(u.tenantId) ? 'self'
          : 'admin';
    try {
      if (await store.compareAndSwap(u, { ...u, emailProvenance: provenance })) {
        r.stamped += 1;
        r[provenance] += 1;
      } else {
        r.casLost += 1;
      }
    } catch {
      r.failed += 1;
    }
  }
  return r;
}

/** Test-only: clear all users. */
export async function __resetUsersStore(): Promise<void> {
  await store.__clear();
  await canonicalByTenant.__clear();
}
