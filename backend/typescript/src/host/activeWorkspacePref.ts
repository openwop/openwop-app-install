/**
 * A subject's last-active workspace (ADR 0434 Phase 4).
 *
 * Before this, switching workspaces produced exactly ONE side effect: a
 * `Set-Cookie`. An exhaustive grep for any server-side persistence of the
 * active workspace returned zero hits, and every session-mint path hard-coded
 * `tenantId = personalTenant`. So the active workspace was device-local: switch
 * into a shared workspace on your laptop, open the app on your desktop, and you
 * silently landed in your personal tenant looking at different data — with no
 * error and no indication. That alone reproduces the "same account, different
 * data" report, with no failure condition required.
 *
 * OWNERSHIP. This is a genuinely NEW concept — "which workspace does this
 * subject default to" — and NOT a second copy of membership, which
 * `accessControlService` continues to own exclusively. Two candidate homes were
 * rejected in review:
 *   - the `User` record: keyed `(tenantId, principalId)`, so one human has
 *     MULTIPLE rows, one per tenant. Storing a cross-tenant preference there is
 *     circular — you would need to know the tenant to find the row that tells
 *     you the tenant.
 *   - `navigation-settings`: a menu-config store. Putting workspace state there
 *     would make it a second owner of a concept ADR 0015 assigns to workspaces.
 *
 * Keyed on SUBJECT, never tenant — that is the whole point.
 */

import { DurableCollection } from './hostExtPersistence.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('host.activeWorkspacePref');

export interface ActiveWorkspacePref {
  /** The RBAC subject (`oidc:<sub>` or a durable `userId`). The primary key. */
  subject: string;
  /** The tenant id the subject last switched into. */
  workspaceId: string;
  updatedAt: string;
}

const store = new DurableCollection<ActiveWorkspacePref>(
  'workspaces:active-pref',
  (p) => p.subject,
);

/** Record the subject's active workspace. Best-effort: a failure here must
 *  never break the switch itself, which has already succeeded on the session. */
export async function setActiveWorkspace(subject: string, workspaceId: string): Promise<void> {
  try {
    await store.put({ subject, workspaceId, updatedAt: new Date().toISOString() });
  } catch (err) {
    log.warn('active-workspace preference not persisted', { subject, workspaceId, err: String(err) });
  }
}

/**
 * The workspace to activate for `subject` at session-mint time, or null to use
 * their personal tenant.
 *
 * FAIL-CLOSED, and this is the security-critical part: the stored preference is
 * only honored after `isMember` confirms the subject is STILL a member. The
 * per-request revalidation in the auth middleware is not sufficient on its own —
 * without this check a removed member's stale preference would resurrect their
 * access for the life of the minted session. A revoked membership must not be
 * re-granted by a preference the user set while they still had it.
 */
export async function resolveActiveWorkspace(
  subject: string,
  personalTenant: string,
  isMember: (subject: string, workspaceId: string) => Promise<boolean>,
): Promise<string> {
  try {
    const pref = await store.get(subject);
    if (!pref) return personalTenant;
    if (pref.workspaceId === personalTenant) return personalTenant;
    if (!(await isMember(subject, pref.workspaceId))) {
      log.info('stored active workspace dropped — no longer a member', { subject, workspaceId: pref.workspaceId });
      return personalTenant;
    }
    return pref.workspaceId;
  } catch (err) {
    // Any doubt resolves to the personal tenant, which the caller always owns.
    log.warn('active-workspace resolution failed; using personal tenant', { subject, err: String(err) });
    return personalTenant;
  }
}

/** Forget the preference (used when a subject leaves a workspace). */
export async function clearActiveWorkspace(subject: string): Promise<void> {
  try {
    await store.delete(subject);
  } catch { /* best-effort */ }
}

/**
 * Clear the preference only if it currently points at `workspaceId` (ADR 0434
 * IDN-9). Used when a subject loses membership: their preference for OTHER
 * workspaces must survive, so an unconditional clear would be wrong.
 */
export async function clearActiveWorkspaceIfPointingAt(
  subject: string,
  workspaceId: string,
): Promise<void> {
  try {
    const pref = await store.get(subject);
    if (pref?.workspaceId === workspaceId) await store.delete(subject);
  } catch { /* best-effort — resolution fail-closes regardless */ }
}
