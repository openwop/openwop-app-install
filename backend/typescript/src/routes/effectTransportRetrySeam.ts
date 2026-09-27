/**
 * RFC 0173 §D.2 G4 / ADR 0639 — `POST /conformance/seams/sample/test/idempotency/effect-retry`.
 *
 * The suite's fixture provider records the idempotency key of every attempt it
 * receives. This seam issues ONE logical effect to `providerUrl` and performs a
 * transport retry of it, so the fixture sees two attempts. The obligation under
 * test (`idempotency.md` §Layer 2) is that both attempts carry the SAME key.
 *
 * WHY THE KEY IS COMPUTED ONCE AND REUSED, rather than derived per attempt.
 * `providerIdempotencyKey()` allocates a logical-invocation ordinal on each
 * call, because "two distinct logical invocations MUST receive different
 * identities". A transport retry is NOT a second logical invocation — it is one
 * effect, attempted twice. So the identity is resolved once, before the first
 * attempt, and the same header value is presented on both. That is exactly what
 * a real transport retry does: the request (headers included) is built once and
 * re-sent, which is why the Stripe path's undici-level retries already reuse
 * their key.
 *
 * WHY THIS SEAM FORCES THE RETRY INSTEAD OF PROVOKING A REAL FAILURE.
 * `ctx.http.safeFetch` deliberately does NOT auto-retry: it carries arbitrary
 * node traffic including non-idempotent POSTs, and silently re-sending those
 * would be a worse defect than the one this witnesses. Nor can the seam make the
 * suite's fixture fail on demand. So the seam forces the second attempt directly
 * — which is what its name says — while the thing under test, the key and its
 * stability, is the production derivation (`host/providerIdempotencyKey.ts`,
 * the same function `features/billing/stripeApi.ts` calls on every POST).
 *
 * The effect is recorded through the real Layer-2 pair (`claim()` then `put()`),
 * as `fireEffectSeam` does, so `GET /runs/{runId}/effects` witnesses it. The
 * `effectId` in the 201 body comes from the SHARED `effectIdFor()` the
 * projection itself uses — a consumer follows this id straight into that
 * projection, and two independent derivations would name different effects while
 * both stayed schema-valid.
 */
import { randomUUID } from 'node:crypto';

import type { Express, Request, Response, NextFunction } from 'express';

import type { Storage } from '../storage/storage.js';
import type { RunRecord } from '../types.js';
import { getInvocationLog } from '../executor/invocationLog.js';
import { toWireRunId } from '../host/v2Ids.js';
import { effectIdFor } from '../host/effectIdentity.js';
import { providerIdempotencyKey } from '../host/providerIdempotencyKey.js';
import { runWithEffectContext } from '../host/runEffectContext.js';
import { sendError } from '../middleware/errorEnvelope.js';

export const EFFECT_TRANSPORT_RETRY_PATH = '/v1/host/sample/test/idempotency/effect-retry';

/** Attempts the fixture must observe: the original plus one forced retry. */
const TRANSPORT_ATTEMPTS = 2;

export function validateRetryBody(body: unknown): { error: string } | { providerUrl: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { error: 'body MUST be a JSON object carrying { providerUrl }' };
  }
  const raw = (body as Record<string, unknown>).providerUrl;
  if (typeof raw !== 'string' || raw.length === 0) {
    return { error: 'providerUrl is REQUIRED and MUST be a non-empty string' };
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { error: `providerUrl MUST be an absolute URI; got "${raw}"` };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: `providerUrl MUST be http(s); got "${parsed.protocol}"` };
  }
  // Reject anything beyond the declared shape rather than ignoring it, matching
  // the request schema's `additionalProperties: false`.
  const extra = Object.keys(body as Record<string, unknown>).filter((k) => k !== 'providerUrl');
  if (extra.length > 0) return { error: `unknown propert${extra.length === 1 ? 'y' : 'ies'}: ${extra.join(', ')}` };
  return { providerUrl: raw };
}

function callerTenant(req: Request): string {
  return (req as Request & { tenantId?: string }).tenantId ?? 'default';
}

export function registerEffectTransportRetrySeam(app: Express, deps: { storage: Storage }): void {
  const { storage } = deps;

  app.post(EFFECT_TRANSPORT_RETRY_PATH, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = validateRetryBody(req.body);
      if ('error' in parsed) {
        sendError(res, 400, 'validation_error', parsed.error);
        return;
      }

      // The caller's tenant, for the same reason `fireEffectSeam` uses it: the
      // suite reads `GET /runs/{runId}/effects` back on this run, and a fixture
      // tenant would answer 403 to the caller that just created it.
      const tenant = callerTenant(req);
      const runId = randomUUID();
      const nodeId = 'seam-effect-retry';
      const now = new Date().toISOString();
      const run: RunRecord = {
        runId,
        workflowId: 'sample.effect-transport-retry',
        tenantId: tenant,
        status: 'completed',
        inputs: {},
        metadata: { seededBy: 'conformance-seam', seam: 'http.outbound' },
        configurable: {},
        createdAt: now,
        updatedAt: now,
      };
      await storage.insertRun(run);

      // Resolve the identity INSIDE a run-effect context — the production
      // derivation reads the ambient context and returns `undefined` outside a
      // run, so a seam that skipped this would silently fall back and witness
      // nothing.
      const key = runWithEffectContext(
        { runId, tenantId: tenant, nodeId, attempt: 1, replaying: false },
        () => providerIdempotencyKey({ operation: `POST ${parsed.providerUrl}` }),
      );
      if (!key) {
        // Never a silent 201. If the identity could not be resolved the leg has
        // nothing to assert, and reporting success would certify an obligation
        // that was never exercised.
        sendError(res, 500, 'internal_error', 'the effect identity could not be resolved inside a run-effect context');
        return;
      }

      const invocationId = key;
      const log = getInvocationLog();
      const won = await log.claim({ runId, nodeId, invocationId }, { nowMs: Date.now(), staleAfterMs: 60_000 });
      if (!won) {
        sendError(res, 500, 'internal_error', 'the invocation claim was already held for a fresh run id');
        return;
      }

      // ONE effect, two transport attempts, ONE key. The fixture provider
      // records what it receives; a changed key between these two requests is
      // the failure this seam exists to expose.
      const observed: number[] = [];
      for (let attempt = 1; attempt <= TRANSPORT_ATTEMPTS; attempt++) {
        try {
          const r = await fetch(parsed.providerUrl, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'idempotency-key': key,
            },
            body: JSON.stringify({ attempt, runId, nodeId }),
          });
          observed.push(r.status);
        } catch {
          // A transport failure is precisely the condition a retry exists for,
          // so it must not abort the loop — the fixture still recorded the key
          // it saw, which is the whole witness.
          observed.push(0);
        }
      }

      // ONE ledger row PER ATTEMPT, all under the same invocation identity: the
      // ledger is the suite's witness (`GET /runs/{runId}/effects`), and a
      // cross-retry keying assertion needs to SEE the two attempts it compares.
      // Recording one row with `attempts: 2` in its payload made the leg record
      // `blocked` ("the seam produced 1 ledger row(s)") on every host posture.
      for (let attempt = 1; attempt <= observed.length; attempt++) {
        await log.put(
          { runId, nodeId, attempt, invocationId },
          // Content-free of provider payloads, per the projection's contract.
          { seam: 'http.outbound', attempt, status: observed[attempt - 1] },
        );
      }

      res.status(201).json({
        runId: toWireRunId(runId, tenant),
        effectId: effectIdFor({ tenantId: tenant, runId, nodeId, invocationId }),
      });
    } catch (err) {
      next(err);
    }
  });
}
