/**
 * ADR 0744 — no OpenWOP error envelope on the A2A 1.0 interface URL.
 *
 * The A2A JSON-RPC endpoint the card lists (`A2A_JSONRPC_PATH`) is answered by
 * `a2aServer10.ts` with JSON-RPC bodies. But a request can be refused BEFORE it
 * reaches that handler — the body parser (malformed JSON, 413), the auth gate
 * (401/403), the rate limiter (429), the request timeout (503) — and every one
 * of those answers with this host's `{ error, message, details? }` envelope. An
 * A2A client then reads a body that is neither an A2A error nor JSON-RPC.
 *
 * This wrapper re-renders such a refusal as a JSON-RPC error on the same HTTP
 * status, keeping every header (`WWW-Authenticate`, `Retry-After`) the
 * refusing layer set. Scope, deliberately narrow:
 *   - only `POST` to the listed A2A interface URL, and only while the A2A
 *     server is enabled — a disabled interface is not listed on any card, so
 *     its 404 is not an A2A response;
 *   - only a request that states an `A2A-Version` (a 1.0-era peer). A
 *     header-less request is a 0.3 request by the upstream receiver rule and the
 *     0.3 codec stays byte-for-byte unchanged (ADR 0552 P0's standing gate);
 *   - only a body that IS the OpenWOP envelope (`error` is a string). A JSON-RPC
 *     body from the handler passes through untouched.
 *
 * Mapping: a malformed body is JSON-RPC `-32700 Parse error`; every other
 * pre-dispatch refusal is `-32000` (the JSON-RPC implementation-defined server
 * error — A2A 1.0.1 reserves -32001..-32099 for its own nine errors and leaves
 * authentication/rate-limit bodies to the implementation, §3.3.2) with one
 * `google.rpc.ErrorInfo` in the `openwop.dev` domain naming the refusal.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { A2A_JSONRPC_PATH } from '../host/a2aCard.js';
import { errorData10 } from '../host/a2aCodec10.js';
import { A2A_VERSION_HEADER, dispositionForA2AVersionHeader } from '../host/a2aProfile.js';

/** The domain of the ErrorInfo a host-level refusal carries (not an A2A error). */
export const OPENWOP_ERROR_DOMAIN = 'openwop.dev';

function reasonForStatus(status: number): string {
  if (status === 401) return 'UNAUTHENTICATED';
  if (status === 403) return 'PERMISSION_DENIED';
  if (status === 413) return 'PAYLOAD_TOO_LARGE';
  if (status === 415) return 'UNSUPPORTED_MEDIA_TYPE';
  if (status === 429) return 'RESOURCE_EXHAUSTED';
  if (status === 503) return 'UNAVAILABLE';
  if (status >= 500) return 'INTERNAL';
  return 'INVALID_REQUEST';
}

/** True when `body` is this host's error envelope rather than a JSON-RPC body. */
function isOpenwopEnvelope(body: unknown): body is { error: string; message?: unknown; details?: unknown } {
  return (
    typeof body === 'object' &&
    body !== null &&
    !Array.isArray(body) &&
    typeof (body as { error?: unknown }).error === 'string' &&
    !('jsonrpc' in body)
  );
}

/** Render one OpenWOP envelope refusal as a JSON-RPC error (exported for tests). */
export function toA2aJsonRpcRefusal(
  status: number,
  envelope: { error: string; message?: unknown; details?: unknown },
  id: unknown,
): unknown {
  // `bodyParseError.ts` names a malformed body `validation_error` with
  // `details.type: 'entity.parse.failed'` — the one refusal JSON-RPC has a
  // standard code for.
  const details = envelope.details as { type?: unknown } | undefined;
  const parse = status === 400 && details?.type === 'entity.parse.failed';
  const message = typeof envelope.message === 'string' && envelope.message !== '' ? envelope.message : envelope.error;
  return {
    jsonrpc: '2.0',
    id: typeof id === 'string' || typeof id === 'number' ? id : null,
    error: {
      code: parse ? -32700 : status >= 500 ? -32603 : -32000,
      message,
      data: errorData10(parse ? 'PARSE_ERROR' : reasonForStatus(status), undefined, OPENWOP_ERROR_DOMAIN),
    },
  };
}

export function a2aInterfaceErrorsMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const path = req.url.split('?')[0] ?? req.url;
    if (
      req.method !== 'POST' ||
      path !== A2A_JSONRPC_PATH ||
      process.env.OPENWOP_A2A_SERVER_ENABLED !== 'true' ||
      dispositionForA2AVersionHeader(req.headers[A2A_VERSION_HEADER]).kind === 'absent'
    ) {
      next();
      return;
    }
    const json = res.json.bind(res);
    res.json = ((body?: unknown) => {
      if (res.statusCode < 400 || !isOpenwopEnvelope(body)) return json(body);
      const rpcId = (req.body as { id?: unknown } | undefined)?.id;
      return json(toA2aJsonRpcRefusal(res.statusCode, body, rpcId));
    }) as Response['json'];
    next();
  };
}
