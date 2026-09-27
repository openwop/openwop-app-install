/**
 * RFC 0176 §D.2 — `POST /conformance/seams/sample/webhooks/receive`
 * (`receiveWebhookDelivery`), served at its v1 address and reached at the v2 one
 * through the ADR 0634 alias.
 *
 * WHY THIS EXISTS, having first been declined. I recorded a decision not to
 * mount it: this host is a webhook SENDER, so a receiver seam looked like a
 * fixture witnessing nothing real. Two things were wrong with that.
 *
 * First, the disposition. A host answering 404/403/405 here records `blocked`,
 * not `inapplicable` — and `blocked` is bundle-wide fatal to certification. So
 * declining did not leave the bundle neutral; it left it uncertifiable.
 *
 * Second, and the part that actually matters: the obligation is real. RFC 0176
 * §D.2 says a v2 host advertising `webhooks` MUST accept a delivery carrying
 * only the `X-openwop-*` family under scheme `v1`, verifying the same bytes it
 * signs. This host DOES advertise `webhooks`. Advertising a family is taking on
 * its obligations in both directions; "we only send" is not a reading the facet
 * supports.
 *
 * The seam verifies through `host/webhookSignature.ts` — the same module the
 * delivery worker signs with — so a passing witness here says something true
 * about the sender too, rather than about a verifier written to match it.
 */
import type { Express, Request, Response, NextFunction } from 'express';

import { verifyWebhookV1 } from '../host/webhookSignature.js';
import { sendError } from '../middleware/errorEnvelope.js';

export const WEBHOOK_RECEIVE_PATH = '/v1/host/sample/webhooks/receive';

/** Closed-world validation against `api/seams-v2.yaml`. */
export function validateReceiveBody(
  body: unknown,
): { error: string } | { secret: string; headers: Record<string, string>; body: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { error: 'body must be a JSON object' };
  const b = body as Record<string, unknown>;
  if (typeof b['secret'] !== 'string' || b['secret'].length === 0) return { error: 'secret must be a non-empty string' };
  if (typeof b['body'] !== 'string') return { error: 'body must be a string (the raw delivery bytes)' };
  const headers = b['headers'];
  if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) {
    return { error: 'headers must be an object of string values' };
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
    if (typeof v !== 'string') return { error: `headers[${k}] must be a string` };
    out[k] = v;
  }
  return { secret: b['secret'], headers: out, body: b['body'] };
}

export function registerWebhookReceiveSeam(app: Express): void {
  app.post(WEBHOOK_RECEIVE_PATH, (req: Request, res: Response, next: NextFunction) => {
    try {
      if (process.env.OPENWOP_TEST_SEAM_ENABLED !== 'true') {
        sendError(res, 404, 'not_found', 'The conformance seam surface is not enabled on this host.');
        return;
      }
      const parsed = validateReceiveBody(req.body);
      if ('error' in parsed) {
        sendError(res, 400, 'validation_error', parsed.error);
        return;
      }
      // A REFUSED delivery is a 200 carrying `accepted: false`, not an HTTP
      // error: the scenario drives a tampered delivery expecting a refusal, and
      // a 4xx there would be indistinguishable from the seam being absent —
      // which is the disposition (`blocked`) this seam exists to clear.
      const result = verifyWebhookV1(parsed.secret, parsed.headers, parsed.body);
      res.status(200).json(result.accepted ? { accepted: true } : { accepted: false, reason: result.reason ?? 'rejected' });
    } catch (err) {
      next(err);
    }
  });
}
