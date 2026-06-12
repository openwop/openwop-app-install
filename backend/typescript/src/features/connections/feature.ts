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

// Connections graduated off its feature toggle on 2026-06-11 (ADR 0024
// § Correction): it is a permanent admin surface, always-on, so it registers
// NO `toggleDefault` — mirroring how Notifications/Widgets stay `BackendFeature`s
// for code organization without a toggle. Routes serve unconditionally.
export const connectionsFeature: BackendFeature = {
  id: 'connections',
  registerRoutes: (deps) => registerConnectionsRoutes(deps),
};
