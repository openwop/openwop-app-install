/**
 * ADR 1023 — which sentence a refused funnels request gets. Branches on the typed
 * status and the server's reason, never on English message text; a refused READ is
 * "no access", not "you can view but not change" (grade-ux FN72UX-3); a reason the
 * user can act on keeps its instruction (FN72UX-2); any other conflict still says
 * "something changed", not "could not save".
 *
 * Sabotage-witnessed: dropping the `mode === 'read'` branch, the
 * `managed_by_experiments` or `stale_review` mapping, or the 409 fallthrough each
 * turns one case red.
 */
import { describe, it, expect } from 'vitest';
import type { TFunction } from 'i18next';
import { FunnelsError } from '../funnelsClient.js';
import { funnelsErrorText, isNotFound, isStaleEdit } from '../funnelsErrors.js';

const t = ((k: string) => k) as unknown as TFunction;
const err = (status: number, reason?: string, message = 'server English') => new FunnelsError(message, status, reason);

describe('funnelsErrorText', () => {
  it.each([
    [err(403), 'write', 'funnels:errForbidden'],
    [err(403), 'read', 'funnels:errNoReadAccess'],
    [err(404), 'write', 'funnels:errNotFound'],
    [err(409, 'funnel_changed'), 'write', 'funnels:errChanged'],
    [err(409, 'step_pages_unpublished'), 'write', 'funnels:errPagesUnpublished'],
    [err(409, 'managed_by_experiments'), 'write', 'funnels:errManagedByExperiments'],
    [err(409, 'stale_review'), 'write', 'funnels:errStaleReview'],
    [err(409, 'something_new'), 'write', 'funnels:errConflict'],
    [err(400, undefined, 'Step page not found in this workspace.'), 'write', 'Step page not found in this workspace.'],
    [err(500), 'write', 'updateFailed'],
    [new Error('network'), 'write', 'updateFailed'],
  ] as const)('%# → %s', (e, mode, want) => {
    expect(funnelsErrorText(e, t, 'updateFailed', mode)).toBe(want);
  });

  it('isNotFound / isStaleEdit read the typed fields, not the message', () => {
    expect(isNotFound(err(404))).toBe(true);
    expect(isNotFound(new Error('404 Not Found'))).toBe(false);
    expect(isStaleEdit(err(409, 'funnel_changed'))).toBe(true);
    expect(isStaleEdit(err(409, 'stale_review'))).toBe(false);
  });
});
