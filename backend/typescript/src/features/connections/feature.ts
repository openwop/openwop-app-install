/**
 * Connections feature (ADR 0024) — a generic per-user / per-org credential broker
 * for external apps (Google, Slack, ServiceNow, Zoom, …). A self-contained
 * feature-package: it adds the per-user + per-org axes BYOK lacks and a provider
 * registry, then injects the resolved credential into the EXISTING core node
 * packs (core.openwop.{mcp,http,integration}). It ships NO new I/O.
 *
 * Phase A: the Connection store + provider registry + the api_key/bearer create
 * path + list/revoke + the resolver hook.
 * Phase B (this commit): the OAuth2 PKCE consent round-trip (authorize/callback),
 * on-demand + warm-daemon token refresh, and the `/test` health probe.
 * Org-connection RBAC management lands in Phase C.
 */

import type { BackendFeature } from '../types.js';
import { registerConnectionsRoutes } from './routes.js';
import { onConnectionRevoked } from '../../host/connectionLifecycle.js';
import { disableInboundForRevokedConnection, purgeInboundSession } from './inboundWebhooks.js';
import { unpair } from './messagingOutbound.js';
import { purgeTenantConnectionChildren } from './tenantTeardown.js';
import { registerTenantPurgeHook } from '../../host/hostExtPersistence.js';

// Connections graduated off its feature toggle on 2026-06-11 (ADR 0024
// § Correction): it is a permanent admin surface, always-on, so it registers
// NO `toggleDefault` — mirroring how Notifications/Widgets stay `BackendFeature`s
// for code organization without a toggle. Routes serve unconditionally.
export const connectionsFeature: BackendFeature = {
  id: 'connections',
  registerRoutes: (deps) => {
    registerConnectionsRoutes(deps);
    // ADR 0285 — the feature's OWN revoke consumer: a revoked credential
    // DISABLES its inbound-webhook config (never deletes it) and pauses the
    // trigger-bridge subscription. Keyed + idempotent registration.
    onConnectionRevoked('connections-inbound', async ({ tenantId, connectionId }) => {
      await disableInboundForRevokedConnection(tenantId, connectionId);
    });
    // ADR 0590 — the pairing + inbound-session POINTERS (`connections:pairing`,
    // `connections:inbound-session`) key by `connectionId` with no user-facing
    // state; unlike the inbound CONFIG they carry no "what broke" value, so they
    // are DELETED when the connection is revoked. This keeps them from orphaning
    // (revokeConnection deletes the parent row), which in turn makes the
    // tenant-purge hook below COMPLETE: at teardown every child has a live parent.
    // Delete the two children INDEPENDENTLY (best-effort each): the connection
    // row is already gone by the time this fires, so the teardown hook can never
    // re-enumerate this id — a child skipped here orphans PERMANENTLY, not
    // "re-markably". Awaiting them in sequence without isolation would let a
    // transient failure on `unpair` skip `purgeInboundSession` (or vice-versa).
    // The lifecycle seam already swallows a throw, so a per-child catch loses no
    // signal it wouldn't already lose while guaranteeing both are attempted.
    onConnectionRevoked('connections-children', async ({ connectionId }) => {
      try { await unpair(connectionId); } catch { /* best-effort; the other child still runs */ }
      try { await purgeInboundSession(connectionId); } catch { /* best-effort */ }
    });
    // ADR 0590 tenant-teardown pre-hook: the generic purgeTenantHostExt walk
    // deletes `connections:connection` (it has a tenantOf) but cannot reach the
    // pairing/inbound-session pointers (keyed by connectionId, no tenant). The
    // named `purgeTenantConnectionChildren` runs FIRST — while the connections
    // still resolve — and deletes each of the tenant's connections' children.
    // With the revoke consumer above ensuring no orphans exist, this reaches
    // every one of the tenant's rows.
    registerTenantPurgeHook('connections', purgeTenantConnectionChildren);
  },
};
