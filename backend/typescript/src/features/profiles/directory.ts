/**
 * ADR 0888 D1 — the ONE answer to "whose profiles may this reader see". The HTTP
 * route and the workflow surface both call it, so the two lanes can no longer
 * read different tenants or apply different floors (`PR2WF-1/2`).
 *
 * Two scopes:
 *   - `home`      — the reader is in their own home tenant: the tenant's profiles
 *                   (today's directory — a personal tenant, a SAML/`org:` tenant).
 *   - `workspace` — the reader is a workspace-ROOT member of the active tenant,
 *                   which is not their home. Profiles live in each person's home
 *                   tenant, so a workspace lists only people who SHARED their
 *                   profile with it (an explicit, per-workspace opt-in), each
 *                   re-verified as a live member on every read.
 *
 * The branch keys on home-vs-membership, NOT on the `ws:` id prefix: feature
 * default workspaces (`host-kicktodo`) are workspace roots without it.
 *
 * IDENTITY (ADR 0780 / row 8): a share row is joined to a person by an EXACT
 * `userId` point read, never by principal. Principal ids are not
 * issuer-qualified, so `scim:jsmith` in one tenant may be a different human from
 * `scim:jsmith` in another. Membership is re-checked with the subject that proved
 * it at share time (`memberSubject`), which can differ from the canonical
 * `userId` for a pre-bind split account.
 */

import type { Request } from 'express';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { isWorkspaceMember, listWorkspaceRootMembers } from '../../host/accessControlService.js';
import { callerSubject, tenantOf } from '../../host/requestSubject.js';
import { resolveSessionSubject } from '../../host/sessionAuthority.js';
import type { BundleScope } from '../../host/inMemorySurfaces.js';
import { OpenwopError } from '../../types.js';
import { resolveCallerUser } from '../users/usersGuards.js';
import { getUser, type User } from '../users/usersService.js';
import { registerSubjectEraser } from '../../host/subjectErasure.js';

export type DirectoryScope =
  | { kind: 'home'; tenantId: string }
  | { kind: 'workspace'; workspaceId: string };

/** One person's opt-in to be listed in one workspace's directory. */
export interface WorkspaceShare {
  workspaceId: string;
  userId: string;
  /** The subject that held the workspace-root membership when the share was
   *  made; membership is re-checked with this exact subject on every read. */
  memberSubject: string;
  sharedAt: string;
}

const shareKey = (workspaceId: string, userId: string): string => `${workspaceId}|${userId}`;
// The tenant index is the WORKSPACE, so a workspace read is bounded by the number
// of people who opted in — never by its member count (an auto-join workspace's
// members are every signup).
const shares = new DurableCollection<WorkspaceShare>(
  'profiles:ws-share',
  (s) => shareKey(s.workspaceId, s.userId),
  undefined,
  (s) => s.workspaceId,
);

/** The most people one workspace read returns; the route says when it truncated. */
export const WORKSPACE_DIRECTORY_CAP = 500;

// ── Route lane ──────────────────────────────────────────────────────────────

/** The route's reader: the canonical durable user (refuses anon/apikey via
 *  `resolveCallerUser`) and the scope the ACTIVE tenant puts them in. */
export async function resolveRouteDirectory(req: Request): Promise<{ viewer: User; scope: DirectoryScope; memberSubject?: string }> {
  const viewer = await resolveCallerUser(req);
  const active = tenantOf(req);
  if (active === viewer.tenantId) return { viewer, scope: { kind: 'home', tenantId: viewer.tenantId } };
  // The subject the auth middleware admitted this request with (`auth.ts` keys
  // workspace membership on it). Re-checked here: the middleware is not this
  // feature's authorization, it is the reason the active tenant is what it is.
  const subject = callerSubject(req);
  if (subject && (await isWorkspaceMember(subject, active))) {
    return { viewer, scope: { kind: 'workspace', workspaceId: active }, memberSubject: subject };
  }
  // Not home and not a member: the reader's own home directory, exactly what
  // this route served before ADR 0888. It names nobody outside that tenant.
  return { viewer, scope: { kind: 'home', tenantId: viewer.tenantId } };
}

// ── Run lane ────────────────────────────────────────────────────────────────

function refuse(reason: string, message: string): never {
  throw new OpenwopError(
    'forbidden_scope',
    `${message} Reading team profiles from a workflow needs the run to be started by a signed-in member (the run owner is stamped at creation and survives :fork).`,
    403,
    { reason },
  );
}

/** The run lane's reader. The route's two facts — the reader's home tenant and
 *  their workspace-root membership — decided for the run's acting user, who must
 *  be a durable, ACTIVE human: a system run, an API key, an anonymous session or
 *  a disabled/erased account is refused with a named reason (`PR2WF-1`). */
export async function resolveRunDirectory(scope: Pick<BundleScope, 'tenantId' | 'actingUserId'>): Promise<{ viewerUserId: string; scope: DirectoryScope }> {
  const actor = scope.actingUserId;
  if (!actor) refuse('no_acting_user', 'This run has no acting user (a webhook or event-started run), so there is nobody whose access could be checked.');
  // A durable account's `userId` is always `user:`-prefixed (`userIdFor`). Anything
  // else — an API key, an anonymous session, or a bearer caller whose account has
  // not been bound yet (`oidc:<sub>`) — is refused rather than aliased to a user:
  // principal ids are not issuer-qualified (ADR 0780), so the mapping is unsafe.
  if (!actor.startsWith('user:')) refuse('not_a_durable_user', 'This run was not started by a signed-in account (an API key, an anonymous session, or an account that has not finished signing in), so it cannot read team profiles.');
  const live = await resolveSessionSubject(actor);
  if (!live || live.status !== 'active') refuse('acting_user_disabled', 'The run\'s acting user is disabled or no longer exists.');
  const user = await getUser(actor);
  if (!user) refuse('acting_user_disabled', 'The run\'s acting user no longer exists.');
  if (user.tenantId === scope.tenantId) return { viewerUserId: actor, scope: { kind: 'home', tenantId: scope.tenantId } };
  if (await isWorkspaceMember(actor, scope.tenantId)) return { viewerUserId: actor, scope: { kind: 'workspace', workspaceId: scope.tenantId } };
  refuse('not_a_member', 'The run\'s acting user is not a member of this workspace.');
}

// ── Workspace shares ────────────────────────────────────────────────────────

/**
 * The workspace's CURRENT root members, read ONCE per request through the
 * bounded per-workspace index (`listWorkspaceRootMembers`). `PROF2CD-1`: the
 * first cut re-checked every share row with `isWorkspaceMember`, whose authoritative
 * "no" falls through to a deployment-wide member scan — so each departed sharer
 * cost a full scan per read. A directory may answer a false "no" (it only hides a
 * profile until the index heals); an auth check may not, which is why the
 * directory does not use the auth predicate's fallback.
 *
 * A row counts as a member under EITHER the subject that proved membership at
 * share time or the person's canonical `userId` (`PROF2CD-3`: binding an account
 * re-keys its member row `oidc:<sub>` → `user:<id>`, and the share must survive
 * that). Both are this person's own spellings; no principal is resolved to a user.
 */
async function rootMemberSubjects(workspaceId: string): Promise<Set<string>> {
  return new Set((await listWorkspaceRootMembers(workspaceId)).map((m) => m.subject).filter((x): x is string => Boolean(x)));
}

/** A share row is live iff the workspace still holds a root member keyed by one
 *  of this person's USER ids — the bound id that proved membership at share time,
 *  or the canonical `userId`. Only `user:` spellings count: a `userId` is globally
 *  unique, a principal (`oidc:`/`saml:`/`scim:`) is NOT issuer-qualified, and a
 *  member row keyed `scim:jsmith` may be a different human from the sharer whose
 *  own principal is also `scim:jsmith` (ADR 0780; the two-IdP witness). The share
 *  route refuses an unbound caller for the same reason, so a stored principal
 *  subject can only exist on a legacy row — and it is ignored here. */
function isLiveMember(row: WorkspaceShare, members: ReadonlySet<string>): boolean {
  return (row.memberSubject.startsWith('user:') && members.has(row.memberSubject)) || members.has(row.userId);
}

/** The live shares of one workspace: each row re-verified (still a root member,
 *  still an active user). A stale row is skipped, not deleted: a member who
 *  leaves and is re-admitted keeps the choice they made (stated in ADR 0888 D1). */
export async function listLiveShares(workspaceId: string): Promise<{ users: User[]; truncated: boolean }> {
  const rows = (await shares.listForTenantIndexed(workspaceId)).filter((r) => r.workspaceId === workspaceId);
  rows.sort((a, b) => a.sharedAt.localeCompare(b.sharedAt));
  const members = await rootMemberSubjects(workspaceId);
  const live = rows.filter((r) => isLiveMember(r, members));
  const users = (await Promise.all(live.slice(0, WORKSPACE_DIRECTORY_CAP).map((r) => getUser(r.userId))))
    .filter((u): u is User => u !== null && u.status === 'active');
  return { users, truncated: live.length > WORKSPACE_DIRECTORY_CAP };
}

/** One person's live share in one workspace, or null (no existence oracle: an
 *  unshared, departed or disabled person reads exactly like an unknown id, and
 *  every case pays the same bounded index read). */
export async function getLiveShare(workspaceId: string, userId: string): Promise<User | null> {
  const [row, members] = await Promise.all([shares.get(shareKey(workspaceId, userId)), rootMemberSubjects(workspaceId)]);
  if (!row || row.workspaceId !== workspaceId) return null;
  if (!isLiveMember(row, members)) return null;
  const user = await getUser(row.userId);
  return user && user.status === 'active' ? user : null;
}

/** The raw share row (unverified) — for the writer, which keeps the first `sharedAt`. */
export async function getShareRow(workspaceId: string, userId: string): Promise<WorkspaceShare | null> {
  const row = await shares.get(shareKey(workspaceId, userId));
  return row && row.workspaceId === workspaceId ? row : null;
}

export async function putShare(share: WorkspaceShare): Promise<void> {
  await shares.put(share);
}

export async function deleteShare(workspaceId: string, userId: string): Promise<boolean> {
  return shares.delete(shareKey(workspaceId, userId));
}

/** Test-only: the RAW share rows of one workspace (unverified). Erasure must
 *  remove the row itself — the read path hiding a dangling row is not erasure. */
export async function __rawWorkspaceShares(workspaceId: string): Promise<WorkspaceShare[]> {
  return (await shares.listForTenantIndexed(workspaceId)).filter((r) => r.workspaceId === workspaceId);
}

// An erasure run IN a workspace removes that workspace's share row for the
// subject. (The home-tenant eraser in `profilesService.ts` removes every share
// the profile lists, before it deletes the row.)
export async function eraseWorkspaceShare(tenantId: string, subjectKey: string): Promise<{ rowsTouched: number }> {
  if (!subjectKey) return { rowsTouched: 0 };
  // The erasure key may be the canonical `userId` OR the bound id that proved
  // membership (they differ for a pre-canonicalisation split account), so match
  // either — over THIS workspace's own index, which is bounded by its opt-ins.
  let touched = 0;
  for (const row of await shares.listForTenantIndexed(tenantId)) {
    if (row.workspaceId !== tenantId || (row.userId !== subjectKey && row.memberSubject !== subjectKey)) continue;
    if (await deleteShare(row.workspaceId, row.userId)) touched += 1;
  }
  return { rowsTouched: touched };
}
registerSubjectEraser(eraseWorkspaceShare);
