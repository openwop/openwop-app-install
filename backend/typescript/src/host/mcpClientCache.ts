/**
 * ADR 0553 P2 — the outbound MCP result cache (RFC 0153 §D).
 *
 * The current revision made list/read results CACHEABLE — they carry `ttlMs`
 * and `cacheScope` — and that is the danger, not the feature. A cache keyed by
 * `(server, method)` would serve one tenant's tool list to another the moment a
 * peer marks it `private`, which is precisely the cross-context poisoning §D
 * exists to forbid. So the key is the whole authorization context:
 *
 *   > An OpenWOP host caching MCP results **MUST** key them by `(tenant,
 *   > workspace, principal, server origin, protocol revision,
 *   > authorization-relevant discovery context)`; a `"private"` result **MUST
 *   > NOT** be served across authorization contexts.
 *
 * And RFC 0153 UQ5 / gap G4, which is the part a TTL cannot express:
 *
 *   > when the caller's authorization scope changes (scope grant/revoke,
 *   > workspace switch), cached `"private"` results for that principal **MUST**
 *   > be treated as stale regardless of `ttlMs` — the TTL is a freshness hint
 *   > about the server's data, not about the caller's rights.
 *
 * THE SCOPE FINGERPRINT IS WHY THIS IS NOT JUST A MAP. It is part of the KEY,
 * not a validator consulted afterwards, so a revoked scope cannot hit a warm
 * entry at all — there is nothing to "check and evict", the lookup simply
 * misses.
 *
 * > **CORRECTION (H57 / AP-07, 2026-08-18).** The paragraph above was TRUE OF
 * > THE DESIGN AND FALSE OF THE CODE from P2 (`df03c3476`) through P3
 * > (`9b2af4839`, DEPLOYED with H53). The fingerprint `mcpClient.cacheKey`
 * > actually built was `sha256([tenant, org, user, serverId])` — the same four
 * > facts already in the key, restated — so it carried NO authorization
 * > material: not the principal's roles/scopes, not which Connection the call
 * > rode, not whether that Connection had been rotated. A grant, revoke or
 * > re-consent produced the SAME key and the warm `private` list was served
 * > for the whole `ttlMs`. And `invalidateMcpCacheForPrincipal` had ZERO
 * > production callers; the sentence that used to follow ("called on an
 * > authorization-scope change") described a wiring that did not exist. Both
 * > are now real: the fingerprint re-derives the principal's scopes and the
 * > Connection's provenance from the store on every read (see
 * > `mcpClient.cacheKey`), and the invalidators below are called from
 * > `accessControlService.updateMember`/`deleteMember` and
 * > `connectionsService.revokeConnection`/`upsertOAuthConnection`. Witness:
 * > `test/mcp-cache-authz-seams.test.ts` (seam-driven, red before the fix).
 *
 * TWO MECHANISMS, and both are needed. The KEY is what protects a SECOND
 * INSTANCE (Cloud Run runs several): a member row edited over there is a
 * different key over here on the next read, with no signal exchanged. The
 * INVALIDATORS are process-local — the same limit as the ADR 0553 P3
 * run-cancellation signal in `executor/runLifecycle.ts` — and drop the
 * principal's entries EAGERLY on the instance that saw the change, so the
 * stale entry is gone rather than merely unreachable. A cross-instance
 * invalidation signal is AP-18's harness, not this file's.
 *
 * Interim MRTR results are NEVER offered to this cache — the client does not
 * call it for `tools/call` at all (§C.1: "An `input_required` result and any
 * request carrying `inputResponses` / `requestState` MUST NOT be cached").
 * Only `tools/list` and `server/discover` are cacheable here, and a `ttlMs` of
 * 0 or an absent one means "do not cache" rather than "cache forever".
 */

export interface McpCacheScopeKey {
  readonly tenantId: string;
  /** The org/workspace the call is made in, when the caller has one. */
  readonly orgId?: string;
  /** The acting principal. Absent for a runless/system caller. */
  readonly principalId?: string;
  /** The peer, by origin — never by connector id, which is a mutable label. */
  readonly serverOrigin: string;
  /** The MCP revision the result was obtained under. */
  readonly revision: string;
  /**
   * ADR 0553 P3 — the PEER's advertised revision: a digest of its
   * `server/discover` answer (supported versions, capabilities, instructions,
   * serverInfo).
   *
   * The ADR names four key components — "server, version, authenticated
   * principal scope and advertised revision" — and P2 shipped the first three.
   * This is the fourth, and it is the one a TTL structurally cannot stand in
   * for: `revision` above is the protocol revision the CALL was made under,
   * which does not change when a peer adds a tool, drops a capability, or
   * re-deploys with a different server version. Without this component a peer
   * that changed its surface inside `ttlMs` is served from a warm entry, which
   * is the "stale entry served after the peer's revision changed" this key part
   * exists to make impossible — not unlikely, impossible, because a changed
   * discovery answer produces a different key and there is nothing to hit.
   *
   * `''` for the bootstrap lookup of `server/discover` itself, which is honest:
   * discovery is what ESTABLISHES the advertised revision, so it cannot be
   * keyed by it. Legacy-profile peers have no `server/discover` and carry a
   * constant instead — see `mcpClient.discoveryRevisionFor`.
   */
  readonly discoveryRevision: string;
  /**
   * A digest of the caller's authorization-relevant context — the principal's
   * effective roles/scopes AND the provenance of the Connection the call rides
   * (which one, its scope axis, its `updatedAt`, its granted scopes and
   * external subject), re-derived from the store on every read. Changing it is
   * what makes a scope grant/revoke or a credential rotation a MISS rather
   * than a stale hit. Built ONLY by `mcpClient.cacheKey`; see the H57
   * correction in the file header for what it was before.
   */
  readonly scopeFingerprint: string;
}

interface Entry {
  value: unknown;
  expiresAtMs: number;
  scope: 'public' | 'private';
  principalId: string;
}

/**
 * Key-part separator. NUL, because every other candidate can appear inside a
 * tenant id, an origin or a method name, and an ambiguous key is a cache that
 * can be made to collide by choosing the right names — the same reasoning
 * `host/effectIdentity.ts` gives for its own preimage separator.
 *
 * Written as the ESCAPE, never a raw NUL byte: a literal one makes the line
 * invisible to grep, which is what `test/source-hygiene.test.ts` exists to
 * prevent. It caught this file.
 */
const SEP = '\u0000';

const store = new Map<string, Entry>();
/** Bound: a cache that can grow without limit is a memory leak with a nice name. */
const MAX_ENTRIES = 2_000;

function keyOf(k: McpCacheScopeKey, method: string): string {
  return [
    k.tenantId,
    k.orgId ?? '',
    k.principalId ?? '',
    k.serverOrigin,
    k.revision,
    k.discoveryRevision,
    k.scopeFingerprint,
    method,
  ].join(SEP);
}

export function readMcpCache(k: McpCacheScopeKey, method: string, nowMs: number = Date.now()): unknown | undefined {
  const hit = store.get(keyOf(k, method));
  if (!hit) return undefined;
  if (hit.expiresAtMs <= nowMs) {
    store.delete(keyOf(k, method));
    return undefined;
  }
  // Belt AND braces. The principal is already in the key, so a cross-principal
  // read cannot reach a `private` entry — but a future key change that dropped
  // the principal would silently turn this cache into the exact vulnerability
  // §D names, and a key is easier to edit than an explicit refusal.
  if (hit.scope === 'private' && hit.principalId !== (k.principalId ?? '')) return undefined;
  return hit.value;
}

export function writeMcpCache(
  k: McpCacheScopeKey,
  method: string,
  value: unknown,
  hints: { ttlMs?: unknown; cacheScope?: unknown },
  nowMs: number = Date.now(),
): void {
  const ttlMs = typeof hints.ttlMs === 'number' && Number.isFinite(hints.ttlMs) ? hints.ttlMs : 0;
  // No hint, or an explicit zero, means do not cache. A peer that omits the
  // CacheableResult fields has not given permission to remember its answer.
  if (ttlMs <= 0) return;
  const scope = hints.cacheScope === 'public' ? 'public' : 'private';
  if (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next();
    if (!oldest.done) store.delete(oldest.value);
  }
  store.set(keyOf(k, method), {
    value,
    expiresAtMs: nowMs + ttlMs,
    scope,
    principalId: k.principalId ?? '',
  });
}

/**
 * Drop every entry cached for a principal — the coarse half of G4. CALLED (H57)
 * from `accessControlService.updateMember` / `deleteMember` (the member's
 * `subject`) and from `connectionsService.revokeConnection` /
 * `upsertOAuthConnection` when the Connection is user-scoped — the seams where
 * the cheapest correct answer is "none of it is trustworthy any more".
 * Process-local (see the file header); the key is the cross-instance guard.
 */
export function invalidateMcpCacheForPrincipal(tenantId: string, principalId: string): number {
  let dropped = 0;
  for (const [key, entry] of store) {
    if (entry.principalId !== principalId) continue;
    if (!key.startsWith(`${tenantId}${SEP}`)) continue;
    store.delete(key);
    dropped += 1;
  }
  return dropped;
}

/**
 * Drop every entry cached for a TENANT (H57). Called when an ORG- or
 * WORKSPACE-scoped Connection is revoked or re-consented: any member may have
 * ridden it, and enumerating them from a lifecycle event is a second answer to
 * "who may use this connection" that would drift from
 * `selectAuthorizedConnection`. Dropping the tenant is coarse and correct.
 */
export function invalidateMcpCacheForTenant(tenantId: string): number {
  let dropped = 0;
  for (const key of store.keys()) {
    if (!key.startsWith(`${tenantId}${SEP}`)) continue;
    store.delete(key);
    dropped += 1;
  }
  return dropped;
}

/** Test seam. */
export function _resetMcpClientCache(): void {
  store.clear();
}

/** Test seam: entry count, so a cache test can prove it cached at all. */
export function _mcpClientCacheSize(): number {
  return store.size;
}
