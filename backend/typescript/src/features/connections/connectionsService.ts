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
import { registerTenantIndexAdoption } from '../../host/tenantIndexAdoption.js';
import { setSecret, resolveSecret, removeSecret } from '../../byok/secretResolver.js';
import { registerCredentialRefConsumer } from '../../host/credentialRefRegistry.js';
import { fireConnectionRevoked, fireConnectionStatusChanged } from '../../host/connectionLifecycle.js';
import { createLogger } from '../../observability/logger.js';
import { resolveEffectiveAccess } from '../../host/accessControlService.js';
import { isProviderAllowed } from '../../host/governanceService.js';
import { getProvider, type CredentialKind } from './providerRegistry.js';
import { invalidateMcpCacheForPrincipal, invalidateMcpCacheForTenant } from '../../host/mcpClientCache.js';
import { refreshAccessToken, deletePendingAuthFor, type OAuthTokenMaterial } from './oauthFlow.js';
import { mintServiceAccountToken, evictServiceAccountToken } from './serviceAccountJwt.js';
import { getUser, getUserByPrincipal } from '../users/usersService.js';
import { OWNED_REF_PREFIXES } from '../../byok/refNamespaces.js';

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
  /** ADR 0780 D3 — minted on every credential write and stored inside the oauth2
   *  secret material too, so a write-back or a reader can tell whether the secret
   *  it holds belongs to the row as it stands now. Absent on rows written before
   *  ADR 0780; an absent value compares equal to an absent value. */
  generation?: string;
  /** ADR 0783 D1 — the base URL this connection serves as a DATA SOURCE for
   *  `ctx.dataIntegration.fetchRest`/`fetchGraphql`. Validated against the
   *  provider's `apiHosts` when set (`setConnectionDataSource`) AND again on every
   *  call. Absent ⇒ the connection is not a data source. Kept across a re-consent. */
  dataSource?: { baseUrl: string; updatedAt: string };
}

const store = new DurableCollection<Connection>('connections:connection', (c) => c.connectionId, undefined, (c) => c.tenantId);
// ADR 0866 — the tenant index is trusted only once the hourly reconcile has verified
// it, so a row written by a pre-index revision during a deploy is never invisible.
registerTenantIndexAdoption('connections:connection', store);

/**
 * ADR 0866 — one tenant's rows, for READ and SELECT paths: the tenant index once it is
 * verified, the full scan until then. Teardown and erasure deliberately stay on
 * `store.list()`: a missed row there is a permanent orphan, not a delayed listing.
 */
async function tenantRows(tenantId: string): Promise<Connection[]> {
  if (await store.tenantIndexVerified()) return store.listForTenantIndexed(tenantId);
  return (await store.list()).filter((c) => c.tenantId === tenantId);
}

/**
 * ADR 0780 grade-code `CONNCD-2` — a secret a revoke has not yet managed to
 * remove. Written BEFORE the row delete, so once the row is gone (and with it
 * every way to find the token: the vault refuses `connection:` refs, a retried
 * DELETE 404s, an eraser walks rows) this is what still names it. Swept on the
 * refresh-daemon tick and by the DSAR eraser until the removal succeeds.
 */
interface SecretTombstone {
  connectionId: string;
  tenantId: string;
  createdAt: string;
  /** The row's owner (user rows), so a DSAR waits only on ITS subject's secrets
   *  — one stuck removal must not fail every other subject's erasure (`CONNCD-13`). */
  userId?: string;
}

/** A tombstone whose row still exists this long after it was written marks a
 *  revoke that never got as far as its delete; it names no orphan. */
const TOMBSTONE_LIVE_ROW_GRACE_MS = 60 * 60_000;
// tenantOf: tenant teardown reaches a tombstone the way it reaches the tenant's secrets.
const tombstones = new DurableCollection<SecretTombstone>('connections:secret-tombstone', (t) => t.connectionId, undefined, (t) => t.tenantId);

/** In-flight token refreshes, keyed by connectionId, so concurrent resolves of
 *  the same expired token share ONE refresh instead of each minting (and the
 *  later setSecret clobbering) — which matters for rotating-refresh-token
 *  providers where a double-mint can invalidate the refresh token (FEAT-3). */
const inFlightRefresh = new Map<string, Promise<string | null>>();

const now = (): string => new Date().toISOString();

/**
 * ADR 0780 D3.1 — a credential generation, ORDERED by write time (a fixed-width
 * base-36 millisecond prefix, then a uuid for uniqueness), so a reader can tell a
 * NEWER secret (a re-consent whose row swap has not landed yet — use it) from an
 * OLDER one (a refresh that wrote over a re-consent — fail closed). grade-code
 * `CONNCD-1`: an unordered id made every read inside a re-consent's own write
 * window flip a healthy row to `needs-reconsent`.
 */
function newGeneration(): string {
  return `${Date.now().toString(36).padStart(10, '0')}.${randomUUID()}`;
}
const secretRef = (connectionId: string): string => `${OWNED_REF_PREFIXES.connection}${connectionId}`;

function scopeAxisOf(c: Connection): ConnectionScope {
  if (c.userId) return 'user';
  if (c.orgId) return 'org';
  return 'workspace';
}

/** List a caller's connections (metadata only — never secret material). Includes
 *  the caller's own user connections, the workspace's org connections, and the
 *  workspace default. ADR 0780 D2 — `userIds` may be every spelling of the ONE
 *  caller (`callerOwnerIds`), so a row written before the OIDC bind stays visible
 *  to the human who owns it. */
export async function listConnections(tenantId: string, userIds?: string | Iterable<string>): Promise<Connection[]> {
  const owners = new Set(typeof userIds === 'string' ? [userIds] : (userIds ?? []));
  return (await tenantRows(tenantId))
    .filter((c) => (c.userId ? owners.has(c.userId) : true))
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
// (kind `connection-token`) and describes its consumer through this entry, but no
// longer deletes it: ADR 0779 D2 made the vault refuse `connection:` refs
// (`routes/adminVault.ts:279`), so deleting the connection is the only lane that
// removes the token (ADR 0780 D6 corrected this comment).
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
 * ADR 0783 D1 — set (or clear, with `null`) a connection's data-source base URL.
 * The caller has validated `baseUrl` against the provider's `apiHosts`
 * (`host/dataSourceUrl.ts`). A CAS: a lost swap is retried once on the fresh row,
 * so a concurrent token refresh is never overwritten with stale fields.
 */
export async function setConnectionDataSource(tenantId: string, connectionId: string, baseUrl: string | null): Promise<Connection | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const c = await getConnection(tenantId, connectionId);
    if (!c) return null;
    const { dataSource: _drop, ...rest } = c;
    const next: Connection = baseUrl === null
      ? { ...rest, updatedAt: now() }
      : { ...rest, dataSource: { baseUrl, updatedAt: now() }, updatedAt: now() };
    if (await store.compareAndSwap(c, next)) return next;
  }
  throw new OpenwopError('conflict', 'The connection changed while saving; try again.', 409);
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
    generation: newGeneration(),
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
  const all = (await store.list()).filter(
    (c) => c.tenantId === tenantId && c.provider === provider && (c.orgId ?? undefined) === (orgId ?? undefined),
  );
  if (userId === undefined) return all.find((c) => c.userId === undefined) ?? null;
  // ADR 0780 grade-code `CONNCD-4` — the identity tuple's user is a HUMAN, not a
  // spelling. Matching the raw string minted a second row when the same person
  // re-consented under the other spelling (the connect lane binds under a run's
  // legacy stamp), and revoking one left the other live. Exact spelling first.
  return ownConnection(all, userId, await actingUserIds(tenantId, userId)) ?? null;
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

  // ADR 0780 D3.2 — the row is written by COMPARE-AND-SWAP against the row this
  // re-consent read. It used to be an unconditional put on the reused id, so a
  // re-consent that read the row before a concurrent revoke re-created it — with a
  // live token — after the user disconnected. A lost swap re-reads ONCE: a row
  // that is now gone gets a NEW id, so an id a revoke deleted is never reused
  // (which is what makes D3.4's scrub safe).
  let existing = await findByIdentity(input.tenantId, input.provider, input.userId, input.orgId);
  let connection = oauthRow(input, existing, manifest.label);
  let material: OAuthTokenMaterial = { ...input.tokens, generation: connection.generation };
  await setSecret(secretRef(connection.connectionId), JSON.stringify(material), { tenantId: input.tenantId });
  if (!(await swapRow(existing, connection))) {
    // The row moved under us. Our secret write may sit on an id a revoke just
    // deleted; D3.4 — scrub it iff that row is gone, then land on a fresh read.
    if ((await store.get(connection.connectionId)) === null) await removeSecret(secretRef(connection.connectionId), { tenantId: input.tenantId });
    existing = await findByIdentity(input.tenantId, input.provider, input.userId, input.orgId);
    connection = oauthRow(input, existing, manifest.label);
    material = { ...input.tokens, generation: connection.generation };
    await setSecret(secretRef(connection.connectionId), JSON.stringify(material), { tenantId: input.tenantId });
    if (!(await swapRow(existing, connection))) {
      throw new OpenwopError('conflict', 'The connection changed while it was being saved. Connect again.', 409, { provider: input.provider });
    }
  }
  const previousStatus = existing?.status;
  const connectionId = connection.connectionId;
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
  await retireDeadTwins(connection);
  return connection;
}

/**
 * A re-consent lands on ONE row per (tenant, provider, human, org), and
 * `findByIdentity` picks the exact spelling of the human first. A dead twin of
 * that row (the same human under the other spelling, or a duplicate a race left)
 * was therefore never the row a consent updated: clicking "Reconnect" on it
 * re-consented the OTHER row and left it `needs-reconsent` for good (MEASURED in
 * prod 2026-10-10: two Google and two Gmail rows, one of each stuck however many
 * times the user reconnected). It can never be revived and no resolve selects it
 * (selection takes `active` rows only), so the consent that just succeeded
 * retires it.
 *
 * Only NON-active twins: an active one still carries a working credential, and
 * removing it is the user's call. The retire IS a revoke, so a sync pinned to the
 * twin pauses as `connection-revoked` and its resume re-binds to this row, the
 * existing ADR 0285 path. A failed retire is logged and leaves the twin as it was;
 * the consent itself has already landed.
 */
async function retireDeadTwins(landed: Connection): Promise<void> {
  if (landed.userId === undefined) return;
  const ids = await actingUserIds(landed.tenantId, landed.userId);
  const twins = (await tenantRows(landed.tenantId)).filter(
    (c) =>
      c.connectionId !== landed.connectionId &&
      c.provider === landed.provider &&
      (c.orgId ?? undefined) === (landed.orgId ?? undefined) &&
      c.userId !== undefined &&
      ids.has(c.userId) &&
      c.status !== 'active',
  );
  for (const twin of twins) {
    try {
      await revokeConnection(landed.tenantId, twin.connectionId);
      log.info('connection_dead_twin_retired', { connectionId: twin.connectionId, keptConnectionId: landed.connectionId, provider: landed.provider, status: twin.status });
    } catch (err) {
      log.warn('connection_dead_twin_retire_failed', { connectionId: twin.connectionId, error: err instanceof Error ? err.message : String(err) });
    }
  }
}

/** The row a completed consent lands (ADR 0780 D3.1: a fresh `generation` every time). */
function oauthRow(
  input: { tenantId: string; provider: string; userId?: string; orgId?: string; displayName?: string; tokens: OAuthTokenMaterial },
  existing: Connection | null,
  label: string,
): Connection {
  return {
    connectionId: existing?.connectionId ?? `conn:${randomUUID()}`,
    tenantId: input.tenantId,
    provider: input.provider,
    kind: 'oauth2',
    displayName: input.displayName ?? existing?.displayName ?? label,
    scopes: input.tokens.scopes,
    status: 'active',
    connectedAt: existing?.connectedAt ?? now(),
    updatedAt: now(),
    generation: newGeneration(),
    // Owner spelling on a re-consent (`CONNCD-4`, re-decided under the D2 revert):
    // the CANONICAL `user:` spelling wins whichever side carries it, so a legacy
    // `oidc:` row is migrated forward the first time its owner re-consents as
    // `user:`, and a legacy-stamped re-consent (the connect lane) never rewrites a
    // canonical row back. Either way the row stays visible to its owner: the only
    // way the two spellings meet here is `actingUserIds`, which is home-tenant-only.
    ...(ownerSpelling(existing?.userId, input.userId) ? { userId: ownerSpelling(existing?.userId, input.userId)! } : {}),
    ...(input.orgId ? { orgId: input.orgId } : {}),
    ...(input.tokens.externalSubject ? { externalSubject: input.tokens.externalSubject } : {}),
    ...(input.tokens.expiresAt ? { expiresAt: input.tokens.expiresAt } : {}),
    // ADR 0783 D1 — a re-consent rebuilds the row; the data-source config is the
    // operator's, not the grant's, so it survives.
    ...(existing?.dataSource ? { dataSource: existing.dataSource } : {}),
  };
}

function ownerSpelling(existing: string | undefined, incoming: string | undefined): string | undefined {
  if (incoming?.startsWith('user:')) return incoming;
  return existing ?? incoming;
}

/** Insert `next` if `expected` is null, else swap it in iff the stored row still
 *  equals `expected` (pass the object `get`/`list` returned). */
async function swapRow(expected: Connection | null, next: Connection): Promise<boolean> {
  return expected === null ? store.putIfAbsent(next) : store.compareAndSwap(expected, next);
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
async function patchConnection(
  connectionId: string,
  patch: Partial<Pick<Connection, 'status' | 'expiresAt'>>,
  /** ADR 0780 D3.2 — the generation the caller's decision was made against; a
   *  row that has been re-consented since is left alone. */
  generation?: string,
): Promise<void> {
  const c = await store.get(connectionId);
  if (!c) return;
  if (generation !== undefined && c.generation !== generation) return;
  // ADR 0780 D3.2 — a CAS, and a lost swap DROPS the patch. It was a get→put,
  // which re-created a row a revoke deleted in between (as `active`), and a retry
  // would re-apply a stale `needs-reconsent` over a fresh re-consent.
  if (!(await store.compareAndSwap(c, { ...c, ...patch, updatedAt: now() }))) return;
  if (patch.status !== undefined && patch.status !== c.status && patch.status !== 'revoked' && c.status !== 'revoked') {
    await fireConnectionStatusChanged({ tenantId: c.tenantId, connectionId, provider: c.provider, status: patch.status, previousStatus: c.status });
  }
}

export async function revokeConnection(
  tenantId: string,
  connectionId: string,
  /** ADR 0780 D4 — carried to the revoke consumers (see `ConnectionRevokedEvent.cause`). */
  opts: { cause?: 'subject-erased' } = {},
): Promise<boolean> {
  const existing = await getConnection(tenantId, connectionId);
  if (!existing) return false;
  // ADR 0780 D3.3 — the ROW goes first: it is what every resolve selects on, so
  // once it is gone nothing can resolve the credential, and a refresh finishing
  // afterwards sees no row and scrubs its own write-back (D3.4). The secret used
  // to go first with its failure swallowed; a refresh landing in between then
  // re-wrote a live refresh token with no row to find it by.
  await tombstones.put({ connectionId, tenantId, createdAt: now(), ...(existing.userId ? { userId: existing.userId } : {}) });
  const removed = await store.delete(connectionId);
  let secretError: unknown;
  try {
    await removeSecret(secretRef(connectionId), { tenantId });
    await tombstones.delete(connectionId);
  } catch (err) {
    // Not swallowed any more: the caller must see the failure (a DSAR counts it
    // in `failed`), and the tombstone written above keeps naming the token until
    // `sweepSecretTombstones` removes it — with the row gone nothing else can.
    secretError = err;
  }
  // ADR 0081 P2 — evict any in-process SA-JWT token so a minted token doesn't outlive revoke.
  if (existing.kind === 'service-account-jwt') evictServiceAccountToken(connectionId);
  if (removed) {
    // ADR 0285 — fire AFTER the credential + row are gone so consumer features
    // (inbound webhooks, knowledge-sync sources, gmail syncs, …) can DISABLE
    // their dependent configs (never delete — the user sees what broke).
    await fireConnectionRevoked({ tenantId, connectionId, provider: existing.provider, ...(opts.cause ? { cause: opts.cause } : {}) });
    // H57 — the credential is gone; a cached `private` tools list gathered
    // under it must not outlive it. AFTER the delete, so a failed removal never
    // reads as a revocation.
    invalidateMcpForConnection(existing);
  }
  if (secretError !== undefined) {
    log.error('connection secret removal failed after revoke', { connectionId, error: secretError instanceof Error ? secretError.message : String(secretError) });
    throw secretError;
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
 * Every id the acting human is known by IN THIS TENANT: the id a run carries,
 * plus its other half of the durable `User` join (`userId` ⇄ `principalId`).
 *
 * WHY. A user's subject moved from the auth principal (`oidc:<uid>`) to the
 * bound `User.userId` (ADR 0003), and the connect route stamps whichever the
 * request carries NOW. A schedule enabled before that move keeps the principal
 * on its job forever (re-enable preserves attribution), so its runs asked for
 * `oidc:…` while the user's live connection sat under `user:…`. The broker found
 * nothing, the fetch went out with NO token, and Google answered 403 every tick
 * (MEASURED 2026-09-28 in prod: both assistant loops, `connectionUse` absent).
 *
 * SAFE BECAUSE the alias comes only from the durable User row and only when that
 * row's tenant IS this tenant: it is the same human in the same workspace, never
 * a lookup that could reach another principal. A shared workspace (whose tenant
 * is not the user's home tenant) gets no alias, which is the pre-existing
 * behaviour, not a widening.
 */
export async function actingUserIds(tenantId: string, actingUserId: string | undefined): Promise<ReadonlySet<string>> {
  if (actingUserId === undefined) return new Set();
  const ids = new Set([actingUserId]);
  try {
    if (actingUserId.startsWith('user:')) {
      // HOME TENANT ONLY — ADR 0780 D2 widened this and was REVERTED (see the D2
      // correction). A principal id is NOT issuer-qualified (`oidc:<sub>`,
      // `saml:<nameId>`, `scim:<userName>`), so `scim:jsmith` from this user's IdP
      // and a shared workspace's OWN `scim:jsmith` from another IdP are the same
      // string: outside the home tenant the alias would hand one person the other's
      // credential. The home tenant is the one place the principal was minted
      // under this user's own IdP. Shared-workspace legacy rows: `CONNWF-5e`.
      const u = await getUser(actingUserId);
      if (u && u.tenantId === tenantId && u.principalId) ids.add(u.principalId);
    } else {
      const u = await getUserByPrincipal(tenantId, actingUserId);
      if (u) ids.add(u.userId);
    }
  } catch (err) {
    // The alias is a recovery, never a requirement: without it the exact id still matches.
    log.warn('acting-user alias lookup failed', { error: err instanceof Error ? err.message : String(err) });
  }
  return ids;
}

/** The acting user's own connection among `candidates`, preferring the EXACT id
 *  over an alias so a user holding both never has the older row win. */
function ownConnection(candidates: readonly Connection[], exact: string | undefined, ids: ReadonlySet<string>): Connection | undefined {
  if (exact === undefined) return undefined;
  return candidates.find((c) => c.userId === exact) ?? candidates.find((c) => c.userId !== undefined && ids.has(c.userId));
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

  const all = (await tenantRows(input.tenantId)).filter((c) => c.provider === input.provider && c.status === 'active');
  // Most-specific ordering: user (acting) → org → workspace.
  const userConn = ownConnection(all, input.actingUserId, await actingUserIds(input.tenantId, input.actingUserId));
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
 * A workspace-scoped row was refused here until a consumer existed. ADR 0783 D3
 * widened it for data sources (witness: `test/adr0783-p2a-data-sources.test.ts`).
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
    return c.userId !== undefined && (await actingUserIds(input.tenantId, input.actingUserId)).has(c.userId) ? c : refuse('not_owner');
  }
  if (axis === 'org') {
    return (await actingUserHasOrgUse(input.tenantId, c.orgId!, input.actingUserId)) ? c : refuse('connections_use_denied');
  }
  // ADR 0783 D3 — a WORKSPACE row is pinnable. The unpinned lane already
  // self-authorizes one for any run in its tenant (`selectAuthorizedConnection`'s
  // `wsConn`), so an EXACT pin to it is no wider: tenant, provider and `active`
  // are still checked above. The first consumer is a shared data source.
  return c;
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
  const active = (await tenantRows(input.tenantId)).filter(
    (c) => c.status === 'active' && getProvider(c.provider)?.category === input.capability,
  );
  // Most-specific ordering mirrors selectAuthorizedConnection: user → org → workspace.
  const userConn = ownConnection(active, input.actingUserId, await actingUserIds(input.tenantId, input.actingUserId));
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
  const active = (await tenantRows(input.tenantId)).filter(
    (c) => c.status === 'active' && getProvider(c.provider)?.category === input.capability,
  );
  const ids = await actingUserIds(input.tenantId, input.actingUserId);
  const ordered = [
    ...(input.actingUserId ? active.filter((c) => c.userId !== undefined && ids.has(c.userId)) : []),
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
    let own: Connection | null = null;
    for (const id of await actingUserIds(input.tenantId, input.actingUserId)) {
      own = await findByIdentity(input.tenantId, input.provider, id, undefined);
      if (own) break;
    }
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
  // ADR 0780 D2 — any spelling of the acting human. A run stamped with the legacy
  // `oidc:` actor (the #4215 loops) was refused an org connection its human holds
  // `connections:use` for, because the member row was re-keyed at bind.
  for (const subject of await actingUserIds(tenantId, actingUserId)) {
    const access = await resolveEffectiveAccess(tenantId, { subject, orgId });
    if (access.scopes.includes('connections:use')) return true;
  }
  return false;
}

/**
 * Resolve the LIVE secret a node should inject for one connection.
 *   - api_key / bearer / basic → the stored raw secret, verbatim.
 *   - oauth2 → the current access token, transparently refreshed (ADR 0024 §4)
 *     when it is within the skew window of expiry. A refresh failure flips the
 *     connection to `needs-reconsent` and returns null — never a silent stall.
 * Returns null when no secret is stored (e.g. KMS unconfigured) or refresh fails.
 */
async function liveSecretFor(input: Connection, tenantId: string): Promise<string | null> {
  let connection = input;
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
  // ADR 0780 D3.5 — the secret must belong to the row as it stands, or be NEWER
  // than it. Newer means a re-consent wrote its secret and its row swap has not
  // landed yet (it writes the secret first): that is the user's own fresh grant for
  // this very row, so use it. OLDER means a refresh wrote the material it started
  // from over a re-consent: a token of stale provenance — fail closed. Material
  // with no generation is legacy (pre-0780, or written by a revision still
  // draining — grade-code `CONNCD-7`) and is accepted as before.
  if (material.generation !== undefined && connection.generation !== undefined && material.generation < connection.generation) {
    log.warn('oauth token material is older than its connection — needs reconsent', { connectionId: connection.connectionId });
    await patchConnection(connection.connectionId, { status: 'needs-reconsent' }, connection.generation);
    return null;
  }

  const expired = material.expiresAt ? new Date(material.expiresAt).getTime() - TOKEN_REFRESH_SKEW_MS <= Date.now() : false;
  if (!expired) return material.accessToken;

  // grade-code `CONNCD-11` — the refresh is keyed on the generation of the SECRET
  // it is about to spend, not the row's. A newer secret on an older row (a
  // re-consent that crashed between its secret write and its row swap, or lost
  // its swap) used to refresh against the row's generation, discard the result
  // as "a newer secret exists" and leave the row `active` with every resolve
  // failing — after the refresh token had already been spent. The row adopts the
  // secret's generation first (a CAS; a concurrent re-consent's own swap then
  // retries onto a fresh generation), so the write-back lands.
  if (material.generation !== undefined && (connection.generation === undefined || material.generation > connection.generation)) {
    // The row describes the grant it now points at (grade-code `CONNCD-17`): the
    // crashed consent's scopes and account, not the superseded one's.
    const adopted: Connection = {
      ...connection,
      generation: material.generation,
      scopes: material.scopes,
      ...(material.externalSubject ? { externalSubject: material.externalSubject } : {}),
      updatedAt: now(),
    };
    if (!(await store.compareAndSwap(connection, adopted))) return null; // the row moved: the next resolve re-reads it
    connection = adopted;
  }

  // Past (or nearing) expiry — mint a fresh access token from the refresh token.
  if (!material.refreshToken) {
    await patchConnection(connection.connectionId, { status: 'needs-reconsent' }, connection.generation);
    return null;
  }

  // Single-flight: concurrent resolves of the same expired connection coalesce
  // onto one refresh (FEAT-3). The warm-refresh daemon pre-empts most expiries,
  // but a burst of parallel node executions can still race here.
  const inflight = inFlightRefresh.get(connection.connectionId);
  if (inflight) return inflight;

  const refreshToken = material.refreshToken;
  const generation = connection.generation;
  const promise = (async (): Promise<string | null> => {
    try {
      return await refreshAndWriteBack(connection, tenantId, refreshToken, material.scopes, generation);
    } finally {
      inFlightRefresh.delete(connection.connectionId);
    }
  })();
  inFlightRefresh.set(connection.connectionId, promise);
  return promise;
}

function safeJson(raw: string): unknown {
  try { return JSON.parse(raw) as unknown; } catch { return null; }
}

/** The refresh + guarded write-back half of `liveSecretFor` (ADR 0780 D3.4). */
async function refreshAndWriteBack(
  connection: Connection,
  tenantId: string,
  refreshToken: string,
  scopes: string[],
  generation: string | undefined,
): Promise<string | null> {
  let refreshed: OAuthTokenMaterial;
  try {
    refreshed = await refreshAccessToken({ provider: connection.provider, refreshToken, scopes });
  } catch (err) {
    log.warn('oauth refresh failed — flipping to needs-reconsent', {
      connectionId: connection.connectionId,
      provider: connection.provider,
      error: err instanceof Error ? err.message : String(err),
    });
    await patchConnection(connection.connectionId, { status: 'needs-reconsent' }, generation);
    return null;
  }
  // ADR 0780 D3.4 — the write-back is guarded by the row it belongs to. The
  // network call above can take seconds; a revoke or a re-consent in that
  // window must win. A missing row or a new generation discards the refreshed
  // material unwritten.
  const before = await store.get(connection.connectionId);
  if (!before || before.generation !== generation) return null;
  // A re-consent writes its (newer) secret BEFORE its row swap; writing over it
  // now would leave the row pointing at a stale token. Its grant wins.
  // grade-code `CONNCD-14` — a failed read here must not turn a spent refresh
  // token into nothing: on a read error, write back (the reader's older-
  // generation rule still fails closed if a re-consent did land in between).
  const current = await resolveSecret(secretRef(connection.connectionId), { tenantId }).catch(() => null);
  const currentGeneration = current === null ? undefined : (safeJson(current) as { generation?: string } | null)?.generation;
  if (currentGeneration !== undefined && generation !== undefined && currentGeneration > generation) return null;
  await setSecret(secretRef(connection.connectionId), JSON.stringify({ ...refreshed, ...(generation !== undefined ? { generation } : {}) }), { tenantId });
  // A revoke that landed between the check and the write deleted the row
  // first (D3.3), so its absence now means our write is the only copy of a
  // credential the user disconnected: remove it. Ids are never reused (D3.2),
  // so this can only ever remove our own write.
  if ((await store.get(connection.connectionId)) === null) {
    await removeSecret(secretRef(connection.connectionId), { tenantId });
    return null;
  }
  await patchConnection(connection.connectionId, { status: 'active', ...(refreshed.expiresAt ? { expiresAt: refreshed.expiresAt } : {}) }, generation);
  return refreshed.accessToken;
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
    if (after && after.status !== 'active') await patchConnection(connectionId, { status: 'active' }, after.generation);
  }
  return (await getConnection(tenantId, connectionId)) ?? c;
}

/**
 * ADR 0780 D4 — the DSAR eraser. Revokes (through `revokeConnection`, so a failed
 * secret removal THROWS and the fan-out counts it in `failed`) every connection in
 * `tenantId` owned by `subjectKey` or by its User row's legacy principal, and drops
 * the subject's in-flight grants there.
 *
 * Only USER-scoped rows: org and workspace rows carry no `userId`, and a user row is
 * only ever selected for its owner (the D2 select), so deleting it cannot break an
 * integration another member relies on — the reason the audit recorded this store
 * as "needs a decision" does not apply to it.
 *
 * Contract fit: invoked once per linked key and idempotent — the ADR 0285 revoke
 * consumers fire only when `store.delete` removed a row, so a second key or a
 * re-run fires nothing. SCOPE: the tenant the DSAR names; the subject's rows in
 * OTHER shared workspaces are not reached (`CONNWF-16`).
 */
export async function eraseSubjectConnections(tenantId: string, subjectKey: string): Promise<{ rowsTouched: number }> {
  // The legacy principal spelling, HOME TENANT ONLY — the same rule as
  // `actingUserIds`: in a shared workspace the same principal string can be a
  // different person from another IdP, and erasing THIS subject must never
  // delete their connection (ADR 0780 D2 correction).
  const ids = new Set(await actingUserIds(tenantId, subjectKey));
  let rowsTouched = 0;
  const failures: string[] = [];
  // grade-code `CONNCD-2` — one failed removal must not skip the subject's other
  // rows or their pending grants on this pass: finish, then fail loudly.
  for (const c of await store.list()) {
    if (c.tenantId !== tenantId || c.userId === undefined || !ids.has(c.userId)) continue;
    try {
      if (await revokeConnection(tenantId, c.connectionId, { cause: 'subject-erased' })) rowsTouched++;
    } catch (err) {
      rowsTouched++; // the row is gone; its secret is tombstoned
      failures.push(err instanceof Error ? err.message : String(err));
    }
  }
  rowsTouched += await deletePendingAuthFor(tenantId, ids);
  // A re-run (the DSAR retry) finds no rows, so it must retry the tombstones —
  // otherwise it would report success over a token that is still stored.
  const { pending } = await sweepSecretTombstones(tenantId, ids);
  if (failures.length > 0 || pending > 0) {
    throw new Error(`connection secret removal failed (${pending} still pending): ${failures.join('; ')}`);
  }
  return { rowsTouched };
}

/**
 * ADR 0780 `CONNCD-2` — retry every pending secret removal (optionally one
 * tenant's). Returns what is still pending afterwards; a caller that must not
 * report success over a live token (the eraser) throws on a non-zero count.
 */
export async function sweepSecretTombstones(
  tenantId?: string,
  /** Count as pending only tombstones owned by one of these ids (the eraser's subject). */
  owners?: ReadonlySet<string>,
): Promise<{ removed: number; pending: number }> {
  let removed = 0;
  let pending = 0;
  const rows = tenantId !== undefined ? await tombstones.listForTenantIndexed(tenantId) : await tombstones.list();
  for (const t of rows) {
    if (owners !== undefined && (t.userId === undefined || !owners.has(t.userId))) continue;
    // The row still exists: the revoke that wrote this is between its tombstone
    // and its delete (grade-code `CONNCD-12` — dropping it here orphaned the token
    // when that revoke's removal then failed), or never got further. Leave it;
    // expire it only once it is clearly not an in-flight revoke. Never remove a
    // live connection's secret.
    if (await store.get(t.connectionId)) {
      if (Date.now() - new Date(t.createdAt).getTime() > TOMBSTONE_LIVE_ROW_GRACE_MS) await tombstones.delete(t.connectionId);
      continue;
    }
    try {
      await removeSecret(secretRef(t.connectionId), { tenantId: t.tenantId });
      await tombstones.delete(t.connectionId);
      removed++;
    } catch (err) {
      pending++;
      log.warn('connection secret removal still failing', { connectionId: t.connectionId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { removed, pending };
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
  await tombstones.__clear();
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
