/**
 * Connectors egress adapter — `ctx.connectors` for workflow nodes (ADR 0076).
 *
 * ADR 0037 shipped the `connectorInvoker` host slot but never exposed it to the
 * node `ctx` (it had zero callers). This adapter is the node-facing front door:
 * it binds the per-run context (tenant / run / acting user / org) to the process
 * `connectorInvoker` and exposes a single `invoke(connectorId, request)` the way
 * `ctx.email`/`ctx.slack` expose theirs. It adds NO new egress path — it composes
 * the same broker (`brokeredFetch` → SSRF guard + provider `apiHosts` pin +
 * `connections:use` gate + RFC 0079 provenance), so a connector can never be a
 * generic egress bypass.
 *
 * First consumer: the `core.bigquery.query` node (ADR 0076 — a dedicated read-only
 * `bigquery` provider pinned to `bigquery.googleapis.com`; deliberately NOT the broad
 * `google` provider, which a connection pack can override and strip of `apiHosts`).
 */

import { createConnectorInvoker } from './connectorInvoker.js';
import { resolveProviderForCapability, resolveProvidersForCapability } from '../features/connections/connectionsService.js';
import type { BrokeredEgressDeps, AuthScheme } from './brokeredEgress.js';

export interface ConnectorsAdapter {
  invoke(connectorId: string, request: {
    url: string;
    method?: string;
    body?: string;
    contentType?: string;
    authScheme?: AuthScheme;
    extraHeaders?: Record<string, string>;
    /** ADR 0627 D5 — exact connection pin (see `ConnectorInvokeArgs.request.connectionId`). */
    connectionId?: string;
  }): Promise<{ ok: boolean; status?: number; data?: unknown; error?: string }>;
  /** Resolve the acting human's connected provider for a capability CATEGORY
   *  ("email-calendar" / "hr" / "ticketing" / …) — the Phase-2 capability binding
   *  (ADR 0186 capability-dispatch). Returns the provider id to hand back to
   *  `invoke`, or `null` when the tenant has no authorized connection of that
   *  category, so a capability node degrades gracefully instead of hard-coding one
   *  vendor. Runs through the same authorization choke point as every connection. */
  resolveForCapability(capability: string): Promise<string | null>;
  /** All authorized providers for a capability category, precedence-ordered — for a
   *  node that supports only a SUBSET of a coarse category and must pick one it can
   *  actually serve (ADR 0186). */
  resolveAllForCapability(capability: string): Promise<string[]>;
}

export function makeConnectorsAdapter(deps: BrokeredEgressDeps): ConnectorsAdapter {
  const invoker = createConnectorInvoker({ storage: deps.storage });
  return {
    invoke(connectorId, request) {
      return invoker.invoke(connectorId, {
        context: {
          tenantId: deps.tenantId,
          runId: deps.runId,
          ...(deps.actingUserId ? { actingUserId: deps.actingUserId } : {}),
          ...(deps.orgId ? { orgId: deps.orgId } : {}),
        },
        request,
      });
    },
    resolveForCapability(capability) {
      return resolveProviderForCapability({
        tenantId: deps.tenantId,
        capability,
        ...(deps.actingUserId ? { actingUserId: deps.actingUserId } : {}),
        ...(deps.orgId ? { orgId: deps.orgId } : {}),
      });
    },
    resolveAllForCapability(capability) {
      return resolveProvidersForCapability({
        tenantId: deps.tenantId,
        capability,
        ...(deps.actingUserId ? { actingUserId: deps.actingUserId } : {}),
        ...(deps.orgId ? { orgId: deps.orgId } : {}),
      });
    },
  };
}
