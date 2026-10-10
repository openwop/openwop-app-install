/**
 * ADR 0781 — the ONE answer for an operation whose family or facet this host
 * does not advertise.
 *
 * errors.md § "Unadvertised operations" (RFC 0228, suite 2.44.6): under major 2
 * such an operation MUST answer `404 not_found`, the same answer as an operation
 * that does not exist. Major 1 keeps the refusal its clients already handle,
 * usually `501 capability_not_provided`.
 *
 * Only for PROTOCOL-surface gates, where the flag the handler checks is the
 * flag discovery advertises. A served operation that is merely unconfigured for
 * a tenant (email's "configure the sender address") is NOT unadvertised; it
 * keeps its own refusal on both majors. Calling that `not_found` would tell a
 * client the operation does not exist when it does.
 */
import type { Request, Response } from 'express';
import { sendError } from '../middleware/errorEnvelope.js';
import { OpenwopError } from '../types.js';

export interface UnadvertisedGate {
  /** The discovery family the operation belongs to, e.g. `prompts`. */
  readonly family: string;
  /** The facet that is off, when the family itself is advertised, e.g. `mutableLibrary`. */
  readonly facet?: string;
  readonly message: string;
}

/** The refusal (`errors.md` § "Unadvertised operations"). Every caller is a protocol route (ADR 0812 P3c). */
export function unadvertisedError(_req: Request, gate: UnadvertisedGate): OpenwopError {
  return new OpenwopError('not_found', gate.message, 404, {
    family: gate.family,
    ...(gate.facet ? { facet: gate.facet } : {}),
  });
}

/** `sendError` form, for handlers that answer directly instead of throwing. */
export function sendUnadvertised(req: Request, res: Response, gate: UnadvertisedGate): void {
  const e = unadvertisedError(req, gate);
  sendError(res, e.httpStatus, e.code, e.message, e.details);
}
