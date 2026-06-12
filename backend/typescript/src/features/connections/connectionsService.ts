/**
 * Connections store (ADR 0024) — a generic per-user / per-org credential broker.
 *
 * Splits storage by sensitivity (the ADR's reuse decision):
 *   - NON-secret metadata (provider, kind, scopes, status, scope axes) → a
 *     DurableCollection here.
 *   - The secret material (api key / bearer / refresh token) → the BYOK envelope
 *     (`setSecret`/`resolveSecret`, KMS-enveloped for signed-in tenants), keyed
 *     `connection:<connectionId>`. We never persist a secret in our own store.
 *
 * Isolation: a connection carries `userId?` (per-user) and/or `orgId?` (shared
 * org). The resolver picks the MOST SPECIFIC connection for a run's acting
 * principal — user → org → workspace (least privilege by default, D2).
 */

import { randomUUID } from 'node:crypto';
import { OpenwopError } from '../../types.js';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { setSecret, resolveSecret, removeSecret } from '../../byok/secretResolver.js';
import { createLogger } from '../../observability/logger.js';
import { resolveEffectiveAccess } from '../../host/accessControlService.js';
import { isProviderAllowed } from '../../host/governanceService.js';
import { getProvider, type CredentialKind } from './providerRegistry.js';
import { refreshAccessToken, type OAuthTokenMaterial } from './oauthFlow.js';

const log = createLogger('connections.service');

/** Refresh an oauth2 access token this many ms BEFORE it actually expires, so a
 *  run never picks up a token that lapses mid-flight. */
const TOKEN_REFRESH_SKEW_MS = 60_000;

export type ConnectionStatus = 'active' | 'needs-reconsent' | 'expired' | 'revoked';
/** The scope axis a connection is bound to (D2 — actor never changes; this is the authority). */
export type ConnectionScope = 'user' | 'org' | 'workspace';

export interface Connection {
  connectionId: string;
  tenantId: string;
  /** per-user isolation axis (the acting user who consented); absent for org/workspace. */
  userId?: string;
  /** shared-org connection (admin-managed, member-usable by grant); absent for user/workspace. */
  orgId?: string;
  provider: string;
  kind: CredentialKind;
  displayName: string;
  scopes: string[];
  status: ConnectionStatus;
  /** which Google/Slack identity (oauth2); absent for api_key/bearer. */
  externalSubject?: string;
  expiresAt?: string;
  connectedAt: string;
  updatedAt: string;
}

const store = new DurableCollection<Connection>('connections:connection', (c) => c.connectionId);

const now = (): string => new Date().toISOString();
const secretRef = (connectionId: string): string => `connection:${connectionId}`;

function scopeAxisOf(c: Connection): ConnectionScope {
  if (c.userId) return 'user';
  if (c.orgId) return 'org';
  return 'workspace';
}

/** List a caller's connections (metadata only — never secret material). Includes
 *  the caller's own user connections, the workspace's org connections, and the
 *  workspace default. */
export async function listConnections(tenantId: string, userId?: string): Promise<Connection[]> {
  return (await store.list())
    .filter((c) => c.tenantId === tenantId)
    .filter((c) => (c.userId ? c.userId === userId : true))
    .sort((a, b) => a.provider.localeCompare(b.provider));
}

export async function getConnection(tenantId: string, connectionId: string): Promise<Connection | null> {
  const c = await store.get(connectionId);
  return c && c.tenantId === tenantId ? c : null;
}

/**
 * Create an api_key/bearer/basic connection (the no-consent path, ADR 0024 §3).
 * OAuth2 (kind oauth2) is acquired via the authorize/callback flow (Phase B);
 * passing a raw secret for an oauth2 provider is rejected.
 */
export async function createSecretConnection(input: {
  tenantId: string;
  provider: string;
  kind: Extract<CredentialKind, 'api_key' | 'bearer' | 'basic'>;
  secret: string;
  displayName?: string;
  scope: ConnectionScope;
  userId?: string;
  orgId?: string;
  scopes?: string[];
}): Promise<Connection> {
  const manifest = getProvider(input.provider);
  if (!manifest) throw new OpenwopError('connection_provider_unresolved', `No connection provider '${input.provider}' — install a connection pack whose provider.id is '${input.provider}', or none is built in (RFC 0095 §B.6).`, 404, { provider: input.provider });

  const connectionId = `conn:${randomUUID()}`;
  const connection: Connection = {
    connectionId,
    tenantId: input.tenantId,
    provider: input.provider,
    kind: input.kind,
    displayName: input.displayName ?? manifest.label,
    scopes: input.scopes ?? manifest.defaultScopes,
    status: 'active',
    connectedAt: now(),
    updatedAt: now(),
    ...(input.scope === 'user' && input.userId ? { userId: input.userId } : {}),
    ...(input.scope === 'org' && input.orgId ? { orgId: input.orgId } : {}),
  };
  // Secret material → BYOK envelope (KMS for signed-in tenants); never in our store.
  await setSecret(secretRef(connectionId), input.secret, { tenantId: input.tenantId });
  await store.put(connection);
  return connection;
}

/** Find an existing connection by its identity tuple (the ADR's UNIQUE key) so a
 *  re-consent updates the same row instead of stacking duplicates. */
async function findByIdentity(tenantId: string, provider: string, userId?: string, orgId?: string): Promise<Connection | null> {
  const all = await store.list();
  return (
    all.find(
      (c) =>
        c.tenantId === tenantId &&
        c.provider === provider &&
        (c.userId ?? undefined) === (userId ?? undefined) &&
        (c.orgId ?? undefined) === (orgId ?? undefined),
    ) ?? null
  );
}

/**
 * Land an oauth2 connection from a completed consent round-trip (ADR 0024 §3).
 * The token material (refresh + access token) is stored KMS-enveloped via the
 * BYOK envelope as a JSON blob; only non-secret metadata lands in our store.
 * A re-consent for the same (tenant, user, provider) UPDATES the existing row.
 */
export async function upsertOAuthConnection(input: {
  tenantId: string;
  provider: string;
  userId?: string;
  orgId?: string;
  displayName?: string;
  tokens: OAuthTokenMaterial;
}): Promise<Connection> {
  const manifest = getProvider(input.provider);
  if (!manifest) throw new OpenwopError('connection_provider_unresolved', `No connection provider '${input.provider}' — install a connection pack whose provider.id is '${input.provider}', or none is built in (RFC 0095 §B.6).`, 404, { provider: input.provider });

  const existing = await findByIdentity(input.tenantId, input.provider, input.userId, input.orgId);
  const connectionId = existing?.connectionId ?? `conn:${randomUUID()}`;
  const connection: Connection = {
    connectionId,
    tenantId: input.tenantId,
    provider: input.provider,
    kind: 'oauth2',
    displayName: input.displayName ?? existing?.displayName ?? manifest.label,
    scopes: input.tokens.scopes,
    status: 'active',
    connectedAt: existing?.connectedAt ?? now(),
    updatedAt: now(),
    ...(input.userId ? { userId: input.userId } : {}),
    ...(input.orgId ? { orgId: input.orgId } : {}),
    ...(input.tokens.externalSubject ? { externalSubject: input.tokens.externalSubject } : {}),
    ...(input.tokens.expiresAt ? { expiresAt: input.tokens.expiresAt } : {}),
  };
  await setSecret(secretRef(connectionId), JSON.stringify(input.tokens), { tenantId: input.tenantId });
  await store.put(connection);
  return connection;
}

/** Patch a connection's status + optional expiry (e.g. after a refresh). */
async function patchConnection(connectionId: string, patch: Partial<Pick<Connection, 'status' | 'expiresAt'>>): Promise<void> {
  const c = await store.get(connectionId);
  if (!c) return;
  await store.put({ ...c, ...patch, updatedAt: now() });
}

export async function revokeConnection(tenantId: string, connectionId: string): Promise<boolean> {
  const existing = await getConnection(tenantId, connectionId);
  if (!existing) return false;
  await removeSecret(secretRef(connectionId), { tenantId }).catch(() => undefined);
  return store.delete(connectionId);
}

/**
 * The injection hook (ADR 0024 §4 / D1+D2). Resolve the MOST SPECIFIC active
 * connection for a run's acting principal — user → org → workspace — and return
 * it together with its live secret. The caller (the http/mcp credential-resolver)
 * injects the secret host-side; it is NEVER handed to workflow `config.headers`.
 *
 * D2: the run's actor is always the human (`actingUserId`); this returns the
 * AUTHORITY (which credential) to use, not who acts. The `provenance` field is a
 * non-wire stamp the caller records on `run.metadata.connectionUse[]`.
 */
export async function resolveConnectionCredential(input: {
  tenantId: string;
  provider: string;
  actingUserId?: string;
  orgId?: string;
}): Promise<{
  connection: Connection;
  secret: string;
  provenance: { connectionId: string; provider: string; scopeAxis: ConnectionScope; actingUserId?: string; scopeChecked: boolean };
} | null> {
  // ADR 0028 — the provider allowlist is enforced HERE, the choke point every
  // consumer flows through (the http egress seam, the Slack adapter, future
  // adapters), with the same predicate the connect routes use. A policy added
  // after a connection was created still wins: fail closed.
  if (!(await isProviderAllowed(input.tenantId, input.provider))) return null;

  const all = (await store.list()).filter((c) => c.tenantId === input.tenantId && c.provider === input.provider && c.status === 'active');
  // Most-specific ordering: user (acting) → org → workspace.
  const userConn = input.actingUserId ? all.find((c) => c.userId === input.actingUserId) : undefined;
  const orgConn = input.orgId ? all.find((c) => c.orgId === input.orgId) : all.find((c) => c.orgId);
  const wsConn = all.find((c) => !c.userId && !c.orgId);
  const chosen = userConn ?? orgConn ?? wsConn;
  if (!chosen) return null;

  // D2 confused-deputy guard (ADR 0024): using an ORG-shared connection requires
  // the acting human to hold `connections:use` on that org. Enforced HERE — the
  // broker's resolve boundary — so it holds for every consumer (node-exec, agent
  // tools, …) regardless of which one calls in, and fails CLOSED. A user- or
  // workspace-scoped connection is self-authorized (the user owns it).
  if (scopeAxisOf(chosen) === 'org') {
    const allowed = await actingUserHasOrgUse(input.tenantId, chosen.orgId!, input.actingUserId);
    if (!allowed) {
      log.warn('connections:use denied — org connection withheld', {
        connectionId: chosen.connectionId, orgId: chosen.orgId, actingUserId: input.actingUserId,
      });
      return null;
    }
  }

  const secret = await liveSecretFor(chosen, input.tenantId);
  if (secret === null) return null;

  return {
    connection: chosen,
    secret,
    provenance: {
      connectionId: chosen.connectionId,
      provider: chosen.provider,
      scopeAxis: scopeAxisOf(chosen),
      // An org connection only reaches here once the connections:use gate above
      // passed; user/workspace are self-authorized. Either way the use is checked.
      scopeChecked: true,
      ...(input.actingUserId !== undefined ? { actingUserId: input.actingUserId } : {}),
    },
  };
}

/** D2: does the acting human hold `connections:use` on this org? Fail-closed —
 *  no acting user, or a non-member, resolves to no scopes ⇒ false.
 *  SCALE NOTE: `resolveEffectiveAccess` scans the members collection, so this is
 *  O(members) on the credential-resolve hot path. Fine at sample scale; a scale
 *  pass should index members by `(tenantId, subject)` to make this O(1). */
async function actingUserHasOrgUse(tenantId: string, orgId: string, actingUserId?: string): Promise<boolean> {
  if (!actingUserId) return false;
  const access = await resolveEffectiveAccess(tenantId, { subject: actingUserId, orgId });
  return access.scopes.includes('connections:use');
}

/**
 * Resolve the LIVE secret a node should inject for one connection.
 *   - api_key / bearer / basic → the stored raw secret, verbatim.
 *   - oauth2 → the current access token, transparently refreshed (ADR 0024 §4)
 *     when it is within the skew window of expiry. A refresh failure flips the
 *     connection to `needs-reconsent` and returns null — never a silent stall.
 * Returns null when no secret is stored (e.g. KMS unconfigured) or refresh fails.
 */
async function liveSecretFor(connection: Connection, tenantId: string): Promise<string | null> {
  const stored = await resolveSecret(secretRef(connection.connectionId), { tenantId });
  if (stored === null) return null;
  if (connection.kind !== 'oauth2') return stored;

  let material: OAuthTokenMaterial;
  try {
    material = JSON.parse(stored) as OAuthTokenMaterial;
  } catch {
    log.error('oauth token material is not JSON — needs reconsent', { connectionId: connection.connectionId });
    await patchConnection(connection.connectionId, { status: 'needs-reconsent' });
    return null;
  }

  const expired = material.expiresAt ? new Date(material.expiresAt).getTime() - TOKEN_REFRESH_SKEW_MS <= Date.now() : false;
  if (!expired) return material.accessToken;

  // Past (or nearing) expiry — mint a fresh access token from the refresh token.
  // NOTE: this on-demand path is not single-flighted, so two concurrent resolves
  // of an expired token both mint and the later setSecret wins. Harmless for
  // providers with stable refresh tokens (e.g. Google offline access), and the
  // warm-refresh daemon pre-empts most expiries so this path rarely races. A
  // rotating-refresh-token provider would want a per-connection lease here.
  if (!material.refreshToken) {
    await patchConnection(connection.connectionId, { status: 'needs-reconsent' });
    return null;
  }
  try {
    const refreshed = await refreshAccessToken({ provider: connection.provider, refreshToken: material.refreshToken, scopes: material.scopes });
    await setSecret(secretRef(connection.connectionId), JSON.stringify(refreshed), { tenantId });
    await patchConnection(connection.connectionId, { status: 'active', ...(refreshed.expiresAt ? { expiresAt: refreshed.expiresAt } : {}) });
    return refreshed.accessToken;
  } catch (err) {
    log.warn('oauth refresh failed — flipping to needs-reconsent', {
      connectionId: connection.connectionId,
      provider: connection.provider,
      error: err instanceof Error ? err.message : String(err),
    });
    await patchConnection(connection.connectionId, { status: 'needs-reconsent' });
    return null;
  }
}

/**
 * Proactively refresh one oauth2 connection if its token is within the skew
 * window (the warm-refresh daemon, ADR 0024 §4). Returns the resulting status.
 * Idempotent + safe to call from every fleet instance — the worst case is a
 * redundant token mint, not corruption.
 */
export async function warmRefreshConnection(connection: Connection): Promise<ConnectionStatus> {
  if (connection.kind !== 'oauth2' || connection.status === 'revoked') return connection.status;
  // liveSecretFor performs the refresh + status patch as a side effect.
  const live = await liveSecretFor(connection, connection.tenantId);
  if (live === null) return 'needs-reconsent';
  return 'active';
}

/** Every oauth2 connection whose access token expires within `withinMs` (and is
 *  still active) — the daemon's due-list. */
export async function listExpiringOAuthConnections(withinMs: number, now: number = Date.now()): Promise<Connection[]> {
  return (await store.list()).filter(
    (c) =>
      c.kind === 'oauth2' &&
      c.status === 'active' &&
      typeof c.expiresAt === 'string' &&
      new Date(c.expiresAt).getTime() - withinMs <= now,
  );
}

/**
 * Health-probe one connection (ADR 0024 §5 `/test`). Resolves the live secret —
 * for oauth2 this exercises the refresh path — and reports whether a usable
 * credential is in hand, WITHOUT ever returning it. A full provider-side ping
 * (an actual API call) is Phase C; this honestly verifies credential validity.
 */
export async function probeConnection(tenantId: string, connectionId: string): Promise<{ ok: boolean; status: ConnectionStatus } | null> {
  const c = await getConnection(tenantId, connectionId);
  if (!c) return null;
  const live = await liveSecretFor(c, tenantId);
  // liveSecretFor may have flipped status to needs-reconsent on a failed refresh.
  const after = (await getConnection(tenantId, connectionId)) ?? c;
  return { ok: live !== null, status: after.status };
}

export async function __resetConnectionsStore(): Promise<void> {
  await store.__clear();
}
