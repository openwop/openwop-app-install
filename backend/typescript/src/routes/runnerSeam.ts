/**
 * RFC 0122 §19 (`host-sample-test-seams.md`) — the self-hosted-runner conformance
 * seam. Two POST endpoints the gated `self-hosted-runner.test.ts` scenario drives:
 *
 *   POST /v1/host/sample/runner/register  { runnerId, subject, capabilities } → { runnerId }
 *   POST /v1/host/sample/runner/dispatch  { subject, ...DispatchFrame }
 *        → { result, deduped }                              (routed to the subject's runner)
 *        → 409 { error: 'runner_unavailable', message, details: { retriable: true } }  (no owning runner)
 *
 * The envelope is the canonical FLAT one (H27 / S22 / `rest-endpoints.md`
 * §"Error response shape"). §19 and the `runner_unavailable` code entry both
 * read the nested `{ error: { code, retriable } }` shape from 2026-07 until
 * 2026-08-16; `schemas/error-envelope.schema.json` never did — `error` is a
 * string and `additionalProperties: false` forbids a top-level `retriable` —
 * so the catalog was corrected to the schema and this seam follows it.
 *
 * Registered under BOTH the app-canonical prefix and the spec-canonical
 * `/v1/host/sample/*` path the vendored suite drives — mirroring the other
 * host-sample seams in `agents.ts`. This proves, NON-VACUOUSLY:
 *   1. subject-first isolation — a subject-A dispatch never routes to a subject-B
 *      runner (→ `runner_unavailable`);
 *   2. at-most-once — a redelivered `{runId, stepId}` returns `deduped:true` from a
 *      real persisted store, never re-executing the runner.
 *
 * The seam trusts the body-supplied `subject` (it is a controllable test seam, so
 * the scenario can drive subject A vs B); the PRODUCT dispatch path derives the
 * subject from the owning RFC 0048 principal on `run.metadata`.
 */

import type { Express, Request, Response } from 'express';
import { sendError } from '../middleware/errorEnvelope.js';
import {
  registerRunner,
  dispatchToRunner,
  RunnerUnavailableError,
  type RunnerRegistration,
} from '../host/selfHostedRunner.js';

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/** Wire the §19 register + dispatch seams onto both canonical prefixes. */
export function registerRunnerSeamRoutes(app: Express): void {
  const registerSeam = (req: Request, res: Response): void => {
    const body = (req.body ?? {}) as Partial<RunnerRegistration>;
    if (!isNonEmptyString(body.runnerId) || !isNonEmptyString(body.subject)) {
      sendError(res, 400, 'validation_error', '`runnerId` and `subject` (non-empty strings) are required.');
      return;
    }
    const caps = (body.capabilities ?? {}) as RunnerRegistration['capabilities'];
    if (typeof caps !== 'object' || caps === null) {
      sendError(res, 400, 'validation_error', '`capabilities` must be an object.');
      return;
    }
    const { runnerId } = registerRunner({ runnerId: body.runnerId, subject: body.subject, capabilities: caps });
    res.status(200).json({ runnerId });
  };

  const dispatchSeam = async (req: Request, res: Response): Promise<void> => {
    const body = (req.body ?? {}) as {
      subject?: unknown; runId?: unknown; stepId?: unknown; seq?: unknown;
      kind?: unknown; provider?: unknown; model?: unknown; tool?: unknown; inputs?: unknown;
    };
    if (!isNonEmptyString(body.subject) || !isNonEmptyString(body.runId) || !isNonEmptyString(body.stepId)) {
      sendError(res, 400, 'validation_error', '`subject`, `runId`, `stepId` (non-empty strings) are required.');
      return;
    }
    if (!Number.isInteger(body.seq)) {
      sendError(res, 400, 'validation_error', '`seq` (integer dispatch cursor) is required.');
      return;
    }
    if (body.kind !== 'model' && body.kind !== 'tool') {
      sendError(res, 400, 'validation_error', '`kind` must be "model" or "tool".');
      return;
    }
    if (body.kind === 'model' && !(isNonEmptyString(body.provider) && isNonEmptyString(body.model))) {
      sendError(res, 400, 'validation_error', 'a `model` dispatch requires `provider` and `model`.');
      return;
    }
    if (typeof body.inputs !== 'object' || body.inputs === null) {
      sendError(res, 400, 'validation_error', '`inputs` (object) is required.');
      return;
    }
    // The credential-free frame is enforced by the closed dispatch-frame schema
    // (`runner-credential-non-transit`); the seam reads no credential material.
    try {
      const outcome = await dispatchToRunner(
        { subject: body.subject, runId: body.runId, stepId: body.stepId, frame: body },
        // Degenerate in-process runner: the registered runner "executes" the step.
        // The scenario asserts routing + dedup, not model output; the PRODUCT path
        // replaces this with the SSE/loopback channel to the real runner, and the
        // caller fences the output as UNTRUSTED before it re-enters the agent loop.
        async (runner) => ({ delivered: true, runnerId: runner.runnerId, stepId: body.stepId }),
      );
      res.status(200).json({ result: outcome.result, deduped: outcome.deduped });
    } catch (err) {
      if (err instanceof RunnerUnavailableError) {
        // Retriable by contract (RFC 0122 §Behavior#5) — a runner may (re)connect.
        sendError(res, 409, 'runner_unavailable', err.message, { retriable: true });
        return;
      }
      sendError(res, 500, 'internal_error', 'runner dispatch failed');
    }
  };

  app.post('/v1/host/openwop-app/runner/register', registerSeam);
  app.post('/v1/host/sample/runner/register', registerSeam);
  app.post('/v1/host/openwop-app/runner/dispatch', dispatchSeam);
  app.post('/v1/host/sample/runner/dispatch', dispatchSeam);
}
