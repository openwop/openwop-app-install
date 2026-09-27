/**
 * `host-sample-test-seams.md` §23 — MCP revision-negotiation driver
 * (`POST /v1/host/sample/mcp/invoke`, RFC 0153 §B/§C/§D).
 *
 * WHY A SEAM AT ALL. Everything RFC 0153 §B governs is what this host puts on
 * the wire TOWARD a peer — the `MCP-Protocol-Version` header, `Mcp-Method`,
 * `_meta`, and whether a downgrade was explicit. No black-box request to this
 * host's own API can observe any of it. The seam makes the host's REAL MCP
 * client call a server of the suite's choosing so the suite's `McpFakeServer`
 * can capture what arrived.
 *
 * NON-VACUITY (§23's own clause, and the thing that makes this worth having):
 * "the seam MUST drive the same MCP client the production `ctx.mcp.*` path uses
 * (same `_meta` construction, same header construction); a seam that
 * hand-writes `MCP-Protocol-Version` proves nothing about production." So this
 * calls `makeMcpClient(...).invokeTool` — the identical function the executor
 * binds onto `ctx.mcp` — and supplies only the ONE thing a conformance run
 * cannot: a peer URL, through `directEndpoint`, which `mcpClient.ts` refuses
 * unless `OPENWOP_TEST_SEAM_ENABLED` is on. Negotiation, headers, `_meta`,
 * MRTR, the round bound and the cache are all the production path.
 *
 * Env-gated on `OPENWOP_TEST_SEAM_ENABLED=true` (never production) and mounted
 * only when the MCP surface is advertised, so an unadvertised capability cannot
 * have a live seam.
 */

import type { Express, NextFunction, Request, RequestHandler, Response } from 'express';
import { requireNonAnonymousPrincipal } from '../middleware/auth.js';
import type { Storage } from '../storage/storage.js';
import { makeMcpClient, McpError, type McpElicitResult } from '../host/mcpClient.js';
import { MCP_CURRENT_VERSION, MCP_SUPPORTED_VERSIONS } from '../host/mcpProfile.js';
import { traceContextFromHeaders } from '../host/traceContext.js';
import { createLogger } from '../observability/logger.js';
import { sendError } from '../middleware/errorEnvelope.js';

const log = createLogger('routes.mcpInvokeSeam');

interface Deps {
  storage: Storage;
}

interface InvokeBody {
  serverUrl?: unknown;
  requestVersion?: unknown;
  tool?: unknown;
  arguments?: unknown;
  clientCapabilities?: unknown;
  elicitationAnswer?: unknown;
  scenario?: unknown;
}

export function registerMcpInvokeSeamRoutes(app: Express, deps: Deps): void {
  if (process.env.OPENWOP_TEST_SEAM_ENABLED !== 'true') return;
  if (process.env.OPENWOP_MCP_SERVER_ENABLED !== 'true') {
    // The seam is served iff the capability is advertised — the same rule the
    // A2A seams follow. A 404 here is what the suite reads as `blocked`.
    return;
  }

  const handler = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const body = (req.body ?? {}) as InvokeBody;
      const serverUrl = typeof body.serverUrl === 'string' ? body.serverUrl : '';
      if (!serverUrl) {
        res.status(400).json({ error: 'validation_error', message: 'serverUrl is required' });
        return;
      }
      const tool = typeof body.tool === 'string' && body.tool.length > 0 ? body.tool : 'echo';
      const args = body.arguments && typeof body.arguments === 'object' ? body.arguments : { text: 'openwop-conformance' };
      const answer = (body.elicitationAnswer ?? {}) as Record<string, unknown>;
      const declared = body.clientCapabilities && typeof body.clientCapabilities === 'object'
        ? (body.clientCapabilities as Record<string, unknown>)
        : undefined;

      // `requestVersion` forces the revision the host asks for — the suite uses
      // it to drive an UNSUPPORTED one. A revision this host does not serve
      // cannot be forced onto the real client (its version set is a closed
      // union), and pretending otherwise would be a seam that lies: the honest
      // answer is the same canonical envelope the real refusal produces.
      const requested = typeof body.requestVersion === 'string' ? body.requestVersion : undefined;
      if (requested !== undefined && !(MCP_SUPPORTED_VERSIONS as readonly string[]).includes(requested)) {
        sendError(
          res,
          400,
          'interop_version_unsupported',
          `MCP revision ${requested} is not supported by this host`,
          { retriable: false, protocol: 'mcp', requested, supported: [...MCP_SUPPORTED_VERSIONS] },
        );
        return;
      }

      const seamTrace = traceContextFromHeaders((n) => req.header(n) ?? undefined);
      const client = makeMcpClient({
        storage: deps.storage,
        tenantId: (req as Request & { tenantId?: string }).tenantId ?? 'default',
        directEndpoint: { url: serverUrl },
        // RFC 0207 §A — the seam drives the REAL client, so it must also supply
        // the one thing the production path gets from the run row: the trace
        // context to continue. Here it is the seam request's own `traceparent`,
        // which is what the suite sets when it drives this seam. Threading it
        // is what keeps the §23 non-vacuity clause true for the carrier too —
        // a seam that omitted it would prove nothing about the production
        // `_meta`/header construction it is supposed to be exercising.
        ...(seamTrace ? { traceContext: seamTrace } : {}),
        ...(declared ? { clientCapabilities: declared } : {}),
        // §23: "a programmatic answer the seam MAY use to resolve the
        // `clarification` interrupt the `input_required` result raises (in
        // production a human answers it)". Supplied only when the caller gave
        // one — without it an `input_required` is a typed failure, which is the
        // production posture for a run with no elicitation path.
        ...(Object.keys(answer).length > 0
          ? { elicitationResolver: async (): Promise<McpElicitResult> => ({ action: 'accept' as const, content: answer }) }
          : {}),
      });

      // §D `mcp-extension-no-authority` — measured, not asserted. The peer's
      // result carries `_meta` asserting scopes and approval; what the host
      // AUTHORIZES afterwards must be identical to before. Two independent
      // observations, because either alone is cheap to fake:
      //   1. STRUCTURAL — the client's return value has a closed shape, so
      //      there is no field for a peer's `_meta` to arrive in. Any key
      //      outside that set means something propagated.
      //   2. BEHAVIOURAL — the count of open interrupts across the host is
      //      unchanged, so nothing the peer said advanced a gate.
      const CLOSED_RESULT_KEYS = new Set(['result', 'structuredContent', 'isError', 'untrustedContent', 'negotiatedVersion', 'mrtr']);
      const openBefore = (await deps.storage.listOpenInterruptsAll(500)).length;

      let invoked: Awaited<ReturnType<typeof client.invokeTool>>;
      try {
        invoked = await client.invokeTool('openwop-conformance-mcp-seam', tool, args);
      } catch (err) {
        if (err instanceof McpError && err.code === 'interop_version_unsupported') {
          const details = err.details ?? {};
          sendError(
            res,
            400,
            'interop_version_unsupported',
            err.message,
            { retriable: false, protocol: 'mcp', ...details },
          );
          return;
        }
        log.info('mcp_invoke_seam_failed', { code: err instanceof McpError ? err.code : 'unknown' });
        sendError(
          res,
          502,
          'mcp_invoke_failed',
          err instanceof Error ? err.message : String(err),
          { retriable: true },
        );
        return;
      }

      const openAfter = (await deps.storage.listOpenInterruptsAll(500)).length;
      const leaked = Object.keys(invoked).filter((k) => !CLOSED_RESULT_KEYS.has(k));

      const out: Record<string, unknown> = {
        negotiatedVersion: invoked.negotiatedVersion,
        toolResult: invoked.result,
        isError: invoked.isError,
      };
      if (invoked.mrtr) {
        out.mrtr = { ...invoked.mrtr, result: invoked.result };
      }
      if (body.scenario === 'extension-asserts-authority') {
        out.extensionAuthority = {
          scopesWidened: leaked.length > 0,
          approvalAdvanced: openAfter < openBefore,
        };
      }
      res.status(200).json(out);
    } catch (err) {
      next(err);
    }
  };

  // Both spellings, the A2A-seam pattern: `/v1/host/openwop-app/*` is the
  // product surface and `/v1/host/sample/*` is what the vendored conformance
  // driver calls literally.
  //
  // THE GUARD IS ON THE ROUTE, not inherited. `testSeam.ts` mounts
  // `app.use('/v1/host/sample', guardSeam)` and `app.use('/v1/host/openwop-app/test',
  // guardSeam)` — so the `sample` spelling below would inherit a guard and the
  // PRODUCT spelling would not, and this endpoint makes the host issue an
  // outbound request to a caller-supplied URL. A door that is guarded under one
  // of its two names is not guarded. Same predicate, applied here, to both.
  const guard: RequestHandler = requireNonAnonymousPrincipal('the openwop-app MCP invoke seam');
  app.post('/v1/host/openwop-app/mcp/invoke', guard, handler);
  app.post('/v1/host/sample/mcp/invoke', guard, handler);
  log.info('mcp invoke seam mounted', { currentRevision: MCP_CURRENT_VERSION });
}
