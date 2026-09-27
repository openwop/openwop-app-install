/**
 * RTV-2 / RTV-3 — host-issued realtime session registry (ADR 0141 / 0142).
 *
 * POST …/session mints a random `hostSessionId` bound to {tenantId, agentId,
 * userId, conversationId}; the Gemini browser-relay path MUST present it on
 * …/tool-call, where the host re-derives the agent allowlist + acting user +
 * the firewall seen-set key from the SERVER-side record — never the client
 * body. This closes RTV-3 (a /tool-call can no longer name a different agent
 * than the session was opened with) and RAISES THE BAR for RTV-2 (resetting
 * the composition seen-set now needs a fresh, rate-limited POST /session
 * instead of a free client UUID).
 *
 * CS-VX-1 (conversation-stack audit 2026-07-09): the registry is now a
 * DURABLE write-through cache (the in-memory Map in front of the
 * DurableCollection seam). On multi-instance Cloud Run a Gemini …/tool-call
 * that landed on a NON-minting instance previously 403'd ("valid realtime
 * session required") — every tool silently broken for that call. A resolve
 * miss now falls through to the durable row. The other per-instance voice
 * state (audio buffers, the OpenAI sideband WebSocket, seen-sets) is
 * INHERENTLY instance-local — a live socket can't be externalized — so
 * multi-instance voice additionally wants Cloud Run session affinity
 * (documented in DEPLOY.md); this registry fix removes the sharpest edge
 * (tool calls) either way.
 *
 * It does NOT make the Gemini path airtight: a client can still mint multiple
 * host sessions (bounded by the per-IP rate limiter) and spread tool calls
 * across them. Gemini stays LOWER-ASSURANCE per ADR 0142; the OpenAI sideband
 * is the sound governance path (its seen-set keys on the host-owned
 * `call_id`, which the client cannot forge).
 *
 * A TTL + size cap keep a teardown-less Gemini path from leaking the map;
 * expired durable rows are best-effort deleted on resolve.
 *
 * A7 (chat-first port) — the composition firewall's per-session seen-set
 * (`toolBridge.seenBySession`, keyed by the `hostSessionId` this registry mints)
 * had NO reaper on the Gemini lane: `clearRealtimeSessionTools` was called only
 * from the OpenAI sideband teardown, so a Gemini call's seen-set leaked for the
 * process lifetime. Every registry eviction path (explicit end, lazy expiry, the
 * size-cap sweep, the backstop drop) now clears it alongside the session row, so
 * the two structures stay in lockstep. Clearing an absent key is a no-op, so this
 * is safe even for a session whose tool calls landed on another instance.
 */
import { randomUUID } from 'node:crypto';
import { DurableCollection } from '../../../host/hostExtPersistence.js';
import { createLogger } from '../../../observability/logger.js';
import { clearRealtimeSessionTools } from './toolBridge.js';

const log = createLogger('features.voice.realtime.sessionRegistry');

interface SessionRecord {
  /** The host-issued id — the DurableCollection key. */
  hostSessionId: string;
  tenantId: string;
  agentId: string | undefined;
  /** ADR 0324 — the AUTHENTICATED session opener, bound at mint so …/tool-call can
   *  thread the acting user into tool execution server-side (never the client body).
   *  Absent for anonymous/unresolvable callers — the deliverable tools then fail
   *  closed exactly as a system-run chat turn does. */
  userId: string | undefined;
  /** ADR 0627 D3 (review S2) — the opener's OWN personal tenant (`req.personalTenant`
   *  at mint, never the body), threaded into the tool scope like `userId` so the
   *  req-less tenant gates keep the HTTP lane's implicit-owner rule over voice. */
  personalTenant?: string;
  /** ADR 0324 — the conversation the session runs inside, bound at mint AFTER the
   *  route's existence+visibility gate (ADR 0309 scope parity with chat). */
  conversationId: string | undefined;
  expiresAt: number;
}

const sessions = new Map<string, SessionRecord>();
// Grade-data G1/G2 hardening (2026-07-09): the tenant extractor upgrades the
// account-deletion purge from the JSON-probe full scan to the indexed path,
// and enables the bounded per-tenant expiry sweep below. (Tenant purge was
// ALREADY reachable via purgeTenantHostExt's jsonTenantId fallback — the
// extractor + sweep close the "never-resolved row leaks until account
// deletion" gap and bound the ops.)
const durable = new DurableCollection<SessionRecord>(
  'voice-realtime-session',
  (r) => r.hostSessionId,
  undefined,
  (r) => r.tenantId,
);

/** Opportunistic expiry sweep: on mint, best-effort delete THIS tenant's
 *  expired durable rows (bounded by the tenant index; throttled per tenant).
 *  The Gemini path is teardown-less by design, so without this a minted-but-
 *  never-resolved session row lived until account deletion. */
const lastSweepAt = new Map<string, number>();
const SWEEP_MIN_INTERVAL_MS = 5 * 60 * 1000;
function sweepTenantDurable(tenantId: string, now: number): void {
  const last = lastSweepAt.get(tenantId) ?? 0;
  if (now - last < SWEEP_MIN_INTERVAL_MS) return;
  lastSweepAt.set(tenantId, now);
  void (async () => {
    try {
      for (const row of await durable.listForTenantIndexed(tenantId)) {
        if (row.expiresAt <= now) await durable.delete(row.hostSessionId);
      }
    } catch (err) {
      log.debug('realtime_session_sweep_failed', { tenantId, error: err instanceof Error ? err.message : String(err) });
    }
  })();
}
const TTL_MS = 60 * 60 * 1000;   // 1h — long enough for a real voice call; swept lazily
const MAX_SESSIONS = 10_000;     // backstop against unbounded growth (no Gemini teardown hook)

function sweep(now: number): void {
  for (const [id, r] of sessions) if (r.expiresAt <= now) { sessions.delete(id); clearRealtimeSessionTools(id); }
}

/** Mint a host-issued session id bound to the tenant + the agent + the caller (ADR 0324)
 *  the session opened with. Write-through durable (CS-VX-1) — fire-and-forget so a
 *  storage hiccup degrades to the old instance-local behavior, never blocks the mint. */
export function issueRealtimeSession(
  tenantId: string,
  agentId: string | undefined,
  binding?: { userId?: string | undefined; conversationId?: string | undefined; personalTenant?: string | undefined },
): string {
  const now = Date.now();
  sweepTenantDurable(tenantId, now); // G2 — reap this tenant's expired durable rows
  if (sessions.size >= MAX_SESSIONS) sweep(now);
  if (sessions.size >= MAX_SESSIONS) {
    const oldest = sessions.keys().next().value; // bounded backstop — drop one entry
    if (oldest) { sessions.delete(oldest); clearRealtimeSessionTools(oldest); }
  }
  const id = `rts_${randomUUID()}`;
  const record: SessionRecord = { hostSessionId: id, tenantId, agentId, userId: binding?.userId, conversationId: binding?.conversationId, ...(binding?.personalTenant ? { personalTenant: binding.personalTenant } : {}), expiresAt: now + TTL_MS };
  sessions.set(id, record);
  void durable.put(record).catch((err: unknown) => {
    log.warn('realtime_session_persist_failed', { hostSessionId: id, error: err instanceof Error ? err.message : String(err) });
  });
  return id;
}

/** Resolve a host session id to its bound agent + caller, or null when
 *  missing/expired/cross-tenant. Async since CS-VX-1: an in-memory miss (the
 *  request landed on a non-minting instance) falls through to the durable row. */
export async function resolveRealtimeSession(
  hostSessionId: string,
  tenantId: string,
): Promise<{ agentId: string | undefined; userId: string | undefined; conversationId: string | undefined; personalTenant?: string | undefined } | null> {
  let r = sessions.get(hostSessionId);
  if (!r) {
    const row = await durable.get(hostSessionId).catch(() => null);
    if (row) { r = row; sessions.set(hostSessionId, row); } // cache for this instance
  }
  if (!r) return null;
  if (r.expiresAt <= Date.now()) {
    sessions.delete(hostSessionId);
    clearRealtimeSessionTools(hostSessionId); // A7 — release the firewall seen-set on expiry
    void durable.delete(hostSessionId).catch(() => { /* lazily reaped next resolve */ });
    return null;
  }
  if (r.tenantId !== tenantId) return null; // a forged/cross-tenant id is rejected
  return { agentId: r.agentId, userId: r.userId, conversationId: r.conversationId, ...(r.personalTenant ? { personalTenant: r.personalTenant } : {}) };
}

/** End a session (best-effort cleanup; TTL expiry is the backstop). */
export function endRealtimeSession(hostSessionId: string): void {
  sessions.delete(hostSessionId);
  clearRealtimeSessionTools(hostSessionId); // A7 — release the firewall seen-set (Gemini has no other teardown)
  void durable.delete(hostSessionId).catch(() => { /* TTL reaps it */ });
}

/** Test-only: evict the in-memory cache entry WITHOUT touching the durable
 *  row — simulates the request landing on a non-minting instance (CS-VX-1). */
export function __evictRealtimeSessionForTests(hostSessionId: string): void {
  sessions.delete(hostSessionId);
}
