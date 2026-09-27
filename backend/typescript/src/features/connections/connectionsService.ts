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
import { registerCredentialRefConsumer } from '../../host/credentialRefRegistry.js';
import { fireConnectionRevoked, fireConnectionStatusChanged } from '../../host/connectionLifecycle.js';
import { createLogger } from '../../observability/logger.js';
import { resolveEffectiveAccess } from '../../host/accessControlService.js';
import { isProviderAllowed } from '../../host/governanceService.js';
import { getProvider, type CredentialKind } from './providerRegistry.js';
import { invalidateMcpCacheForPrincipal, invalidateMcpCacheForTenant } from '../../host/mcpClientCache.js';
import { refreshAccessToken, type OAuthTokenMaterial } from './oauthFlow.js';
import { mintServiceAccountToken, evictServiceAccountToken } from './serviceAccountJwt.js';

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

/** In-flight token refreshes, keyed by connectionId, so concurrent resolves of
 *  the same expired token share ONE refresh instead of each minting (and the
 *  later setSecret clobbering) — which matters for rotating-refresh-token
 *  providers where a double-mint can invalidate the refresh token (FEAT-3). */
const inFlightRefresh = new Map<string, Promise<string | null>>();

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

/**
 * ALL of a tenant's connection ids, regardless of `userId` (ADR 0590 teardown).
 * Deliberately NOT `listConnections(tenantId)`: that helper's
 * `(c.userId ? c.userId === userId : true)` filter DROPS user-scoped connections
 * when `userId` is omitted — a teardown that used it would miss those tenants'
 * connections (and orphan their pairing/inbound-session children).
 */
export async function listTenantConnectionIds(tenantId: string): Promise<string[]> {
  return (await store.list()).filter((c) => c.tenantId === tenantId).map((c) => c.connectionId);
}

// ADR 0499 — the OAuth token blob lives at `connection:<id>`. The vault lists it
// (kind `connection-token`), so it is deletable there even though this service
// owns its lifecycle; without this the connection would keep reporting healthy
// while every dispatch silently lost its credential.
registerCredentialRefConsumer({
  id: 'connections:token',
  async describe(tenantId, ref) {
    if (!ref.startsWith('connection:')) return [];
    const connection = await getConnection(tenantId, ref.slice('connection:'.length));
    return connection ? [`connection "${connection.displayName || connection.provider}"`] : [];
  },
});

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
  kind: Extract<CredentialKind, 'api_key' | 'bearer' | 'basic' | 'service-account-jwt'>;
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
  const previousStatus = existing?.status;
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
  // H57 (ADR 0553 correction / RFC 0153 §D-G4) — a re-consent lands on the SAME
  // row by the ADR 0024 identity tuple, so the credential material changed
  // underneath an unchanged `connectionId`. Anything an outbound MCP peer
  // returned under the OLD token was gathered under rights the user has since
  // replaced. Dropped here rather than left to the TTL.
  invalidateMcpForConnection(connection);
  // ADR 0627 D5 (review SHOULD-3) — a re-consent that REVIVES a dead row
  // (`needs-reconsent`/`expired` → `active`) is a status transition like any
  // other: fire it, so a consumer that marked itself needs-reconsent on this
  // connectionId (the CRM gmail sync) can resume — re-consent IS the resume.
  if (previousStatus !== undefined && previousStatus !== 'active' && previousStatus !== 'revoked') {
    await fireConnectionStatusChanged({ tenantId: input.tenantId, connectionId, provider: input.provider, status: 'active', previousStatus });
  }
  return connection;
}

/**
 * ADR 0627 D5 (review BLOCKER-2) — the owner's current ACTIVE user-scoped
 * connection for a provider, or null. Owner-verified by construction (it is
 * keyed on `userId`), so a consumer that pinned a connection which has since
 * been revoked (a revoke DELETES the row; a re-consent mints a NEW id) can
 * re-bind to the row the same user consented to afterwards — without any
 * org/workspace fall-through.
 */
export async function findUserConnection(tenantId: string, provider: string, userId: string): Promise<Connection | null> {
  const c = await findByIdentity(tenantId, provider, userId, undefined);
  return c && c.status === 'active' ? c : null;
}

/** H57 — drop what an outbound MCP peer told us under a credential that just
 *  moved. A USER-scoped Connection narrows to that principal; an ORG- or
 *  workspace-scoped one is usable by every member by grant, so there is no
 *  single principal to name and the honest answer is the whole tenant. */
function invalidateMcpForConnection(connection: Connection): void {
  if (connection.userId) invalidateMcpCacheForPrincipal(connection.tenantId, connection.userId);
  else invalidateMcpCacheForTenant(connection.tenantId);
}

/** Patch a connection's status + optional expiry (e.g. after a refresh).
 *  ADR 0627 D5 — a STATUS TRANSITION (never a same-status re-write) fires
 *  `fireConnectionStatusChanged` AFTER the row landed, so a consumer that keyed
 *  a schedule on this connection (the CRM gmail sync) can mark itself
 *  `needs-reconsent` instead of re-failing on every tick. */
async function patchConnection(connectionId: string, patch: Partial<Pick<Connection, 'status' | 'expiresAt'>>): Promise<void> {
  const c = await store.get(connectionId);
  if (!c) return;
  await store.put({ ...c, ...patch, updatedAt: now() });
  if (patch.status !== undefined && patch.status !== c.status && patch.status !== 'revoked' && c.status !== 'revoked') {
    await fireConnectionStatusChanged({ tenantId: c.tenantId, connectionId, provider: c.provider, status: patch.status, previousStatus: c.status });
  }
}

export async function revokeConnection(tenantId: string, connectionId: string): Promise<boolean> {
  const existing = await getConnection(tenantId, connectionId);
  if (!existing) return false;
  await removeSecret(secretRef(connectionId), { tenantId }).catch(() => undefined);
  // ADR 0081 P2 — evict any in-process SA-JWT token so a minted token doesn't outlive revoke.
  if (existing.kind === 'service-account-jwt') evictServiceAccountToken(connectionId);
  const removed = await store.delete(connectionId);
  if (removed) {
    // ADR 0285 — fire AFTER the credential + row are gone so consumer features
    // (inbound webhooks, knowledge-sync sources, gmail syncs, …) can DISABLE
    // their dependent configs (never delete — the user sees what broke).
    await fireConnectionRevoked({ tenantId, connectionId, provider: existing.provider });
    // H57 — the credential is gone; a cached `private` tools list gathered
    // under it must not outlive it. AFTER the delete, so a failed removal never
    // reads as a revocation.
    invalidateMcpForConnection(existing);
  }
  return removed;
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
/** Connection-selection input shared by `resolveConnectionCredential` (which then
 *  resolves the live secret) and `connectionExists` (which stops here). */
interface ConnectionSelectInput {
  tenantId: string;
  provider: string;
  actingUserId?: string;
  orgId?: string;
  /** Internal: a presence PRE-CHECK (`connectionExists`) must not log a pin
   *  refusal as if a dispatch had been withheld — only a real resolve warns. */
  quiet?: boolean;
  /** ADR 0627 D5 — an EXACT pin. When present the user→org→workspace
   *  fall-through is NOT consulted: the named connection is returned iff it is
   *  `active`, this provider, and either owned by the acting user or org-shared
   *  with `connections:use`; anything else is a refusal (null), never a
   *  substitute credential (a `needs-reconsent` user mailbox must not silently
   *  become the workspace's). */
  connectionId?: string;
}

/**
 * Pick the MOST SPECIFIC active connection for a run's acting principal AND pass
 * the D2 authorization gate — but stop BEFORE resolving the live secret. This is
 * the selection + authz half of `resolveConnectionCredential`, extracted so the
 * two callers share ONE source of truth for "which connection, and may the actor
 * use it" (no drift). It makes NO network egress — crucially, it never calls
 * `liveSecretFor`, which can refresh an OAuth token (a network call). So a
 * caller that only needs presence (a dry-run preview) gets a faithful answer
 * without any egress or secret decrypt.
 */
async function selectAuthorizedConnection(input: ConnectionSelectInput): Promise<Connection | null> {
  // ADR 0028 — the provider allowlist is enforced HERE, the choke point every
  // consumer flows through (the http egress seam, the Slack adapter, future
  // adapters), with the same predicate the connect routes use. A policy added
  // after a connection was created still wins: fail closed.
  if (!(await isProviderAllowed(input.tenantId, input.provider))) return null;
  if (input.connectionId !== undefined) return selectPinnedConnection(input, input.connectionId);

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
  return chosen;
}

/**
 * ADR 0627 D5 — the pinned lane of `selectAuthorizedConnection`. EXACT: the
 * named row, or nothing. Every refusal is logged with its reason and returns
 * null (the broker's `no_connection` outcome) — the caller that pinned is the
 * one that must react (the gmail sync marks itself `needs-reconsent`), and a
 * fall-through here would hand it a DIFFERENT principal's mailbox.
 *
 * A workspace-scoped row is refused under a pin on purpose: the ADR names the
 * two authorised shapes (owned by the actor; org-shared with `connections:use`),
 * and no pinning consumer exists for a workspace credential. Widen here, with a
 * witness, if one ever does.
 */
async function selectPinnedConnection(input: ConnectionSelectInput, connectionId: string): Promise<Connection | null> {
  const refuse = (reason: string): null => {
    if (!input.quiet) log.warn('pinned connection refused — no fall-through', { connectionId, provider: input.provider, actingUserId: input.actingUserId, reason });
    return null;
  };
  const c = await store.get(connectionId);
  if (!c || c.tenantId !== input.tenantId) return refuse('not_found');
  if (c.provider !== input.provider) return refuse('provider_mismatch');
  if (c.status !== 'active') return refuse(`status_${c.status}`);
  const axis = scopeAxisOf(c);
  if (axis === 'user') {
    return input.actingUserId !== undefined && c.userId === input.actingUserId ? c : refuse('not_owner');
  }
  if (axis === 'org') {
    return (await actingUserHasOrgUse(input.tenantId, c.orgId!, input.actingUserId)) ? c : refuse('connections_use_denied');
  }
  return refuse('workspace_scoped_pin');
}

/**
 * Would a real dispatch find an authorized connection for this provider/principal?
 * Selection + D2 authz only — makes NO network egress and never decrypts/refreshes
 * the secret (it stops before `liveSecretFor`). Used by side-effect-free previews
 * (e.g. the ads dry-run) to surface connection-readiness WITHOUT a real call.
 * NOTE: a `true` here means a connection row is present and the actor may use it —
 * NOT that the live secret will resolve (KMS could be unconfigured / a refresh
 * could fail); that residual is only knowable at real dispatch.
 */
export async function connectionExists(input: ConnectionSelectInput): Promise<boolean> {
  return (await selectAuthorizedConnection({ ...input, quiet: true })) !== null;
}

/**
 * Resolve a capability (a `ProviderManifest.category` like `email-calendar`,
 * `hr`, `ticketing`) to the acting caller's configured provider — so a workflow
 * or agent can require "a calendar connection" and bind to whatever provider
 * the user set up, instead of a hard-coded provider id. Host-only: RFC 0095's
 * `provider.id` stays the wire key; this is a resolution layer above it.
 *
 * Picks the caller's most-specific ACTIVE connection (user → org → workspace)
 * whose provider has the requested category, then runs it back through
 * `selectAuthorizedConnection` so the SAME allowlist + D2 confused-deputy gate
 * apply (single authorization choke point). Returns the provider id, or null
 * when the caller has no authorized connection of that capability.
 */
export async function resolveProviderForCapability(input: {
  tenantId: string;
  capability: string;
  actingUserId?: string;
  orgId?: string;
}): Promise<string | null> {
  const active = (await store.list()).filter(
    (c) => c.tenantId === input.tenantId && c.status === 'active' && getProvider(c.provider)?.category === input.capability,
  );
  // Most-specific ordering mirrors selectAuthorizedConnection: user → org → workspace.
  const userConn = input.actingUserId ? active.find((c) => c.userId === input.actingUserId) : undefined;
  const orgConn = input.orgId ? active.find((c) => c.orgId === input.orgId) : active.find((c) => c.orgId);
  const wsConn = active.find((c) => !c.userId && !c.orgId);
  const chosen = userConn ?? orgConn ?? wsConn;
  if (!chosen) return null;
  // Re-run through the authorization choke point (allowlist + org connections:use).
  const authorized = await selectAuthorizedConnection({
    tenantId: input.tenantId, provider: chosen.provider, actingUserId: input.actingUserId, orgId: input.orgId,
  });
  return authorized ? authorized.provider : null;
}

/**
 * Plural sibling of `resolveProviderForCapability` (ADR 0186): return ALL of the
 * caller's authorized providers for a capability category, precedence-ordered
 * (user → org → workspace), deduped. A capability node that only supports a SUBSET
 * of a coarse category (e.g. `email-calendar` covers email-only providers like
 * gmail/sendgrid AND calendar providers like google/microsoft-graph) uses this to
 * pick a provider it can actually serve, instead of degrading because the single
 * most-specific match happens to be an email-only connection. Each candidate is run
 * through the same `selectAuthorizedConnection` choke point.
 */
export async function resolveProvidersForCapability(input: {
  tenantId: string;
  capability: string;
  actingUserId?: string;
  orgId?: string;
}): Promise<string[]> {
  const active = (await store.list()).filter(
    (c) => c.tenantId === input.tenantId && c.status === 'active' && getProvider(c.provider)?.category === input.capability,
  );
  const ordered = [
    ...(input.actingUserId ? active.filter((c) => c.userId === input.actingUserId) : []),
    ...(input.orgId ? active.filter((c) => c.orgId === input.orgId) : active.filter((c) => c.orgId)),
    ...active.filter((c) => !c.userId && !c.orgId),
  ];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of ordered) {
    if (seen.has(c.provider)) continue;
    seen.add(c.provider);
    const authorized = await selectAuthorizedConnection({
      tenantId: input.tenantId, provider: c.provider, actingUserId: input.actingUserId, orgId: input.orgId,
    });
    if (authorized) out.push(authorized.provider);
  }
  return out;
}

export async function resolveConnectionCredential(input: {
  tenantId: string;
  provider: string;
  actingUserId?: string;
  orgId?: string;
  /** ADR 0627 D5 — exact pin; see `ConnectionSelectInput.connectionId`. */
  connectionId?: string;
}): Promise<{
  connection: Connection;
  secret: string;
  provenance: { connectionId: string; provider: string; scopeAxis: ConnectionScope; actingUserId?: string; scopeChecked: boolean };
} | null> {
  const chosen = await selectAuthorizedConnection(input);
  if (!chosen) return null;

  const secret = await liveSecretFor(chosen, input.tenantId);
  if (secret === null) return null;

  return {
    connection: chosen,
    secret,
    provenance: {
      connectionId: chosen.connectionId,
      provider: chosen.provider,
      scopeAxis: scopeAxisOf(chosen),
      // An org connection only reaches here once the connections:use gate in
      // selectAuthorizedConnection passed; user/workspace are self-authorized.
      scopeChecked: true,
      ...(input.actingUserId !== undefined ? { actingUserId: input.actingUserId } : {}),
    },
  };
}

/**
 * RFC 0199 §C.2 / §C.4 (ADR 0753 D8) — does a credential for (Subject, provider,
 * scopes) resolve? The ONE answer the `credential` interrupt's pre-check, its
 * resolve-time re-check and the node's own token fetch share: it goes through
 * `resolveConnectionCredential` (selection + D2 authz + live refresh), never a
 * parallel lookup, so the gate cannot disagree with what the node would get.
 *
 *  - `ok`                  a credential resolves and covers every scope;
 *  - `insufficient_scope`  one resolves with fewer scopes;
 *  - `expired`             the Subject's own connection exists but its refresh
 *                          failed terminally (now, or on an earlier attempt);
 *  - `missing`             nothing resolves.
 */
export type CredentialStatus =
  | { status: 'ok'; connectionId: string }
  | { status: 'insufficient_scope'; connectionId: string }
  | { status: 'expired'; connectionId: string }
  | { status: 'missing' };

export async function credentialStatusFor(input: {
  tenantId: string;
  provider: string;
  actingUserId?: string;
  scopes: readonly string[];
}): Promise<CredentialStatus> {
  const resolved = await resolveConnectionCredential({
    tenantId: input.tenantId,
    provider: input.provider,
    ...(input.actingUserId !== undefined ? { actingUserId: input.actingUserId } : {}),
  });
  if (resolved) {
    const granted = new Set(resolved.connection.scopes);
    return input.scopes.every((s) => granted.has(s))
      ? { status: 'ok', connectionId: resolved.connection.connectionId }
      : { status: 'insufficient_scope', connectionId: resolved.connection.connectionId };
  }
  if (input.actingUserId !== undefined) {
    const own = await findByIdentity(input.tenantId, input.provider, input.actingUserId, undefined);
    if (own && (own.status === 'needs-reconsent' || own.status === 'expired')) return { status: 'expired', connectionId: own.connectionId };
  }
  return { status: 'missing' };
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
  // ADR 0081 P2 — a service-account-jwt connection mints a short-lived access token from
  // the BYOK SA key (the stored secret), cached in-process to expiry. The broker injects
  // the returned token as a bearer, exactly like the oauth2 access token.
  if (connection.kind === 'service-account-jwt') {
    return mintServiceAccountToken(connection.connectionId, stored);
  }
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
  if (!material.refreshToken) {
    await patchConnection(connection.connectionId, { status: 'needs-reconsent' });
    return null;
  }

  // Single-flight: concurrent resolves of the same expired connection coalesce
  // onto one refresh (FEAT-3). The warm-refresh daemon pre-empts most expiries,
  // but a burst of parallel node executions can still race here.
  const inflight = inFlightRefresh.get(connection.connectionId);
  if (inflight) return inflight;

  const refreshToken = material.refreshToken;
  const promise = (async (): Promise<string | null> => {
    try {
      const refreshed = await refreshAccessToken({ provider: connection.provider, refreshToken, scopes: material.scopes });
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
    } finally {
      inFlightRefresh.delete(connection.connectionId);
    }
  })();
  inFlightRefresh.set(connection.connectionId, promise);
  return promise;
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
 * ADR 0627 D5 (review SHOULD-2) — give a `needs-reconsent` row ONE more chance
 * before a consumer refuses on it. `liveSecretFor` flips to `needs-reconsent` on
 * ANY refresh error — a Google 5xx included — and every later lane (the pinned
 * broker select, the warm-refresh daemon) skips non-active rows, so a transient
 * failure parked the credential with no retry path. This re-runs the resolve: a
 * successful refresh already patches `active` (and fires `→ active`); a valid,
 * never-expired token on a non-active row is patched `active` here. Returns the
 * row as it stands afterwards (still `needs-reconsent` when the refresh fails
 * again), or null when the row does not exist.
 */
export async function reviveConnection(tenantId: string, connectionId: string): Promise<Connection | null> {
  const c = await getConnection(tenantId, connectionId);
  if (!c) return null;
  if (c.status === 'active') return c;
  const live = await liveSecretFor(c, tenantId);
  if (live !== null) {
    const after = await getConnection(tenantId, connectionId);
    if (after && after.status !== 'active') await patchConnection(connectionId, { status: 'active' });
  }
  return (await getConnection(tenantId, connectionId)) ?? c;
}

/** Test-only: park a row in a non-active status WITHOUT touching its secret —
 *  the shape a transient refresh failure leaves behind (fires the transition). */
/**
 * Conformance seam `expireOAuthAccessToken` (seams-v2 `…/oauth/expire-refresh`,
 * ADR 0753 D12) — mark the caller's own oauth2 credential's ACCESS token expired,
 * so the next resolve takes the PRODUCTION refresh path (and, when the provider
 * refuses the refresh, the production needs-reconsent path). It rewrites only
 * the expiry inside the stored material; the refresh token and everything else
 * are untouched. Returns false when the caller holds no such credential.
 */
export async function expireAccessTokenForSeam(tenantId: string, provider: string, userId: string): Promise<boolean> {
  const conn = await findByIdentity(tenantId, provider, userId, undefined);
  if (!conn || conn.kind !== 'oauth2') return false;
  const stored = await resolveSecret(secretRef(conn.connectionId), { tenantId });
  if (stored === null) return false;
  let material: OAuthTokenMaterial;
  try {
    material = JSON.parse(stored) as OAuthTokenMaterial;
  } catch {
    return false;
  }
  await setSecret(secretRef(conn.connectionId), JSON.stringify({ ...material, expiresAt: new Date(0).toISOString() }), { tenantId });
  return true;
}

export async function __setConnectionStatusForTests(connectionId: string, status: ConnectionStatus): Promise<void> {
  await patchConnection(connectionId, { status });
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

// ── ADR 0357 P6 — a per-(tenant, key) circuit breaker ───────────────────────
// The broker owns connection HEALTH (adsAdapter stays the policy chokepoint):
// N consecutive reported failures OPEN the circuit; while open, callers get a
// graceful circuit_open refusal; after the cooldown one probe call is allowed
// (half-open) — success resets, failure re-opens. IN-PROCESS state (the
// cooldown precedent): a restart resets the breaker, which is the safe
// direction (closed).
interface BreakerState { failures: number; openedAtMs?: number; probeAtMs?: number }
const breakers = new Map<string, BreakerState>();
const BREAKER_THRESHOLD = 5;
const BREAKER_COOLDOWN_MS = 120_000;
/** How long a claimed half-open probe holds the slot before another may try —
 *  a crashed probe (never reported back) must not wedge the circuit shut. */
const BREAKER_PROBE_WINDOW_MS = 30_000;

const breakerKey = (tenantId: string, key: string): string => `${tenantId}::${key}`;

/** Report a transport failure; returns true when this report OPENED (or
 *  RE-OPENED, after a failed half-open probe) the circuit. */
export function reportConnectionFailure(tenantId: string, key: string): boolean {
  const k = breakerKey(tenantId, key);
  const st = breakers.get(k) ?? { failures: 0 };
  st.failures += 1;
  if (st.openedAtMs !== undefined) {
    // Already open. If the cooldown has elapsed this failure IS the half-open
    // probe failing — RE-OPEN with a fresh cooldown (INTEL-CODE-1: without the
    // refresh the breaker stayed half-open forever after the first cooldown,
    // admitting every caller regardless of probe outcome).
    if (Date.now() - st.openedAtMs >= BREAKER_COOLDOWN_MS) {
      st.openedAtMs = Date.now();
      delete st.probeAtMs;
      breakers.set(k, st);
      return true;
    }
    breakers.set(k, st);
    return false;
  }
  if (st.failures >= BREAKER_THRESHOLD) {
    st.openedAtMs = Date.now();
    breakers.set(k, st);
    return true;
  }
  breakers.set(k, st);
  return false;
}

/** Report a success — closes the circuit and clears the counter (and any
 *  in-flight probe claim). */
export function reportConnectionSuccess(tenantId: string, key: string): void {
  breakers.delete(breakerKey(tenantId, key));
}

/**
 * Circuit status: 'closed' (proceed) | 'open' (refuse) | 'half-open' (ONE probe
 * allowed). SINGLE-PROBE semantics (INTEL-CODE-4): the first caller to observe
 * the elapsed cooldown CLAIMS the probe slot ('half-open'); concurrent callers
 * see 'open' until the probe reports back (success closes, failure re-opens)
 * or the probe window expires (so a probe that never reports can't wedge it).
 */
export function circuitStatus(tenantId: string, key: string): 'closed' | 'open' | 'half-open' {
  const st = breakers.get(breakerKey(tenantId, key));
  if (!st || st.openedAtMs === undefined) return 'closed';
  if (Date.now() - st.openedAtMs < BREAKER_COOLDOWN_MS) return 'open';
  if (st.probeAtMs !== undefined && Date.now() - st.probeAtMs < BREAKER_PROBE_WINDOW_MS) return 'open';
  st.probeAtMs = Date.now();
  return 'half-open';
}

// Test-only.
export function __resetCircuitBreakers(): void { breakers.clear(); }
