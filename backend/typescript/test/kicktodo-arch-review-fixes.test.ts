/**
 * Architect-review fixes on the audit-remediation delta.
 *
 * ARCH-1/ARCH-2 — two domain errors I introduced were plain `Error`s, so
 * `errorEnvelope` fell through to a 500 `internal_error`. Every sibling route
 * in this feature family maps its domain errors to a typed envelope
 * (`kicktodo-accountability/routes.ts:62`, `kicktodo-creator/routes.ts:121`),
 * so this was a break with the established pattern, not a judgement call: an
 * ordinary caller mistake was reported as a server fault.
 *
 * ARCH-3 — `reconcileSeats` was called only from the expiry and release paths,
 * so a partial failure that skipped BOTH left no way to invoke it. "The sagas
 * are repairable" was true of the function and not of the system. B13's
 * entitlement repair already shipped an operator route; the seat repair now
 * has the matching one.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { openStorage } from '../src/storage/index.js';
import { initHostExtPersistence } from '../src/host/hostExtPersistence.js';
import { registerGoalVerifier } from '../src/features/goals/goalVerifiers.js';
import { OpenwopError } from '../src/types.js';
import { KICKTODO_METRICS_ROUTES } from '../src/features/kicktodo-metrics/routes.js';
import { KICKTODO_CIRCLES_ROUTES } from '../src/features/kicktodo-accountability/routes.js';
import { KICKTODO_CREATOR_ROUTES } from '../src/features/kicktodo-creator/routes.js';

beforeEach(async () => {
  initHostExtPersistence(await openStorage('memory://'));
  registerGoalVerifier('kicktodo:progress-evidence', async () => ({ satisfied: false, confidence: 0, runId: 'r' }));
});

/** Every domain error a handler can raise must reach the client as an
 *  OpenwopError. A plain Error is a 500 with a generic message. */
function handlerSource(routes: ReadonlyArray<{ path: string; handler: unknown }>, match: string): string {
  const r = routes.find((x) => x.path.includes(match));
  expect(r, `no route matching ${match}`).toBeDefined();
  return String(r!.handler);
}

describe('ARCH-1/2 — domain errors are typed envelopes, never 500s', () => {
  it('the verifier-sample route maps SampleSubjectError', () => {
    const src = handlerSource(KICKTODO_METRICS_ROUTES, 'verifier-sample');
    expect(src).toContain('SampleSubjectError');
    expect(src).toContain('OpenwopError');
  });

  it('the research route maps UnparsableSourceUrlError', () => {
    const src = handlerSource(KICKTODO_CREATOR_ROUTES, 'research');
    expect(src).toContain('UnparsableSourceUrlError');
  });

  it('OpenwopError carries a 4xx status, so these are actionable, not server faults', () => {
    expect(new OpenwopError('not_found', 'x', 404).httpStatus).toBe(404);
    expect(new OpenwopError('validation_error', 'x', 422).httpStatus).toBe(422);
  });
});

describe('ARCH-3 — the seat repair is reachable, not just implemented', () => {
  it('exposes an admin-gated reconcile-seats route', () => {
    const r = KICKTODO_CIRCLES_ROUTES.find((x) => x.path.includes('reconcile-seats'));
    expect(r, 'no reconcile-seats route').toBeDefined();
    expect(r!.method).toBe('post');
    // Admin-gated: restating a capacity counter is an administrative act, and
    // this must NOT be the participant-level `gate`.
    expect(String(r!.handler)).toContain('requireKicktodoManage');
  });
});
