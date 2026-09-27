/**
 * RFC 0154 §A — bind a presented workload credential to THIS request (ADR 0556 P3).
 *
 * Runs immediately after `authMiddleware()`, and the order is load-bearing in
 * both directions:
 *
 *   - AFTER auth, because a workload credential may accompany a human principal
 *     (a gateway calling on a user's behalf), and the `onBehalfOf` fact is only
 *     meaningful next to the principal the request already resolved to.
 *   - BEFORE any route, because §A requires the identity to be resolved to an
 *     OpenWOP principal *before* authorization — not alongside it, and not by
 *     whichever handler happens to look.
 *
 * ── Fail closed, and the shape of "closed" ──────────────────────────────────
 * A request that presents `X-OpenWOP-Workload-Identity` and does not verify is
 * REFUSED with `401` and a non-retriable closed reason. It is not downgraded to
 * "well, the bearer token was fine" — a caller that presents a workload
 * credential is asserting something, and silently ignoring a failed assertion is
 * how a confused deputy is built. A request that presents NO such header is
 * untouched; this profile is additive.
 *
 * ── The header that does NOT exist ──────────────────────────────────────────
 * There is no header here carrying a pre-projected identity, and no
 * configured-trusted-terminator branch. `auth.md` §A: forwarded identity headers
 * are attacker-controlled unless the terminator is one the host has been
 * configured to believe. This host configures none, so it believes none — and
 * `resolveWorkloadIdentity` will not accept a projection whose provenance is not
 * `'verified-credential'` even if a future edit here tried to hand it one.
 *
 * @see spec/v1/auth.md §"Workload identity and delegated actor chain" §A
 * @see docs/adr/0556-production-metrics-workload-identity-and-assurance-operations.md (P3)
 */

import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import {
  isWorkloadIdentityEnabled,
  resolveWorkloadIdentity,
  verifyWorkloadCredential,
  type ResolvedWorkloadPrincipal,
} from '../host/workloadIdentity.js';
import {
  authorityFromWorkload,
  recordAuthorizationDecision,
  runWithAuthority,
} from '../host/authorityContext.js';
import { createLogger } from '../observability/logger.js';
import { sendError } from './errorEnvelope.js';

const log = createLogger('middleware.workload-identity');

/** The one header this host reads a workload credential from. */
export const WORKLOAD_IDENTITY_HEADER = 'x-openwop-workload-identity';

declare module 'express-serve-static-core' {
  // eslint-disable-next-line @typescript-eslint/no-empty-interface
  interface Request {
    /** The verified workload identity bound to THIS request, when one was
     *  presented and resolved. Absent means no workload credential — never
     *  "one was presented and we could not check it", which is a 401. */
    workloadPrincipal?: ResolvedWorkloadPrincipal;
  }
}

export function workloadIdentityMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const presented = req.get(WORKLOAD_IDENTITY_HEADER);
    if (!presented) {
      next();
      return;
    }
    if (!isWorkloadIdentityEnabled()) {
      // The profile is not configured, so the host advertises nothing and
      // verifies nothing. Refusing rather than ignoring: a caller presenting a
      // credential to a host that cannot check it must not proceed believing it
      // was checked.
      refuse(res, 'identity_unverified');
      return;
    }
    void bind(req, res, next, presented).catch((err: unknown) => {
      log.error('workload_identity_bind_failed', { error: err instanceof Error ? err.message : String(err) });
      refuse(res, 'identity_unresolvable');
    });
  };
}

async function bind(req: Request, res: Response, next: NextFunction, presented: string): Promise<void> {
  const correlationId = randomUUID();
  const verification = await verifyWorkloadCredential(presented);
  if (!verification.ok) {
    await recordAuthorizationDecision({
      // The credential did not verify, so there is no verified tenant to file
      // this under; the request's own tenant is the only honest bucket, and an
      // unauthenticated request files under the host bucket.
      tenantId: req.tenantId ?? 'host',
      principal: '(unverified-workload)',
      action: 'workload-identity.resolve',
      allowed: false,
      reason: verification.reason,
      cause: verification.cause,
      delegationDepth: 0,
      audienceDecision: 'absent',
      senderConstraint: 'none',
      correlationId,
    });
    refuse(res, verification.reason);
    return;
  }

  const resolution = await resolveWorkloadIdentity(verification.identity, 'verified-credential', {
    verified: { tenantId: verification.tenantId, scopes: verification.scopes },
  });
  if (!resolution.ok) {
    await recordAuthorizationDecision({
      tenantId: verification.tenantId,
      principal: '(unresolved-workload)',
      action: 'workload-identity.resolve',
      allowed: false,
      reason: resolution.reason,
      cause: resolution.cause,
      delegationDepth: verification.identity.delegation?.chain.length ?? 0,
      audienceDecision: verification.identity.audience === undefined ? 'absent' : 'mismatch',
      senderConstraint: verification.identity.keyBinding?.method ?? 'none',
      correlationId,
    });
    refuse(res, resolution.reason);
    return;
  }

  const principal = resolution.principal;
  req.workloadPrincipal = principal;
  await recordAuthorizationDecision({
    tenantId: principal.tenantId,
    principal: principal.principalId,
    action: 'workload-identity.resolve',
    allowed: true,
    reason: 'resolved',
    delegationDepth: principal.delegationDepth,
    issuerClass: principal.issuerClass,
    audienceDecision: principal.audienceDecision,
    senderConstraint: principal.senderConstraint,
    correlationId,
  });
  // The rest of the request runs INSIDE the authority scope, so every seam it
  // reaches — effect, A2A, MCP, sandbox, compensation — records the same two
  // identities without any of them being handed a parameter.
  runWithAuthority(authorityFromWorkload(principal, correlationId), () => next());
}

/**
 * The refusal envelope.
 *
 * The canonical HTTP error shape is `{ error: <code>, message, details }`
 * (`schemas/error-envelope.schema.json`, `middleware/errorEnvelope.ts`), so the
 * code rides `error` and the RFC 0154 fact rides `details`.
 *
 * CORRECTED 2026-08-16 (H27 / S22), twice over. This block used to call the
 * shape `{ error: <code>, details }` — omitting `message`, which the schema
 * makes REQUIRED, and the emit below matched the comment rather than the schema:
 * a 401 with no explanation at all. It also said the §20 seam "emits §20's shape
 * verbatim" and that "the two surfaces have different contracts". There are not
 * two contracts. §20 prescribed the nested form as 2026-06→08 drift, S22
 * corrected the catalog to the schema, and `routes/workloadIdentitySeam.ts` now
 * emits this same flat envelope.
 *
 * `retriable: false` is not decoration: an identity that does not resolve will
 * not resolve on retry, and a caller told otherwise will hammer a failing
 * authorization path.
 */
function refuse(res: Response, code: string): void {
  sendError(res, 401, code, `Workload identity could not be resolved: ${code}.`, { retriable: false });
}
