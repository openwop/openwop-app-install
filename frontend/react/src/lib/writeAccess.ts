/**
 * Presentation of a WRITE authority — the ONE scope-parameterised helper.
 *
 * A surface whose writes the server gates on a scope (`workspace:write`,
 * `host:byok:manage`, …) used to offer every control to everyone and then show
 * the raw transport string (`… → 403: Missing required scope …`). These helpers
 * let it hide what the caller cannot do and say plainly why a write failed. The
 * backend stays the authority.
 *
 * Promoted from `byok/lib/byokWriteAccess.ts` (ADR 0779 D7) by ADR 0780 so the
 * connections surface does not add a third copy; byok re-exports its names from
 * here. `agents/agentWriteAccess.ts` (ADR 0775 D1) is the same shape and has not
 * been folded in yet.
 */
import { useEffectiveAccessState } from '../client/useEffectiveAccess.js';
import { classifyHttpError } from '../client/classifyHttpError.js';
import { loadErrorMessage } from '../client/loadErrorMessage.js';

/**
 * Does the caller hold `scope` here? FAIL-OPEN: only a resolved MEMBER whose
 * scopes lack it reads as read-only. While access is loading, when the read
 * failed (`basis: 'none'`), for the tenant owner (a personal workspace) and for
 * a superadmin, the controls stay offered — the server judges a person by both
 * identity spellings while `/access/effective` reads one, so hiding on anything
 * less certain would lock out someone the server admits.
 */
export function canWriteWithScope(
  access: { basis: string; scopes: readonly string[]; superadmin?: boolean },
  resolved: boolean,
  scope: string,
): boolean {
  if (!resolved) return true;
  if (access.superadmin === true || access.basis !== 'member') return true;
  return access.scopes.includes(scope);
}

export function useScopeWriteAccess(scope: string): boolean {
  const { access, resolved } = useEffectiveAccessState();
  return canWriteWithScope(access, resolved, scope);
}

type TFn = (key: string) => string;

/** The message for a failed read or write. Never the raw transport string:
 *   - 403 → the caller's missing authority, localized (`common:error_forbidden`);
 *   - another 4xx the server EXPLAINED (a validation refusal) → the server's own
 *     sentence, which is the only thing that says what to fix;
 *   - an error with no HTTP status (thrown by the caller's own code) → its text;
 *   - everything else (network, 429, 5xx) → the shared localized classification. */
export function writeErrorMessage(t: TFn, err: unknown): string {
  if (classifyHttpError(err).kind === 'forbidden') return t('common:error_forbidden');
  const status = err && typeof err === 'object' ? (err as { status?: unknown }).status : undefined;
  if (typeof status === 'number' && status >= 400 && status < 500 && status !== 429) {
    const body = (err as { body?: unknown }).body;
    const said = body && typeof body === 'object' ? (body as { message?: unknown }).message : undefined;
    if (typeof said === 'string' && said.length > 0) return said;
  }
  if (status === undefined && err instanceof Error && err.message) return err.message;
  return loadErrorMessage(t, err);
}
