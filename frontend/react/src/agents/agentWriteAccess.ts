/**
 * ADR 0775 D1 — presentation of the agent-area WRITE authority.
 *
 * Every roster / agent / profile / workforce / example-data / org-chart write
 * now requires `workspace:write` on the server. A viewer used to be offered
 * every write control anyway, and each failed with a developer string
 * (`… returned 403`, "Missing required scope: workspace:write"). These two
 * helpers let a surface hide what the caller cannot do and say plainly why a
 * write was refused. The backend stays the authority.
 */
import { useEffectiveAccessState } from '../client/useEffectiveAccess.js';
import { classifyHttpError } from '../client/classifyHttpError.js';
import { ApiError } from '../client/errorEnvelope.js';

/**
 * May the caller WRITE agent-area state here? FAIL-OPEN: only a resolved
 * MEMBER whose scopes lack `workspace:write` reads as a viewer. While access is
 * loading, when the read failed (`basis: 'none'`), for the workspace owner, and
 * for a superadmin, the controls stay offered. The server judges a person by
 * BOTH identity spellings while `/access/effective` reads one, so hiding on
 * anything less certain would lock out someone the server admits.
 */
export function canWriteAgents(access: { basis: string; scopes: readonly string[]; superadmin?: boolean }, resolved: boolean): boolean {
  if (!resolved) return true;
  if (access.superadmin === true || access.basis !== 'member') return true;
  return access.scopes.includes('workspace:write');
}

export function useAgentWriteAccess(): boolean {
  const { access, resolved } = useEffectiveAccessState();
  return canWriteAgents(access, resolved);
}

/** True when `err` is the server's write-authority refusal. Keyed on the HTTP
 *  STATUS: `ApiError.status` (and the `… returned 403` convention of the older
 *  raw-fetch clients) through `classifyHttpError`. */
export function isWriteRefusal(err: unknown): boolean {
  return classifyHttpError(err).kind === 'forbidden';
}

/** The message a surface shows for a failed write: `forbidden` (the caller's
 *  localized `common:error_forbidden`) for a refusal, `stale` (when given) for a
 *  stale-version refusal, the error text otherwise. */
export function writeErrorMessage(err: unknown, forbidden: string, stale?: string): string {
  if (isWriteRefusal(err)) return forbidden;
  if (stale !== undefined && isStaleWrite(err)) return stale;
  return err instanceof Error ? err.message : String(err);
}

/** ADR 0775 P4 — the server refused an edit because the agent changed after the
 *  caller loaded it (`409`, `details.reason: 'stale_write'`). */
export function isStaleWrite(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && err.reason === 'stale_write';
}
