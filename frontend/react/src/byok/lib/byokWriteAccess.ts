/**
 * ADR 0779 D7 — presentation of the BYOK WRITE authority.
 *
 * Every key-store write (add/delete a key, the chat binding, the headless AI
 * default, compat endpoints) requires `host:byok:manage` in a shared workspace
 * (ADR 0711, widened to `ai-default` + compat by ADR 0779 D1). A member without
 * it used to be offered every control and see the raw
 * `POST /host/openwop-app/byok/secrets → 403 …` text. These helpers let a
 * surface hide what the caller cannot do and say plainly why a write failed.
 * The backend stays the authority.
 *
 * ADR 0780 promoted the implementation to `lib/writeAccess.ts` (scope-
 * parameterised) so connections could reuse it; these names stay as thin
 * byok-scoped wrappers so no byok caller changed.
 */
import { canWriteWithScope, useScopeWriteAccess, writeErrorMessage } from '../../lib/writeAccess.js';

export const BYOK_MANAGE_SCOPE = 'host:byok:manage';

/**
 * May the caller change this workspace's keys? FAIL-OPEN — see
 * `lib/writeAccess.ts` (the shared helper this row's copy was promoted to by
 * ADR 0780); only a resolved MEMBER lacking `host:byok:manage` reads as read-only.
 */
export function canManageByok(access: { basis: string; scopes: readonly string[]; superadmin?: boolean }, resolved: boolean): boolean {
  return canWriteWithScope(access, resolved, BYOK_MANAGE_SCOPE);
}

export function useByokWriteAccess(): boolean {
  return useScopeWriteAccess(BYOK_MANAGE_SCOPE);
}

/** The message for a failed BYOK read or write — the shared
 *  `writeErrorMessage` (403 → `common:error_forbidden`, an explained 4xx → the
 *  server's sentence, else the localized classification). */
export const byokErrorMessage = writeErrorMessage;

/** What a `409` from `DELETE /byok/secrets/:ref` said (ADR 0499 / ADR 0779 D2). */
export interface DeleteConflict {
  /** The consumers the server named — empty when it could not check. */
  references: string[];
  /** False when the server could not verify what uses the key. */
  referencesKnown: boolean;
  /** Set when another lifecycle owns the ref (connections, subscriptions, …). */
  owner?: string;
}

export function deleteConflictOf(err: unknown): DeleteConflict | null {
  if (!err || typeof err !== 'object' || (err as { status?: unknown }).status !== 409) return null;
  const body = (err as { body?: unknown }).body;
  const details = body && typeof body === 'object' ? (body as { details?: unknown }).details : undefined;
  const d = details && typeof details === 'object' ? (details as Record<string, unknown>) : {};
  const references = Array.isArray(d.references) ? d.references.filter((r): r is string => typeof r === 'string') : [];
  const out: DeleteConflict = { references, referencesKnown: d.referencesKnown !== false };
  if (typeof d.owner === 'string') out.owner = d.owner;
  return out;
}
