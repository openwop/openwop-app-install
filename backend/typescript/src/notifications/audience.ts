/**
 * ADR 0816 — who a notice is for, answered ONCE.
 *
 * Before this module, four delivery lanes (inbox SQL, the SSE filter, Web Push,
 * and the per-row state routes) each re-derived "who is told", and the two that
 * disagreed were the holes: Web Push treated every record without a
 * `recipientUserId` as a broadcast, so an ADR 0710 operator notice reached every
 * member's phone; and one shared row carried one status, so a Viewer's delete
 * removed a team notice for everyone. ADR 0710 already moved the EMIT decision
 * into one predicate (`runNoticeAudience`); this moves the DELIVERY decision.
 *
 * Three exports, one per question:
 *  - `notificationSubject(req)` (D0) — whose inbox a request is reading;
 *  - `effectiveNotificationRoles(roles)` (D2) — which roles a member holds for
 *    addressing purposes (an owner is an operator);
 *  - `materialiseRecipients(tenantId, role?)` (D1) — the people a shared-workspace
 *    broadcast or role notice is materialised for.
 */
import type { Request } from 'express';
import { isSharedWorkspaceTenant, isWorkspaceMember, listWorkspaceRootMembers } from '../host/accessControlService.js';

/**
 * D0 — the subject a request reads and mutates notifications as.
 *
 * In a shared `ws:` workspace this is the principal the auth middleware ADMITTED
 * the member under (`isWorkspaceMember(effectiveSubject, ws)` →
 * `req.principal.principalId`), which is by construction the member row's
 * `subject` — the same string D1 writes into `recipientUserId`. `req.userId` is
 * set only for BOUND sessions, so keying on it left an unbound OIDC member with
 * the unfiltered tenant view.
 *
 * Elsewhere it stays `req.userId` (personal tenants: unchanged). A wildcard
 * principal returns `undefined` — the unfiltered admin view.
 */
export function notificationSubject(req: Request): string | undefined {
  const tenants = req.principal?.tenants ?? [];
  if (tenants.includes('*')) return undefined;
  if (req.tenantId && isSharedWorkspaceTenant(req.tenantId)) {
    // An `owk_` key reads as the person who issued it (ADR 0601: the key's
    // authority IS its issuer's), so a CLI or integration sees its issuer's
    // inbox rather than an `apikey:<id>` nobody ever addresses.
    const auth = req.principal?.auth;
    if (auth?.kind === 'api-key' && typeof auth.issuer === 'string' && auth.issuer) return auth.issuer;
    return req.principal?.principalId || req.userId || undefined;
  }
  return req.userId ?? undefined;
}

/** D2 — the roles `subject` holds in workspace `tenantId` for addressing: the
 *  union over its root rows (legacy twins included, as D1 unions them), expanded.
 *  Read through the same per-tenant index as D1, so the emit side and the read
 *  side can never disagree about who holds a role. */
export async function subjectNotificationRoles(tenantId: string, subject: string): Promise<string[]> {
  const roles = new Set<string>();
  for (const m of await listWorkspaceRootMembers(tenantId)) {
    if (m.subject === subject) for (const r of m.roles) roles.add(r);
  }
  return effectiveNotificationRoles([...roles]);
}

/**
 * D2 — the roles a member holds FOR ADDRESSING. ADR 0710 names the operator
 * audience `admin`; a workspace owner's root row carries `owner`, so without the
 * expansion the owner never saw the workspace's run failures. Only the built-in
 * hierarchy edge that ADR names is expanded; a custom role has no hierarchy.
 */
export function effectiveNotificationRoles(roles: readonly string[]): string[] {
  const out = new Set(roles);
  if (out.has('owner')) out.add('admin');
  return [...out];
}

/**
 * D1 — the people a broadcast (`role` absent) or role-addressed notice in a
 * shared workspace is materialised for: the workspace's ROOT members that have a
 * subject (a descriptive member has nobody to notify), deduplicated by subject
 * with legacy twins' roles unioned (ADR 0697), filtered by role when one is
 * given. Returns `null` when the tenant is not a shared workspace, or has no
 * such member — the caller then keeps today's single row.
 *
 * Reads the bounded per-tenant member index (`listWorkspaceRootMembers`), not a
 * cross-tenant scan — this runs on every shared-workspace broadcast. See that
 * helper for the index's one accepted gap (a delayed marker).
 */
export async function materialiseRecipients(tenantId: string, role?: string): Promise<string[] | null> {
  if (!isSharedWorkspaceTenant(tenantId)) return null;
  const bySubject = new Map<string, Set<string>>();
  for (const m of await listWorkspaceRootMembers(tenantId)) {
    if (!m.subject) continue;
    const roles = bySubject.get(m.subject) ?? new Set<string>();
    for (const r of m.roles) roles.add(r);
    bySubject.set(m.subject, roles);
  }
  if (bySubject.size === 0) return null;
  const out: string[] = [];
  for (const [subject, roles] of bySubject) {
    if (role === undefined || effectiveNotificationRoles([...roles]).includes(role)) out.push(subject);
  }
  return out.sort();
}

/** D4 — is `subject` still present in shared workspace `tenantId`? Rides
 *  `isWorkspaceMember`, the auth middleware's own check (point-read fast path),
 *  so delivery and admission can never disagree. Non-`ws:` tenants have no
 *  membership-defined presence here, so they answer true. */
export async function isCurrentNotificationAudience(tenantId: string, subject: string | undefined): Promise<boolean> {
  if (!isSharedWorkspaceTenant(tenantId)) return true;
  if (!subject) return false;
  return isWorkspaceMember(subject, tenantId);
}
