/**
 * RTV-2 / RTV-3 — host-issued realtime session registry (ADR 0141 / 0142).
 *
 * POST …/session mints a random `hostSessionId` bound to {tenantId, agentId}; the Gemini
 * browser-relay path MUST present it on …/tool-call, where the host re-derives the agent
 * allowlist + the firewall seen-set key from the SERVER-side record — never the client
 * body. This closes RTV-3 (a /tool-call can no longer name a different agent than the
 * session was opened with) and RAISES THE BAR for RTV-2 (resetting the composition
 * seen-set now needs a fresh, rate-limited POST /session instead of a free client UUID).
 *
 * It does NOT make the Gemini path airtight: a client can still mint multiple host
 * sessions (bounded by the per-IP rate limiter) and spread tool calls across them. Gemini
 * stays LOWER-ASSURANCE per ADR 0142; the OpenAI sideband is the sound governance path
 * (its seen-set keys on the host-owned `call_id`, which the client cannot forge).
 *
 * In-memory + per-instance — matching the sideband WS + seen-set (RTV-5, the realtime
 * connection is inherently sticky). A TTL + size cap keep a teardown-less Gemini path from
 * leaking the map.
 */
import { randomUUID } from 'node:crypto';

interface SessionRecord { tenantId: string; agentId: string | undefined; expiresAt: number }

const sessions = new Map<string, SessionRecord>();
const TTL_MS = 60 * 60 * 1000;   // 1h — long enough for a real voice call; swept lazily
const MAX_SESSIONS = 10_000;     // backstop against unbounded growth (no Gemini teardown hook)

function sweep(now: number): void {
  for (const [id, r] of sessions) if (r.expiresAt <= now) sessions.delete(id);
}

/** Mint a host-issued session id bound to the tenant + the agent the session opened with. */
export function issueRealtimeSession(tenantId: string, agentId: string | undefined): string {
  const now = Date.now();
  if (sessions.size >= MAX_SESSIONS) sweep(now);
  if (sessions.size >= MAX_SESSIONS) {
    const oldest = sessions.keys().next().value; // bounded backstop — drop one entry
    if (oldest) sessions.delete(oldest);
  }
  const id = `rts_${randomUUID()}`;
  sessions.set(id, { tenantId, agentId, expiresAt: now + TTL_MS });
  return id;
}

/** Resolve a host session id to its bound agent, or null when missing/expired/cross-tenant. */
export function resolveRealtimeSession(hostSessionId: string, tenantId: string): { agentId: string | undefined } | null {
  const r = sessions.get(hostSessionId);
  if (!r) return null;
  if (r.expiresAt <= Date.now()) { sessions.delete(hostSessionId); return null; }
  if (r.tenantId !== tenantId) return null; // a forged/cross-tenant id is rejected
  return { agentId: r.agentId };
}

/** End a session (best-effort cleanup; TTL expiry is the backstop). */
export function endRealtimeSession(hostSessionId: string): void { sessions.delete(hostSessionId); }
