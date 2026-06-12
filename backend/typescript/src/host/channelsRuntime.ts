/**
 * Channels runtime — in-process per-run typed-state channels for the
 * workflow-engine sample, per `spec/v1/channels-and-reducers.md`.
 *
 * Holds the per-run channel projections that `GET /v1/runs/{runId}`
 * surfaces as `RunSnapshot.channels` (run-snapshot.schema.json
 * §channels: "Present when the workflow declares channel-aware
 * mode."). Today the sample materializes channels through the
 * canonical `message` reducer (Multi-Agent Shift Phase 1):
 *
 *   - Append-only — new messages land at the end of the list.
 *   - Idempotent on `messageId` — a duplicate emission folds to a
 *     single entry (`channels-and-reducers.md` §`message`).
 *   - Replay-deterministic — the same emission sequence produces the
 *     same final channel value.
 *
 * NOTE: `core.channelWrite` (the §append + §TTL reducer family) keeps
 * its existing variable-bag storage (`variablesRuntime.ts`) — the
 * conformance channel-ttl contract reads that surface via
 * `RunSnapshot.variables`. This module is the `message`-reducer
 * sibling that projects to `RunSnapshot.channels`.
 *
 * Same persistence posture as `variablesRuntime.ts`: in-process Map
 * keyed by runId; survives the process lifetime, not a restart.
 * Sufficient for the sample's single-process conformance-target scope.
 */

/** A `message`-reducer channel entry per `channels-and-reducers.md`
 *  §`message` (`ConversationMessage`). `messageId` is the idempotency
 *  key; everything else is the conversational payload. */
export interface ConversationMessage {
  messageId: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | Array<{ type: string; [k: string]: unknown }>;
  agentId?: string;
  timestamp: string;
  toolName?: string;
  toolCallId?: string;
}

const runChannels = new Map<string, Map<string, ConversationMessage[]>>();

/**
 * Apply the canonical `message` reducer: append `message` to the named
 * channel unless an entry with the same `messageId` already exists
 * (duplicate emissions fold to a single entry — the idempotency
 * invariant the agentMessageReducer conformance scenario pins).
 */
export function appendChannelMessage(
  runId: string,
  channelName: string,
  message: ConversationMessage,
): void {
  let channels = runChannels.get(runId);
  if (!channels) {
    channels = new Map<string, ConversationMessage[]>();
    runChannels.set(runId, channels);
  }
  const current = channels.get(channelName) ?? [];
  if (current.some((m) => m.messageId === message.messageId)) return;
  channels.set(channelName, [...current, message]);
}

/**
 * Snapshot every channel for `runId` as a plain object (the
 * `RunSnapshot.channels` projection). Returns `null` when the run has
 * no channel state — `JSON.stringify` collapse keeps the snapshot
 * field absent, matching the schema's "present when channel-aware"
 * semantics.
 */
export function snapshotRunChannels(runId: string): Record<string, unknown> | null {
  const channels = runChannels.get(runId);
  if (!channels) return null;
  return Object.fromEntries(channels.entries());
}

/** Drop channel state for `runId`. Safe on absent runIds. */
export function clearRunChannels(runId: string): void {
  runChannels.delete(runId);
}

/** Test-only: drop EVERY run's channel state. */
export function __resetAllRunChannelsForTests(): void {
  runChannels.clear();
}
