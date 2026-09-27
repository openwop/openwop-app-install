/**
 * Module-scope helpers + constants for the chat-session hook family
 * (ADR 0327 P2). Pure functions only — no hooks, no React state.
 */

import type { ChatMessagePersisted } from '../../../client/chatSessionsClient.js';
import type { ToolActivity } from '../../conversationTransport.js';
import type { ChatMessage, ChatSession } from '../../types.js';

/** Built-in fallback inputs for hardcoded sample.* workflows that ship without
 *  a SavedWorkflow defaultInputs blob. Module-scoped (static data) so it has a
 *  stable identity and never needs to appear in a hook dependency array. */
export const SAMPLE_DEFAULT_INPUTS: Record<string, Record<string, unknown>> = {
  'openwop-app.uppercase': { text: 'hello world' },
};

/** How many messages a backend session loads per page (ADR 0043 Phase 3b).
 *  The newest page renders immediately; "Load earlier messages" pages older. */
export const MESSAGE_PAGE_SIZE = 50;

// ADR 0079 §Phase 3 — how long the async-exchange path waits for the reply's
// settle signal (the agent turn or a terminal error) on the SSE before giving
// up and surfacing a retry. Generous: removing the ~60s ceiling for long replies
// is the whole point, so this matches the backend dispatch budget (180s).
export const ASYNC_SETTLE_TIMEOUT_MS = 180_000;
/** The CANONICAL chat-message id for a conversation wire turn — the single id used
 *  for display, the durable store, dedup, and reopen, so there is no per-path id
 *  duality (feedback / regenerate / "load earlier" all key on the same value).
 *
 *  Wire turn ids are `${runId}:gate:0:${turnIndex}:${role}` — the colons fail the
 *  chat-message store's `/^[A-Za-z0-9_-]{1,64}$/` pattern. Sanitizing colons →
 *  `_` is enough for today's uuid runIds (~52 chars), and is stable/deterministic
 *  (same turn → same id) so dedup + a later reload line up. But a naive
 *  `.slice(0, 64)` would truncate the TAIL — exactly the `${turnIndex}:${role}`
 *  discriminator — so a longer (e.g. prefixed) runId could collide two turns and
 *  silently drop the second on its 409. Guard with a stable hash fallback that
 *  preserves the discriminating tail; the common path stays the readable id. */
export function conversationMessageId(wireId: string): string {
  const sanitized = wireId.replace(/[^A-Za-z0-9_-]/g, '_');
  if (sanitized.length <= 64) return sanitized;
  // FNV-1a (32-bit) over the FULL wire id — deterministic, no deps. Combined with
  // the readable tail (turnIndex+role) so two long ids can't collide on the hash.
  let h = 0x811c9dc5;
  for (let i = 0; i < wireId.length; i += 1) { h ^= wireId.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return `cm_${(h >>> 0).toString(36)}_${sanitized.slice(-40)}`;
}

/** Decode persisted rows (each `content` is a JSON-encoded ChatMessage minus its
 *  id — the id is the row's messageId) back into ChatMessages, dropping any row
 *  that fails to parse. Shared by the initial load + the load-earlier path. */
export function parsePersistedMessages(rows: readonly ChatMessagePersisted[]): ChatMessage[] {
  return rows
    .map((p): ChatMessage | null => {
      // The chat surface stores a JSON-serialized ChatMessage envelope; CHANNEL
      // posts + agent replies (channelService / agentRunnerNode) store PLAIN TEXT.
      // Handle both: a JSON object envelope wins; anything else (plain text, or a
      // JSON scalar) is treated as a plain-text message built from the row's role.
      // ADR 0192 — thread the server-stamped author through BOTH branches so
      // multi-party surfaces can attribute + align messages.
      const author = p.authorSubject !== undefined && p.authorSubject !== null ? { authorSubject: p.authorSubject } : {};
      // ADR 0195 — reactions ride the row; editedAt/deletedAt/deletedBy live in
      // the ROW meta (server-stamped) and must survive both parse branches.
      const reactions = p.reactions?.length ? { reactions: p.reactions } : {};
      let rowMeta: Record<string, unknown> = {};
      if (p.meta) { try { rowMeta = JSON.parse(p.meta) as Record<string, unknown>; } catch { /* ignore */ } }
      const lifecycle = {
        ...(typeof rowMeta.editedAt === 'string' ? { editedAt: rowMeta.editedAt } : {}),
        ...(typeof rowMeta.deletedAt === 'string' ? { deletedAt: rowMeta.deletedAt } : {}),
        ...(typeof rowMeta.deletedBy === 'string' ? { deletedBy: rowMeta.deletedBy } : {}),
        // Grade-ux fix — the system-notice discriminator (e.g. 'voice-degraded')
        // must survive reload so the warning treatment isn't live-only.
        ...(typeof rowMeta.kind === 'string' ? { kind: rowMeta.kind } : {}),
      };
      const withLifecycle = (m: ChatMessage): ChatMessage =>
        Object.keys(lifecycle).length ? { ...m, meta: { ...m.meta, ...lifecycle } } : m;
      // ADR 0304 D4 — plain-text rows written server-side (the OpenAI voice sideband)
      // stamp the SPEAKER into the row meta so a multi-voice boardroom/delegation call
      // reloads with per-agent attribution (avatar + name), not an anonymous blob.
      const attribution = {
        ...(typeof rowMeta.agentId === 'string' && rowMeta.agentId ? { agentId: rowMeta.agentId } : {}),
        ...(typeof rowMeta.agentPersona === 'string' && rowMeta.agentPersona ? { agentPersona: rowMeta.agentPersona } : {}),
      };
      try {
        const parsed = JSON.parse(p.content) as unknown;
        if (parsed && typeof parsed === 'object' && ('content' in parsed || 'role' in parsed)) {
          return withLifecycle({ ...(parsed as Omit<ChatMessage, 'id'>), id: p.messageId, ...author, ...reactions } as ChatMessage);
        }
      } catch { /* not JSON — fall through to the plain-text path */ }
      return withLifecycle({ id: p.messageId, role: p.role, content: p.content, createdAt: p.createdAt, ...author, ...reactions, ...attribution } as ChatMessage);
    })
    .filter((m): m is ChatMessage => m !== null);
}
/** ADR 0089 Phase 2 — fold one tool-loop step into the in-flight assistant
 *  message's existing `agentEvents.toolCalls` cards (Running… → done/error).
 *  De-dupes on `callId` since the run SSE replays from seq 0 on reconnect. */
export function applyToolActivity(
  messageId: string,
  activity: ToolActivity,
  setSession: (updater: (s: ChatSession) => ChatSession) => void,
): void {
  if (activity.kind === 'reasoned') return; // summary only — no card
  setSession((s) => ({
    ...s,
    messages: s.messages.map((m) => {
      if (m.id !== messageId) return m;
      // TOCU-7 (ADR 0604) — `handoffs` and `decisions` are initialised here and
      // NEVER written. This is the SOLE `agentEvents` constructor in the SPA, and
      // the write-back below spreads `ae` and replaces `toolCalls` only, so both
      // arrays are permanently `[]`. Their readers — `HandoffIndicator` and
      // `DecisionCard` in `AgentEventCards.tsx`, plus `EnvelopeInspector` and
      // `MessageBubble` — are therefore dead render branches today.
      //
      // Deliberately NOT deleted, unlike the `inputs`/`outcome` disclosures in
      // `AgentEventCards.tsx`. Those were UNWIREABLE: `agent.toolCalled` carries
      // an `argsHash` and `agent.toolReturned` carries no result payload, so
      // reviving them needs an RFC in `../openwop`. These two are a WIRING gap in
      // this file — the activity stream simply has no `handoff`/`decision` branch
      // beside the `tool-called` one above. Adding those branches is host work
      // and is the fix; the components are already correct.
      const ae = m.agentEvents ?? { toolCalls: [], handoffs: [], decisions: [] };
      const toolCalls = [...ae.toolCalls];
      if (activity.kind === 'tool-called') {
        if (activity.callId && toolCalls.some((c) => c.callId === activity.callId)) return m;
        toolCalls.push({
          callId: activity.callId ?? crypto.randomUUID(),
          toolName: activity.toolName ?? 'tool',
          agentId: activity.agentId ?? '',
          startedAt: new Date().toISOString(),
        });
      } else {
        const idx = toolCalls.findIndex((c) =>
          activity.callId ? c.callId === activity.callId : (!c.finishedAt && c.toolName === activity.toolName),
        );
        const card = idx >= 0 ? toolCalls[idx] : undefined;
        // No matching open card, OR already settled — ignore. The settled guard
        // keeps a replayed `toolReturned` (the run SSE replays from seq 0 on
        // reconnect) from re-stamping `finishedAt` and drifting the duration badge.
        if (!card || card.finishedAt) return m;
        const failedStatus = activity.status && activity.status !== 'ok' ? activity.status : undefined;
        // WFAU-4 / RFC 0064 §E — prefer the wire's populated `error` discriminator
        // ({ code, message }) so a real execution/validation/capability failure shows
        // its true code + reason. Fall back to the status-derived code for the
        // `forbidden`/`rate_limited` gate statuses, which carry `status` only (no
        // `error` payload). Before §E, the wire never populated `error`, so EVERY
        // failure collapsed to the bare code `error` here — the WFAU-4 gap.
        const cardError = activity.error ?? (failedStatus ? { code: failedStatus } : undefined);
        // TOCU-6 (ADR 0604) — `message` stays a RENDER concern resolved per-locale
        // at the card; this function has no `t()` in scope. The wire `message` (when
        // present) is an SR-1-redacted machine string, surfaced as a fallback there.
        toolCalls[idx] = {
          ...card,
          finishedAt: new Date().toISOString(),
          ...(cardError ? { error: cardError } : {}),
        };
      }
      return { ...m, agentEvents: { ...ae, toolCalls } };
    }),
  }));
}
