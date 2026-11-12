/**
 * ADR 1023 — the words a funnels page shows for a refused request. Branches on the
 * typed `FunnelsError` (status + the server's reason), so a Viewer's 403, a stale
 * edit's 409 and a dark-funnel publish read as sentences in the user's language,
 * not as the server's English message. A 400 keeps the server's text: it names the
 * field that was wrong, which no generic sentence can.
 */
import type { TFunction } from 'i18next';
import { FunnelsError } from './funnelsClient.js';

export function funnelsErrorText(e: unknown, t: TFunction, fallbackKey: string, mode: 'read' | 'write' = 'write'): string {
  if (e instanceof FunnelsError) {
    // A refused READ is "no access here", not "you can view but not change".
    if (e.status === 403) return t(mode === 'read' ? 'funnels:errNoReadAccess' : 'funnels:errForbidden');
    if (e.status === 404) return t('funnels:errNotFound');
    if (e.reason === 'funnel_changed') return t('funnels:errChanged');
    if (e.reason === 'step_pages_unpublished') return t('funnels:errPagesUnpublished');
    if (e.reason === 'managed_by_experiments') return t('funnels:errManagedByExperiments');
    if (e.reason === 'stale_review') return t('funnels:errStaleReview');
    if (e.status === 400 && e.message) return e.message;
    // Any other conflict is still "something changed": say so, not "could not save".
    if (e.status === 409) return t('funnels:errConflict');
  }
  return t(fallbackKey);
}

/** True for the refusal a stale editor gets (ADR 1023 D8): reload, then retry. */
export const isStaleEdit = (e: unknown): boolean => e instanceof FunnelsError && e.reason === 'funnel_changed';

/** True when the funnel is not there (deleted, another workspace, feature off). */
export const isNotFound = (e: unknown): boolean => e instanceof FunnelsError && e.status === 404;

/** True when the caller may not READ here: a Retry can never succeed (grade-ux FN72UX-13). */
export const isForbidden = (e: unknown): boolean => e instanceof FunnelsError && e.status === 403;
