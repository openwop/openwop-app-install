/**
 * Priority Matrix — app↔app federated portfolio (ADR 0061, Option A). A per-tenant
 * registry of peer openwop-app origins + a merge of each peer's
 * `/priority-matrix/portfolio` into the local one. Both ends run THIS host, so the
 * federated route is the non-normative host-extension route — no OpenWOP wire, no RFC.
 *
 * Security (the load-bearing part):
 *   - NO secrets at rest — a `FederatedPeer` stores only `{ label, baseUrl }`; the
 *     per-peer bearer is a deploy-time env secret (`OPENWOP_PM_PEER_TOKEN_<ID>` or the
 *     shared `OPENWOP_PM_PEER_TOKEN`), resolved at fetch time, never persisted.
 *   - SSRF-guarded egress — `baseUrl` host is validated at registration with
 *     `isDeniedWebhookHost`, and every fetch dials through `webhookEgressDispatcher()`
 *     (pinned, denied-range-checked DNS at connect, RFC 0093 §A.1). GET only, timeout,
 *     size cap.
 *   - Fail-soft — a peer that errors/times-out/returns junk is dropped from the merge and
 *     reported in `peers[]`; it never blocks the local portfolio.
 *
 * @see docs/adr/0061-priority-matrix-federated-portfolio.md
 */

import { randomUUID } from 'node:crypto';
import { fetch as undiciFetch } from 'undici';
import { DurableCollection } from '../../host/hostExtPersistence.js';
import { OpenwopError } from '../../types.js';
import { cleanString } from '../../host/boundedStrings.js';
import { isDeniedWebhookHost, webhookPrivateEgressAllowed, webhookEgressDispatcher } from '../../host/webhookEgressGuard.js';
import { setSecret, resolveSecret, removeSecret } from '../../byok/secretResolver.js';
import { coalesce, invalidateWhere } from './federationCache.js';
import type { PortfolioItem } from './priorityMatrixService.js';

export interface FederatedPeer {
  id: string;
  tenantId: string;
  label: string;
  /** The peer openwop-app origin (scheme + host[:port]); no path. NON-secret. */
  baseUrl: string;
  createdBy: string;
  createdAt: string;
}

export interface FederatedItem extends PortfolioItem {
  /** `'local'` or the peer's label — so cross-origin ordering is read honestly. */
  source: string;
}

export interface PeerStatus {
  peerId: string;
  label: string;
  ok: boolean;
  count: number;
  error?: string;
}

const peers = new DurableCollection<FederatedPeer>('priority-matrix:peer', (p) => `${p.tenantId}::${p.id}`);
const PEER_CAP = 25;
const PEER_FETCH_TIMEOUT_MS = 6_000;
const PEER_MAX_BYTES = 1_000_000;
/** STRAT-3 — peers are fetched CONCURRENTLY (bounded), not one-at-a-time. With the prior
 *  sequential loop, `PEER_CAP` (25) peers each timing out at `PEER_FETCH_TIMEOUT_MS` (6s)
 *  stacked to ~150s of portfolio-page stall. Bounding concurrency caps the wall-clock at
 *  ~`ceil(PEER_CAP / PEER_FETCH_CONCURRENCY) × PEER_FETCH_TIMEOUT_MS` (~30s worst case) while
 *  staying polite to the network (no 25-way outbound burst). */
const PEER_FETCH_CONCURRENCY = 6;
const nowIso = (): string => new Date().toISOString();

/** Order-preserving bounded-concurrency map (mirrors `host/webResearchSurface.ts`). */
async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx]!);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Validate + normalize a peer base URL: http(s) only, host not in a denied range
 *  (SSRF), returns the bare origin (no path/query). Throws a 400 on a bad/unsafe URL. */
export function validateBaseUrl(raw: unknown): string {
  const s = cleanString(raw, 300);
  if (!s) throw new OpenwopError('validation_error', 'Field `baseUrl` is required.', 400, { field: 'baseUrl' });
  let url: URL;
  try { url = new URL(s); } catch { throw new OpenwopError('validation_error', '`baseUrl` must be a valid URL.', 400, { field: 'baseUrl' }); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new OpenwopError('validation_error', '`baseUrl` must be http(s).', 400, { field: 'baseUrl' });
  }
  if (!webhookPrivateEgressAllowed() && isDeniedWebhookHost(url.hostname)) {
    throw new OpenwopError('validation_error', '`baseUrl` host is in a blocked range (loopback / private / link-local). Set OPENWOP_WEBHOOK_ALLOW_PRIVATE for local testing.', 400, { field: 'baseUrl' });
  }
  return url.origin;
}

// ─── credentials (ADR 0062 — BYOK-enveloped; per-(peer[,user]); env = deprecated) ──

/** Workspace-shared credential ref for a peer (BYOK envelope, KMS-sealed). */
const peerCredentialRef = (peerId: string): string => `pm-peer:${peerId}`;
/** Per-user credential ref for a peer — resolving this means the peer authorizes on
 *  THAT user's own token, so the peer slice is filtered to their access (c1). */
const peerUserCredentialRef = (peerId: string, userId: string): string => `pm-peer:${peerId}:user:${userId}`;

/** The deprecated deploy-time env bearer (back-compat fallback only, ADR 0062). */
function envPeerToken(peer: FederatedPeer): string | undefined {
  const keyed = process.env[`OPENWOP_PM_PEER_TOKEN_${peer.id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`];
  return (keyed && keyed.trim()) || (process.env.OPENWOP_PM_PEER_TOKEN?.trim()) || undefined;
}

/** Context for resolving the bearer to present to a peer (ADR 0062). */
export interface FederationContext { tenantId: string; actingUserId?: string }

/**
 * The resolved bearer + the *identity tier* it came from. `identity` is what makes
 * the fan-out cache (ADR 0061 #3) safe: a peer's slice depends on WHICH credential
 * authorized it (per-user bearers filter the peer to that user), so the cache key
 * must include this tier — never just `(tenantId, peerId, topN)`, or one user's
 * filtered slice would be served to another. Tiers:
 *   - `u:<userId>` — the caller's own per-user credential resolved (slice is theirs);
 *   - `shared`     — the workspace-shared credential (same slice for all who fall back);
 *   - `env`        — the deprecated deploy-time env token;
 *   - `none`       — no credential (the peer sees an unauthenticated request).
 */
export interface ResolvedPeerCredential { token: string | undefined; identity: string }

/**
 * Resolve the bearer for a peer, precedence: the caller's OWN per-user credential →
 * the workspace-shared credential → the deprecated env token. The per-user path is
 * what closes the read-authorization asymmetry (c1): the peer authorizes on the
 * caller's identity, so its slice is filtered to their access. Also reports the
 * `identity` tier so the fan-out cache can key on it without leaking slices.
 */
export async function resolvePeerCredential(peer: FederatedPeer, ctx: FederationContext): Promise<ResolvedPeerCredential> {
  const scope = { tenantId: ctx.tenantId };
  if (ctx.actingUserId) {
    const mine = await resolveSecret(peerUserCredentialRef(peer.id, ctx.actingUserId), scope);
    if (mine) return { token: mine, identity: `u:${ctx.actingUserId}` };
  }
  const shared = await resolveSecret(peerCredentialRef(peer.id), scope);
  if (shared) return { token: shared, identity: 'shared' };
  const env = envPeerToken(peer);
  return env ? { token: env, identity: 'env' } : { token: undefined, identity: 'none' };
}

/** Back-compat token-only resolver (delegates to {@link resolvePeerCredential}). */
export async function resolvePeerToken(peer: FederatedPeer, ctx: FederationContext): Promise<string | undefined> {
  return (await resolvePeerCredential(peer, ctx)).token;
}

/** Store a peer credential (BYOK-enveloped). `scope:'tenant'` = workspace-shared
 *  (superadmin at the route); `scope:'user'` = the acting member's own (self). */
export async function setPeerCredential(
  tenantId: string, peerId: string, token: string, scope: 'tenant' | 'user', actingUserId?: string,
): Promise<void> {
  const peer = await peers.get(`${tenantId}::${peerId}`);
  if (!peer || peer.tenantId !== tenantId) throw new OpenwopError('not_found', 'Peer not found.', 404, { peerId });
  const value = cleanString(token, 4096);
  if (!value) throw new OpenwopError('validation_error', 'Field `token` is required.', 400, { field: 'token' });
  if (scope === 'user') {
    if (!actingUserId) throw new OpenwopError('validation_error', 'A per-user credential requires an authenticated caller.', 400, {});
    await setSecret(peerUserCredentialRef(peerId, actingUserId), value, { tenantId });
  } else {
    await setSecret(peerCredentialRef(peerId), value, { tenantId });
  }
  // Bust any cached slice for this peer: the same identity tier now authorizes on a
  // rotated token, so the ≤TTL window must not keep serving the old token's slice.
  invalidateWhere((key) => key.startsWith(peerCachePrefix(tenantId, peerId)));
}

// ─── peer registry (per-tenant; NON-secret) ────────────────────────────────────

export async function listPeers(tenantId: string): Promise<FederatedPeer[]> {
  return (await peers.listByPrefix(`${tenantId}::`))
    .filter((p) => p.tenantId === tenantId)
    .sort((a, b) => a.label.localeCompare(b.label));
}

export async function addPeer(tenantId: string, createdBy: string, body: Record<string, unknown>): Promise<FederatedPeer> {
  const label = cleanString(body.label, 80);
  if (!label) throw new OpenwopError('validation_error', 'Field `label` is required.', 400, { field: 'label' });
  const baseUrl = validateBaseUrl(body.baseUrl);
  if ((await listPeers(tenantId)).length >= PEER_CAP) {
    throw new OpenwopError('validation_error', `This workspace already has the maximum ${PEER_CAP} federated peers.`, 400, { cap: PEER_CAP });
  }
  const peer: FederatedPeer = { id: `peer-${randomUUID().slice(0, 12)}`, tenantId, label, baseUrl, createdBy, createdAt: nowIso() };
  await peers.put(peer);
  return peer;
}

export async function deletePeer(tenantId: string, id: string): Promise<boolean> {
  const p = await peers.get(`${tenantId}::${id}`);
  if (!p || p.tenantId !== tenantId) return false;
  // Clear the workspace-shared credential (best-effort; per-user refs are cleared on
  // account deletion via the BYOK cascade, not enumerable here).
  await removeSecret(peerCredentialRef(id), { tenantId }).catch(() => undefined);
  invalidateWhere((key) => key.startsWith(peerCachePrefix(tenantId, id)));
  return peers.delete(`${tenantId}::${id}`);
}

// ─── peer fetch (SSRF-guarded) + merge ──────────────────────────────────────────

/** A peer fetch outcome — items on success, an error string on a fail-soft drop. */
export type PeerFetchResult = { ok: true; items: PortfolioItem[] } | { ok: false; error: string };

/** Injectable for tests; the default does the real SSRF-guarded GET (cached). `ctx` carries
 *  the resolution scope (tenant + acting user) for the per-(peer,user) credential (ADR 0062). */
export type PeerFetcher = (peer: FederatedPeer, topN: number, ctx: FederationContext) => Promise<PeerFetchResult>;

/** Coerce a peer's JSON item into a trusted PortfolioItem (drop malformed). */
function coerceItem(raw: unknown): PortfolioItem | null {
  const o = (raw ?? {}) as Record<string, unknown>;
  if (typeof o.cardId !== 'string' || typeof o.title !== 'string' || typeof o.computedPriority !== 'number') return null;
  return {
    listId: typeof o.listId === 'string' ? o.listId : '',
    listName: typeof o.listName === 'string' ? o.listName : '',
    votingMode: o.votingMode === 'multi-voter' ? 'multi-voter' : 'single',
    scoringModel: typeof o.scoringModel === 'string' ? o.scoringModel : 'custom',
    cardId: o.cardId,
    title: o.title,
    status: typeof o.status === 'string' ? o.status : '',
    computedPriority: o.computedPriority,
    inListRank: typeof o.inListRank === 'number' ? o.inListRank : 0,
    ...(typeof o.normalizedPriority === 'number' ? { normalizedPriority: o.normalizedPriority } : {}),
  };
}

/**
 * Read a fetch response body to text with a HARD byte cap (ADR 0061 #4 / OWASP SSRF
 * cheat sheet — undici has no built-in max-response-size, and Content-Length is
 * untrusted). Streams chunks and aborts past `maxBytes` so a malicious/buggy peer
 * can't OOM the host; returns `null` when the cap is exceeded. Because the request
 * sends `accept-encoding: identity`, these are raw (non-decompressed) bytes — the
 * cap is therefore also a decompression-bomb guard (no decode amplification).
 */
export async function readCapped(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<string | null> {
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel().catch(() => undefined); return null; }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const buf = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { buf.set(c, offset); offset += c.byteLength; }
  return new TextDecoder().decode(buf);
}

/** Fan-out cache TTL in ms (ADR 0061 #3). Default 30s; `0`/negative disables caching
 *  (so a deployment can opt out). Bounded + jittered + single-flight in `federationCache`. */
function fanoutTtlMs(): number {
  const raw = Number(process.env.OPENWOP_PM_FED_CACHE_TTL_MS);
  return Number.isFinite(raw) ? raw : 30_000;
}

/** The fan-out cache key. Each component is `encodeURIComponent`-escaped (so `:` →
 *  `%3A`) before joining on `::`, making the delimiter impossible inside a component —
 *  no two distinct tuples can collide on one key even if a tenantId/userId held `::`.
 *  `peerCachePrefix` is the `(tenant,peer)` head used to invalidate on credential change. */
const enc = encodeURIComponent;
const peerCachePrefix = (tenantId: string, peerId: string): string => `${enc(tenantId)}::${enc(peerId)}::`;
const peerCacheKey = (tenantId: string, peerId: string, topN: number, identity: string): string =>
  `${peerCachePrefix(tenantId, peerId)}${topN}::${enc(identity)}`;

/** The real SSRF-guarded GET to one peer with a pre-resolved bearer (token already
 *  resolved by {@link cachedPeerFetch}, which also owns the cache key). */
async function rawPeerGet(peer: FederatedPeer, topN: number, token: string | undefined): Promise<PeerFetchResult> {
  try {
    const url = `${peer.baseUrl}/v1/host/openwop-app/priority-matrix/portfolio?topN=${encodeURIComponent(String(topN))}`;
    const res = await undiciFetch(url, {
      method: 'GET',
      // `identity` encoding removes the decompression-bomb vector (undici advisory
      // GHSA-g9mf-h72j-4rw9); the cap below then bounds raw bytes directly.
      headers: { accept: 'application/json', 'accept-encoding': 'identity', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      redirect: 'error',
      dispatcher: webhookEgressDispatcher(),
      signal: AbortSignal.timeout(PEER_FETCH_TIMEOUT_MS),
    });
    if (!res.ok) { await res.body?.cancel().catch(() => undefined); return { ok: false, error: `HTTP ${res.status}` }; }
    // Fast-path reject on an honest oversized Content-Length, then the real guard:
    // a streaming reader with a hard byte cap (Content-Length is untrusted/optional).
    const declared = Number(res.headers.get('content-length') ?? '0');
    if (declared > PEER_MAX_BYTES) { await res.body?.cancel().catch(() => undefined); return { ok: false, error: 'response too large' }; }
    const text = await readCapped(res.body as ReadableStream<Uint8Array> | null, PEER_MAX_BYTES);
    if (text === null) return { ok: false, error: 'response too large' };
    const body = JSON.parse(text) as { items?: unknown };
    const items = Array.isArray(body.items) ? body.items.map(coerceItem).filter((i): i is PortfolioItem => i !== null) : [];
    return { ok: true, items };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Resolve the peer credential ONCE (token + identity tier), then fetch through the
 * fan-out cache (ADR 0061 #3): single-flight + short-TTL + bounded + jittered. The
 * cache key carries `(tenantId, peerId, topN, identity)` so a per-user slice is never
 * served to another identity (the load-bearing correctness rule). Only successful
 * fetches are cached (`r.ok`); a fail-soft drop is never sticky. `inner` is injectable
 * so the cache integration is testable without real network. TTL ≤ 0 bypasses the cache.
 */
export async function cachedPeerFetch(
  peer: FederatedPeer,
  topN: number,
  ctx: FederationContext,
  inner: (token: string | undefined) => Promise<PeerFetchResult> = (token) => rawPeerGet(peer, topN, token),
): Promise<PeerFetchResult> {
  const { token, identity } = await resolvePeerCredential(peer, ctx);
  const ttl = fanoutTtlMs();
  if (ttl <= 0) return inner(token);
  const key = peerCacheKey(ctx.tenantId, peer.id, topN, identity);
  return coalesce(key, ttl, () => inner(token), (r) => r.ok);
}

const defaultPeerFetcher: PeerFetcher = (peer, topN, ctx) => cachedPeerFetch(peer, topN, ctx);

/**
 * Merge the already-built LOCAL portfolio items with each peer's portfolio, tag every
 * item with its `source`, re-rank by raw `computedPriority`, slice to `topN`. RBAC + the
 * local build are the caller's responsibility (the route passes RBAC-filtered local
 * items). Fail-soft per peer. `fetcher` is injectable for tests.
 */
export async function buildFederatedPortfolio(
  localItems: PortfolioItem[],
  peerList: FederatedPeer[],
  topN: number,
  ctx: FederationContext,
  fetcher: PeerFetcher = defaultPeerFetcher,
): Promise<{ items: FederatedItem[]; peers: PeerStatus[] }> {
  const items: FederatedItem[] = localItems.map((i) => ({ ...i, source: 'local' }));
  const status: PeerStatus[] = [];
  // STRAT-3 — fan out to peers with BOUNDED CONCURRENCY (each fetch carries its own
  // PEER_FETCH_TIMEOUT_MS), not sequentially. Order-preserving, so `status` stays in peer
  // order. Still fail-soft per peer (the fetcher returns `{ok:false,error}`, never throws).
  const results = await mapWithConcurrency(peerList, PEER_FETCH_CONCURRENCY, (peer) => fetcher(peer, topN, ctx));
  peerList.forEach((peer, idx) => {
    const r = results[idx]!;
    if (r.ok) {
      for (const it of r.items) items.push({ ...it, source: peer.label });
      status.push({ peerId: peer.id, label: peer.label, ok: true, count: r.items.length });
    } else {
      status.push({ peerId: peer.id, label: peer.label, ok: false, count: 0, error: r.error });
    }
  });
  items.sort((a, b) => b.computedPriority - a.computedPriority);
  return { items: items.slice(0, Math.max(1, topN)), peers: status };
}

/** Test-only: drop all peers. */
export async function __resetFederationStore(): Promise<void> { await peers.__clear(); }
