/**
 * RFC 0154 conformance test seam — `host-sample-test-seams.md` §20.
 *
 *   POST /v1/host/sample/test/workload-identity/resolve
 *     { identity: <WorkloadIdentity>, expectedAudience?: string }
 *     → 200 { principalId, resolved: true }
 *     → 4xx { error: <code>, message, details: { retriable: false } }
 *       (the canonical FLAT envelope — H27 / S22. §20's contract read the nested
 *        `{ error: { code, retriable } }` shape until 2026-08-16; the schema was
 *        always flat and the catalog was corrected to match it.)
 *
 * WHY THIS SEAM HAS TO EXIST. §A's requirements — verify the presented identity,
 * bind it to the request, resolve it to a principal BEFORE authorization, fail
 * closed — are invisible from a normal request: a call either succeeds or 401s,
 * and both outcomes look identical whether the host verified anything or simply
 * trusted a header. RFC 0148 §A resolves an unobservable requirement to
 * `blocked`, so without this endpoint RFC 0154 cannot be certified at all.
 *
 * NON-VACUITY, which §20 states as a MUST: this "MUST NOT be a mock that returns
 * a canned principal: the resolver must be the same one the production request
 * path consults, or the witness proves nothing about production." So this file
 * contains no policy. It parses, hands the projection to
 * `resolveWorkloadIdentity` — the exact function `middleware/workloadIdentity.ts`
 * calls on every real request — and renders the result. Every negative the suite
 * drives (`audience_mismatch`, `delegation_expired`, a closed non-retriable
 * reason) is produced by that resolver, and each one goes red if the
 * corresponding check is removed from it.
 *
 * WHAT THE SEAM DOES NOT EXERCISE, stated plainly rather than implied: the
 * CRYPTOGRAPHIC half. §20's request body is a `workload-identity` object, and
 * that schema is closed precisely so credential material cannot be handed to it
 * — "the seam cannot be handed a raw token even by a caller trying to". So the
 * seam necessarily supplies a PROJECTION, not a proof, and the signature/expiry
 * verification that produces a projection in production is exercised by
 * `verifyWorkloadCredential` and its own tests, not here. The resolver is told
 * so: it takes an explicit `provenance` of `'test-seam'`, and refuses that
 * provenance outright unless `OPENWOP_TEST_SEAM_ENABLED=true` — so the seam's
 * relaxation cannot exist in a production boot even if this route did.
 *
 * Gated on `OPENWOP_TEST_SEAM_ENABLED=true` (OFF by default), the standard
 * `/v1/host/sample/*` posture per §"Production safety", AND on the capability
 * (`auth.workloadIdentity.supported: true`) the seam is documented under — an
 * unconfigured deployment 404s, which is what makes the suite report `blocked`
 * rather than a false pass.
 *
 * @see spec/v1/host-sample-test-seams.md §20
 * @see spec/v1/auth.md §"Workload identity and delegated actor chain"
 * @see docs/adr/0556-production-metrics-workload-identity-and-assurance-operations.md (P3)
 */

import { randomUUID } from 'node:crypto';
import type { Express, Request, Response } from 'express';
import {
  isWellFormedIdentity,
  isWorkloadIdentityEnabled,
  resolveWorkloadIdentity,
} from '../host/workloadIdentity.js';
import { recordAuthorizationDecision } from '../host/authorityContext.js';
import { createLogger } from '../observability/logger.js';
import { sendError } from '../middleware/errorEnvelope.js';

const log = createLogger('routes.workload-identity-seam');

const SEAM_PATHS = [
  '/v1/host/openwop-app/test/workload-identity',
  '/v1/host/sample/test/workload-identity',
] as const;

/** §20: a 4xx carries a closed reason code and `retriable: false`. The envelope
 *  is the canonical FLAT one (H27 / S22 / `rest-endpoints.md` §"Error response
 *  shape") — `retriable` rides `details`, which is where §20 was corrected to
 *  put it on 2026-08-16. `message` is free text (the schema only requires it to
 *  be non-empty); the closed fact the witness reads is `error` + `details.retriable`. */
function refuse(res: Response, code: string): void {
  sendError(res, 400, code, `Workload identity refused: ${code}.`, { retriable: false });
}

async function handleResolve(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as { identity?: unknown; expectedAudience?: unknown };
  if (!isWellFormedIdentity(body.identity)) {
    // The closed shape check is the seam's own guard against credential
    // material: an object carrying a `token` or a `certificate` key is not a
    // workload identity, and refusing it here is the same rule the schema
    // enforces on the wire.
    refuse(res, 'identity_unverified');
    return;
  }
  const expectedAudience = typeof body.expectedAudience === 'string' ? body.expectedAudience : undefined;
  const correlationId = randomUUID();
  const resolution = await resolveWorkloadIdentity(body.identity, 'test-seam', { expectedAudience });

  if (!resolution.ok) {
    await recordAuthorizationDecision({
      tenantId: req.tenantId ?? 'host',
      principal: '(unresolved-workload)',
      action: 'workload-identity.resolve',
      resource: 'seam',
      allowed: false,
      reason: resolution.reason,
      cause: resolution.cause,
      delegationDepth: body.identity.delegation?.chain.length ?? 0,
      audienceDecision: body.identity.audience === undefined ? 'absent' : 'mismatch',
      senderConstraint: body.identity.keyBinding?.method ?? 'none',
      correlationId,
    });
    refuse(res, resolution.reason);
    return;
  }

  const principal = resolution.principal;
  await recordAuthorizationDecision({
    tenantId: principal.tenantId,
    principal: principal.principalId,
    action: 'workload-identity.resolve',
    resource: 'seam',
    allowed: true,
    reason: 'resolved',
    delegationDepth: principal.delegationDepth,
    issuerClass: principal.issuerClass,
    audienceDecision: principal.audienceDecision,
    senderConstraint: principal.senderConstraint,
    correlationId,
  });
  // §20's 200 body, and nothing beside it. `principalId` is opaque and is never
  // the presented subject — a response that echoed the subject would hand a
  // prober the mapping the salted hash exists to withhold. A 200 here means the
  // identity resolved; it never means the caller may act.
  res.status(200).json({ principalId: principal.principalId, resolved: true });
}

export function registerWorkloadIdentitySeamRoutes(app: Express): void {
  if (process.env.OPENWOP_TEST_SEAM_ENABLED !== 'true') {
    log.info('workload-identity seam disabled (set OPENWOP_TEST_SEAM_ENABLED=true to enable)');
    return;
  }
  for (const base of SEAM_PATHS) {
    app.post(`${base}/resolve`, (req, res) => {
      // The capability gate is read PER REQUEST rather than at registration, so
      // a boot that registers the seam but has not configured the profile 404s
      // — advert and seam can never disagree, which is what the suite's
      // 404 → `blocked` branch depends on.
      if (!isWorkloadIdentityEnabled()) {
        // `message` is a REQUIRED top-level field of the envelope, not a detail —
        // this used to bury it under `details`, which reads as a 404 with no
        // explanation to any client that renders `body.message` (H27 / S22).
        sendError(res, 404, 'not_found', 'workload identity is not configured');
        return;
      }
      void handleResolve(req, res).catch((err: unknown) => {
        log.error('workload_identity_seam_failed', { error: err instanceof Error ? err.message : String(err) });
        // Fail CLOSED even on an internal error: a 500 that read as "try again"
        // would make an unresolvable identity look transient.
        refuse(res, 'identity_unresolvable');
      });
    });
  }
}
