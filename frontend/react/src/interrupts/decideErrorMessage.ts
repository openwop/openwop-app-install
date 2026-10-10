/**
 * ADR 0778 (grade-ux `APUX-5`) — the ONE localized message for a failed gate
 * decision, shared by the review inbox card and every inline interrupt card.
 *
 * Every one of those surfaces rendered the raw server text (`forbidden:
 * Missing required scope: approvals:respond`) — English, code-prefixed, in all
 * four locales. A 409 is the one status with a domain meaning here (somebody
 * else decided first), so it is answered before falling through to the shared
 * `common:error_*` classification (`client/loadErrorMessage`), which maps a 403
 * to `common:error_forbidden`.
 */
import { loadErrorMessage } from '../client/loadErrorMessage.js';

type TFn = (key: string) => string;

/** The HTTP status an error carries: the SDK `WopError`/`ApiError` `.status`,
 *  or the review client's `httpStatus`. */
export function decideErrorStatus(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as { status?: unknown; httpStatus?: unknown };
  if (typeof e.status === 'number') return e.status;
  if (typeof e.httpStatus === 'number') return e.httpStatus;
  return undefined;
}

export function decideErrorMessage(t: TFn, err: unknown): string {
  const status = decideErrorStatus(err);
  if (status === 409) return t('interrupts:resolvedElsewhere');
  // The shared classifier reads `.status`; hand it one when the error only
  // carries `httpStatus`, or a 403 classifies as `unknown`.
  const classifiable = status !== undefined && typeof (err as { status?: unknown }).status !== 'number'
    ? { status, message: err instanceof Error ? err.message : '' }
    : err;
  return loadErrorMessage(t, classifiable);
}
