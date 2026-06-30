/**
 * ADR 0126 Phase 3a — channels FE client. The data layer for the channels rail:
 * list/create channels + read/post membership-gated messages (the backend owns the
 * default-deny access gate; this just calls it). Mirrors the other host-ext clients.
 */
import { authedHeaders, config, fetchOpts } from './config.js';
import { readSseFrames } from './sseFrames.js';

async function http<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${config.baseUrl}${path}`, {
    ...fetchOpts(init),
    headers: { ...(init.headers ?? {}), ...authedHeaders({ 'content-type': 'application/json' }) },
  });
  const body = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok) {
    const err = body as { error?: string; message?: string };
    throw new Error(`${err.error ?? 'http_error'}: ${err.message ?? `HTTP ${res.status}`}`);
  }
  return body as T;
}

export interface ChannelDescriptor { name: string; description?: string; visibility: 'public' | 'private'; archived?: boolean }
export interface ChannelSummary { conversationId: string; channel?: ChannelDescriptor }
export interface ChannelMember { subjectRef: string; role: 'owner' | 'member'; addedAt?: string }
/** The full channel meta (GET /:id) — carries visibility + the membership roster,
 *  which the rail's conversation-list projection omits. `viewerIsOwner` is
 *  server-computed (ADR 0154 Phase 2) so the FE never reconstructs the backend
 *  identity to gate management. */
export interface ChannelDetail { conversationId: string; ownerUserId?: string; viewerIsOwner?: boolean; channel?: ChannelDescriptor; participants?: ChannelMember[] }
export interface ChannelMessage { messageId: string; role: string; content: string; createdAt: string }
/** A discovery row (ADR 0154 FU-4): a public channel or the caller's own private
 *  membership, with whether the caller is already in it. */
export interface ChannelListEntry { conversationId: string; channel?: ChannelDescriptor; joined: boolean }

const BASE = '/v1/host/openwop-app/channels';

/** Discover joinable channels (public + the caller's private memberships). */
export async function listJoinableChannels(): Promise<ChannelListEntry[]> {
  return (await http<{ channels: ChannelListEntry[] }>(BASE)).channels ?? [];
}

/** Self-join a public channel (ADR 0154 FU-4). */
export async function joinChannel(channelId: string): Promise<ChannelSummary> {
  return (await http<{ channel: ChannelSummary }>(`${BASE}/${encodeURIComponent(channelId)}/join`, { method: 'POST' })).channel;
}

export async function createChannel(input: { name: string; visibility?: 'public' | 'private'; description?: string }): Promise<ChannelSummary> {
  return (await http<{ channel: ChannelSummary }>(BASE, { method: 'POST', body: JSON.stringify(input) })).channel;
}

/** Fetch a channel's full meta (visibility + member roster) — membership-gated. */
export async function getChannel(channelId: string): Promise<ChannelDetail> {
  return (await http<{ channel: ChannelDetail }>(`${BASE}/${encodeURIComponent(channelId)}`)).channel;
}

/** Rename a channel (ADR 0154 Phase 2). Owner-only — the backend
 *  `assertChannelManage` gate is authoritative (403 non-owner / 404 non-member);
 *  the FE only gates the UI for clarity. */
export async function renameChannel(channelId: string, name: string): Promise<ChannelSummary> {
  return (await http<{ channel: ChannelSummary }>(`${BASE}/${encodeURIComponent(channelId)}`, { method: 'PATCH', body: JSON.stringify({ name }) })).channel;
}

/** Archive a channel (owner-only). Backend returns 204; `http` tolerates the empty body. */
export async function archiveChannel(channelId: string): Promise<void> {
  await http<unknown>(`${BASE}/${encodeURIComponent(channelId)}/archive`, { method: 'POST' });
}

/** Add a member by user id (owner-only). Returns the updated channel meta. */
export async function addChannelMember(channelId: string, userId: string): Promise<ChannelDetail> {
  return (await http<{ channel: ChannelDetail }>(`${BASE}/${encodeURIComponent(channelId)}/members`, { method: 'POST', body: JSON.stringify({ userId }) })).channel;
}

/** Add an AGENT as a channel member (owner-only) — ADR 0154 Phase 4. The agent can
 *  then be addressed in a post to dispatch a turn into the channel. */
export async function addChannelAgent(channelId: string, agentId: string): Promise<ChannelDetail> {
  return (await http<{ channel: ChannelDetail }>(`${BASE}/${encodeURIComponent(channelId)}/members`, { method: 'POST', body: JSON.stringify({ agentId }) })).channel;
}

/** Remove a member by user id (owner-only). Returns the updated channel meta. */
export async function removeChannelMember(channelId: string, userId: string): Promise<ChannelDetail> {
  return (await http<{ channel: ChannelDetail }>(`${BASE}/${encodeURIComponent(channelId)}/members/${encodeURIComponent(userId)}`, { method: 'DELETE' })).channel;
}

/** Remove an agent member (owner-only) — ADR 0154 Phase 4. */
export async function removeChannelAgent(channelId: string, agentId: string): Promise<ChannelDetail> {
  return (await http<{ channel: ChannelDetail }>(`${BASE}/${encodeURIComponent(channelId)}/agents/${encodeURIComponent(agentId)}`, { method: 'DELETE' })).channel;
}

export async function listChannelMessages(channelId: string): Promise<ChannelMessage[]> {
  return (await http<{ messages: ChannelMessage[] }>(`${BASE}/${encodeURIComponent(channelId)}/messages`)).messages ?? [];
}

export async function postChannelMessage(channelId: string, content: string): Promise<{ messageId: string }> {
  return http<{ messageId: string }>(`${BASE}/${encodeURIComponent(channelId)}/messages`, { method: 'POST', body: JSON.stringify({ content }) });
}


export interface PresenceSnapshot {
  conversationId: string;
  present: string[];
  typing: string[];
  /** Liveness of the presence SSE itself: true on a live connection/snapshot, false
   *  once the stream drops and the reconnect backoff is in flight. Lets the UI surface a
   *  "reconnecting…" cue rather than silently showing stale presence. */
  connected: boolean;
}

/** ADR 0126 Phase 4 / RFC 0110 — subscribe to a channel's EPHEMERAL presence SSE. The
 *  open connection itself marks the caller present; closing it (the returned unsubscribe)
 *  marks them gone. Silent when the feature is off (404 ⇒ the host emits no presence, so
 *  the UI shows none — honest). Frames are `event: channel.presence`. */
export function subscribeChannelPresence(channelId: string, onSnapshot: (s: PresenceSnapshot) => void): () => void {
  // One signal for the whole subscription (reusable across reconnects until aborted); the
  // returned unsubscribe aborts it, ending the loop + any in-flight fetch/backoff.
  const sub = new AbortController();
  const url = `${config.sseBaseUrl}/v1/host/openwop-app/channels/${encodeURIComponent(channelId)}/presence`;
  let attempt = 0;
  // Last server-sent presence, retained across reconnects so the connected/disconnected
  // toggle keeps the last-known present/typing rather than flashing empty.
  let last: { conversationId: string; present: string[]; typing: string[] } = { conversationId: channelId, present: [], typing: [] };
  // Abortable backoff sleep — resolves early on unsubscribe so teardown isn't blocked.
  const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    sub.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
  void (async () => {
    // Reconnect loop: the SSE connection IS the presence signal, so a transient drop is a
    // brief honest absence — reconnect re-marks the viewer present. Exponential backoff +
    // jitter avoids a thundering-herd reconnect storm when a host restarts; a 404/405 is
    // TERMINAL (presence disabled — not transient, don't hammer the host).
    while (!sub.signal.aborted) {
      try {
        const res = await fetch(url, { method: 'GET', headers: authedHeaders(), credentials: 'include', signal: sub.signal });
        if (res.status === 404 || res.status === 405) return; // presence not enabled — terminal
        if (res.ok && res.body) {
          attempt = 0; // a successful connect resets the backoff
          for await (const frame of readSseFrames(res.body, sub.signal)) {
            if (frame.event === 'channel.presence') {
              try {
                const snap = JSON.parse(frame.data) as { conversationId?: string; present?: string[]; typing?: string[] };
                last = { conversationId: snap.conversationId ?? channelId, present: snap.present ?? [], typing: snap.typing ?? [] };
                onSnapshot({ ...last, connected: true });
              } catch { /* skip a malformed frame */ }
            }
          }
          // stream ended (server closed / network) → fall through to backoff + reconnect
        }
      } catch { /* aborted / network — fall through to backoff (or exit if aborted) */ }
      if (sub.signal.aborted) break;
      // The stream dropped (or the connect failed): surface "disconnected" before backoff so
      // the UI can show a reconnecting cue while we retry.
      onSnapshot({ ...last, connected: false });
      attempt += 1;
      const cap = Math.min(30_000, 1000 * 2 ** Math.min(attempt - 1, 5)); // 1s → capped at 30s
      await sleep(cap / 2 + Math.random() * (cap / 2)); // full jitter over [cap/2, cap]
    }
  })();
  return () => sub.abort();
}

/** ADR 0154 FU-6 — subscribe to a channel's live MESSAGE stream. Fires `onMessage`
 *  on each `channel.message` frame; the durable store is the source of truth, so the
 *  caller reloads the thread (the frame carries only the messageId). Reconnects with
 *  backoff + jitter; a 404/405 is TERMINAL (not a member). Returns an unsubscribe.
 *  Unlike presence, this rides the cross-instance host-ext bus — always-on. */
export function subscribeChannelMessages(channelId: string, onMessage: () => void): () => void {
  const sub = new AbortController();
  const url = `${config.sseBaseUrl}/v1/host/openwop-app/channels/${encodeURIComponent(channelId)}/stream`;
  let attempt = 0;
  const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    sub.signal.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });
  void (async () => {
    while (!sub.signal.aborted) {
      try {
        const res = await fetch(url, { method: 'GET', headers: authedHeaders(), credentials: 'include', signal: sub.signal });
        if (res.status === 404 || res.status === 405) return; // not a member / unavailable — terminal
        if (res.ok && res.body) {
          attempt = 0; // a successful connect resets the backoff
          for await (const frame of readSseFrames(res.body, sub.signal)) {
            if (frame.event === 'channel.message') onMessage();
          }
        }
      } catch { /* aborted / network — fall through to backoff */ }
      if (sub.signal.aborted) break;
      attempt += 1;
      const cap = Math.min(30_000, 1000 * 2 ** Math.min(attempt - 1, 5));
      await sleep(cap / 2 + Math.random() * (cap / 2));
    }
  })();
  return () => sub.abort();
}

/** Set the caller's typing state in a channel (best-effort; ignored when presence is off). */
export async function setChannelTyping(channelId: string, typing: boolean): Promise<void> {
  try {
    await fetch(
      `${config.baseUrl}/v1/host/openwop-app/channels/${encodeURIComponent(channelId)}/presence/typing`,
      fetchOpts({ method: 'POST', headers: authedHeaders({ 'content-type': 'application/json' }), body: JSON.stringify({ typing }) }),
    );
  } catch { /* best-effort */ }
}
