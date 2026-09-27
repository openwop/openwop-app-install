/**
 * MCP server mount — RFC 0020 reference implementation.
 *
 * Exposes a JSON-RPC endpoint at `POST /v1/host/openwop-app/mcp` so external
 * MCP clients (Claude Desktop, Cursor, conformance harness) can:
 *   - discover workflows exposed via `core.openwop.mcp.expose-{tool,
 *     resource,prompt}` nodes;
 *   - invoke them via `tools/call` / `resources/read` / `prompts/get`;
 *   - issue bidirectional `sampling/createMessage` + `elicitation/create`
 *     that bridge into the workflow's `ctx.callAI` / `ctx.suspend`.
 *
 * Env-gated on `OPENWOP_MCP_SERVER_ENABLED=true`. OFF by default; boot
 * log warns when ON. Sample-vendor-namespaced under `/v1/host/openwop-app/*`
 * per `spec/v1/host-extensions.md` §"Canonical prefixes" — NOT part of
 * the openwop wire contract.
 *
 * @see RFCS/0020-host-mcp-server-composition.md
 */

import type { Express, Request } from 'express';
import type { Storage } from '../storage/storage.js';
import type { HostAdapterSuite } from '../host/index.js';
import type { Principal } from '../types.js';
import { dispatch } from '../host/mcpServerRouter.js';
import { dispatchCurrent } from '../host/mcpCurrentCodec.js';
import { MCP_ERR_UNSUPPORTED_VERSION, MCP_PROTOCOL_VERSION_HEADER, MCP_SUPPORTED_VERSIONS, selectMcpCodec } from '../host/mcpProfile.js';
import { parseRequest, rpcError } from '../host/mcpJsonRpc.js';
import { enforceMcpPrincipalRateLimit } from '../middleware/rateLimit.js';
import { sendError } from '../middleware/errorEnvelope.js';
import { anonymousActorAdvertised } from '../host/anonymousActor.js';
import { mcpAuditTarget, recordMcpAudit } from '../host/mcpAudit.js';
import { createLogger } from '../observability/logger.js';

const log = createLogger('routes.mcp');

interface Deps {
  storage: Storage;
  hostSuite: HostAdapterSuite;
}

export function registerMcpServerRoutes(app: Express, deps: Deps): void {
  if (process.env.OPENWOP_MCP_SERVER_ENABLED !== 'true') {
    log.info('mcp server mount disabled (set OPENWOP_MCP_SERVER_ENABLED=true to enable)');
    return;
  }
  log.warn(
    'mcp server mount ENABLED — POST /v1/host/openwop-app/mcp is reachable. NEVER enable in production without auth review.',
  );

  app.post('/v1/host/openwop-app/mcp', async (req, res) => {
    // ADR 0553 P3 — every refusal below emits ONE content-free audit row
    // (`host/mcpAudit.ts`), so an inbound refusal is as auditable as an outbound
    // one and the two share a payload shape. `durationMs` is measured from here
    // because a refusal's cost is a real signal: an unauthenticated prober and a
    // version-refused peer have very different profiles.
    const startedAtMs = Date.now();
    const principal = principalFromReq(req);
    if (!principal) {
      // ADR 0553 P0 — fail CLOSED. No principal, no MCP. Returned before the
      // body is even parsed, so an unauthenticated caller learns nothing about
      // which methods or tools this host exposes.
      // DELIBERATELY NOT an audit-chain row (H53 self-review). This branch is
      // reachable by any unauthenticated caller, and a durable hash-chain append
      // takes a per-tenant lock and a seq CAS — so auditing it would let an
      // anonymous prober drive unbounded writes into a tenant bucket it does not
      // belong to (there IS no tenant here; the row would have to invent one).
      // The refusal is already recorded content-free in the structured log, and
      // the ADR's audit requirement is about MCP DECISIONS, which presuppose a
      // principal. Every branch below has one and is audited.
      log.warn('mcp_unauthenticated_rejected', { path: req.path });
      res.status(401).json({ error: 'unauthorized', message: 'MCP requires an authenticated principal.' });
      return;
    }
    // RFC 0153 §E (H43, MEASURED on prod 2026-08-17): "an anonymous MCP
    // principal MUST NOT be the production default for an advertised current
    // profile — refuse (401/403) or advertise anonymousActor". The check above
    // is not that boundary: in the cookie posture the auth middleware MINTS a
    // principal for a credential-less caller (`anon:<sid>`, ADR 0015) and marks
    // it `req.anonymousPrincipal`, so `principalFromReq` returned a principal
    // and an unauthenticated POST to the mount got a live 2026-07-28 session —
    // `mcp-current-auth-boundary` red against prod (`expected [401,403] to
    // include 200`), green locally only because the driver's unauthenticated
    // request carries no cookie either. Consumers MUST NOT treat an anonymous
    // principal as authenticated (`auth.ts` § anonymousPrincipal); the one
    // sanctioned exception is the RFC 0132 anonymous-actor capability, and only
    // when the host ADVERTISES it — the advert and the behaviour must agree.
    // The test-seam posture (`OPENWOP_TEST_SEAM_ENABLED`, OFF in production and
    // documented above as a non-production affordance) keeps its existing
    // behaviour so the seam-driven codec/mount tests can post credential-less;
    // the guard is the PRODUCTION boundary, and prod runs with the seam off.
    if (
      req.anonymousPrincipal === true
      && !anonymousActorAdvertised()
      && process.env.OPENWOP_TEST_SEAM_ENABLED !== 'true'
    ) {
      log.warn('mcp_anonymous_principal_refused', { path: req.path });
      await recordMcpAudit({ tenantId: principal.tenants[0] ?? 'unknown', direction: 'inbound', method: 'unknown', target: mcpAuditTarget('mount'), principal: principal.principalId, outcome: 'unauthenticated', reason: 'anonymous_principal', durationMs: Date.now() - startedAtMs });
      sendError(res, 401, 'unauthenticated', 'MCP requires an authenticated, non-anonymous principal (RFC 0153 §E); this host does not advertise anonymousActor.', { reason: 'anonymous_principal_refused' });
      return;
    }
    const parsed = parseRequest(req.body);
    if ('error' in parsed) {
      res.status(200).json(parsed);
      return;
    }
    // MCP-1 (ADR 0087 OQ-2) — per-principal budget on `tools/call` (which runs a
    // workflow), layered on the per-IP floor. Reads (`tools/list`, etc.) stay on
    // the IP floor. On exceed, a canonical 429 is already sent. Applied before
    // codec selection: the budget is about what the method DOES, and both
    // revisions spell `tools/call` the same way.
    if (parsed.method === 'tools/call' && enforceMcpPrincipalRateLimit(res, principal.principalId)) {
      return;
    }
    const semanticDeps = { storage: deps.storage, hostSuite: deps.hostSuite, principal };

    // ADR 0553 P2 — ONE mount, TWO codecs, selected by `MCP-Protocol-Version`
    // (RFC 0153 §B). There is deliberately no second route: a `/mcp-2026`
    // endpoint would duplicate this file's authorization boundary, which is the
    // alternative ADR 0553 weighed and rejected.
    const selection = selectMcpCodec(req.headers[MCP_PROTOCOL_VERSION_HEADER]);
    if (selection.kind === 'unsupported') {
      // THE FAIL-CLOSED PATH ADR 0553 P1 DEFERRED. An explicit header naming a
      // revision this host does not serve is refused with the revisions it does
      // serve — never silently downgraded into the legacy codec, which is what
      // ignoring the header would amount to.
      log.info('mcp_version_refused', { requested: selection.requested });
      // `selection.requested` is peer-controlled text and therefore does NOT
      // reach the audit row; the closed `reason` code carries the fact and the
      // structured log above carries the value for diagnosis.
      await recordMcpAudit({
        tenantId: principal.tenants[0] ?? 'unknown',
        direction: 'inbound',
        method: parsed.method,
        target: mcpAuditTarget('mount'),
        principal: principal.principalId,
        outcome: 'version_refused',
        reason: selection.requested === '' ? 'header_absent_legacy_unserved' : 'unsupported_revision',
        durationMs: Date.now() - startedAtMs,
      });
      res.status(400).json(
        rpcError(parsed.id ?? null, MCP_ERR_UNSUPPORTED_VERSION, `protocol version ${selection.requested} is not supported by this host`, {
          supported: [...MCP_SUPPORTED_VERSIONS],
          requested: selection.requested,
        }),
      );
      return;
    }
    if (selection.kind === 'current') {
      const current = await dispatchCurrent({ request: parsed, headers: req.headers, deps: semanticDeps });
      res.status(current.status).json(current.body);
      return;
    }
    const response = await dispatch(parsed, semanticDeps);
    res.status(200).json(response);
  });
}

/**
 * ADR 0553 P0 — the principal for an inbound MCP call, or `null` to fail closed.
 *
 * This used to SYNTHESIZE `{ principalId: 'mcp-anonymous', tenants: ['*'] }`
 * whenever auth middleware had not populated a principal, with a comment
 * explaining that the conformance harness might not. Two things were wrong
 * with that:
 *
 *  1. **A tenant WILDCARD as a fallback.** `tenants: ['*']` is the widest
 *     possible authority, handed out precisely when the host could not
 *     establish who was calling. The safe default for "I do not know who you
 *     are" is no authority, not all of it.
 *  2. **It was unconditional**, so the conformance convenience was reachable on
 *     any deployment where middleware failed to attach a principal. ADR 0553:
 *     "A warning is not an authorization boundary. This must never be
 *     production-reachable."
 *
 * `isAnonymousPrincipal` (ADR 0087) did mitigate this — it denies *gated* tools
 * to `mcp-anonymous` and to any wildcard principal. But that is a per-tool
 * check, so any tool that never opted into gating stayed reachable. A per-tool
 * denial is not a substitute for a route-level boundary.
 *
 * Now: an explicit, NON-wildcard test principal behind the same
 * `OPENWOP_TEST_SEAM_ENABLED` flag the rest of the host uses for conformance
 * seams, and `null` — a 401 — everywhere else.
 */
export const MCP_TEST_SEAM_PRINCIPAL_ID = 'mcp-test-seam';

/** Exported for tests: the boundary itself, independent of the global auth
 *  middleware that sits in front of it. */
export function principalFromReq(req: Request): Principal | null {
  const maybe = (req as Request & { principal?: Principal }).principal;
  if (maybe) return maybe;
  if (process.env.OPENWOP_TEST_SEAM_ENABLED === 'true') {
    // Scoped to ONE named tenant, never `['*']`. The conformance harness needs
    // a caller; it does not need omniscience, and giving it a wildcard is what
    // made the seam a production hazard rather than a test affordance.
    return {
      principalId: MCP_TEST_SEAM_PRINCIPAL_ID,
      tenants: ['default'],
      token: '',
      // ADR 0601 — named so an authority resolver can see it is the seam and
      // give it nothing. A test affordance must not accumulate authority by
      // being indistinguishable from a real credential.
      auth: { kind: 'test-seam' },
    };
  }
  return null;
}
