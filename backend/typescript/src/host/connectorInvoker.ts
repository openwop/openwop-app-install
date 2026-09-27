/**
 * Connector invoker (ADR 0037) — the real implementation behind the
 * `connectorInvoker` host slot (host/index.ts), replacing the throw-on-use stub.
 *
 * A "connector" is a thin, host-curated egress wrapper over a Connections
 * provider: `invoke(connectorId, args)` resolves the acting human's Connection
 * for the connector's provider through the EXISTING broker and performs an
 * audited, token-injected HTTP call via brokered egress. It is NOT a new egress
 * path — it composes `brokeredFetch` (which itself reuses the RFC 0093 SSRF
 * dispatcher + the provider `apiHosts` pin), so the connector inherits the whole
 * security spine for free:
 *   - the credential is host-resolved as the run's `actingUserId`; the broker
 *     enforces `connections:use` for org connections (fail-closed);
 *   - the destination is pinned to the provider's curated `apiHosts` (eTLD+1,
 *     never substring) — a connector can never be a generic egress bypass;
 *   - the provider allowlist (ADR 0028 governance) is enforced inside the broker;
 *   - the token goes over https only, never follows a redirect, never lands in
 *     node config / an event / the run doc / a log;
 *   - every successful call stamps RFC 0079 provenance on
 *     `run.metadata.connectionUse[]`.
 *
 * BOUNDED FIRST CUT (honesty): `connectorId` IS a registered Connections provider
 * id (e.g. `servicenow`). A connector with no configured Connection FAILS CLOSED
 * (`connector_no_connection`), never a silent no-op or a 500. Richer connector
 * descriptors (named operations, request/response schemas, retries, pagination)
 * are deferred — see ADR 0037 §Deferrals.
 */

import { createLogger } from '../observability/logger.js';
import { OpenwopError } from '../types.js';
import { getProvider } from '../features/connections/providerRegistry.js';
import { brokeredFetch, type AuthScheme, type BrokeredEgressDeps } from './brokeredEgress.js';
import { stampConnectionUse } from './connectionInjection.js';

const log = createLogger('host.connectors');

/** The structured request a caller hands `connectorInvoker.invoke`. The run
 *  context (tenant / run / acting user / org) rides in `args` because the host
 *  factory is built once per process, not per run. */
export interface ConnectorInvokeArgs {
  /** Run context — the broker resolves the acting human's Connection from this. */
  context: {
    tenantId: string;
    runId: string;
    /** Absent ⇒ system run ⇒ the broker withholds the user/org connection. */
    actingUserId?: string;
    orgId?: string;
  };
  /** The egress request. `url` MUST resolve to one of the provider's curated
   *  `apiHosts` (brokeredFetch pins it; an off-host URL fails closed). */
  request: {
    url: string;
    method?: string;
    body?: string;
    contentType?: string;
    authScheme?: AuthScheme;
    /** Static, non-secret headers a provider protocol requires (e.g. NetSuite
     *  SuiteQL's `Prefer: transient`). The broker strips any `authorization` /
     *  `content-type` variant — it stays the sole authority for those. */
    extraHeaders?: Record<string, string>;
    /** ADR 0627 D5 — pin the credential to ONE connection row. Threaded to the
     *  broker's selection choke (`selectAuthorizedConnection`), where a pin is
     *  EXACT: a row that is not `active` / not this provider / not the acting
     *  user's (or org-shared with `connections:use`) is refused, and the
     *  user→org→workspace fall-through is never consulted. Surfaced as
     *  `connector_pinned_connection_unusable` so the caller can react (the CRM
     *  gmail sync marks itself `needs-reconsent`). */
    connectionId?: string;
  };
}

export interface ConnectorInvokeResult {
  ok: boolean;
  status?: number;
  /** Parsed JSON body when the response is JSON; raw text otherwise. */
  data?: unknown;
  /** A stable error code when `ok:false` (fail-closed reasons). */
  error?: string;
}

/** Precise shape `createConnectorInvoker` returns — structurally assignable to the
 *  looser `ConnectorInvoker` host slot (whose `invoke` returns `Promise<unknown>`),
 *  but typed concretely so node-facing callers (ctx.connectors) get a typed result. */
export interface ConcreteConnectorInvoker {
  invoke(connectorId: string, args: unknown): Promise<ConnectorInvokeResult>;
}

function isConnectorInvokeArgs(args: unknown): args is ConnectorInvokeArgs {
  if (typeof args !== 'object' || args === null) return false;
  const a = args as Partial<ConnectorInvokeArgs>;
  return (
    typeof a.context === 'object' && a.context !== null &&
    typeof a.context.tenantId === 'string' && typeof a.context.runId === 'string' &&
    typeof a.request === 'object' && a.request !== null && typeof a.request.url === 'string'
  );
}

/**
 * Build the host's connector invoker. Composes the Connections broker + brokered
 * egress; takes no I/O of its own. Deps mirror the integration adapters
 * (`storage` is the only persistent dependency — the run context arrives per-call
 * in `args`).
 */
export function createConnectorInvoker(deps: { storage: BrokeredEgressDeps['storage'] }): ConcreteConnectorInvoker {
  return {
    async invoke(connectorId: string, args: unknown): Promise<ConnectorInvokeResult> {
      // First cut: a connector id IS a registered Connections provider id.
      const provider = getProvider(connectorId);
      if (!provider) {
        throw new OpenwopError(
          'not_found',
          `No connector '${connectorId}' — a connector id must be a registered Connections provider (RFC 0095). Install a connection pack, or pick a built-in provider.`,
          404,
          { connectorId },
        );
      }
      if (!isConnectorInvokeArgs(args)) {
        throw new OpenwopError(
          'invalid_request',
          `connector '${connectorId}' invoked with malformed args — expected { context:{tenantId,runId,…}, request:{url,…} }.`,
          400,
          { connectorId },
        );
      }

      // ADR 0076 P3 — host-side read-only gate (defense-in-depth). For a provider
      // declared `readOnly`, fail closed on unambiguously-mutating verbs before the
      // secret is ever touched. Method default mirrors brokeredFetch (absent ⇒ GET).
      // Intentionally PERMISSIVE to GET/POST (read APIs like BigQuery jobs.query are
      // POST-with-a-body) — so this cannot catch a mutating POST; the primary control
      // is the provider's missing write scope + provider-side enforcement.
      if (provider.readOnly) {
        const method = (args.request.method ?? 'GET').toUpperCase();
        if (method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
          return { ok: false, error: 'connector_read_only' };
        }
      }

      const egressDeps: BrokeredEgressDeps = {
        storage: deps.storage,
        tenantId: args.context.tenantId,
        runId: args.context.runId,
        ...(args.context.actingUserId ? { actingUserId: args.context.actingUserId } : {}),
        ...(args.context.orgId ? { orgId: args.context.orgId } : {}),
      };

      const r = await brokeredFetch(egressDeps, {
        provider: connectorId,
        url: args.request.url,
        ...(args.request.method ? { method: args.request.method } : {}),
        ...(args.request.body !== undefined ? { body: args.request.body } : {}),
        ...(args.request.contentType ? { contentType: args.request.contentType } : {}),
        ...(args.request.authScheme ? { authScheme: args.request.authScheme } : {}),
        ...(args.request.extraHeaders ? { extraHeaders: args.request.extraHeaders } : {}),
        // `!== undefined`, not truthiness: an EMPTY pin is a refusal, never an un-pin
        // (the broker gates on `!== undefined` too — three layers, one rule).
        ...(args.request.connectionId !== undefined ? { connectionId: args.request.connectionId } : {}),
      });

      // Fail closed — never a silent no-op, never a 500. Each is a stable code.
      // Under a pin, `no_connection` can only mean the PINNED row is unusable
      // (refused at selection, or its secret failed to resolve/refresh) — the
      // broker never substituted another credential — so it gets its own code.
      if (r.outcome === 'no_connection') {
        return { ok: false, error: args.request.connectionId !== undefined ? 'connector_pinned_connection_unusable' : 'connector_no_connection' };
      }
      if (r.outcome === 'host_not_allowed') return { ok: false, error: 'connector_host_not_allowed' };
      if (r.outcome === 'insecure_base') return { ok: false, error: 'connector_insecure_base' };
      if (r.outcome === 'request_failed') return { ok: false, error: r.timedOut ? 'connector_timeout' : 'connector_request_failed' };

      // Stamp provenance only on a transport success (an HTTP error from the
      // provider is still a "use" of the credential — we reached the provider).
      await stampConnectionUse(deps.storage, args.context.runId, r.provenance);

      const ct = r.res.headers.get('content-type') ?? '';
      let data: unknown;
      try {
        data = ct.includes('application/json') ? await r.res.json() : await r.res.text();
      } catch (err) {
        log.warn('connector response body unreadable', { connectorId, error: err instanceof Error ? err.message : String(err) });
        data = undefined;
      }
      return { ok: r.res.ok, status: r.res.status, data };
    },
  };
}
