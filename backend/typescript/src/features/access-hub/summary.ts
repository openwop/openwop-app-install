/**
 * Access hub summary (ADR 0864) — the counts the `/access` console shows beside
 * its sections, in its summary cards and in its "needs reconnecting" banner.
 *
 * Every section is read through the SAME request-level reader its own list route
 * uses (ADR 0864 D2), so a count can never include a row the section's panel
 * would not show. A section whose reader refuses or fails is OMITTED, never
 * reported as zero: the console shows no count rather than a false "none".
 *
 * Counts only (D3) — no secret refs, key names, member identities or rule bodies.
 * The one exception is the banner's subject: the display name and provider of a
 * connection that needs reconnecting, which the Connections panel already shows
 * the same caller.
 */
import type { Request } from 'express';
import { OpenwopError } from '../../types.js';
import { createLogger } from '../../observability/logger.js';
import { listCallerSecretRefs } from '../../routes/byok.js';
import { listCallerOrgs, readOrgCounts } from '../../routes/accessControl.js';
import { countReadableCompatEndpoints } from '../../routes/compatEndpoints.js';
import { listCallerConnections } from '../connections/routes.js';
import type { Connection } from '../connections/connectionsService.js';
import { listVisibleApiKeys } from '../developer-keys/routes.js';
import { isExpired } from '../developer-keys/apiKeyService.js';
import { readRealtimeProvider } from '../voice/realtime/routes.js';
import { readFirewallPosture } from '../capability-firewall/routes.js';

const log = createLogger('access-hub.summary');

/** The MCP page's naming convention for its client keys — mirrors
 *  `frontend/react/src/features/developer-keys/apiKeysClient.ts` `MCP_KEY_PREFIX`.
 *  A naming convention, not a field (see that file). */
const MCP_KEY_PREFIX = 'MCP: ';

/** Bound on the banner's named connections; the count is always exact. */
const MAX_NAMED = 5;

export interface ConnectionCounts {
  count: number;
  needsReconnect: number;
  /** Up to `MAX_NAMED` of the connections that need reconnecting, for the banner. */
  reconnect: { connectionId: string; displayName: string; provider: string }[];
}

export interface AccessSummary {
  keys?: { count: number };
  /** Split by the Connections panel's own axis: a `userId` row is Personal. */
  connections?: { workspace: ConnectionCounts; personal: ConnectionCounts };
  voice?: { on: boolean };
  apiKeys?: { count: number; expired: number };
  mcpClients?: { count: number };
  orgs?: { count: number; members: number };
  firewall?: { isDefault: boolean; rules: number };
  /** ADR 0866 — summed over the orgs the caller can read, as the panel's picker offers them. */
  endpoints?: { count: number };
}

/** The predicate `ConnectionsManager.tsx` and `connectionsService.ts` use (D4). */
export function needsReconnect(c: Pick<Connection, 'kind' | 'status'>): boolean {
  return c.kind === 'oauth2' && (c.status === 'needs-reconsent' || c.status === 'expired');
}

function countConnections(rows: readonly Connection[]): ConnectionCounts {
  const broken = rows.filter(needsReconnect);
  return {
    count: rows.length,
    needsReconnect: broken.length,
    reconnect: broken.slice(0, MAX_NAMED).map((c) => ({ connectionId: c.connectionId, displayName: c.displayName, provider: c.provider })),
  };
}

/**
 * Run one section's reader. A refusal (the section's own 401/403/404) means the
 * caller may not see it; anything else is a failure worth a log line. Either way
 * the section is omitted.
 */
async function section<T>(name: string, read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (err) {
    const status = err instanceof OpenwopError ? err.httpStatus : undefined;
    if (status !== 401 && status !== 403 && status !== 404) {
      log.warn('access_summary_section_failed', { section: name, error: err instanceof Error ? err.message : String(err) });
    }
    return undefined;
  }
}

export async function buildAccessSummary(req: Request, now: number = Date.now()): Promise<AccessSummary> {
  const [keys, connections, voice, apiKeys, orgs, firewall, endpoints] = await Promise.all([
    section('keys', async () => ({ count: (await listCallerSecretRefs(req)).length })),
    section('connections', async () => {
      const rows = await listCallerConnections(req);
      return {
        workspace: countConnections(rows.filter((c) => !c.userId)),
        personal: countConnections(rows.filter((c) => Boolean(c.userId))),
      };
    }),
    section('voice', async () => ({ on: (await readRealtimeProvider(req)) !== 'off' })),
    section('apiKeys', async () => (await listVisibleApiKeys(req)).keys.filter((k) => !k.revokedAt)),
    section('orgs', async () => {
      const c = await readOrgCounts(req);
      return { count: c.orgs, members: c.members };
    }),
    section('firewall', () => readFirewallPosture(req)),
    section('endpoints', async () => {
      const count = await countReadableCompatEndpoints(req, (await listCallerOrgs(req)).map((o) => o.orgId));
      return count === null ? undefined : { count }; // too many orgs to check: omit, never under-report
    }),
  ]);

  const out: AccessSummary = {};
  if (keys) out.keys = keys;
  if (connections) out.connections = connections;
  if (voice) out.voice = voice;
  if (apiKeys) {
    out.apiKeys = { count: apiKeys.length, expired: apiKeys.filter((k) => isExpired(k.expiresAt, now)).length };
    out.mcpClients = { count: apiKeys.filter((k) => k.name.startsWith(MCP_KEY_PREFIX)).length };
  }
  if (orgs) out.orgs = orgs;
  if (firewall) out.firewall = firewall;
  if (endpoints) out.endpoints = endpoints;
  return out;
}
