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
import { resolveProvidersForCapability } from '../features/connections/connectionsService.js';
import { listProviders } from '../features/connections/providerRegistry.js';
import { isInstanceScopedProvider } from './connectorInstancePin.js';
import type { BrokeredEgressDeps, AuthScheme } from './brokeredEgress.js';
import { runClientOrgOf } from './runClientOrg.js';

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
    /** Host-local cancellation; the broker still owns the network request. */
    signal?: AbortSignal;
  }): Promise<{ ok: boolean; status?: number; data?: unknown; error?: string; link?: string }>;
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

/**
 * ADR 1035 D2 — the run's client, decided HOST-side. In a client-stamped run
 * (ADR 0944 D2), an INSTANCE-SCOPED provider (ADR 1035 D1) is served only by the
 * client org's own connection: no user or workspace fall-through, whatever the
 * caller passes. A pack cannot opt out, so the guard is not a property of the
 * caller. `null` = not a client run (unchanged selection); a refusal when the
 * stamp is unreadable or names two clients.
 */
async function runClient(deps: BrokeredEgressDeps): Promise<{ orgId: string } | { refused: true } | null> {
  const stamp = await runClientOrgOf(deps.tenantId, deps.runId);
  if (stamp && 'refused' in stamp) return { refused: true };
  return stamp ?? null;
}

/** Skip the stamp read for a category no instance-scoped provider belongs to. */
function getProviderCategoryHasInstanceScoped(capability: string): boolean {
  return listProviders().some((p) => p.category === capability && isInstanceScopedProvider(p.id));
}

export function makeConnectorsAdapter(deps: BrokeredEgressDeps): ConnectorsAdapter {
  const invoker = createConnectorInvoker({ storage: deps.storage });
  const plain = (capability: string) => resolveProvidersForCapability({
    tenantId: deps.tenantId,
    capability,
    ...(deps.actingUserId ? { actingUserId: deps.actingUserId } : {}),
    ...(deps.orgId ? { orgId: deps.orgId } : {}),
  });
  /** The capability's providers for this run: in a client run, the client's own
   *  instance-scoped providers first, then the non-instance-scoped ones as before;
   *  another org's or the workspace's instance-scoped connection never counts. */
  const forRun = async (capability: string): Promise<string[]> => {
    if (!getProviderCategoryHasInstanceScoped(capability)) return plain(capability);
    const client = await runClient(deps);
    if (client === null) return plain(capability);
    const others = (await plain(capability)).filter((p) => !isInstanceScopedProvider(p));
    if ('refused' in client) return others;
    const own = await resolveProvidersForCapability({
      tenantId: deps.tenantId, capability, orgId: client.orgId, orgOnly: true,
      ...(deps.actingUserId ? { actingUserId: deps.actingUserId } : {}),
    });
    return [...own.filter((p) => isInstanceScopedProvider(p)), ...others];
  };
  return {
    async invoke(connectorId, request) {
      let orgId = deps.orgId;
      let orgOnly = false;
      if (isInstanceScopedProvider(connectorId)) {
        const client = await runClient(deps);
        if (client && 'refused' in client) return { ok: false, error: 'connector_client_org_unreadable' };
        if (client) { orgId = client.orgId; orgOnly = true; }
      }
      return invoker.invoke(connectorId, {
        context: {
          tenantId: deps.tenantId,
          runId: deps.runId,
          ...(deps.actingUserId ? { actingUserId: deps.actingUserId } : {}),
          ...(orgId ? { orgId } : {}),
        },
        request: { ...request, ...(orgOnly ? { orgOnly: true } : {}) },
      });
    },
    async resolveForCapability(capability) {
      return (await forRun(capability))[0] ?? null;
    },
    resolveAllForCapability(capability) {
      return forRun(capability);
    },
  };
}
